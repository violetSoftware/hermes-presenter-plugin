/** Same-origin JSON over existing runtime. PCM is transient base64, explicitly little endian. */
export function httpTranscription({ request = async (route, body, signal) => {
  const response = await fetch('/presenter-api/' + route, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Presenter-Connection': body.connectionId,
      'X-Transcription-Session': body.sessionId, 'X-Transcription-Turn': body.turnId },
    body: JSON.stringify(body), signal });
  if (!response.ok) throw Error('transcription unavailable or refused');
  return response.json();
} } = {}) {
  let connectionId, generation = 0;
  const transport = {
    available: false,
    configure(config) { generation++; connectionId = config.connectionId; transport.available = config.transcriptionAvailable === true; transport.reviewRequired = config.transcriptionReviewRequired === true; transport.streaming = config.transcriptionStreaming === true; transport.maxTranscriptChars = config.transcriptionMaxChars || 1000; },
    async open({ identity, onEvent, signal }) {
      if (!transport.available || signal?.aborted) throw Error('unavailable');
      const g = generation, connection = connectionId, abort = new AbortController();
      let cancelled = false, chain = Promise.resolve(), pending = 0, finishing = false, pollTimer;
      const manual = transport.reviewRequired;
      let samples = new Int16Array(19200), used = 0, inputSeq = 0, wireSeq = 0;
      const owns = () => !cancelled && g === generation && !signal?.aborted;
      const payload = value => ({ ...value, ...identity, connectionId: connection });
      const cancel = () => {
        if (cancelled) return; cancelled = true; clearTimeout(pollTimer); abort.abort(); signal?.removeEventListener('abort', cancel);
        samples = new Int16Array(); used = 0;
        void request('transcription/cancel', payload({}), AbortSignal.timeout(1000)).catch(() => {});
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const enqueue = (route, body) => {
        if (!owns() || pending >= 32) { cancel(); return Promise.reject(Error('cancelled or backlog')); }
        pending++;
        const work = chain.then(async () => {
          if (!owns()) throw Error('stale connection');
          const result = await request('transcription/' + route, payload(body), AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]));
          if (!owns()) throw Error('stale response');
          for (const event of result.events || []) { await onEvent(event); if (!owns()) throw Error('cancelled'); }
          return result;
        }).catch(error => { cancel(); throw error; });
        chain = work.catch(() => {});
        return work.finally(() => { pending--; });
      };
      try { await enqueue('open', {}); } catch (error) { cancel(); throw error; }
      const poll = async () => {
        if (!owns() || finishing) return;
        try { await enqueue('poll', {}); }
        catch { if (g === generation && !signal?.aborted) onEvent({ ...identity, type: 'error' }); return; }
        if (owns() && !finishing) pollTimer = setTimeout(poll, 250);
      };
      if (manual || transport.streaming) pollTimer = setTimeout(poll, 250);
      const flush = () => {
        if (!used) return Promise.resolve();
        const bytes = new Uint8Array(used * 2), view = new DataView(bytes.buffer);
        for (let i = 0; i < used; i++) view.setInt16(i * 2, samples[i], true);
        used = 0;
        return enqueue('write', { seq: ++wireSeq, sampleRate: 16000, pcm: btoa(String.fromCharCode(...bytes)) });
      };
      return {
        write(frame) {
          if (!owns() || finishing || !(frame.samples instanceof Int16Array) || !frame.samples.length || frame.samples.length > 19200 ||
              frame.seq !== inputSeq + 1 || frame.sampleRate !== 16000 ||
              frame.sessionId !== identity.sessionId || frame.turnId !== identity.turnId) {
            cancel(); return Promise.reject(Error('invalid PCM'));
          }
          inputSeq++;
          const count = Math.min(samples.length - used, frame.samples.length);
          samples.set(frame.samples.subarray(0, count), used); used += count;
          const work = used === samples.length ? flush() : Promise.resolve();
          if (count < frame.samples.length) { samples.set(frame.samples.subarray(count), used); used += frame.samples.length - count; }
          return work;
        },
        async reviewCandidate(value) {
          if (!manual || finishing || value.sessionId !== identity.sessionId || value.turnId !== identity.turnId) throw Error('invalid review');
          finishing = true; clearTimeout(pollTimer);
          await flush();
          const result = await enqueue('review', {});
          // Revoke further local provider delivery before handing the candidate to its editor.
          cancelled = true; signal?.removeEventListener('abort', cancel);
          return result.candidate;
        },
        async finish(value) {
          if (manual) throw Error('human review required');
          if (finishing || value.sessionId !== identity.sessionId || value.turnId !== identity.turnId) throw Error('invalid finish');
          finishing = true; clearTimeout(pollTimer);
          await flush();
          const result = await enqueue('finish', {});
          signal?.removeEventListener('abort', cancel);
          return result.ack;
        },
        cancel,
      };
    },
  };
  return transport;
}
