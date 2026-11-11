// Tests for js/leave.js — client-side leave rules (working-day counting, the
// request-form policy check, balance formatting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object, Array, JSON });
for (const file of ['js/utils.js', 'js/leave.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
const u = (name) => vm.runInContext(name, ctx);
const D = (iso) => u('parseIsoDateLocal')(iso);

test('calendarDayCount: inclusive calendar days — Fri→Mon is 4 (policy)', () => {
  const f = u('calendarDayCount');
  assert.equal(f(D('2026-06-12'), D('2026-06-15')), 4);  // Fri→Mon
  assert.equal(f(D('2026-06-08'), D('2026-06-12')), 5);  // Mon→Fri
  assert.equal(f(D('2026-06-10'), D('2026-06-10')), 1);  // single day
  assert.equal(f(D('2026-06-11'), D('2026-06-10')), 0);  // inverted → 0
});

test('leavePolicyCheck: SL>=3 days needs certificate; half-day passes through', () => {
  const f = u('leavePolicyCheck');
  assert.equal(f('SL', 3).level, 'warn');
  assert.match(f('SL', 3).text, /medical certificate/);
  assert.equal(f('SL', 2).level, 'ok');
  assert.equal(f('PL', 10).level, 'ok');
  assert.match(f('CL', 0.5).text, /CL request for 0.5 day/);
});

test('emptyLeaveSummary: Apr-Mar allocations PL8/CL8/SL12', () => {
  const s = u('emptyLeaveSummary')();
  assert.equal(s.cycle_label, 'Apr-Mar');
  assert.equal(s.pl.allocated, 8);
  assert.equal(s.cl.allocated, 8);
  assert.equal(s.sl.allocated, 12);
  assert.equal(s.sl.remaining, 12);
});

test('leaveDayText: no float noise', () => {
  const f = u('leaveDayText');
  assert.equal(f(8), '8');
  assert.equal(f(7.5), '7.5');
  assert.equal(f(0.333333), '0.33');
  assert.equal(f('junk'), '0');
});

test('leaveStatusMeta + formatLeaveDateRange behave as before', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(u('leaveStatusMeta')('approved'))), { chipClass: 'approved', label: 'Approved' });
  assert.equal(u('leaveStatusMeta')('anything-else').label, 'Pending');
  assert.equal(u('formatLeaveDateRange')('2026-06-08', '2026-06-10'), 'Mon, Jun 8 – Wed, Jun 10');
  assert.equal(u('formatLeaveDateRange')('2026-06-08', '2026-06-08'), 'Mon, Jun 8');
  assert.equal(u('formatLeaveDateRange')('', ''), '');
});

// Streak rewards (27 Sep 2026): the form offers one only while it is unused and unexpired.
test('streakRewardSummary: unused and unexpired only, earliest expiry first', () => {
  const s = u('streakRewardSummary')([
    { expires_on: '2026-12-01', leave_request_id: null },
    { expires_on: '2026-11-01', leave_request_id: null },
    { expires_on: '2026-10-01', leave_request_id: null },   // expired
    { expires_on: '2027-01-01', leave_request_id: 'x' }     // already taken
  ], '2026-10-15');
  assert.equal(s.count, 2);
  assert.equal(s.days, 1);
  assert.equal(s.nextExpiry, '2026-11-01');
});

test('SR reads as Streak reward, and its policy line never mentions a balance', () => {
  assert.equal(u('leaveTypeDisplay')('SR'), 'Streak reward');
  assert.equal(u('leaveTypeDisplay')('PL'), 'PL');
  assert.match(u('leavePolicyCheck')('SR', 0.5).text, /not from PL, CL or SL/);
});
