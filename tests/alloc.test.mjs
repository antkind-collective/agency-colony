// Tests for js/alloc.js — allocation week math (Monday weeks, month-boundary rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object, Array, JSON });
for (const file of ['js/utils.js', 'js/alloc.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
const u = (n) => vm.runInContext(n, ctx);
const VDate = u('Date');

test('mondayWeekStartDate: Monday weeks, Sunday belongs to previous week', () => {
  const f = u('mondayWeekStartDate');
  const iso = (d) => u('toISODateLocal')(d);
  assert.equal(iso(f(new VDate(2026, 5, 10))), '2026-06-08'); // Wed → Mon
  assert.equal(iso(f(new VDate(2026, 5, 8))),  '2026-06-08'); // Mon → itself
  assert.equal(iso(f(new VDate(2026, 5, 14))), '2026-06-08'); // Sun → PREVIOUS Mon
  assert.equal(iso(f(new VDate(2026, 5, 15))), '2026-06-15'); // next Mon
});

test('monthWindowFor: parses YYYY-MM, falls back to now on junk', () => {
  const f = u('monthWindowFor');
  const w = f('2026-06');
  assert.equal(w.monthStartIso, '2026-06-01');
  assert.equal(w.monthEndIso, '2026-06-30');
  assert.equal(w.monthLabel, 'Jun 2026');
  const fb = f('garbage', new VDate(2026, 1, 15)); // Feb 2026
  assert.equal(fb.monthStartIso, '2026-02-01');
  assert.equal(fb.monthEndIso, '2026-02-28');
});

test('plannerWeekStartsForMonth: includes the prior-month Monday when the 1st is midweek', () => {
  const weeks = u('plannerWeekStartsForMonth')(u('monthWindowFor')('2026-06')); // Jun 1 2026 = Monday
  assert.equal(weeks[0], '2026-06-01');
  assert.equal(weeks.length, 5);
  const aug = u('plannerWeekStartsForMonth')(u('monthWindowFor')('2026-08')); // Aug 1 2026 = Saturday
  assert.equal(aug[0], '2026-07-27'); // month-boundary rule: prior-month Monday
  assert.ok(aug.includes('2026-08-31'));
});

test('shortWeekLabel + utilizationStatusMeta', () => {
  assert.equal(u('shortWeekLabel')('2026-06-08'), 'W24');
  assert.equal(u('shortWeekLabel')('junk'), 'W-');
  assert.equal(u('utilizationStatusMeta')(110).key, 'over');
  assert.equal(u('utilizationStatusMeta')(59).key, 'under');
  assert.equal(u('utilizationStatusMeta')(80).key, 'balanced');
  assert.equal(u('utilizationStatusMeta')(100).key, 'balanced');
  assert.equal(u('utilizationStatusMeta')(60).key, 'balanced');
});

test('suggestAllocationsFromTasks: distribution, filters, steps of 5, sums 100', () => {
  const f = u('suggestAllocationsFromTasks');
  const week = '2026-06-29'; // Mon
  const rows = f([
    { task_date: '2026-06-30', status: 'in_progress', notes: 'Example Records' },
    { task_date: '2026-07-01', status: 'done', notes: 'Example Records' },        // done-but-dated counts
    { task_date: '2026-07-02', status: 'in_progress', notes: 'example records' }, // case-insensitive grouping
    { task_date: null, status: 'in_progress', notes: 'Example Climate' },              // weekly active counts
    { task_date: null, status: 'done', notes: 'Example Climate' },                     // weekly done does NOT
    { task_date: '2026-06-25', status: 'in_progress', notes: 'Example Materials' },       // outside week: dropped
    { task_date: '2026-07-01', status: 'archived', notes: 'Example Materials' },          // archived: dropped
    { task_date: '2026-07-01', status: 'in_progress', notes: '' },           // no client: dropped
    { task_date: '2026-07-03', status: 'in_progress', notes: 'Example Fashion' }
  ], week);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].client, 'Example Records');                    // 3 tasks → biggest
  assert.equal(rows.reduce((s, r) => s + r.percent, 0), 100);    // trues up to 100
  assert.ok(rows.every(r => r.percent % 5 === 0 && r.percent >= 5));
  assert.equal(rows[0].percent, 60);                             // 3/5 = 60%
});

test('suggestAllocationsFromTasks: empty and single-client cases', () => {
  const f = u('suggestAllocationsFromTasks');
  assert.equal(f([], '2026-06-29').length, 0);
  assert.equal(f([{ task_date: null, status: 'done', notes: 'X' }], '2026-06-29').length, 0);
  const solo = f([{ task_date: '2026-06-30', status: 'in_progress', notes: 'Example Climate' }], '2026-06-29');
  assert.equal(solo.length, 1);
  assert.equal(solo[0].percent, 100);
});

test('utilizationStatusMeta: thresholds are relative to the person\'s capacity', () => {
  const f = u('utilizationStatusMeta');
  // Full-timers unchanged (capacity defaults to 100) — the pre-existing contract
  assert.equal(f(50).key, 'under');
  assert.equal(f(80).key, 'balanced');
  assert.equal(f(120).key, 'over');

  // A 40%-capacity person allocated 40% is FULLY committed, not "Under".
  // This is the bug: capacity-blind, 40 < 60 read as under-utilized and
  // invited more work onto someone with nothing left.
  assert.equal(f(40, 40).key, 'balanced');
  assert.equal(f(50, 40).key, 'over');      // 125% of her capacity
  assert.equal(f(20, 40).key, 'under');     // 50% of her capacity
  assert.equal(f(40, 100).key, 'under');    // same 40% for a full-timer IS under

  // Guards: capacity 0/blank/garbage must not divide-by-zero or NaN out
  assert.equal(f(80, 0).key, 'balanced');   // falls back to a 100 ceiling
  assert.equal(f(80, null).key, 'balanced');
  assert.equal(f(80, undefined).key, 'balanced');
  assert.equal(f(0, 40).key, 'under');
});
