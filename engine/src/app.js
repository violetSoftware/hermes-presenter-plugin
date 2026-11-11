import Reveal from 'reveal.js';
import RevealNotes from 'reveal.js/plugin/notes/notes.esm.js';
import 'reveal.js/dist/reset.css';
import 'reveal.js/dist/reveal.css';
import { loadTheme } from './core/theme.js';
import { loadDeck, loadManifest, selectDeckId } from './core/deck-loader.js';
import { renderDeck } from './core/renderer.js';
import { revealConfig } from './core/reveal-config.js';
import { mountNavigation } from './core/navigation.js';

export async function start() {
  try {
    const manifest = await loadManifest();
    const id = selectDeckId(window.location, manifest);
    const deck = await loadDeck(id, manifest);
    await loadTheme(deck.theme);
    document.title = deck.title;
    document.documentElement.lang = deck.language;
    renderDeck(deck, document.querySelector('.reveal .slides'));
    const reveal = new Reveal(
      document.querySelector('.reveal'),
      revealConfig(deck.reveal),
    );
    window.Reveal = reveal;
    await reveal.initialize({ plugins: [RevealNotes] });
    mountNavigation(reveal);
    if (new URLSearchParams(window.location.search).get('presenter') === '1') {
      const { mountPresenter } = await import('./presenter/controller.js');
      mountPresenter({ deckId: id, reveal, guided: new URLSearchParams(window.location.search).get('guided') === '1', running: new URLSearchParams(window.location.search).get('running') === '1' });
    }
    return reveal;
  } catch (error) {
    console.error(error);
    const app = document.querySelector('#app');
    app.innerHTML = '';
    const panel = document.createElement('section');
    panel.className = 'error-panel';
    panel.setAttribute('role', 'alert');
    const heading = document.createElement('h1');
    heading.textContent = 'Presentation unavailable';
    const detail = document.createElement('p');
    detail.textContent = error.message;
    panel.append(heading, detail);
    app.append(panel);
    return null;
  }
}

start();
