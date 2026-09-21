import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { awaitsPickup, pickupNudgeFor } = require('../netlify/functions/lib/pickup-nudge.js');

const HOLS = ['2026-09-14']; // Ganesh Chaturthi, a Monday
const approved = { id: 'b1', request_type: 'brief', status: 'ready_for_review', deadline: '2026-09-15', paused_at: null, created_at: '2026-09-09T02:26:00Z' };

test("Alice's brief the morning after approval — the case this exists for", () => {
  // Approved Thu 10 Sep evening; run Fri 11 Sep: one working day waited.
  const hit = pickupNudgeFor(approved, [], '2026-09-10', '2026-09-11', HOLS);
  assert.equal(hit.waited, 1);
  // Fri -> Tue is one working day (Sat, Sun, holiday Mon).
  assert.equal(hit.workingDaysLeft, 1);
  assert.equal(hit.urgent, true);
});

test('waiting is measured from APPROVAL, not from when the client raised it', () => {
  // Raised on the 9th, approved on the 11th, run on the 11th: zero days waited.
  assert.equal(pickupNudgeFor(approved, [], '2026-09-11', '2026-09-11', HOLS), null);
});

test('an owned deliverable means somebody has it', () => {
  const owned = [{ brief_id: 'b1', assignee_employee_id: 'e1' }];
  assert.equal(awaitsPickup(approved, owned), false);
  // An unowned one proves nothing.
  assert.equal(awaitsPickup(approved, [{ brief_id: 'b1', assignee_employee_id: null }]), true);
  // Someone else's brief's deliverable is irrelevant.
  assert.equal(awaitsPickup(approved, [{ brief_id: 'other', assignee_employee_id: 'e1' }]), true);
});

test('only briefs sitting at ready_for_review, and never paused ones', () => {
  assert.equal(awaitsPickup({ ...approved, status: 'in_creative' }, []), false);
  assert.equal(awaitsPickup({ ...approved, status: 'submitted' }, []), false);
  assert.equal(awaitsPickup({ ...approved, request_type: 'notify_only' }, []), false);
  assert.equal(awaitsPickup({ ...approved, paused_at: '2026-09-10T00:00:00Z' }, []), false);
});

test('no approval date means nothing to measure, so no nudge', () => {
  assert.equal(pickupNudgeFor(approved, [], null, '2026-09-11', HOLS), null);
});

test('a distant deadline is chased but not urgent', () => {
  const hit = pickupNudgeFor({ ...approved, deadline: '2026-10-30' }, [], '2026-09-09', '2026-09-11', HOLS);
  assert.equal(hit.urgent, false);
  assert.ok(hit.waited >= 1);
});
