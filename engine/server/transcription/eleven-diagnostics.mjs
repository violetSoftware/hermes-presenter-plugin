// Never copy arbitrary provider strings into diagnostics, even if they look like tokens.
const providerErrors = new Set([
  'error', 'auth_error', 'quota_exceeded', 'transcriber_error', 'input_error',
  'commit_throttled', 'unaccepted_terms', 'rate_limited', 'queue_overflow',
  'resource_exhausted', 'session_time_limit_exceeded', 'chunk_size_exceeded',
  'insufficient_audio_activity',
]);
const messageTypes = new Set([
  ...providerErrors, 'session_started', 'partial_transcript', 'committed_transcript',
  'committed_transcript_with_timestamps',
]);
// Keep connector rejection generic while preventing a second adapter diagnostic.
export const diagnosedErrors = new WeakSet();
export function closeFailure(event) {
  return {
    category: 'socket_closed',
    code: Number.isInteger(event?.code) && event.code >= 0 && event.code <= 4999 ? event.code : null,
    wasClean: typeof event?.wasClean === 'boolean' ? event.wasClean : null,
  };
}
export function providerFailure(value) {
  const type = value?.message_type;
  return {
    category: providerErrors.has(type) ? 'provider_error' : 'unexpected_provider_message',
    message_type: messageTypes.has(type) ? type : 'unknown',
  };
}
export function logFailure(stage, details) {
  console.warn('[eleven-stt] failure', { stage, ...details });
}
