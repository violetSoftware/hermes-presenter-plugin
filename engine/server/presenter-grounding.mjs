/** Server-only, byte-pinned presenter shareability. Registration alone grants nothing. */
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';

const ROOT = resolve(new URL('../public/presentations/', import.meta.url).pathname);
const schema = JSON.parse(readFileSync(new URL('../src/schema/deck.schema.json', import.meta.url)));
const manifestSchema = JSON.parse(readFileSync(new URL('../src/schema/manifest.schema.json', import.meta.url)));
const ajv = new Ajv({ allErrors: true });
const validateDeck = ajv.compile(schema), validateManifest = ajv.compile(manifestSchema);
export const APPROVED_DECKS = Object.freeze({});
const snapshots = new WeakSet();
const selections = new Map();
/** Trusted service bootstrap only. A server binds an exact selected snapshot, never a directory. */
export function registerSelectedDeck(id, options) {
  const snapshot = approvedDeck(id, options);
  if (selections.has(id)) throw Error('deck selection already bound');
  selections.set(id, snapshot);
  return snapshot;
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
function deepFreeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
function safeFile(root, parts, limit) {
  const base = realpathSync(root); let path = base;
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') throw Error('unsafe source path');
    path = join(path, part); if (lstatSync(path).isSymbolicLink()) throw Error('source symlink refused');
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit || !realpathSync(path).startsWith(base + '/')) throw Error('invalid or oversized source file');
  return readFileSync(path);
}
/** Options are trusted offline test dependencies, never an HTTP or runtime directory interface. */
export function approvedDeck(id, { root = ROOT, approvals = APPROVED_DECKS } = {}) {
  if (selections.size && root === ROOT && approvals === APPROVED_DECKS) {
    if (!selections.has(id)) throw Error('deck outside explicit selection');
    return selections.get(id);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id || '') || !Object.hasOwn(approvals, id)) throw Error('deck not presenter-approved');
  const manifest = JSON.parse(safeFile(root, ['manifest.json'], 16000));
  if (!validateManifest(manifest) || !manifest.decks.some(d => d.id === id)) throw Error('deck not registered');
  const bytes = safeFile(root, [id, 'deck.json'], 64000);
  if (hash(bytes) !== approvals[id]) throw Error('approved deck bytes changed');
  const deck = JSON.parse(bytes);
  if (!validateDeck(deck) || deck.id !== id || deck.slides.length > 16) throw Error('invalid bounded deck schema (1–16 slides)');
  const slides = deck.slides.map((slide, index) => {
    const data = slide.data, visibleText = [];
    for (const key of ['title', 'subtitle', 'text', 'name', 'email', 'phone']) if (data[key]) visibleText.push(data[key]);
    visibleText.push(slide.header?.presenter ?? deck.presenter, slide.header?.theme ?? deck.title,
      deck.date.split('-').reverse().join('.'), deck.website ?? 'example.org');
    const items = (rows, depth = 0) => { if (depth > 8) throw Error('nested content too deep'); for (const row of rows || []) { visibleText.push(row.text); items(row.items, depth + 1); } };
    items(data.items);
    const assets = [];
    for (const key of ['image', 'backgroundImage']) if (data[key]) {
      const path = data[key];
      if (!/^assets\/[a-zA-Z0-9_.-]+$/.test(path)) throw Error('unsafe asset path');
      safeFile(root, [id, ...path.split('/')], 256000);
      assets.push({ kind: key, description: key === 'image' && data.imageAlt ? data.imageAlt : 'Unseen image: no approved description.' });
    }
    const notes = slide.notes || '';
    if (visibleText.some(t => t.length > 2000) || notes.length > 2000) throw Error('slide content too large');
    return { id: `${id}:${index + 1}`, template: slide.template, visibleText, notes, assets };
  });
  if (deck.runningOrder && (new Set(deck.runningOrder.map(s => s.id)).size !== deck.runningOrder.length ||
      deck.runningOrder.some(s => !slides.some(slide => slide.id === s.slideId)))) throw Error('invalid running-order identity');
  const source = { deckId: id, sourceHash: hash(bytes), title: deck.title, slides,
    ...(deck.runningOrder ? { runningOrder: deck.runningOrder } : {}) };
  if (Buffer.byteLength(canonical(source), 'utf8') > 24000) throw Error('grounding too large');
  const snapshot = deepFreeze({ ...source, snapshotHash: hash(canonical(source)) });
  snapshots.add(snapshot); return snapshot;
}
export const ATTENDED_SPEECH = 'attended-passage-v1';
export function validateSpeech(text, speech) {
  if (speech !== undefined && speech !== ATTENDED_SPEECH) throw Error('unknown speech policy');
  if (typeof text !== 'string' || !text.trim() || (speech && text !== text.trim()) || text.length > (speech ? 2000 : 240) ||
      (speech ? /[\n\r\x00-\x1f]/u.test(text) || !/[.!?]$/u.test(text) : !/^[^.!?\n]+[.!?]$/u.test(text.trim()))) throw Error('invalid bounded speech');
  return text;
}
export function validateGroundedPayload(payload) {
  const attended = payload?.speech === ATTENDED_SPEECH;
  if (!payload || Object.keys(payload).sort().join(',') !== (attended ? 'delivered,grounding,mode,question,questions,speech' : 'delivered,grounding,mode,question,questions') || JSON.stringify(payload).length > (attended ? 32000 : 16000)) throw Error('invalid approved payload');
  const source = payload.grounding;
  if (!source || Object.keys(source).sort().join(',') !== (source.runningOrder ? 'currentSlide,deckId,runningOrder,slides,snapshotHash,sourceHash,title' : 'currentSlide,deckId,slides,snapshotHash,sourceHash,title')) throw Error('invalid source fields');
  const approved = groundingFor(approvedDeck(source.deckId), source.currentSlide?.index);
  if (canonical(source) !== canonical(approved)) throw Error('unapproved source payload');
  if (!['answer', 'narration'].includes(payload.mode) || (payload.mode === 'answer'
    ? typeof payload.question !== 'string' || !payload.question.trim() || payload.question.length > 1000 : payload.question !== null)) throw Error('invalid question');
  for (const [field, keys, limits] of [['delivered', ['kind', 'text'], { text: attended ? 2000 : 240 }], ['questions', ['answer', 'question'], { answer: attended ? 2000 : 240, question: 1000 }]]) {
    if (!Array.isArray(payload[field]) || payload[field].length > 4) throw Error('invalid recent contributions');
    for (const row of payload[field]) {
      if (!row || Object.keys(row).sort().join(',') !== keys.join(',') || Object.entries(limits).some(([key, cap]) => typeof row[key] !== 'string' || !row[key].length || row[key].length > cap)
          || (field === 'delivered' && !['answer', 'narration'].includes(row.kind))) throw Error('invalid contribution');
    }
  }
  return payload;
}
export function validateNativePayload(payload) {
  if (payload?.grounding) return validateGroundedPayload(payload);
  if (!payload || Object.keys(payload).sort().join(',') !== 'delivered,mode,question,questions' || JSON.stringify(payload).length > 16000) throw Error('invalid presentation context');
  return payload;
}
export function groundingFor(snapshot, index) {
  if (!snapshots.has(snapshot) || !Number.isSafeInteger(index) || index < 0 || index >= snapshot.slides.length) throw Error('invalid approved slide identity');
  return { ...structuredClone(snapshot), currentSlide: { index, id: snapshot.slides[index].id } };
}
