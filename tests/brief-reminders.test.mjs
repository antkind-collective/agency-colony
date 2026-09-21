// Deadline reminders for brief deliverables (netlify/functions/lib/brief-reminders.js).
// This is the decision that, if wrong, emails the team about work that is
// finished, paused, or not theirs — so it is tested away from any sending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isWorkingDayIso, workingDaysUntil, reminderStageFor,
  briefAcceptsReminders, reminderFor, reminderKey, isReminderRunDay
} = require('../netlify/functions/lib/brief-reminders.js');

// Sept 2026: 14th is Ganesh Chaturthi (a Monday), from app.public_holidays.
const HOLS = ['2026-09-14', '2026-10-02'];
const live = { status: 'in_creative', paused_at: null };

test('working days: weekends and holidays are not working days', () => {
  assert.equal(isWorkingDayIso('2026-09-09', HOLS), true);   // Wed
  assert.equal(isWorkingDayIso('2026-09-12', HOLS), false);  // Sat
  assert.equal(isWorkingDayIso('2026-09-13', HOLS), false);  // Sun
  assert.equal(isWorkingDayIso('2026-09-14', HOLS), false);  // Ganesh Chaturthi
});

test('workingDaysUntil counts after today, up to and including the due date', () => {
  // Wed 9th → Fri 11th is two working days: Thu, Fri.
  assert.equal(workingDaysUntil('2026-09-09', '2026-09-11', HOLS), 2);
  assert.equal(workingDaysUntil('2026-09-10', '2026-09-11', HOLS), 1);
  assert.equal(workingDaysUntil('2026-09-11', '2026-09-11', HOLS), 0);
  // Past deadlines are not "0 days away" — they are gone.
  assert.equal(workingDaysUntil('2026-09-12', '2026-09-11', HOLS), null);
});

test('the weekend does not eat a reminder', () => {
  // Deadline Tue 15th. Two working days earlier is Thu 10th, because Fri 11th
  // is one working day out once Sat, Sun and Ganesh Chaturthi are removed.
  assert.equal(workingDaysUntil('2026-09-10', '2026-09-15', HOLS), 2);
  assert.equal(workingDaysUntil('2026-09-11', '2026-09-15', HOLS), 1);
  // From a Saturday there is STILL one working day until Tuesday, so the
  // arithmetic says 't1' — correct, and on its own it would nudge someone on
  // their weekend. The run-day guard is what stops that, not the counting.
  assert.equal(reminderStageFor('2026-09-15', '2026-09-12', HOLS), 't1');
  assert.equal(isReminderRunDay('2026-09-12', HOLS), false);  // Saturday
  assert.equal(isReminderRunDay('2026-09-14', HOLS), false);  // Ganesh Chaturthi
  assert.equal(isReminderRunDay('2026-09-15', HOLS), true);
});

test('stages land on the right days', () => {
  assert.equal(reminderStageFor('2026-09-11', '2026-09-09', HOLS), 't2');
  assert.equal(reminderStageFor('2026-09-11', '2026-09-10', HOLS), 't1');
  assert.equal(reminderStageFor('2026-09-11', '2026-09-11', HOLS), 'due');
  assert.equal(reminderStageFor('2026-09-11', '2026-09-08', HOLS), null);  // 3 out
  assert.equal(reminderStageFor('2026-09-11', '2026-09-14', HOLS), null);  // overdue
});

test('a paused brief is never chased — the reason On Pause shipped first', () => {
  const paused = { status: 'in_creative', paused_at: '2026-09-07T10:00:00Z' };
  assert.equal(briefAcceptsReminders(paused), false);
  assert.equal(briefAcceptsReminders(live), true);
  assert.equal(briefAcceptsReminders({ status: 'completed', paused_at: null }), false);
  assert.equal(briefAcceptsReminders({ status: 'closed', paused_at: null }), false);
  assert.equal(briefAcceptsReminders(null), false);

  const deliv = { id: 'd1', due_at: '2026-09-11T00:00:00Z', status: 'in_progress', assignee_employee_id: 'e1' };
  assert.equal(reminderFor(deliv, paused, '2026-09-09', HOLS), null);
  assert.equal(reminderFor(deliv, live, '2026-09-09', HOLS).stage, 't2');
});

test('finished, unassigned and undated work is nobody to chase', () => {
  const base = { id: 'd1', due_at: '2026-09-11T00:00:00Z', status: 'in_progress', assignee_employee_id: 'e1' };
  const on = (patch) => reminderFor({ ...base, ...patch }, live, '2026-09-09', HOLS);
  assert.equal(on({}).stage, 't2');
  assert.equal(on({ status: 'delivered' }), null);
  // The real enum is queued | in_progress | in_review | ready_to_share |
  // delivered. Ready is not delivered, so it is still chased — the deadline
  // is about the handover, not the craft.
  assert.equal(on({ status: 'ready_to_share' }).stage, 't2');
  assert.equal(on({ status: 'in_review' }).stage, 't2');
  assert.equal(on({ delivered_at: '2026-09-08T10:00:00Z' }), null);  // status lagging behind reality
  assert.equal(on({ assignee_employee_id: null }), null);
  assert.equal(on({ due_at: null }), null);
});

test('one email per deliverable per stage, not per run', () => {
  // Deliberately undated: a re-run after a failure, or a deadline nudged back
  // and forth over a boundary, must not tell someone twice about the same
  // stage of the same piece.
  assert.equal(reminderKey('d1', 't2'), 'd1|t2');
  assert.notEqual(reminderKey('d1', 't2'), reminderKey('d1', 't1'));
  assert.notEqual(reminderKey('d1', 't2'), reminderKey('d2', 't2'));
});

test('a deadline far out is silent', () => {
  const deliv = { id: 'd1', due_at: '2026-12-31T00:00:00Z', status: 'in_progress', assignee_employee_id: 'e1' };
  assert.equal(reminderFor(deliv, live, '2026-09-09', HOLS), null);
});
