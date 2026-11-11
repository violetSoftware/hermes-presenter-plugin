import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Schema is shipped with the declared engine; selection never comes from HTTP.
export function selectDeck(path, { engineRoot = resolve(new URL('../../', import.meta.url).pathname) } = {}) {
  const Ajv = createRequire(join(engineRoot, 'package.json'))('ajv');
  const schema = JSON.parse(readFileSync(join(engineRoot, 'src/schema/deck.schema.json')));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const read = (file, limit) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('Invalid selected deck or asset');
    return readFileSync(file);
  };
  path = resolve(path);
  const bytes = read(path, 64000), deck = JSON.parse(bytes);
  if (!validate(deck) || deck.slides.length > 16) throw Error('Selected JSON must satisfy the bounded deck schema (1–16 slides)');
  const root = realpathSync(dirname(path));
  const files = new Map([[`/presentations/${deck.id}/deck.json`, bytes]]);
  for (const slide of deck.slides) for (const key of ['image', 'backgroundImage']) {
    const asset = slide.data[key];
    if (!asset) continue;
    if (!/^assets\/[A-Za-z0-9_.-]+\.(png|jpe?g|webp|gif)$/i.test(asset)) throw Error('Only local raster assets are shareable');
    if (lstatSync(join(root, 'assets')).isSymbolicLink()) throw Error('Asset directory symlink refused');
    const file = join(root, asset);
    if (!realpathSync(file).startsWith(root + '/assets/')) throw Error('Asset escapes deck');
    files.set(`/presentations/${deck.id}/${asset}`, read(file, 256000));
  }
  const manifest = { defaultDeck: deck.id, decks: [{ id: deck.id }] };
  return { deck, bytes, files, manifest, digest: createHash('sha256').update(bytes).digest('hex') };
}
