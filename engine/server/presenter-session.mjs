import { randomUUID } from 'node:crypto';
import { groundingFor, validateSpeech } from './presenter-grounding.mjs';

/** Application event session, NOT a full-profile Hermes chat. Drafts are never history. */
export class PresenterSession {
  constructor({ speech, existing = false } = {}) {
    this.speech = speech;
    this.existing = existing;
    this.id = randomUUID(); this.epoch = 0; this.floor = 'human';
    this.phase = 'paused'; this.connected = true; this.active = null;
    this.delivered = []; this.questions = []; this.pendingQuestion = null;
    this.completedNarration = new Set();
    this.segmentCursor = 0; this.sequenceActive = false; this.contributions = [];
    this.events = []; this.record('created');
  }
  record(type, extra = {}) { this.events.push({ seq: this.events.length + 1, epoch: this.epoch, type, ...extra }); }
  state() { return { id: this.id, epoch: this.epoch, floor: this.floor, phase: this.phase, connected: this.connected,
    active: this.active ? { ...this.active } : null, delivered: structuredClone(this.delivered), questions: structuredClone(this.questions),
    ...(this.hasRunningOrder() ? { runningOrder: { cursor: this.segmentCursor, active: this.sequenceActive,
      finished: !this.segment(), segment: structuredClone(this.segment() || null) } } : {}),
    ...(this.guided ? { guided: { completed: [...this.completedNarration], finished: this.completedNarration.has(this.grounding?.slides.at(-1).id) } } : {}),
    ...(this.grounding ? { source: { deckId: this.grounding.deckId, sourceHash: this.grounding.sourceHash,
      snapshotHash: this.grounding.snapshotHash, currentSlide: { ...this.grounding.currentSlide } } } : {}) }; }
  payload() { return { ...(this.existing ? {} : { delivered: structuredClone(this.grounding ? this.delivered.slice(-4) : this.delivered), questions: structuredClone(this.grounding ? this.questions.slice(-4) : this.questions) }),
    question: this.pendingQuestion, mode: this.pendingQuestion ? 'answer' : 'narration',
    ...(this.grounding ? { grounding: structuredClone(this.grounding) } : {}), ...(this.speech ? { speech: this.speech } : {}),
    ...(this.hasRunningOrder() ? { performance: { segmentId: this.segment()?.id || null, contributions: structuredClone(this.contributions) } } : {}) }; }
  hasRunningOrder() { return this.running && !!this.grounding?.runningOrder; }
  segment() { return this.hasRunningOrder() ? this.grounding.runningOrder[this.segmentCursor] : undefined; }
  selectSegment() {
    const segment = this.segment();
    if (segment) {
      const index = this.grounding.slides.findIndex(s => s.id === segment.slideId);
      this.grounding.currentSlide = { index, id: segment.slideId };
    }
    const ready = this.sequenceActive && segment?.role === 'agent';
    this.floor = ready ? 'agent' : 'human'; this.phase = ready ? 'ready' : 'paused';
  }
  // Finalized actual text is the sole contribution, never planned-and-said.
  confirmHuman(transcript) {
    const segment = this.segment();
    if (segment?.role !== 'human') throw Error('not a human segment');
    if (transcript !== undefined && (typeof transcript !== 'string' || !transcript.trim() || transcript.length > 12000)) throw Error('invalid reviewed contribution');
    this.contributions.push({ segmentId: segment.id, kind: transcript === undefined ? 'placeholder' : 'transcript', text: transcript === undefined ? segment.placeholder : transcript });
    this.segmentCursor++; this.record('human-confirmed', { segmentId: segment.id });
  }
  navigate(snapshot, index) {
    const grounding = groundingFor(snapshot, index);
    const switched = this.grounding?.snapshotHash !== grounding.snapshotHash;
    this.command('stop', undefined, false);
    if (switched) { this.delivered = []; this.questions = []; this.completedNarration.clear(); this.segmentCursor = 0; this.contributions = []; }
    this.grounding = grounding;
    return this.state();
  }
  matches(r) { return !!r && !!this.active && r.epoch === this.active.epoch && r.id === this.active.id; }
  begin() {
    if (!this.connected || this.floor !== 'agent' || this.phase !== 'ready' || this.active) throw Error('not ready');
    const r = { epoch: this.epoch, id: randomUUID(), kind: this.pendingQuestion ? 'answer' : 'narration', question: this.pendingQuestion, status: 'generating',
      ...(this.hasRunningOrder() ? { segmentId: this.segment()?.id || null } : {}) };
    this.active = r; this.phase = 'preparing'; this.record('requested', { request: r.id }); return { ...r };
  }
  generated(r, text) {
    if (!this.matches(r) || r.epoch !== this.epoch || this.active.status !== 'generating') return false;
    // Deliberately simple sentence-unit contract. Abbreviations require upstream wording changes.
    validateSpeech(text, this.speech);
    this.active.text = text.trim(); this.active.status = 'tts'; this.record('draft', { request: r.id });
    if (this.hasRunningOrder()) this.contributions = []; // Native receipt persisted before this acknowledgment.
    return true;
  }
  audioReady(r, audio) {
    if (!this.matches(r) || r.epoch !== this.epoch || this.active.status !== 'tts') return false;
    this.active.audio = audio; this.active.status = 'buffered'; return true;
  }
  started(r) {
    if (!this.matches(r) || r.epoch !== this.epoch || this.active.status !== 'buffered') return false;
    this.active.status = 'playing'; this.phase = 'speaking'; this.record('playback-start', { request: r.id }); return true;
  }
  ended(r, persist) {
    // A graceful pause grants exactly this already-playing request a completion lease.
    if (!this.matches(r) || this.active.status !== 'playing' ||
        (r.epoch !== this.epoch && this.active.finishLease !== this.epoch)) return false;
    const a = this.active;
    persist?.(a); // Durable operation receipt precedes publishing heard context.
    this.delivered.push({ text: a.text, kind: a.kind });
    if (a.kind === 'answer') {
      this.questions.push({ question: a.question, answer: a.text });
      if (this.pendingQuestion === a.question) this.pendingQuestion = null;
    }
    this.record('delivered', { request: a.id }); this.active = null;
    if (this.hasRunningOrder()) {
      if (a.kind === 'narration' && a.segmentId === this.segment()?.id) {
        this.segmentCursor++; this.epoch++; this.record('segment-advance', { segmentId: a.segmentId });
        this.selectSegment();
      } else { this.sequenceActive = false; this.floor = 'human'; this.phase = 'paused'; }
      if (!this.segment()) { this.sequenceActive = false; this.record('sequence-finished'); }
      return true;
    }
    if (this.guided && a.kind === 'narration') {
      const index = this.grounding.currentSlide.index;
      this.completedNarration.add(this.grounding.currentSlide.id);
      if (index < this.grounding.slides.length - 1) {
        this.grounding.currentSlide = { index: index + 1, id: this.grounding.slides[index + 1].id };
        this.epoch++; this.record('guided-advance');
      } else this.record('guided-finished');
      this.floor = 'human'; this.phase = 'paused'; return true;
    }
    if (this.floor === 'human' || a.kind === 'answer') { this.floor = 'human'; this.phase = 'paused'; }
    else this.phase = 'ready';
    return true;
  }
  command(action, text, audible = true) {
    if (!['resume', 'pause', 'stop', 'question', 'disconnect', 'reconnect'].includes(action)) throw Error('unknown control');
    if (action === 'question' && (typeof text !== 'string' || !text.trim() || text.length > 1000)) throw Error('finalized question required');
    if (action === 'resume' && (!this.connected || this.active)) throw Error('not ready to resume');
    if (action === 'resume' && text !== undefined && (!this.hasRunningOrder() || this.segment()?.role !== 'human' || this.phase !== 'paused' || this.pendingQuestion || this.segment().slideId !== this.grounding.currentSlide.id || typeof text !== 'string' || !text.trim() || text.length > 12000)) throw Error('invalid human handback');
    if (this.hasRunningOrder() && action === 'question' && (this.segment()?.role !== 'human' || this.active || this.phase !== 'paused')) throw Error('question requires planned human boundary');
    this.epoch++;
    const graceful = audible && ['pause', 'question'].includes(action) && this.active?.status === 'playing';
    if (graceful) this.active.finishLease = this.epoch;
    else this.active = null;
    const resume = action === 'resume' && !(this.guided && !this.pendingQuestion && this.completedNarration.has(this.grounding?.currentSlide.id));
    this.floor = resume ? 'agent' : 'human';
    this.phase = resume ? 'ready' : graceful ? 'pausing' : 'paused';
    if (action === 'question') this.pendingQuestion = text;
    if (['stop', 'disconnect', 'reconnect'].includes(action)) this.pendingQuestion = null;
    if (action === 'disconnect') this.connected = false;
    if (action === 'reconnect') this.connected = true;
    if (this.hasRunningOrder()) {
      this.sequenceActive = false;
      if (action === 'resume') {
        if (this.pendingQuestion) { this.floor = 'agent'; this.phase = 'ready'; }
        else {
          this.sequenceActive = true;
          // A manually selected slide must be restored before confirming a human contribution.
          const onSegment = this.segment()?.slideId === this.grounding.currentSlide.id;
          if (onSegment && this.segment()?.role === 'human') this.confirmHuman(text);
          this.selectSegment();
          if (!this.segment()) this.sequenceActive = false;
        }
      }
    }
    this.record(action); return this.state();
  }
}
