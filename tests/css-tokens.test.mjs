// Every CSS custom property the app reads must be declared in styles.css.
// A var(--x) with no declaration is invalid at computed-value time, so the
// whole declaration silently drops: borders vanish, radii go square, grey
// text comes out full black. A fallback — var(--x, #hex) — hides the gap
// and bakes in a colour that ignores the theme. Both happened (Sep 2026:
// ~30 undefined names, and an offboarding modal hard-coded to dark navy
// that was unreadable in light mode). New colours and sizes go in the
// :root / [data-theme="dark"] blocks at the top of styles.css, then get
// referenced by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const css = read('styles.css');
const sources = {
  'styles.css': css,
  'index.html': read('index.html'),
  'app.js': read('app.js'),
};
for (const f of readdirSync(new URL('../js/', import.meta.url))) {
  if (f.endsWith('.js')) sources[`js/${f}`] = read(`js/${f}`);
}

const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

function uses() {
  const out = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ file, line, name: m[1], fallback: Boolean(m[2]) });
    }
  }
  return out;
}

test('every var(--name) is declared in styles.css', () => {
  const missing = uses().filter((u) => !declared.has(u.name));
  assert.deepEqual(
    missing.map((u) => `${u.file}:${u.line} ${u.name}`),
    [],
    'Undeclared CSS custom properties — declare them in the :root block of styles.css or use an existing token',
  );
});

test('the light and dark theme blocks exist', () => {
  assert.match(css, /:root\s*\{/);
  assert.match(css, /\[data-theme="dark"\]\s*\{/);
});
