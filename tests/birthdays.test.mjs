// Birthdays go to leadership plus the person's manager, once a day
// (4 Nov 2026: Modeera's went to five fixed addresses, twice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { birthdayRecipients } = require('../netlify/functions/lib/birthdays.js');

const people = [
  { full_name: 'Alex', email: 'admin@youragency.com', access_level: 'admin' },
  { full_name: 'Nadia', email: 'am-lead@youragency.com', access_level: 'leadership' },
  { full_name: 'Dev', email: 'dev@youragency.com', access_level: 'employee' },
  { full_name: 'Modeera', email: 'modeera@youragency.com', access_level: 'employee', date_of_birth: '1999-11-04', direct_manager_email: 'dev@youragency.com' },
  { full_name: 'Maya', email: 'maya@youragency.com', access_level: 'employee', date_of_birth: '1998-11-04', direct_manager_email: 'am-lead@youragency.com' },
  { full_name: 'Asha', email: 'asha@youragency.com', access_level: 'employee', date_of_birth: '1990-05-01', direct_manager_email: 'am-lead@youragency.com' }
];

test('leadership hears about everyone; a manager only about their own reports', () => {
  const r = birthdayRecipients(people, 11, 4);
  assert.deepEqual([...r.keys()].sort(), ['admin@youragency.com', 'am-lead@youragency.com', 'dev@youragency.com']);
  assert.deepEqual(r.get('admin@youragency.com').map((p) => p.full_name), ['Modeera', 'Maya']);
  assert.deepEqual(r.get('am-lead@youragency.com').map((p) => p.full_name), ['Modeera', 'Maya'], 'manager and leader: one email');
  assert.deepEqual(r.get('dev@youragency.com').map((p) => p.full_name), ['Modeera']);
});

test('nobody hears about their own birthday', () => {
  const r = birthdayRecipients([...people, { full_name: 'Sam', email: 'strategy-lead@youragency.com', access_level: 'leadership', date_of_birth: '1980-01-02' }], 1, 2);
  assert.equal(r.has('strategy-lead@youragency.com'), false);
  assert.ok(r.has('admin@youragency.com'));
});

test('no hard-coded list, and each email checks the log before sending', () => {
  const src = readFileSync(new URL('../netlify/functions/daily-reminders.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /leadershipEmails/);
  assert.match(src, /sentToday\(supabase, 'birthday_notification'/);
  assert.match(src, /sentToday\(supabase, 'pending_leave_digest'/);
});
