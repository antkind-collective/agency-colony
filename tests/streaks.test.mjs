// Tests for js/streaks.js — streak counting, grace days, milestones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object, Array, JSON, Set });
for (const file of ['js/utils.js', 'js/streaks.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
const u = (n) => vm.runInContext(n, ctx);
const compute = (dates, today, holidays = [], leave = []) =>
  u('computeStreak')(new Set(dates), today, holidays, new Set(leave));

// Sep 2026: 7th Mon … 11th Fri, 12–13 weekend, 14th Mon = Ganesh Chaturthi.
const HOL = ['2026-09-14'];

test('counts consecutive working days', () => {
  const r = compute(['2026-09-08', '2026-09-09', '2026-09-10'], '2026-09-10', HOL);
  assert.equal(r.count, 3);
});

test('weekends do not break or pad a streak', () => {
  // Fri 11th and Mon 15th, with the weekend and the 14th holiday between.
  const r = compute(['2026-09-11', '2026-09-15'], '2026-09-15', HOL);
  assert.equal(r.count, 2);
});

test('a public holiday neither breaks nor counts', () => {
  const r = compute(['2026-09-11', '2026-09-15', '2026-09-16'], '2026-09-16', HOL);
  assert.equal(r.count, 3);
});

test('approved leave does not break a streak', () => {
  // Missed Wed 9th, but was on leave that day.
  const r = compute(['2026-09-08', '2026-09-10'], '2026-09-10', HOL, ['2026-09-09']);
  assert.equal(r.count, 2);
});

test('today not yet logged does not break the streak', () => {
  // Nothing today (Thu 10th) but yesterday and the day before are logged.
  const r = compute(['2026-09-08', '2026-09-09'], '2026-09-10', HOL);
  assert.equal(r.count, 2);
});

test('one missed day per month is forgiven, the second breaks it', () => {
  // Missed Wed 9th with no leave — grace covers it.
  const forgiven = compute(['2026-09-07', '2026-09-08', '2026-09-10'], '2026-09-10', HOL);
  assert.equal(forgiven.count, 3);
  assert.deepEqual(forgiven.graceMonthsUsed, ['2026-09']);
  // Missing BOTH the 8th and 9th: grace covers one, the next stops the walk.
  const broken = compute(['2026-09-07', '2026-09-10'], '2026-09-10', HOL);
  assert.equal(broken.count, 1);
});

test('grace is per calendar month, not per streak', () => {
  // A miss in September and another in August are each forgiven.
  const dates = ['2026-08-27', '2026-08-28', '2026-08-31', '2026-09-02', '2026-09-03'];
  // missed 1 Sep (Tue) and 26 Aug (Wed)
  const r = compute(dates, '2026-09-03', HOL);
  assert.equal(r.count, 5);
  assert.deepEqual(r.graceMonthsUsed.sort(), ['2026-08', '2026-09']);
});

test('milestones and progress', () => {
  assert.equal(u('nextMilestone')(0), 5);
  assert.equal(u('nextMilestone')(21), 50);
  assert.equal(u('nextMilestone')(365), null);
  assert.equal(u('milestoneReached')(21), 21);
  assert.equal(u('milestoneReached')(22), null);
  const p = u('streakProgress')(12);
  assert.equal(p.next, 21);
  assert.equal(p.remaining, 9);
  assert.equal(u('STREAK_REWARD_DAY'), 50);
});

test('milestone labels: named at the round ones, numeric otherwise', () => {
  const f = u('milestoneLabel');
  assert.equal(f(5), 'one week');
  assert.equal(f(21), 'one month');
  assert.equal(f(50), '50 days');
  // 365 WORKING days is nearer 17 months than a calendar year. Alex's call
  // (3 Sep 2026): the top rung reads "one year" anyway — it is the name of the
  // achievement, not a claim about elapsed time.
  assert.equal(f(365), 'one year');
});

test('day 1 says four working days to one week', () => {
  const p = u('streakProgress')(1);
  assert.equal(p.next, 5);
  assert.equal(p.remaining, 4);
  assert.equal(u('milestoneLabel')(p.next), 'one week');
});

// ── Streak freeze by choice, from 1 Oct 2026 ──────────────────────────────
// Oct 2026: 2nd (Fri) Gandhi Jayanti; 5 Mon … 9 Fri; 12 Mon … 16 Fri.
const OCT = ['2026-10-02'];
const freezeCase = (dates, today, freezes = []) =>
  u('computeStreak')(new Set(dates), today, OCT, new Set(), new Set(freezes));

test('a miss from 1 Oct is pending the next day: streak holds, freeze offered', () => {
  const r = freezeCase(['2026-10-05', '2026-10-06'], '2026-10-08');
  assert.equal(r.count, 2);
  assert.equal(r.pendingMiss, '2026-10-07');
});

test('the offer stays up for two working days, then the miss breaks the streak', () => {
  const held = freezeCase(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09'], '2026-10-09');
  assert.deepEqual([held.count, held.pendingMiss], [4, '2026-10-07']);
  const lapsed = freezeCase(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-12'], '2026-10-12');
  assert.deepEqual([lapsed.count, lapsed.pendingMiss], [3, null]);
});

test('a used freeze covers the day for good', () => {
  const r = freezeCase(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-12'], '2026-10-12', ['2026-10-07']);
  assert.deepEqual([r.count, r.pendingMiss], [5, null]);
});

test('one freeze a month: a second miss after using it ends the streak, no offer', () => {
  const r = freezeCase(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-12'], '2026-10-14', ['2026-10-07']);
  assert.deepEqual([r.count, r.pendingMiss], [0, null]);
});

test('no offer when a freeze could not save anything', () => {
  // Two misses in a row: the freeze could cover only one.
  assert.equal(freezeCase(['2026-10-05', '2026-10-06'], '2026-10-09').pendingMiss, null);
  // Nothing before the miss.
  assert.equal(freezeCase([], '2026-10-08').pendingMiss, null);
});

test('misses up to 30 Sep keep the automatic grace day (no one changed on switch-over)', () => {
  const r = compute(['2026-09-21', '2026-09-22', '2026-09-24', '2026-09-25', '2026-09-28'], '2026-09-28');
  assert.equal(r.count, 5);
  assert.equal(r.pendingMiss, null);
});
