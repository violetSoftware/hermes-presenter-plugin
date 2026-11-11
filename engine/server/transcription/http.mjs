import { randomUUID } from 'node:crypto';

export function cancelTranscription(entry) {
  const turn = entry.transcription;
  if (turn) { entry.transcription = null; turn.abort.abort(); turn.channel?.cancel(); }
}

/** Already authenticated by presenter HTTP cookie + exact Host/Origin checks. */
export async function transcriptionRequest(entry, route, body, adapter, req, res) {
  const session = entry.session;
  const sameConnection = body.connectionId === entry.connectionId && body.sessionId === session.id;
  if (!sameConnection || !session.connected || session.floor !== 'human' || session.phase !== 'paused' || session.active) {
    return { status: 409, body: { error: 'stale transcription owner or floor' } };
  }
  if (adapter?.plannedHumanOnly && (!session.hasRunningOrder() || session.segment()?.role !== 'human' || session.segment().slideId !== session.grounding.currentSlide.id)) {
    return { status: 409, body: { error: 'microphone requires planned human segment' } };
  }
  if (!adapter?.available) return { status: 503, body: { error: 'transcription unavailable; use typed question' } };
  let turn = entry.transcription;
  if (route === 'open') {
    if (turn || typeof body.turnId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.turnId)) {
      return { status: 409, body: { error: 'turn already active or invalid' } };
    }
    turn = { identity: { sessionId: session.id, turnId: body.turnId }, epoch: session.epoch,
      connectionId: entry.connectionId, abort: new AbortController(), events: [], bytes: 0, busy: false };
    entry.transcription = turn;
  }
  if (route === 'cancel' && turn?.identity.turnId === body.turnId) {
    cancelTranscription(entry); return { status: 200, body: {} };
  }
  if (!turn || turn.identity.turnId !== body.turnId || turn.busy || turn.finishing) return { status: 409, body: { error: 'stale or busy turn' } };
  if (adapter.reviewRequired && (turn.requests = (turn.requests || 0) + 1) > 1024) {
    cancelTranscription(entry); return { status: 409, body: { error: 'transcription request limit; paused' } };
  }
  const owns = () => entry.transcription === turn && !turn.abort.signal.aborted &&
    session.epoch === turn.epoch && entry.connectionId === turn.connectionId && session.connected && session.floor === 'human';
  const cancel = () => { if (entry.transcription === turn) cancelTranscription(entry); };
  const disconnected = () => { if (!res.writableEnded) cancel(); };
  req.once('aborted', cancel); res.once('close', disconnected);
  turn.busy = true;
  try {
    if (route === 'open') {
      turn.channel = await adapter.open({ identity: turn.identity, signal: turn.abort.signal, onEvent: event => {
        if (!owns()) throw Error('obsolete event');
        if (typeof event.text !== 'string' || turn.events.length >= 128 || event.text.length > (adapter.maxTranscriptChars || 1000) ||
            (event.type === 'final' && (turn.bytes += event.text.length) > (adapter.maxTranscriptChars || 1000))) throw Error('transcript limit');
        turn.events.push(event);
      } });
    } else if (route === 'write') {
      await turn.channel.write({ ...body, ...turn.identity });
    } else if (route === 'poll') {
      if (!adapter.reviewRequired && !adapter.streaming) throw Error('poll unavailable');
    } else if (route === 'review') {
      if (!adapter.reviewRequired) throw Error('review unavailable');
      turn.finishing = true;
      turn.candidate = await turn.channel.reviewCandidate(turn.identity);
    } else if (route === 'finish') {
      if (adapter.reviewRequired) throw Error('human review required');
      turn.finishing = true;
      turn.ack = await turn.channel.finish(turn.identity);
    } else if (route === 'cancel') {
      cancel(); return { status: 200, body: {} };
    } else throw Error('unknown transcription operation');
    if (!owns()) throw Error('obsolete transcription');
    const result = { events: turn.events.splice(0), ...(turn.ack ? { ack: turn.ack } : {}), ...(turn.candidate ? { candidate: turn.candidate } : {}) };
    if (route === 'finish' || route === 'review') { entry.transcription = null; turn.abort.abort(); }
    return { status: 200, body: result };
  } catch {
    cancel();
    return { status: 409, body: { error: 'transcription failed; paused' } };
  } finally {
    turn.busy = false; req.off('aborted', cancel); res.off('close', disconnected);
  }
}

export const newConnectionId = () => randomUUID();
