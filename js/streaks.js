// Task streaks — pure logic (All Hands, 24 Aug 2026). No DOM, no Supabase.
//
// A streak is consecutive WORKING days on which you touched your own tasks.
// Weekends, Your Agency public holidays and approved leave never break it and never
// pad it — they are simply not counted. Everyone also gets one automatic grace
// day per calendar month, because one missed day wiping forty is how people
// stop playing altogether.
//
// Depends on isWorkingDay / shiftIsoDays from js/utils.js.

const STREAK_MILESTONES = [5, 21, 50, 100, 150, 200, 365];
const STREAK_REWARD_DAY = 50; // half-day off — Kira's idea, agreed at 50

// `active` and `leave` are Sets of 'YYYY-MM-DD'. Walking BACKWARDS from today.
// Today never breaks a streak just because it has not happened yet — the day is
// still in progress — so a miss today is skipped rather than counted against.
function computeStreak(active, todayIso, holidays = [], leave = new Set()) {
  const isActive = (d) => active.has(d);
  let cursor = todayIso;
  let count = 0;
  const graceUsed = {}; // 'YYYY-MM' -> true
  let first = true;

  while (true) {
    const working = isWorkingDay(cursor, holidays);
    if (!working || leave.has(cursor)) {
      // Closed day or approved leave: skip it entirely, streak intact.
      cursor = shiftIsoDays(cursor, -1);
      first = false;
      continue;
    }
    if (isActive(cursor)) {
      count += 1;
    } else if (first) {
      // Today, not logged yet. The day is not over; do not break, do not count.
    } else {
      const month = cursor.slice(0, 7);
      if (!graceUsed[month]) {
        graceUsed[month] = true; // one free miss per calendar month
      } else {
        break;
      }
    }
    first = false;
    cursor = shiftIsoDays(cursor, -1);
    // A streak longer than a working year is not worth walking further.
    if (count > 400) break;
  }
  return { count, graceMonthsUsed: Object.keys(graceUsed) };
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
