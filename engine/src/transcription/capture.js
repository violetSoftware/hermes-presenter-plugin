/** Streaming linear resampler. Retains at most one sample between calls, never a recording. */
export class Pcm16Converter {
  constructor(inputRate) {
    if (!Number.isFinite(inputRate) || inputRate < 16000) throw Error('unsupported capture rate');
    this.step = inputRate / 16000; this.position = 0; this.tail = new Float32Array();
  }
  convert(input) {
    const data = new Float32Array(this.tail.length + input.length);
    data.set(this.tail); data.set(input, this.tail.length);
    const result = [];
    while (this.position < data.length && (Number.isInteger(this.position) || this.position + 1 < data.length)) {
      const i = Math.floor(this.position), fraction = this.position - i;
      const value = Math.max(-1, Math.min(1, data[i] * (1 - fraction) + (fraction ? data[i + 1] * fraction : 0)));
      result.push(Math.trunc(value * (value < 0 ? 32768 : 32767))); this.position += this.step;
    }
    const keep = Math.min(Math.floor(this.position), data.length);
    this.tail = data.slice(keep); this.position -= keep;
    return Int16Array.from(result);
  }
  flush() {
    // Extend only the last interpolation sample at end-of-input. No recording.
    const result = [];
    while (this.position < this.tail.length) {
      const value = Math.max(-1, Math.min(1, this.tail[Math.floor(this.position)]));
      result.push(Math.trunc(value * (value < 0 ? 32768 : 32767))); this.position += this.step;
    }
    this.tail = new Float32Array(); this.position = 0;
    return Int16Array.from(result);
  }
}

/** No access at construction. Call start only from the visible operator's consent button. */
export function browserCapture({ devices = globalThis.navigator?.mediaDevices,
  contextFactory = () => new AudioContext({ sampleRate: 16000 }),
  nodeFactory = context => new AudioWorkletNode(context, 'transcription-pcm') } = {}) {
  // A stopped graph is silent immediately, but releasing its browser resources
  // is asynchronous. Do not acquire another device while that close is pending.
  let teardown;
  return { async start(onFrame, { signal, onError = () => {} } = {}) {
    if (teardown) await teardown;
    if (signal?.aborted) throw Error('cancelled');
    let context, source, node, closing, stopped = false, draining, resolveDrain, tracks = [], stage = 'get-user-media';
    // Snapshot only bounded metadata, before stop()/close() can overwrite the cause.
    const diagnostic = (reason, event, error) => ({ reason, event, stage,
      contextState: ['running', 'suspended', 'closed', 'interrupted'].includes(context?.state) ? context.state : 'unavailable',
      tracks: tracks.slice(0, 4).map(track => ({
        readyState: ['live', 'ended'].includes(track.readyState) ? track.readyState : 'unknown',
        enabled: typeof track.enabled === 'boolean' ? track.enabled : null,
        muted: typeof track.muted === 'boolean' ? track.muted : null,
      })),
      errorName: !error ? 'none' : ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError',
        'SecurityError', 'AbortError', 'InvalidStateError', 'NotSupportedError', 'TypeError'].includes(error.name) ? error.name : 'other',
    });
    let stream;
    try {
      stream = await devices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
      tracks = stream.getTracks();
    } catch (error) {
      if (!signal?.aborted) onError(diagnostic('capture-start-failed', 'exception', error));
      throw error;
    }
    const stopTracks = () => { for (const track of tracks) { track.onended = null; track.stop(); } };
    const stop = () => {
      if (stopped) return closing; stopped = true; signal?.removeEventListener('abort', stop);
      if (!draining) stopTracks();
      if (node) { node.port.onmessage = null; node.onprocessorerror = null; node.disconnect(); }
      source?.disconnect();
      closing = teardown = Promise.resolve(context?.close()).catch(() => {}).then(() => { resolveDrain?.(); });
      return closing;
    };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) { stop(); throw Error('cancelled'); }
      stage = 'context-create'; context = contextFactory();
      stage = 'worklet-module';
      await context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      if (stopped) throw Error('cancelled');
      stage = 'pcm-converter';
      const converter = new Pcm16Converter(context.sampleRate);
      stage = 'source-create'; source = context.createMediaStreamSource(stream);
      stage = 'worklet-create'; node = nodeFactory(context);
      node.port.onmessage = event => {
        if (stopped) return;
        if (event.data?.drained) { const pcm = converter.flush(); if (pcm.length) onFrame(pcm); stop(); return; }
        const pcm = converter.convert(event.data); if (pcm.length) onFrame(pcm);
      };
      const failed = (reason, event) => {
        if (stopped) return;
        const detail = diagnostic(reason, event);
        stop(); onError(detail);
      };
      node.onprocessorerror = () => failed('processor-error', 'processorerror');
      for (const track of tracks) track.onended = () => { if (!draining) failed('track-ended', 'ended'); };
      stage = 'graph-connect'; source.connect(node); node.connect(context.destination);
      stage = 'context-resume'; await context.resume();
      if (stopped) throw Error('cancelled');
      stage = 'listening';
      return { stop: ({ drain = false } = {}) => {
        if (!drain || stopped) return stop();
        if (draining) return draining;
        stage = 'draining';
        draining = new Promise(resolve => { resolveDrain = resolve; });
        stopTracks(); source.disconnect();
        node.port.postMessage({ drain: true });
        return draining;
      } };
    } catch (error) {
      const detail = !stopped && !signal?.aborted ? diagnostic('capture-start-failed', 'exception', error) : null;
      stop(); if (detail) onError(detail); throw error;
    }
  } };
}
