// Chasing briefs stuck awaiting client approval
// (netlify/functions/lib/approval-nudge.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { waitingWorkingDays, awaitsClientApproval, nudgeFor, nudgeKey } =
  require('../netlify/functions/lib/approval-nudge.js');

const HOLS = ['2026-09-14'];  // Ganesh Chaturthi, a Monday
const partnerBrief = {
  id: 'b1', request_type: 'brief', status: 'submitted',
  submitted_by_partner_id: 'p1', created_at: '2026-09-09T02:26:00Z', deadline: '2026-09-15'
};

test('a brief raised today is not already late', () => {
  // The day it arrives counts as zero — otherwise a 2am submission is "a day
  // overdue" by that afternoon.
  assert.equal(waitingWorkingDays('2026-09-10', '2026-09-10', HOLS), 0);
  assert.equal(nudgeFor({ ...partnerBrief, created_at: '2026-09-10T02:00:00Z' }, '2026-09-10', HOLS), null);
});

test('waiting is counted in working days, not calendar days', () => {
  assert.equal(waitingWorkingDays('2026-09-09', '2026-09-10', HOLS), 1);
  // Fri 11th → Tue 15th is ONE working day: Sat, Sun and Ganesh Chaturthi
  // are not the client ignoring you.
  assert.equal(waitingWorkingDays('2026-09-11', '2026-09-15', HOLS), 1);
  assert.equal(waitingWorkingDays('2026-09-11', '2026-09-16', HOLS), 2);
  // A future submission date cannot be negative waiting.
  assert.equal(waitingWorkingDays('2026-09-20', '2026-09-10', HOLS), 0);
});

test('only a partner-submitted brief is gated, so only it can be stuck', () => {
  assert.equal(awaitsClientApproval(partnerBrief), true);
  // Quick requests reach Your Agency immediately — nobody approves them.
  assert.equal(awaitsClientApproval({ ...partnerBrief, request_type: 'notify_only' }), false);
  // Already approved and moving.
  assert.equal(awaitsClientApproval({ ...partnerBrief, status: 'ready_for_review' }), false);
  // Logged internally by an AM: there is no client approval to wait for.
  assert.equal(awaitsClientApproval({ ...partnerBrief, submitted_by_partner_id: null }), false);
  assert.equal(awaitsClientApproval(null), false);
});

test("Alice's brief — the case this exists for", () => {
  // Submitted 02:26 on the 9th, deadline Friday the 15th, still unapproved.
  const hit = nudgeFor(partnerBrief, '2026-09-10', HOLS);
  assert.equal(hit.waited, 1);
  assert.equal(hit.due, '2026-09-15');
  // Urgency is WORKING days, not calendar days. The 15th looks five days off
  // from the 10th, but Sat, Sun and Ganesh Chaturthi leave two working days —
  // measuring this in calendar days called it "not urgent" and was wrong.
  assert.equal(hit.workingDaysLeft, 2);
  assert.equal(hit.urgent, true);
});

test('a distant deadline is chased, but not as urgent', () => {
  const hit = nudgeFor({ ...partnerBrief, deadline: '2026-10-30' }, '2026-09-10', HOLS);
  assert.equal(hit.waited, 1);
  assert.equal(hit.urgent, false);
  // No deadline at all is still worth chasing, just never urgent.
  const noDue = nudgeFor({ ...partnerBrief, deadline: null }, '2026-09-10', HOLS);
  assert.equal(noDue.due, null);
  assert.equal(noDue.urgent, false);
});

test('chased once per working day, not once ever and not per run', () => {
  // Blocking work needs more than a single message, but more than daily nags.
  assert.equal(nudgeKey('b1', '2026-09-10'), 'b1|2026-09-10');
  assert.notEqual(nudgeKey('b1', '2026-09-10'), nudgeKey('b1', '2026-09-11'));
});

test('a deadline already gone is as urgent as it gets', () => {
  const hit = nudgeFor({ ...partnerBrief, deadline: '2026-09-08' }, '2026-09-10', HOLS);
  assert.equal(hit.workingDaysLeft, null);
  assert.equal(hit.urgent, true);
});

test('On Pause is not chased', () => {
  assert.equal(nudgeFor({ ...partnerBrief, paused_at: '2026-09-09T10:00:00Z' }, '2026-09-10', HOLS), null);
});
