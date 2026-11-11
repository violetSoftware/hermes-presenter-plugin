// Real browser screenshot + computed colors, no live inference or microphone.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const require = createRequire(join(root, 'engine/package.json'));
const { chromium } = require('@playwright/test');
const { launch } = await import('../plugin/runtime/launcher.mjs');
const browser = await chromium.launch({ headless: true });
const evidence = [];
try {
  for (const deck of ['sample']) {
    const directory = mkdtempSync(join(tmpdir(), 'purple-visual-'));
    const service = await launch({ engineRoot: join(root, 'engine'), directory, deckPath: join(root, 'plugin', deck, 'deck.json'), port: 0, profile: 'fixture', sessionId: 'fixture-caller', microphone: false }, {
      warmFactory: () => ({ ready: async () => {}, generate: async () => { throw Error('Inference forbidden'); }, close: async () => {} }), synthesize: async () => { throw Error('Synthesis forbidden'); },
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(service.url);
      await page.waitForFunction(() => window.Reveal?.isReady());
      const values = await page.evaluate(() => ({ background: getComputedStyle(document.querySelector('.reveal')).backgroundColor,
        font: getComputedStyle(document.querySelector('.reveal')).fontFamily,
        heading: getComputedStyle(document.querySelector('h1')).color,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--stage-accent').trim(),
        slides: document.querySelectorAll('.reveal .slides > section').length,
        title: document.title, text: document.querySelector('.reveal .slides').textContent,
        resources: performance.getEntriesByType('resource').map(r => r.name) }));
      assert.equal(values.background, 'rgb(30, 18, 51)');
      assert.equal(values.accent, '#c4b5fd');
      assert.equal(values.heading, 'rgb(250, 245, 255)');
      assert.match(values.font, /system-ui/);
      assert.equal(values.slides, 1);
      assert.ok(values.resources.every(url => !/woff/i.test(url)));
      const panel = page.locator('#presenter-panel');
      const disconnect = panel.getByRole('button', { name: 'disconnect', exact: true });
      const initial = await disconnect.evaluate(button => {
        const row = button.getBoundingClientRect(), panel = button.closest('#presenter-panel').getBoundingClientRect();
        return { rowBottom: row.bottom, panelBottom: panel.bottom };
      });
      assert.ok(initial.rowBottom <= initial.panelBottom - 3, 'last operator row must fit the initial 1440x900 purple view');
      await disconnect.scrollIntoViewIfNeeded();
      const reachability = await disconnect.evaluate(button => {
        const row = button.getBoundingClientRect();
        return { visible: document.elementFromPoint(row.x + row.width / 2, row.bottom - 2) === button,
          scrollTop: button.closest('#presenter-panel').scrollTop };
      });
      assert.equal(reachability.visible, true, 'last row is not clipped or covered after scrolling');
      await disconnect.click(); // Disconnected fixture: no native/provider operation.
      const stop = await page.getByRole('button', { name: 'emergency stop', exact: true }).boundingBox();
      assert.ok(stop && stop.y + stop.height <= 900);
      await page.screenshot({ path: join(output, deck + '-purple.png'), fullPage: true });
      evidence.push({ deck, ...values, operator: { initial, reachability, stop } });
      await page.close();
    } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
  }
} finally { await browser.close(); }
writeFileSync(join(output, 'purple-visual.json'), JSON.stringify(evidence, null, 2));
console.log('VERIFIED purple sample in Chromium; screenshots and computed-style evidence: ' + output);
