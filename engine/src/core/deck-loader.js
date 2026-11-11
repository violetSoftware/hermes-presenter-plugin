import { DeckError } from './errors.js';
import { validateDeck, validateManifest } from './schema-validation.js';
import { appUrl, presentationUrl } from './urls.js';

async function jsonResponse(fetcher, url, label) {
  let response;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new DeckError(`Could not load ${label}: ${error.message}`, error);
  }

  if (!response.ok) {
    throw new DeckError(
      `Could not load ${label}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new DeckError(`${label} did not contain valid JSON`, error);
  }
}

export async function loadManifest(fetcher = fetch, options = {}) {
  const manifest = await jsonResponse(
    fetcher,
    appUrl('presentations/manifest.json', options),
    'presentation manifest',
  );
  return validateManifest(manifest);
}

export function selectDeckId(location, manifest) {
  const requested =
    new URLSearchParams(location.search || '').get('deck') || manifest.defaultDeck;
  if (!manifest.decks.some((entry) => entry.id === requested)) {
    throw new DeckError(`Deck "${requested}" is not registered`);
  }
  return requested;
}

export async function loadDeck(id, manifest, fetcher = fetch, options = {}) {
  if (!manifest.decks.some((item) => item.id === id)) {
    throw new DeckError(`Deck "${id}" is not registered`);
  }
  const deck = await jsonResponse(
    fetcher,
    presentationUrl(id, 'deck.json', options),
    `deck "${id}"`,
  );
  return validateDeck(deck, id);
}
