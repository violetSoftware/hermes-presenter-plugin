import { validateGroundedPayload, ATTENDED_SPEECH } from './presenter-grounding.mjs';
export function validateExistingPayload(payload) {
  if (!payload || Object.keys(payload).sort().join(',') !== (payload.performance ? 'correction,grounding,initial,mode,performance,question,speech' : 'correction,grounding,initial,mode,question,speech') || JSON.stringify(payload).length > 32000 ||
      typeof payload.initial !== 'boolean' || (payload.correction !== null && (typeof payload.correction !== 'string' || payload.correction.length > 2200))) throw Error('invalid existing handover');
  validateGroundedPayload({ grounding: payload.grounding, mode: payload.mode, question: payload.question,
    speech: payload.speech, delivered: [], questions: [] });
  if (payload.speech !== ATTENDED_SPEECH) throw Error('existing passage policy required');
  if (payload.performance) {
    const p = payload.performance, segments = payload.grounding.runningOrder;
    const segment = segments?.find(s => s.id === p.segmentId);
    if (!p || Object.keys(p).sort().join(',') !== 'contributions,segmentId' ||
        !(segment || p.segmentId === null && payload.mode === 'answer') ||
        (segment && segment.slideId !== payload.grounding.currentSlide.id) ||
        (payload.mode === 'narration' && segment?.role !== 'agent') ||
        !Array.isArray(p.contributions) || p.contributions.length > 32 || new Set(p.contributions.map(c => c.segmentId)).size !== p.contributions.length) throw Error('invalid performance');
    for (const c of p.contributions) {
      const human = segments?.find(s => s.id === c.segmentId && s.role === 'human');
      if (!human || Object.keys(c).sort().join(',') !== 'kind,segmentId,text' || !['placeholder', 'transcript'].includes(c.kind) ||
          typeof c.text !== 'string' || !c.text.trim() || c.text.length > 12000 || (c.kind === 'placeholder' && c.text !== human.placeholder)) throw Error('invalid human contribution');
    }
  }
  return payload;
}
// Retain original byte-bound payload in private proof, but never send planned and said human passages together.
export function existingPromptState(payload) {
  const state = structuredClone(payload);
  if (state.performance) state.grounding.runningOrder = state.grounding.runningOrder.map(({ placeholder: _placeholder, ...segment }) => segment);
  return state;
}
export function validExistingProof(proof, sessionRef) {
  const sid = /^@session:[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+)$/.exec(sessionRef || '')?.[1];
  return !!(sid && proof?.existing_session === true && proof.session_id === sid && proof.prompt_submissions === 1 &&
    proof.no_tool_transcript === true && proof.grounding_receipt?.session_id === sid &&
    typeof proof.grounding_receipt?.input_id === 'string');
}
