// Every colour token the app reads must exist (3 Nov 2026). Charts read
// --text-secondary, which was never defined, so they fell back to a pale
// night-mode grey and their axes vanished in day mode (Maya). A missing
// token fails silently in the browser; it fails here instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('styles.css');
const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const files = ['styles.css', 'app.js', 'index.html', ...readdirSync(new URL('../js/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`)];

test('every CSS custom property used is defined in styles.css', () => {
  const missing = [];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/var\(\s*(--[\w-]+)|getPropertyValue\(\s*['"](--[\w-]+)/g)) {
      const name = m[1] || m[2];
      if (!defined.has(name) && !src.includes(`${name}:`) && !src.includes(`'${name}',`)) missing.push(`${f}: ${name}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('chart colours come from theme tokens, not one theme\'s literals', () => {
  const app = read('app.js');
  const fn = app.slice(app.indexOf('function getChartThemeColors'), app.indexOf('\n}\n', app.indexOf('function getChartThemeColors')));
  assert.match(fn, /--text-rgb/);
  assert.doesNotMatch(fn, /rgba\(255, 255, 255/);
  assert.doesNotMatch(fn, /--text-secondary/);
});
