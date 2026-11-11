// Probation (3 Nov 2026): three months from the date of joining, and the
// hiring manager hears 15 days before it ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { probationEnd, probationDue, reminderKey, REMIND_DAYS } = require('../netlify/functions/lib/probation.js');

const row = (over) => ({ hire_id: 'h1', full_name: 'Dev Iyer', hire_type: 'full-time', stage: 'payroll_done', start_date: '2026-09-09', ...over });

test('probation is three months from joining, ending the day before', () => {
  assert.equal(probationEnd('2026-09-09'), '2026-12-08');
  assert.equal(probationEnd('2026-09-24'), '2026-12-23');
  assert.equal(probationEnd('2026-11-01'), '2027-01-31');
  assert.equal(probationEnd('2026-11-30'), '2027-02-28'); // short month clamps
  assert.equal(probationEnd('2027-01-01'), '2027-03-31');
});

test('reminds from 15 days before the end, not 16', () => {
  assert.equal(REMIND_DAYS, 15);
  assert.equal(probationDue([row()], '2026-11-23').length, 1);
  assert.equal(probationDue([row()], '2026-11-22').length, 0);
  assert.equal(probationDue([row()], '2026-12-08').length, 1);
  assert.equal(probationDue([row()], '2026-12-09').length, 0);
});

test('only signed full-time hires; once per hire and end date', () => {
  for (const hire_type of ['consultant', 'fractional']) assert.equal(probationDue([row({ hire_type })], '2026-11-30').length, 0);
  for (const stage of ['invited', 'details_submitted', 'contract_uploaded', 'reviewed', 'cancelled']) assert.equal(probationDue([row({ stage })], '2026-11-30').length, 0);
  assert.equal(probationDue([row({ stage: 'signed' })], '2026-11-30').length, 1);
  const sent = new Set([reminderKey('h1', '2026-12-08')]);
  assert.equal(probationDue([row()], '2026-11-30', sent).length, 0);
});

test('the kind it logs exists in a migration, and it is scheduled', () => {
  const src = readFileSync(new URL('../netlify/functions/probation-reminder.js', import.meta.url), 'utf8');
  assert.match(src, /kind: 'probation_end_reminder'/);
  const mig = readFileSync(new URL('../supabase/migrations/202611030005_probation_end_reminder_kind.sql', import.meta.url), 'utf8');
  assert.match(mig, /add value if not exists 'probation_end_reminder'/);
  assert.match(readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8'), /\[functions\."probation-reminder"\]\s+schedule = "55 4 \* \* \*"/);
});
