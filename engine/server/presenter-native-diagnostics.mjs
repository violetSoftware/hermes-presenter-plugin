/** Fixed vocabulary only. Never copy exception messages, RPC data or raw stderr into evidence. */
const stages = new Set(['runtime', 'payload', 'gateway.discovery', 'gateway.connect', 'credential',
  'runtime.describe', 'session.create', 'session.info', 'policy.readback', 'prompt.submit',
  'generation', 'prompt.receipt', 'policy.after', 'session.detach', 'session.resume']);
const reasons = new Set(['operation-failed', 'timeout', 'cancelled', 'permission-denied', 'invalid-params',
  'unsupported-policy', 'policy-mismatch', 'transport-disconnected', 'authority-event', 'incomplete',
  'invalid-result', 'authority-result', 'invalid-text', 'submission-uncertain', 'busy-or-unknown']);
export function nativeFailure(value) {
  if (!value || value.version !== 1 || !stages.has(value.stage) || !reasons.has(value.reason)) return undefined;
  return { version: 1, stage: value.stage, reason: value.reason };
}
export function nativeStderrFailure(stderr) {
  // Child stdout/stderr are bounded separately; only the last nonempty line is a diagnostic frame.
  try { return nativeFailure(JSON.parse(stderr.trim().split('\n').at(-1)).nativeFailure); }
  catch { return undefined; }
}
