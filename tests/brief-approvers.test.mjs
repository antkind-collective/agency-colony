import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { approverRecipients, shortDate } = require('../netlify/functions/lib/brief-approvers.js');

const ga = [
  { full_name: 'Nina Marsh', partner_role: 'submitter' },
  { full_name: 'Mira Holt', partner_role: 'coordinator' },
  { full_name: 'Grace Moss', partner_role: 'coordinator' }
];

test('a date change goes to the approvers named on the brief', () => {
  assert.deepEqual(approverRecipients('Nina', ga).map(p => p.full_name), ['Nina Marsh']);
  assert.deepEqual(approverRecipients('Nina, Mira', ga).map(p => p.full_name), ['Nina Marsh', 'Mira Holt']);
  assert.deepEqual(approverRecipients('Mira Holt', ga).map(p => p.full_name), ['Mira Holt']);
});

test('no approver, or one nobody can match, goes to the coordinators', () => {
  assert.deepEqual(approverRecipients('', ga).map(p => p.full_name), ['Mira Holt', 'Grace Moss']);
  assert.deepEqual(approverRecipients('Someone Else', ga).map(p => p.full_name), ['Mira Holt', 'Grace Moss']);
});

test('dates read as calendar days', () => {
  assert.equal(shortDate('2026-10-21'), '21 Oct');
});
