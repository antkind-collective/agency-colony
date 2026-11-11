// Streak rewards — pure logic (27 Sep 2026). No Supabase, no mail.
//
// A half-day off every 50 consecutive streak days (50, 100, 150, …), valid for
// 90 days. The streak here MUST match what people see on the home page, so
// computeStreak is a line-for-line port of js/streaks.js (browser globals there,
// CommonJS here); tests/streak-rewards.test.mjs runs both on the same fixtures
// and fails if they ever disagree. The one addition: startedOn, the earliest
// counted day, which keys a reward to one unbroken streak so a person who
// breaks and rebuilds earns again, but a streak is never rewarded twice.

const { isWorkingDayIso, shiftIso } = require('./brief-reminders');

const REWARD_EVERY = 50;
const REWARD_VALID_DAYS = 90;

const STREAK_FREEZE_FROM = '2026-10-01';
const STREAK_FREEZE_WINDOW = 2;

// `active`, `leave` and `freezes` are Sets of 'YYYY-MM-DD'. Walks backwards
// from today. Same rules as js/streaks.js (automatic grace before 1 Oct 2026,
// a clicked freeze from then on, a miss pending while the prompt is up).
function computeStreak(active, todayIso, holidays = [], leave = new Set(), freezes = new Set()) {
  let cursor = todayIso;
  let count = 0;
  let startedOn = null;
  const graceUsed = {};
  const freezeMonths = new Set([...freezes].map((d) => d.slice(0, 7)));
  let pendingMiss = null;
  let countAtPending = 0;
  let workingSeen = 0;
  let first = true;

  while (true) {
    const working = isWorkingDayIso(cursor, holidays);
    if (!working || leave.has(cursor)) {
      cursor = shiftIso(cursor, -1);
      first = false;
      continue;
    }
    if (active.has(cursor)) {
      count += 1;
      startedOn = cursor;
    } else if (first) {
      // Today, not logged yet: neither breaks nor counts.
    } else if (cursor < STREAK_FREEZE_FROM) {
      const month = cursor.slice(0, 7);
      if (!graceUsed[month]) graceUsed[month] = true;
      else break;
    } else if (freezes.has(cursor)) {
      // Covered by a chosen freeze.
    } else if (!pendingMiss && workingSeen <= STREAK_FREEZE_WINDOW && !freezeMonths.has(cursor.slice(0, 7))) {
      pendingMiss = cursor;
      countAtPending = count;
      freezeMonths.add(cursor.slice(0, 7));
    } else {
      break;
    }
    workingSeen += 1;
    first = false;
    cursor = shiftIso(cursor, -1);
    if (count > 400) break;
  }
  if (pendingMiss && count === countAtPending) pendingMiss = null;
  return { count, startedOn, graceMonthsUsed: Object.keys(graceUsed), pendingMiss };
}

// Every reward rung this streak has reached: 120 days -> [50, 100].
function rewardMilestones(count) {
  const out = [];
  for (let m = REWARD_EVERY; m <= count; m += REWARD_EVERY) out.push(m);
  return out;
}

// Rewards to grant now: rungs reached by this streak that have no row yet.
// `granted` is the employee's existing rows ({ milestone, streak_started_on }).
function rewardsDue(streak, granted = []) {
  if (!streak || !streak.startedOn) return [];
  const have = new Set(granted
    .filter((g) => String(g.streak_started_on).slice(0, 10) === streak.startedOn)
    .map((g) => Number(g.milestone)));
  return rewardMilestones(streak.count).filter((m) => !have.has(m));
}

function rewardExpiry(earnedIso) { return shiftIso(earnedIso, REWARD_VALID_DAYS); }

module.exports = { STREAK_FREEZE_FROM, STREAK_FREEZE_WINDOW, computeStreak, rewardMilestones, rewardsDue, rewardExpiry, REWARD_EVERY, REWARD_VALID_DAYS };
