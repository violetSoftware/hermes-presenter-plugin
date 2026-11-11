import Ajv from 'ajv';
import deckSchema from '../schema/deck.schema.json';
import manifestSchema from '../schema/manifest.schema.json';
import { DeckError } from './errors.js';

const ajv = new Ajv({ allErrors: true });
const validateDeckSchema = ajv.compile(deckSchema);
const validateManifestSchema = ajv.compile(manifestSchema);

function formatErrors(label, errors) {
  const detail = errors
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  return `${label} failed schema validation: ${detail}`;
}

export function validateManifest(manifest) {
  if (!validateManifestSchema(manifest)) {
    throw new DeckError(formatErrors('Presentation manifest', validateManifestSchema.errors));
  }

  const seen = new Set();
  for (const { id } of manifest.decks) {
    if (seen.has(id)) {
      throw new DeckError(`Presentation manifest has duplicate deck ID "${id}"`);
    }
    seen.add(id);
  }

  if (!seen.has(manifest.defaultDeck)) {
    throw new DeckError(
      'Presentation manifest defaultDeck must reference a registered deck',
    );
  }

  return manifest;
}

export function validateDeck(deck, expectedId) {
  if (!validateDeckSchema(deck)) {
    throw new DeckError(
      formatErrors(`Deck "${expectedId}"`, validateDeckSchema.errors),
    );
  }
  if (deck.id !== expectedId) {
    throw new DeckError(`Deck "${expectedId}" has a mismatched id`);
  }
  return deck;
}
