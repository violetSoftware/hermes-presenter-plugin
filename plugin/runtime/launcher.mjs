import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs';
import { selectDeck } from './deck.mjs';

export async function launch(config, { warmFactory, synthesize, transcription } = {}) {
  const root = resolve(config.engineRoot);
  const companion = JSON.parse(readFileSync(join(root, 'presenter-engine.json')));
  if (companion.name !== 'hermes-presenter-engine' || companion.version !== '0.1.0' || companion.protocol !== 1) throw Error('Matching companion engine 0.1.0 protocol 1 required');
  const engine = file => import(pathToFileURL(join(root, file)));
  const require = createRequire(join(root, 'package.json'));
  const { build } = await import(pathToFileURL(require.resolve('vite')));
  const { registerSelectedDeck } = await engine('server/presenter-grounding.mjs');
  const { createPresenterHandler } = await engine('server/presenter-http.mjs');
  const { attendedProvider } = await engine('server/presenter-approved-operations.mjs');
  const { warmNative } = await engine('server/presenter-warm.mjs');
  const selected = selectDeck(config.deckPath, { engineRoot: root });
  const publicDir = join(config.directory, 'selected');
  mkdirSync(join(publicDir, selected.deck.id, 'assets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(publicDir, 'manifest.json'), JSON.stringify(selected.manifest), { mode: 0o600 });
  for (const [url, bytes] of selected.files) writeFileSync(join(publicDir, url.slice('/presentations/'.length)), bytes, { mode: 0o600 });
  const snapshot = registerSelectedDeck(selected.deck.id, { root: publicDir, approvals: { [selected.deck.id]: selected.digest } });
  writeFileSync(join(config.directory, 'snapshot.json'), JSON.stringify(snapshot), { mode: 0o600 });
  process.env.PRESENTER_SNAPSHOT = join(config.directory, 'snapshot.json');
  const output = join(config.directory, 'browser');
  // Build ONLY application sources. Never copy the engine's public decks or serve Vite fs routes.
  await build({ root, configFile: false, publicDir: false, logLevel: 'silent', base: './', build: { outDir: output, emptyOutDir: true } });
  if (!synthesize) {
    const { elevenStream } = await engine('server/presenter-stream.mjs');
    synthesize = elevenStream({ ...config.credentials, speech: 'attended-passage-v1' });
  }
  if (config.microphone && !transcription) {
    const { configuredElevenTranscription } = await engine('server/transcription/eleven-socket.mjs');
    transcription = await configuredElevenTranscription({ PRESENTER_TRANSCRIPTION_PROVIDER: 'elevenlabs' }, { credentials: async () => config.credentials, performance: true });
  }
  const sessionRef = `@session:${config.profile}/${config.sessionId}`;
  const provider = attendedProvider({ enabled: true, sessionRef, synthesize,
    warmFactory: warmFactory || (({ onAdmission } = {}) => warmNative({ sessionRef, onAdmission, maxFrameBytes: 228000,
      python: config.python, args: ['-B', fileURLToPath(new URL('existing.py', import.meta.url))] })),
    persist: record => appendFileSync(join(config.directory, 'events.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 }) });
  let origin = config.baseUrl;
  const api = createPresenterHandler(provider, { transcription, allowedOrigin: origin || undefined });
  const mime = file => ({ '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' }[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream');
  const server = createServer((req, res) => {
    if (req.url.startsWith('/presenter-api/')) return void api(req, res);
    const url = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    let bytes, type;
    if (url === '/presentations/manifest.json') { bytes = Buffer.from(JSON.stringify(selected.manifest)); type = 'application/json'; }
    else if (selected.files.has(url)) { bytes = selected.files.get(url); type = mime(url); }
    else if (url === '/') { bytes = readFileSync(join(output, 'index.html')); type = 'text/html'; }
    else if (/^\/assets\/[A-Za-z0-9_.-]+$/.test(url)) {
      try { const file = realpathSync(join(output, url)); if (!file.startsWith(output + '/assets/')) throw Error(); bytes = readFileSync(file); type = mime(file); } catch { /* 404 */ }
    }
    if (!bytes) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': type }); res.end(bytes);
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(config.port, '127.0.0.1', ok); });
  const address = server.address();
  origin ||= `http://127.0.0.1:${address.port}`;
  let stopping;
  return { url: `${origin}/?deck=${selected.deck.id}&presenter=1${snapshot.runningOrder ? '&running=1' : ''}`,
    stop: () => stopping ||= (async () => { await api.close(); await provider.close(); await transcription?.close?.(); server.closeIdleConnections(); await new Promise(ok => server.close(ok)); })() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const service = await launch(JSON.parse(raw));
    process.stdout.write(JSON.stringify({ ready: true, url: service.url }) + '\n');
    const stop = () => { void service.stop().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch { process.stderr.write('Presenter startup refused; check engine dependencies and selected deck.\n'); process.exitCode = 1; }
}
