// A click that fails must say so on screen (29 Oct 2026). Kira's
// reimbursement "just didn't upload": the files were gone by the time the
// code read them, and nothing was shown. The sweep after it found nine saves
// that returned with only a console.error and ~55 buttons whose unexpected
// errors went to the console alone. Buttons now use actionFailed(e) and
// refused saves use notSaved(what, error), both in js/modal.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const files = ['app.js', ...readdirSync('js').filter((f) => f.endsWith('.js')).map((f) => `js/${f}`)];
const sources = files.map((f) => ({ f, lines: readFileSync(f, 'utf8').split('\n') }));

test('event listeners never send failures only to the console', () => {
  const bad = [];
  for (const { f, lines } of sources) {
    lines.forEach((l, i) => {
      if (/addEventListener\(/.test(l) && /\.catch\(console\.(error|warn)\)/.test(l)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], 'use .catch(actionFailed) on a click/change handler');
});

test('a refused save is shown, not only logged', () => {
  const bad = [];
  for (const { f, lines } of sources) {
    lines.forEach((l, i) => {
      if (!/\.(update|insert|delete|upsert)\(/.test(l)) return;
      for (let j = i; j <= i + 3 && j < lines.length; j += 1) {
        if (/\{\s*console\.(error|warn)\([^;]*\);\s*return;?\s*\}/.test(lines[j])) { bad.push(`${f}:${j + 1}`); break; }
      }
    });
  }
  assert.deepEqual(bad, [], 'use notSaved(what, error) where a write can be refused');
});

test('picked files are copied before anything awaits', () => {
  // A live FileList is emptied when its input is cleared; pass a copy.
  const app = readFileSync('app.js', 'utf8');
  assert.doesNotMatch(app, /uploadPayFiles\(e\.target\.files\b/);
  assert.match(app, /async function uploadPayFiles\(fileList[^)]*\) \{[\s\S]{0,400}const files = \[\.\.\.fileList\]/);
});
