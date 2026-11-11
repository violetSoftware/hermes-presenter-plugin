import { spawn } from 'node:child_process';
import { presenterPython, presenterPythonArgs } from './presenter-python.mjs';
import { nativeStderrFailure } from './presenter-native-diagnostics.mjs';
import { validateNativePayload } from './presenter-grounding.mjs';

async function nativeRun(file, args, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '', errorSize = 0;
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 16000) child.kill(); });
    child.stderr.on('data', chunk => { errorSize += chunk.length; if (errorSize > 16000) child.kill(); else stderr += chunk; });
    child.on('error', () => reject(Error('restricted inference unavailable')));
    child.on('close', code => {
      if (code !== 0) {
        const error = Error('restricted inference unavailable');
        const diagnostic = errorSize <= 16000 ? nativeStderrFailure(stderr) : undefined;
        if (diagnostic) error.nativeFailure = diagnostic;
        return reject(error);
      }
      try { resolve(JSON.parse(output)); } catch { reject(Error('restricted inference unavailable')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

export function nativeGenerator({ run = nativeRun, onResult = () => {}, returnResult = false } = {}) {
  return async (payload, signal) => {
    validateNativePayload(payload);
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90000)]);
    const result = await run(presenterPython, presenterPythonArgs('native'), JSON.stringify(payload), bounded);
    if (typeof result.text !== 'string') throw Error('restricted inference failed');
    onResult(result);
    return returnResult ? result : result.text;
  };
}

/** Server-only adapters. No expression-rewrite pass, paid retries or browser credentials. */
export function elevenSpeech({ key, voice, fetchImpl = fetch }) {
  return async (text, signal) => {
    if (!key || !voice || !text.trim() || text.length > 240) throw Error('invalid speech input');
    const response = await fetchImpl('https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128', {
      method: 'POST', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90000)]),
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/*' },
      body: JSON.stringify({ model_id: 'eleven_v4', inputs: [{ text, voice_id: voice }] }),
    });
    if (!response.ok) throw Error(`speech HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.startsWith('audio/')) throw Error('speech invalid audio');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length; if (size > 16 * 1024 * 1024) throw Error('speech failed'); chunks.push(Buffer.from(chunk));
    }
    if (!size) throw Error('speech failed');
    return { bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') };
  };
}

// Deterministic generation and a local tone. NOT ElevenLabs speech or model performance evidence.
export function offlineProvider() {
  return {
    label: 'OFFLINE: deterministic text double + local test tone (not speech)',
    generate: async ({ mode, delivered }) => mode === 'answer' ? 'This is an offline answer fixture.' :
      `Offline sentence number ${delivered.length + 1} demonstrates playback confirmation.`,
    synthesize: async () => {
      const rate = 8000, samples = rate * 2, bytes = Buffer.alloc(44 + samples * 2);
      bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
      bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
      bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
      bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
      for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * 440 * Math.PI * 2) * 800), 44 + i * 2);
      return { bytes, contentType: 'audio/wav' };
    },
  };
}
