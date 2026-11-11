import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'undici';
import { elevenAdapter } from './eleven.mjs';
import { logFailure, providerFailure, closeFailure, diagnosedErrors } from './eleven-diagnostics.mjs';
import { presenterPython, presenterPythonArgs } from '../presenter-python.mjs';

const endpoint = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=manual&include_timestamps=false';

/** Existing undici (not native global WebSocket) supports server authentication headers.
 * URL injection exists solely for loopback protocol tests; production caller fixes endpoint.
 */
export function connectSocket({ key, signal, url = endpoint, requireSession = true }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('transcription cancelled')); return; }
    let socket, stage = 'connecting', diagnosed = false;
    function failure(details, text = 'transcription connection failed') {
      const error = Error(text);
      if (!diagnosed && !signal?.aborted) { logFailure(stage, details); diagnosed = true; }
      diagnosedErrors.add(error);
      return error;
    }
    try { socket = new WebSocket(url, { headers: { 'xi-api-key': key } }); }
    catch { reject(failure({ category: 'socket_error' }, 'transcription socket unavailable')); return; }
    const timer = setTimeout(() => fail({ category: 'connection_timeout' }), 5000);
    function cleanup() { clearTimeout(timer); socket.removeEventListener('open', opened); socket.removeEventListener('message', message); socket.removeEventListener('error', socketError); socket.removeEventListener('close', closed); }
    function fail(details = { category: 'connection_failure' }) { cleanup(); signal?.removeEventListener('abort', abort); socket.close(); reject(failure(details)); }
    function socketError() { fail({ category: 'socket_error' }); }
    function closed(event) { fail(closeFailure(event)); }
    function abort() { socket.close(); fail(); }
    function ready() { cleanup(); socket.addEventListener('close', () => signal?.removeEventListener('abort', abort), { once: true }); resolve(socket); }
    function opened() { stage = 'awaiting_session'; if (!requireSession) ready(); }
    function message(event) {
      try {
        if (typeof event.data !== 'string' || event.data.length > 16000) throw Error();
        const value = JSON.parse(event.data);
        if (value?.message_type !== 'session_started') { fail(providerFailure(value)); return; }
        ready();
      } catch { fail({ category: 'malformed_provider_message' }); }
    }
    signal?.addEventListener('abort', abort, { once: true });
    socket.addEventListener('open', opened); socket.addEventListener('message', message);
    socket.addEventListener('error', socketError); socket.addEventListener('close', closed);
  });
}

async function configuredKey() {
  try {
    const { stdout } = await promisify(execFile)(presenterPython, presenterPythonArgs('transcription-key'), { maxBuffer: 16000, timeout: 5000 });
    return JSON.parse(stdout);
  } catch { return {}; }
}

export async function configuredElevenTranscription(env = process.env, { credentials = configuredKey, connect = connectSocket, performance = false } = {}) {
  if (env.PRESENTER_TRANSCRIPTION_PROVIDER !== 'elevenlabs') return undefined;
  const { key } = await credentials();
  if (typeof key !== 'string' || !key) return undefined;
  // Legacy smoke retains one attempt. Attended performance opens a fresh segment
  // only after browser consent; no automatic reconnect/retry after STT failure.
  return elevenAdapter({ connect: options => connect({ ...options, key }), performance });
}
