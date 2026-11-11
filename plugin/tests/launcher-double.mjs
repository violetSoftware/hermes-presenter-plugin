// Only test entrypoint: real launcher/HTTP/build, no native or paid provider.
import { launch } from '../runtime/launcher.mjs';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const config = JSON.parse(raw);
const service = await launch(config, {
  warmFactory: () => ({ ready: async () => {}, generate: async () => { throw Error('Test forbids inference'); }, close: async () => {} }),
  synthesize: async () => { throw Error('Test forbids paid synthesis'); },
});
process.stdout.write(JSON.stringify({ ready: true, url: service.url }) + '\n');
process.once('SIGTERM', () => { void service.stop().then(() => process.exit(0)); });
