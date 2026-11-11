// Streak rewards (27 Sep 2026): the server's streak must equal the home page's,
// and a streak earns a half-day at every 50, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const srv = require('../netlify/functions/lib/streak-rewards.js');

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object, Array, JSON, Set });
for (const file of ['js/utils.js', 'js/streaks.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
const browserStreak = (a, t, h, l, f) => vm.runInContext('computeStreak', ctx)(a, t, h, l, f);

// Working days walking back from `end`, skipping weekends and holidays.
function workingDaysBack(end, n, holidays = []) {
  const out = [];
  let d = new Date(`${end}T00:00:00Z`);
  while (out.length < n) {
    const iso = d.toISOString().slice(0, 10);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6 && !holidays.includes(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

const HOL = ['2026-09-14', '2026-10-02', '2026-10-20'];

test('server and home page agree on the streak (same fixtures, both implementations)', () => {
  const cases = [
    { active: workingDaysBack('2026-11-06', 60, HOL), today: '2026-11-09', leave: [] },
    { active: workingDaysBack('2026-11-06', 60, HOL).filter((d) => d !== '2026-10-15'), today: '2026-11-09', leave: [] },
    { active: workingDaysBack('2026-11-06', 60, HOL).filter((d) => !['2026-10-15', '2026-10-16'].includes(d)), today: '2026-11-09', leave: [] },
    { active: workingDaysBack('2026-11-06', 55, HOL).filter((d) => d !== '2026-10-21'), today: '2026-11-09', leave: ['2026-10-21'] },
    { active: [], today: '2026-11-09', leave: [] }
  ];
  for (const c of cases) {
    const a = new Set(c.active); const l = new Set(c.leave);
    assert.equal(srv.computeStreak(a, c.today, HOL, l).count, browserStreak(a, c.today, HOL, l).count);
  }
});

test('a reward at every 50, never below', () => {
  assert.deepEqual(srv.rewardMilestones(49), []);
  assert.deepEqual(srv.rewardMilestones(50), [50]);
  assert.deepEqual(srv.rewardMilestones(149), [50, 100]);
  assert.deepEqual(srv.rewardMilestones(150), [50, 100, 150]);
});

test('each rung of one streak is rewarded once; a rebuilt streak earns again', () => {
  const streak = { count: 104, startedOn: '2026-05-04' };
  assert.deepEqual(srv.rewardsDue(streak, []), [50, 100]);
  assert.deepEqual(srv.rewardsDue(streak, [{ milestone: 50, streak_started_on: '2026-05-04' }]), [100]);
  assert.deepEqual(srv.rewardsDue(streak, [{ milestone: 50, streak_started_on: '2026-05-04' }, { milestone: 100, streak_started_on: '2026-05-04' }]), []);
  // An older, broken streak's 50 does not count against the new one.
  assert.deepEqual(srv.rewardsDue({ count: 51, startedOn: '2026-09-01' }, [{ milestone: 50, streak_started_on: '2026-03-02' }]), [50]);
});

test('startedOn is the first counted day of the streak', () => {
  const active = new Set(workingDaysBack('2026-11-06', 50, HOL));
  const s = srv.computeStreak(active, '2026-11-09', HOL);
  assert.equal(s.count, 50);
  assert.equal(s.startedOn, [...active].sort()[0]);
});

test('a reward lasts 90 days', () => {
  assert.equal(srv.rewardExpiry('2026-11-06'), '2027-02-04');
});

test('server and home page agree on streak freezes from 1 Oct 2026', () => {
  const OCT = ['2026-10-02'];
  const cases = [
    { active: ['2026-10-05', '2026-10-06'], today: '2026-10-08', freezes: [] },
    { active: ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-12'], today: '2026-10-12', freezes: [] },
    { active: ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-12'], today: '2026-10-12', freezes: ['2026-10-07'] },
    { active: ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-12'], today: '2026-10-14', freezes: ['2026-10-07'] },
    { active: ['2026-09-28', '2026-09-29', '2026-10-01', '2026-10-05'], today: '2026-10-06', freezes: [] }
  ];
  for (const c of cases) {
    const a = new Set(c.active); const f = new Set(c.freezes);
    const s1 = srv.computeStreak(a, c.today, OCT, new Set(), f);
    const s2 = browserStreak(a, c.today, OCT, new Set(), f);
    assert.deepEqual([s1.count, s1.pendingMiss], [s2.count, s2.pendingMiss], JSON.stringify(c));
  }
});
