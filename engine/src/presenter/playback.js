/** Native Web Audio resampling/clocked bounded queue. PCM input is 24000Hz mono LE. */
export class PassagePlayer {
  constructor(context) { this.context = context; this.sources = new Set(); this.stopped = false; this.end = context.currentTime; this.paused = true; }
  stop() { this.stopped = true; this.paused = true; for (const source of this.sources) {
    source.onended = null; source.stop(); source.disconnect(); source.buffer = null;
  } this.sources.clear(); this.end = this.context.currentTime; }
  async append(bytes) {
    if (!bytes.length || bytes.length % 2 || bytes.length > 4096) throw Error('invalid PCM frame');
    while (this.end - this.context.currentTime > 0.5 && !this.stopped) {
      if (this.context.state !== 'running') throw Error('audio suspended');
      await new Promise(r => setTimeout(r, 10));
    }
    if (this.stopped) throw Error('stopped playback');
    if (this.context.state !== 'running') throw Error('audio unavailable');
    const buffer = this.context.createBuffer(1, bytes.length / 2, 24000), samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); };
    const start = Math.max(this.end, this.context.currentTime + 0.02); // underrun is silence, never fake delivery
    this.end = start + buffer.duration; source.start(start); this.paused = false;
  }
  async drain() {
    while (!this.stopped && (this.sources.size || this.context.currentTime < this.end)) {
      if (this.context.state !== 'running') throw Error('audio suspended');
      await new Promise(r => setTimeout(r, 10));
    }
    if (this.stopped) throw Error('stopped playback');
  }
}

export async function readPassage(response, frame, signal) {
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', eof = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      while (pending.includes('\n')) {
        const index = pending.indexOf('\n');
        if (index > 16000 || eof) throw Error('invalid stream');
        const message = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
        if (message.type === 'eof') eof = true;
        await frame(message);
      }
      if (pending.length > 16000) throw Error('stream frame too large');
    }
    if (pending || !eof) throw Error('truncated passage');
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
