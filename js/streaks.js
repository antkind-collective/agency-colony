// Task streaks — pure logic (All Hands, 24 Aug 2026). No DOM, no Supabase.
//
// A streak is consecutive WORKING days on which you touched your own tasks.
// Weekends, Your Agency public holidays and approved leave never break it and never
// pad it — they are simply not counted.
//
// A missed working day (28 Sep 2026):
//   * up to 30 Sep 2026 — the old rule: one automatic grace day per calendar
//     month. Kept for those dates so nobody's streak changed on switch-over.
//   * from 1 Oct 2026 — a STREAK FREEZE, used by clicking. The morning after a
//     miss your own row asks "Use your streak freeze?"; the miss stays PENDING
//     (neither counts nor breaks) for STREAK_FREEZE_WINDOW working days, then
//     breaks if nobody clicked. One freeze per calendar month. A used freeze is
//     a row in app.streak_freezes (written only by app.use_streak_freeze).
//
// Depends on isWorkingDay / shiftIsoDays from js/utils.js. Mirrored line for
// line in netlify/functions/lib/streak-rewards.js (parity-tested).

const STREAK_MILESTONES = [5, 21, 50, 100, 150, 200, 365];
const STREAK_REWARD_DAY = 50; // half-day off — Kira's idea, agreed at 50
const STREAK_FREEZE_FROM = '2026-10-01';
const STREAK_FREEZE_WINDOW = 2; // working days the "Use freeze" prompt stays up

// `active`, `leave` and `freezes` are Sets of 'YYYY-MM-DD'. Walks BACKWARDS
// from today. Today never breaks a streak just because it has not happened
// yet — the day is still in progress.
// Returns pendingMiss: the missed day a freeze could still cover (only when
// there is something before it to save), else null.
function computeStreak(active, todayIso, holidays = [], leave = new Set(), freezes = new Set()) {
  let cursor = todayIso;
  let count = 0;
  const graceUsed = {}; // 'YYYY-MM' -> true (pre-1-Oct automatic rule)
  const freezeMonths = new Set([...freezes].map((d) => d.slice(0, 7)));
  let pendingMiss = null;
  let countAtPending = 0;
  let workingSeen = 0; // working days walked so far, today included
  let first = true;

  while (true) {
    const working = isWorkingDay(cursor, holidays);
    if (!working || leave.has(cursor)) {
      // Closed day or approved leave: skip it entirely, streak intact.
      cursor = shiftIsoDays(cursor, -1);
      first = false;
      continue;
    }
    if (active.has(cursor)) {
      count += 1;
    } else if (first) {
      // Today, not logged yet. The day is not over; do not break, do not count.
    } else if (cursor < STREAK_FREEZE_FROM) {
      const month = cursor.slice(0, 7);
      if (!graceUsed[month]) graceUsed[month] = true; // one free miss per calendar month
      else break;
    } else if (freezes.has(cursor)) {
      // Covered by a freeze the person chose to use.
    } else if (!pendingMiss && workingSeen <= STREAK_FREEZE_WINDOW && !freezeMonths.has(cursor.slice(0, 7))) {
      pendingMiss = cursor; // still time to click "Use freeze"
      countAtPending = count;
      freezeMonths.add(cursor.slice(0, 7));
    } else {
      break;
    }
    workingSeen += 1;
    first = false;
    cursor = shiftIsoDays(cursor, -1);
    // A streak longer than a working year is not worth walking further.
    if (count > 400) break;
  }
  if (pendingMiss && count === countAtPending) pendingMiss = null; // nothing before it to save
  return { count, graceMonthsUsed: Object.keys(graceUsed), pendingMiss };
}

// Working days, so a "week" is 5 and a "month" is ~21. Rungs without an honest
// name keep their number — better a plain "50 days" than a fake unit. Naming
// exists because "4 working days to your next milestone — 5 days" put two
// different numbers side by side and read as a contradiction (26 Aug).
const STREAK_MILESTONE_LABELS = { 5: 'one week', 21: 'one month', 365: 'one year' };

function milestoneLabel(count) {
  return STREAK_MILESTONE_LABELS[count] || `${count} days`;
}

function nextMilestone(count) {
  return STREAK_MILESTONES.find((m) => m > count) || null;
}

// The rung just reached, for the one-day celebration. Only when the count lands
// EXACTLY on a rung, so it shows the day it happens and not for a week after.
function milestoneReached(count) {
  return STREAK_MILESTONES.includes(count) ? count : null;
}

function streakProgress(count) {
  const next = nextMilestone(count);
  if (!next) return { next: null, remaining: 0, percent: 100 };
  const prev = [...STREAK_MILESTONES].reverse().find((m) => m <= count) || 0;
  const span = next - prev;
  return {
    next,
    remaining: next - count,
    percent: span > 0 ? Math.round(((count - prev) / span) * 100) : 0
  };
}
