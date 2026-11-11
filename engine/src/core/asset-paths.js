import { presentationUrl } from './urls.js';

const SPECIAL = [
  ['https://', 'allowRemote'],
  ['http://', 'allowRemote'],
  ['data:', 'allowData'],
  ['#', 'allowFragment'],
];

export function resolveAssetPath(deckId, value, options = {}) {
  if (typeof value !== 'string' || !value) {
    throw new Error('Asset path must be a non-empty string');
  }
  for (const [prefix, permission] of SPECIAL) {
    if (value.startsWith(prefix)) {
      if (!options[permission]) throw new Error(`${prefix} URLs are not allowed`);
      return value;
    }
  }

  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error('Asset path must be a safe relative path');
  }
  if (
    value.startsWith('/') ||
    decoded.split('/').includes('..') ||
    decoded.includes('\\')
  ) {
    throw new Error('Asset path must be a safe relative path');
  }
  if (!/^[a-z0-9-]+$/.test(deckId)) throw new Error('Invalid deck ID');

  const encoded = value.split('/').map(encodeURIComponent).join('/');
  return presentationUrl(deckId, encoded, options);
}
