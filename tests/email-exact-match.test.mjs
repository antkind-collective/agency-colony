// Audit 14 Oct 2026: an email is matched exactly, never with ilike, where `_`
// and `%` are wildcards (a_b@youragency.com would match axb@youragency.com).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const f of ['setup-approval-notify.js', 'joiner-slack.js']) {
  test(`${f}: emails matched exactly, not with ilike`, () => {
    const src = readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\.ilike\(\s*'(work_)?email'/);
  });
}
