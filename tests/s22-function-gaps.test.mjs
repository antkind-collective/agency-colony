// Audit S22 (4 Nov 2026): three small gaps in that week's new functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const read = (f) => readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), 'utf8');

test('finance-gate claims a try and a send against the count it read', () => {
  const src = read('finance-gate.js');
  assert.match(src, /update\(\{ attempts: n \+ 1 \}\)[\s\S]{0,120}\.eq\('attempts', n\)\.select/);
  assert.match(src, /\.eq\('sends', Number\(row\.sends \|\| 0\)\)/);
  assert.doesNotMatch(src, /attempts: Number\(row\.attempts \|\| 0\) \+ 1/, 'the old read-then-write bump is gone');
  assert.doesNotMatch(src, /\.upsert\(/, 'no blind upsert on send');
});

test('ooo-notify emails once per entry and does not return the address', () => {
  const src = read('ooo-notify.js');
  assert.match(src, /from\('notification_log'\)[\s\S]{0,120}\.eq\('kind', 'out_of_office'\)\.eq\('payload->>out_of_office_id', row\.id\)/);
  assert.ok(src.indexOf("from('notification_log')") < src.indexOf('await sendEmail('), 'the check runs before sending');
  assert.doesNotMatch(src, /json\(200, \{[^}]*\bto\b/);
});

test('payslip-notify escapes the name in the email HTML', () => {
  const src = read('payslip-notify.js');
  assert.match(src, /<p>Hi \$\{escapeHtml\(firstName\)\},<\/p>/);
});
