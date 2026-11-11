import { logFailure, providerFailure, closeFailure, diagnosedErrors } from './eleven-diagnostics.mjs';

/** Scribe segment collection, NEVER a provider all-input finish acknowledgement. */
export function elevenAdapter({ connect, collectMs = 1200, sessionMs = 120000, maxAudioBytes = 32000 * 90, maxAttempts = 1, performance = false, finishMs = 7000 } = {}) {
  if (typeof connect !== 'function' || collectMs < 0 || collectMs > 3000 || sessionMs < 1 || sessionMs > 120000 ||
      maxAudioBytes < 2 || maxAudioBytes > 32000 * 90 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20 || finishMs < 1 || finishMs > 7000) throw Error('invalid transcription limits');
  let active, attempts = 0;
  const textLimit = performance ? 12000 : 1000;
  const adapter = { available: true, reviewRequired: !performance, streaming: true, plannedHumanOnly: performance, maxTranscriptChars: textLimit,
    async open({ identity, onEvent, signal }) {
      if (active || (!performance && attempts >= maxAttempts) || signal?.aborted) throw Error('transcription unavailable');
      const a = { live: true }; active = a; attempts++;
      let socket, connecting = true, seq = 0, frame = 0, bytes = 0, characters = 0, hasText = false, collecting = false, failed = false, timer, collectionTimer, settle, finalCommit;
      const owns = () => active === a && a.live && !signal?.aborted;
      const freeze = () => {
        a.live = false; clearTimeout(timer); clearTimeout(collectionTimer);
        signal?.removeEventListener('abort', cancel);
        socket?.removeEventListener('message', message); socket?.removeEventListener('error', socketError); socket?.removeEventListener('close', closed);
        // Hold concurrency until the socket actually closes; no reconnect or retry.
        if (socket && socket.readyState !== 3) {
          socket.addEventListener('close', release, { once: true }); socket.close();
        } else if (!connecting) release();
        settle?.();
      };
      const release = () => { if (active === a) active = null; };
      const closeAndWait = () => new Promise((resolve, reject) => {
        if (socket.readyState === 3) { freeze(); resolve(); return; }
        const timer = setTimeout(() => { socket.removeEventListener('close', done); reject(Error('transcription close timeout')); }, 1000);
        const done = () => { clearTimeout(timer); resolve(); };
        socket.addEventListener('close', done, { once: true }); freeze();
      });
      const cancel = () => { freeze(); };
      a.cancel = cancel;
      const emit = (type, text) => {
        if (!owns()) return;
        if (text.length > textLimit || (type === 'final' && (characters += text.length) > textLimit) || (!performance && seq >= 512)) throw Error('transcription limit');
        onEvent({ ...identity, seq: ++seq, type, text });
      };
      const error = (details = { category: 'adapter_failure' }) => {
        if (!owns()) return;
        logFailure(connecting ? 'connecting' : collecting ? 'collecting' : 'streaming', details);
        failed = true;
        try { emit('error', ''); } catch { /* Consumer failure is fail-closed, never a raw event-loop error. */ } finally { freeze(); }
      };
      const socketError = () => error({ category: 'socket_error' });
      const closed = event => error(closeFailure(event));
      const message = event => {
        if (!owns()) return;
        let details = { category: 'malformed_provider_message' };
        try {
          if (typeof event.data !== 'string' || event.data.length > 16000) throw Error('invalid provider event');
          const value = JSON.parse(event.data), type = value.message_type;
          if (type === 'session_started' || type === 'committed_transcript_with_timestamps') return;
          if (!['partial_transcript', 'committed_transcript'].includes(type)) { error(providerFailure(value)); return; }
          details = { category: 'malformed_provider_message', message_type: type };
          if (typeof value.text !== 'string') throw Error('provider failed');
          details = { category: 'adapter_failure' };
          // Plain commit is authoritative for a segment. Timestamp companion is ignored,
          // never text-based deduplication (repeated spoken phrases remain repeated).
          const text = value.text;
          if (performance && type === 'committed_transcript') {
            // Empty final segment clears only the provisional suffix, never prior pieces.
            emit('final', text ? (hasText ? ' ' : '') + text : '');
            if (text) hasText = true;
            finalCommit?.();
            return;
          }
          if (!text) return; // Legacy review retains uncertain text for deliberate editing.
          if (type === 'committed_transcript') {
            emit('final', (hasText ? ' ' : '') + text); hasText = true;
          } else emit('tentative', (hasText ? ' ' : '') + text);
        } catch { error(details); }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      // Attended performance has no tiny per-human time/attempt quota; operator
      // consent and connection cleanup bound capture. Legacy smoke limits remain.
      if (!performance) timer = setTimeout(error, sessionMs);
      try {
        socket = await connect({ signal }); connecting = false;
        if (!owns()) { freeze(); throw Error('cancelled'); }
        socket.addEventListener('message', message); socket.addEventListener('error', socketError); socket.addEventListener('close', closed);
      } catch (cause) {
        if (owns() && !diagnosedErrors.has(cause)) logFailure('connecting', { category: 'connection_failure' });
        connecting = false; freeze(); throw Error('transcription connection failed');
      }
      const send = (pcm, commit) => {
        if (!owns() || socket.readyState !== 1 || socket.bufferedAmount > 64000) throw Error('transcription unavailable');
        socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: pcm, commit, sample_rate: 16000 }));
      };
      return {
        async write(value) {
          try {
            if (collecting || value.sessionId !== identity.sessionId || value.turnId !== identity.turnId || value.seq !== frame + 1 ||
                value.sampleRate !== 16000 || typeof value.pcm !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.pcm)) throw Error('invalid PCM');
            const length = Buffer.from(value.pcm, 'base64').length;
            if (!length || length % 2 || length > 38400 || ((bytes += length) > maxAudioBytes && !performance)) throw Error('audio limit');
            frame++; send(value.pcm, false);
          } catch { error(); throw Error('transcription write failed'); }
        },
        ...(performance ? { async finish(value) {
          if (collecting || !owns() || value.sessionId !== identity.sessionId || value.turnId !== identity.turnId) throw Error('invalid finish');
          collecting = true;
          let committed = false;
          try {
            await new Promise(resolve => {
              settle = resolve;
              finalCommit = () => { committed = true; resolve(); };
              collectionTimer = setTimeout(error, finishMs);
              send('', true);
            });
            if (!committed || failed || !owns()) throw Error('final commit missing');
            await closeAndWait();
            // PoC: next plain committed event after ordered commit, NOT a provider
            // input watermark. A delayed automatic commit remains ambiguous.
            return { ...identity, lastSeq: seq, boundary: 'next-committed-event' };
          } finally { finalCommit = null; freeze(); }
        } } : {}),
        async reviewCandidate(value) {
          if (collecting || value.sessionId !== identity.sessionId || value.turnId !== identity.turnId || signal?.aborted) throw Error('invalid candidate');
          collecting = true;
          if (owns()) {
            try {
              send('', true);
              await new Promise(resolve => { settle = resolve; collectionTimer = setTimeout(resolve, collectMs); });
            } catch { failed = true; }
          }
          freeze();
          if (signal?.aborted) throw Error('cancelled');
          return { ...identity, complete: false, uncertain: true, failed, lastSeq: seq };
        },
        cancel,
      };
    },
    async close() { active?.cancel?.(); },
  };
  return adapter;
}
