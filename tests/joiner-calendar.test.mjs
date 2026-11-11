// Joiners join All Hands + Thirsty Thursday after their first sign-in (7 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { joinersToAdd, withAttendee, SERIES } = require('../netlify/functions/lib/joiner-calendar.js');

test('only hires whose access is switched on, once', () => {
  const hires = [
    { id: 1, work_email: 'siva@youragency.com', stage: 'payroll_done', activated_at: '2026-10-12T04:00:00Z', calendar_added_at: null },
    { id: 2, work_email: 'modeera@youragency.com', stage: 'payroll_done', activated_at: null, calendar_added_at: null },
    { id: 3, work_email: 'maya@youragency.com', stage: 'payroll_done', activated_at: '2026-09-24T00:00:00Z', calendar_added_at: '2026-09-24T00:00:00Z' },
    { id: 4, work_email: 'x@youragency.com', stage: 'cancelled', activated_at: '2026-09-24T00:00:00Z', calendar_added_at: null }
  ];
  assert.deepEqual(joinersToAdd(hires).map((h) => h.id), [1]);
});

test('adds the joiner to the guest list, and never twice', () => {
  const list = [{ email: 'admin@youragency.com', organizer: true }, { email: 'asha@youragency.com' }];
  assert.deepEqual(withAttendee(list, 'Siva@youragency.com').map((a) => a.email), ['admin@youragency.com', 'asha@youragency.com', 'siva@youragency.com']);
  assert.equal(withAttendee(list, 'asha@youragency.com'), null);
});

test('both recurring meetings are covered', () => {
  assert.deepEqual(SERIES.map((s) => s.name), ['All Hands', 'Thirsty Thursday']);
});
