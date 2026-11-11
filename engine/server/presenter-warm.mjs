import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { presenterPython, presenterPythonArgs } from './presenter-python.mjs';
import { nativeFailure } from './presenter-native-diagnostics.mjs';
import { validateNativePayload } from './presenter-grounding.mjs';
import { validateExistingPayload } from './presenter-existing-contract.mjs';

/** One warm bootstrap/transport per presenter connection; no native history cache. */
export function warmNative({ spawnImpl = spawn, timeoutMs = 90000, maxFrameBytes = 32000, sessionRef, onAdmission,
  python = presenterPython, args = presenterPythonArgs(sessionRef ? 'existing' : 'native-warm') } = {}) {
  const child = spawnImpl(python, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    ...(sessionRef ? { env: { ...process.env, PRESENTER_SESSION_REF: sessionRef } } : {}) });
  let closed = false, buffer = '', pending, resolveReady, rejectReady, closing, operatorCancelled = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const exit = new Promise(resolve => child.once('close', resolve));
  const fail = () => {
    closed = true; rejectReady(Error('warm inference unavailable'));
    const error = Error('warm inference unavailable');
    if (sessionRef) {
      error.nativeFailure = { version: 1, stage: 'generation', reason: operatorCancelled && pending?.recovery ? 'cancelled' : 'submission-uncertain' };
      error.nativeAdmission = pending?.admission;
      if (operatorCancelled && pending?.recovery) error.nativeRecovery = pending.recovery;
    }
    pending?.reject(error); pending = undefined;
  };
  child.on('error', fail); child.on('close', fail);
  child.stdin.on('error', fail);
  let stderrSize = 0;
  child.stderr.on('data', chunk => { stderrSize += chunk.length; if (stderrSize > 16000) { fail(); child.kill(); } });
  child.stdout.setEncoding('utf8'); // Preserve code points split across pipe chunks.
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > maxFrameBytes) { fail(); child.kill(); return; }
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.ready === true && Object.keys(frame).length === 1) { resolveReady(); continue; }
        if (!pending || frame.id !== pending.id) throw Error();
        if (sessionRef && frame.admission) { pending.admission = frame.admission; onAdmission?.(frame.admission); continue; }
        if (sessionRef && frame.recovery) {
          const r = frame.recovery, a = pending.admission;
          if (!closing || !operatorCancelled || r.session_id !== sessionRef.split('/')[1] || !a?.admission_id ||
              r.admission_id !== a.admission_id || r.input_id !== a.input_id || !Number.isSafeInteger(r.execution_generation) ||
              r.interrupted_owned !== true || r.idle !== true) throw Error();
          pending.recovery = r; continue;
        }
        const work = pending; pending = undefined;
        if (frame.result && !frame.nativeFailure) work.resolve(frame.result);
        else {
          const error = Error('restricted inference unavailable');
          const diagnostic = nativeFailure(frame.nativeFailure); if (diagnostic) error.nativeFailure = diagnostic;
          if (sessionRef && diagnostic) error.nativeAdmission = { input_id: frame.nativeFailure.input_id, admission_id: frame.nativeFailure.admission_id };
          work.reject(error);
        }
      } catch { fail(); child.kill(); }
    }
  });
  const preparation = setTimeout(() => { fail(); child.kill(); }, timeoutMs); preparation.unref();
  ready.finally(() => clearTimeout(preparation)).catch(() => {});
  function close(cancelled = false) {
    if (closing) return closing;
    cancelled ||= !!pending;
    closing = (async () => {
      if (!closed) { closed = true; if (cancelled) { child.stdin.end(); child.kill('SIGTERM'); }
        else child.stdin.end(JSON.stringify({ op: 'close' }) + '\n'); }
      const kill = setTimeout(() => child.kill('SIGKILL'), 1000); kill.unref();
      // Existing work settles only after bounded cleanup evidence; never infer recovery from a signal.
      if (!sessionRef) fail();
      try { await exit; } finally { clearTimeout(kill); fail(); }
    })();
    return closing;
  }
  return {
    ready: () => ready,
    async generate(payload, signal) {
      if (closed || pending) throw Error('warm inference busy or closed');
      (sessionRef ? validateExistingPayload : validateNativePayload)(payload);
      await ready;
      if (closed || pending) throw Error('warm inference busy or closed');
      signal?.throwIfAborted();
      const id = randomUUID();
      const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
      const cancel = () => { operatorCancelled = signal?.aborted === true && signal.reason?.name !== 'TimeoutError'; void close(true); };
      bounded.addEventListener('abort', cancel, { once: true });
      try {
        return await new Promise((resolve, reject) => {
          pending = { id, resolve, reject };
          child.stdin.write(JSON.stringify({ op: 'generate', id, payload }) + '\n');
        });
      } finally { bounded.removeEventListener('abort', cancel); }
    },
    close,
  };
}
