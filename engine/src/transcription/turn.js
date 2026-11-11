/** In-memory turn boundary, independent of slides and recognition engine. No raw audio storage. */
export const unavailableTransport = { available: false };

export class TranscriptionTurn {
  constructor({ capture, transport = unavailableTransport, onChange = () => {}, timeoutMs = 10000, diagnosticContext = () => ({}) } = {}) {
    this.capture = capture; this.transport = transport; this.onChange = onChange; this.timeoutMs = timeoutMs;
    this.diagnosticContext = diagnosticContext;
    this.phase = 'idle'; this.active = null;
  }
  snapshot() {
    const a = this.active;
    return { phase: this.phase, error: this.error || null, identity: a ? { ...a.identity } : null,
      text: a?.text || '', tentative: a?.tentative || '', candidate: a?.candidate || '', reviewRequired: !!this.transport.reviewRequired, speakerLabel: a?.speakerLabel || '', speakerVerified: false };
  }
  notify() { this.onChange(this.snapshot()); }
  get textLimit() { return this.transport.maxTranscriptChars || 1000; }
  owns(a) { return this.active === a && !a.cancelled; }
  cleanup(a) { a.capture?.stop(); a.capture = null; a.channel?.cancel(); a.channel = null; }
  cancel() {
    const a = this.active;
    if (a) { a.cancelled = true; a.abort.abort(); this.cleanup(a); }
    this.active = null; this.phase = 'idle'; this.error = null; this.notify();
  }
  fail(a, reason) {
    if (!this.owns(a)) return;
    if (this.transport.reviewRequired) { this.freezeCandidate(a, reason); return; }
    a.cancelled = true; a.abort.abort(); this.cleanup(a); this.phase = 'paused'; this.error = reason; this.notify();
  }
  captureFailure(a, detail = {}) {
    if (!this.owns(a) || a.frozen || a.captureFailure) return;
    a.captureFailure = true;
    const pick = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback;
    const reason = pick(detail.reason, ['track-ended', 'processor-error', 'capture-start-failed', 'capture-error', 'start-timeout', 'transport-open-failed'], 'capture-error');
    const diagnostic = {
      reason, event: pick(detail.event, ['ended', 'processorerror', 'exception', 'timeout']),
      stage: pick(detail.stage, ['get-user-media', 'context-create', 'worklet-module', 'pcm-converter', 'source-create',
        'worklet-create', 'graph-connect', 'context-resume', 'listening', 'draining', 'transport-open', 'capture-start']),
      contextState: pick(detail.contextState, ['running', 'suspended', 'closed', 'interrupted', 'unavailable']),
      tracks: Array.isArray(detail.tracks) ? detail.tracks.slice(0, 4).map(track => ({
        readyState: pick(track?.readyState, ['live', 'ended']),
        enabled: typeof track?.enabled === 'boolean' ? track.enabled : null,
        muted: typeof track?.muted === 'boolean' ? track.muted : null,
      })) : [],
      errorName: pick(detail.errorName, ['none', 'NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError',
        'SecurityError', 'AbortError', 'InvalidStateError', 'NotSupportedError', 'TypeError', 'other']),
      turnPhase: this.phase, draining: !!a.draining, handover: this.diagnosticContext()?.handover === true,
    };
    // Serialized snapshot, not an event/Error object or mutable live resource.
    console.warn('[presenter microphone]', JSON.stringify(diagnostic));
    this.fail(a, ({ 'track-ended': 'microphone track ended unexpectedly', 'processor-error': 'microphone audio processor failed',
      'capture-start-failed': 'microphone could not start', 'capture-error': 'microphone capture error (unspecified)',
      'start-timeout': 'microphone start timeout', 'transport-open-failed': 'transcription connection could not open' })[reason]);
  }
  async bounded(work, a) {
    if (a.abort.signal.aborted) throw Error('cancelled');
    let timer, onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(Error('cancelled'));
      a.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([work, aborted, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('timeout')), this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); a.abort.signal.removeEventListener('abort', onAbort); }
  }
  async start({ sessionId, allowed, speakerLabel = '' }) {
    this.cancel();
    if (!this.transport.available) { this.phase = 'unavailable'; this.error = 'transcription transport unavailable; use typed question'; this.notify(); return false; }
    if (!sessionId || !allowed()) return false;
    const a = { identity: { sessionId, turnId: crypto.randomUUID() }, allowed, speakerLabel,
      text: '', tentative: '', seq: 0, pending: new Map(), abort: new AbortController(), startStage: 'transport-open' };
    this.active = a; this.phase = 'starting'; this.notify();
    try {
      await this.bounded((async () => {
        const channel = await this.transport.open({ identity: { ...a.identity }, speakerLabel, onEvent: e => this.event(a, e), signal: a.abort.signal });
        if (!this.owns(a) || a.frozen) { channel.cancel(); return; }
        a.channel = channel;
        a.startStage = 'capture-start';
        const captured = await this.capture.start(samples => {
          if (!this.owns(a) || (!['starting', 'listening'].includes(this.phase) && !a.draining)) return;
          if (!a.draining && !allowed()) { this.fail(a, 'capture floor lost'); return; }
          try {
            a.writes ||= new Set();
            if (a.writes.size >= 128) throw Error('audio backlog');
            const writing = Promise.resolve(a.channel.write({ ...a.identity, seq: (a.frameSeq = (a.frameSeq || 0) + 1), sampleRate: 16000, samples }));
            a.writes.add(writing);
            writing.then(() => a.writes.delete(writing), () => { a.writes.delete(writing); this.fail(a, 'audio transport failed'); });
          } catch { this.fail(a, 'audio transport failed'); }
        }, { signal: a.abort.signal, onError: detail => this.captureFailure(a, detail) });
        if (!this.owns(a) || a.frozen || !allowed()) { captured.stop(); if (this.owns(a) && !a.frozen) throw Error('capture floor lost'); return; }
        a.capture = captured;
      })(), a);
      if (!this.owns(a) || a.frozen) return false;
      this.phase = 'listening'; this.notify(); return true;
    } catch (error) {
      this.captureFailure(a, { reason: error.message === 'timeout' ? 'start-timeout' : a.startStage === 'transport-open' ? 'transport-open-failed' : 'capture-start-failed',
        event: error.message === 'timeout' ? 'timeout' : 'exception', stage: a.startStage });
      return false;
    }
  }
  event(a, e) {
    if (!this.owns(a) || a.frozen || e.sessionId !== a.identity.sessionId || e.turnId !== a.identity.turnId ||
        !['starting', 'listening', 'finalizing'].includes(this.phase)) return;
    if (e.type === 'error') { this.fail(a, 'transcription transport failed'); return; }
    if (!Number.isSafeInteger(e.seq) || e.seq <= a.seq || a.pending.has(e.seq)) return;
    if (!['tentative', 'final'].includes(e.type) || typeof e.text !== 'string' || e.text.length > this.textLimit || e.seq > a.seq + 128) {
      this.fail(a, 'invalid transcript event'); return;
    }
    a.pending.set(e.seq, e);
    while (a.pending.has(a.seq + 1)) {
      const next = a.pending.get(++a.seq); a.pending.delete(a.seq);
      if (next.type === 'final') { a.text += next.text; a.tentative = ''; } else a.tentative = next.text;
    }
    if (a.text.length > this.textLimit) { this.fail(a, 'transcript too long; paused'); return; }
    this.notify();
  }
  freezeCandidate(a, reason = 'Best-effort candidate, NOT provider-complete. Check final words and provisional text before submitting.') {
    if (!this.owns(a) || a.frozen) return;
    a.frozen = true; a.draining = false;
    // Revoke callback ownership BEFORE stopping resources or exposing the editor.
    a.candidate = a.text + a.tentative;
    a.abort.abort(); this.cleanup(a); this.phase = 'review'; this.error = reason; this.notify();
  }
  async reviewCandidate() {
    const a = this.active;
    if (!this.transport.reviewRequired || !a || !this.owns(a) || this.phase !== 'listening') throw Error('not listening for review');
    this.phase = 'finalizing'; a.draining = true; this.notify();
    try {
      await this.bounded(Promise.resolve(a.capture?.stop({ drain: true })), a);
      a.draining = false; a.capture = null;
      await this.bounded(Promise.all(a.writes || []), a);
      if (!this.owns(a) || a.frozen) return;
      const result = await this.bounded(a.channel.reviewCandidate({ ...a.identity }), a);
      if (result.sessionId !== a.identity.sessionId || result.turnId !== a.identity.turnId || result.complete !== false) throw Error('invalid review candidate');
      this.freezeCandidate(a);
    } catch { this.freezeCandidate(a, 'Collection failed or timed out. Incomplete candidate; edit deliberately or discard.'); }
  }
  editCandidate(text) {
    const a = this.active;
    if (!a?.frozen || this.phase !== 'review' || typeof text !== 'string' || text.length > 1000) throw Error('invalid candidate edit');
    a.candidate = text; this.notify();
  }
  confirmCandidate() {
    const a = this.active;
    if (!a?.frozen || this.phase !== 'review' || !a.allowed() || !a.candidate.trim() || a.candidate.length > 1000) throw Error('no reviewed contribution');
    this.phase = 'confirmed'; this.notify(); return a.candidate;
  }
  async finalize() {
    if (this.transport.reviewRequired) throw Error('explicit human review required');
    const a = this.active;
    if (!a || !this.owns(a) || this.phase !== 'listening') throw Error('not listening');
    this.phase = 'finalizing'; a.draining = true; this.notify();
    try {
      await this.bounded(Promise.resolve(a.capture?.stop({ drain: true })), a);
      a.draining = false; a.capture = null;
      await this.bounded(Promise.all(a.writes || []), a);
      if (!this.owns(a)) throw Error('cancelled');
      const ack = await this.bounded(a.channel.finish({ ...a.identity }), a);
      if (!this.owns(a)) throw Error('cancelled');
      if (ack.sessionId !== a.identity.sessionId || ack.turnId !== a.identity.turnId || ack.lastSeq !== a.seq ||
          a.pending.size || a.tentative || !a.text.trim()) throw Error('silence or incomplete final transcript');
      this.cleanup(a); this.phase = 'finalized'; this.notify(); return a.text;
    } catch (error) { this.fail(a, error.message === 'timeout' ? 'transcript finalization timeout' : 'silence or incomplete final transcript'); throw Error('transcription paused; no question submitted'); }
  }
}
