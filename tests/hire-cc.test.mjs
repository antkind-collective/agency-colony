// Alex is copied on every email a new hire receives (8 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hireEmailCc, DEFAULT_HIRE_EMAIL_CC } = require('../netlify/functions/lib/hire-cc.js');
const fake = (value) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value === undefined ? null : { value } }) }) }) }) });

test('hireEmailCc: Alex by default, app_config overrides, [] stops it', async () => {
  assert.deepEqual(DEFAULT_HIRE_EMAIL_CC, ['admin@youragency.com']);
  assert.deepEqual(await hireEmailCc(fake(undefined)), ['admin@youragency.com']);
  assert.deepEqual(await hireEmailCc(fake(['am-lead@youragency.com'])), ['am-lead@youragency.com']);
  assert.deepEqual(await hireEmailCc(fake([])), []);
});

test('every hire-facing email path copies Alex', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['hire-welcome', 'joiner-slack', 'workspace-provision', 'hire-notify']) {
    assert.match(readFileSync(new URL(`../netlify/functions/${f}.js`, import.meta.url), 'utf8'), /hireEmailCc/, f);
  }
});
