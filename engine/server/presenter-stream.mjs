/** Completed passage → incremental mono PCM16LE. No expression pass or retry. */
import { ATTENDED_SPEECH } from './presenter-grounding.mjs';
export function elevenStream({ key, voice, speech, fetchImpl = fetch }) {
  return async (text, signal) => {
    if ((speech !== undefined && speech !== ATTENDED_SPEECH) || !key || !voice || typeof text !== 'string' || !text.trim() || text.length > (speech ? 2000 : 240)) throw Error('invalid speech input');
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90000)]);
    bounded.throwIfAborted();
    const response = await fetchImpl('https://api.elevenlabs.io/v1/text-to-dialogue/stream?output_format=pcm_24000', {
      method: 'POST', signal: bounded,
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
      body: JSON.stringify({ model_id: 'eleven_v4', inputs: [{ text, voice_id: voice }] }),
    });
    const kind = response.headers.get('content-type')?.split(';')[0].toLowerCase();
    if (!response.ok || !['audio/pcm', 'audio/raw', 'application/octet-stream'].includes(kind)) {
      await response.body?.cancel?.(); throw Error('speech invalid audio');
    }
    const reader = response.body.getReader?.();
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    bounded.addEventListener('abort', cancel, { once: true });
    if (bounded.aborted) cancel();
    return { sampleRate: 24000, contentType: 'audio/pcm', chunks: (async function* () {
      let tail = Buffer.alloc(0), size = 0;
      const iterator = reader ? { async *[Symbol.asyncIterator]() { for (;;) { const value = await reader.read(); if (value.done) return; yield value.value; } } } : response.body;
      try {
      bounded.throwIfAborted();
      for await (const chunk of iterator) {
        bounded.throwIfAborted();
        size += chunk.length;
        if (size > 24000 * 2 * (speech ? 90 : 30)) throw Error('speech too large');
        const data = Buffer.concat([tail, Buffer.from(chunk)]), length = data.length - data.length % 2;
        // Wire frames are at most 4096 bytes; the consumer controls backpressure.
        for (let offset = 0; offset < length; offset += 4096) yield data.subarray(offset, Math.min(length, offset + 4096));
        tail = data.subarray(length);
      }
      bounded.throwIfAborted();
      if (!size || tail.length) throw Error('speech empty or truncated');
      } finally { bounded.removeEventListener('abort', cancel); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    })() };
  };
}
