/* ── Your Agency leave logic: pure helpers ──
   Classic script — loads after utils.js, before app.js. PURE ONLY: no DOM,
   no `state`, no Supabase. The heavy balance math (cycle rollover, taken/
   applied tallies) lives in DB RPCs; this module owns the client-side rules:
   calendar-day counting, the leave policy check shown on the request form,
   summary defaults, and display formatting. Tested in tests/leave.test.mjs.

   Leave types: PL (8) / CL (8) / SL (12) per Apr-Mar fiscal year. */

// POLICY (12 Jun 2026): leave costs CALENDAR days, inclusive — a
// Fri→Mon leave is 4 days; weekends/holidays inside the range count.
// Mirrors app.overlap_days in the DB (the balance math).
function calendarDayCount(startDate, endDate) {
  const ms = endDate - startDate;
  if (Number.isNaN(ms) || ms < 0) return 0;
  return Math.round(ms / 86400000) + 1;
}

// The request-form policy check. Returns { level: 'ok'|'warn', text }.
// Rule: SL of 3+ days needs a medical certificate (matches the DB trigger).
function leavePolicyCheck(type, days) {
  if (type === 'SR') {
    return { level: 'ok', text: 'Streak reward: a half-day off from your streak, not from PL, CL or SL.' };
  }
  if (type === 'SL' && days >= 3) {
    return { level: 'warn', text: `Policy check: SL for ${days} day(s) requires medical certificate.` };
  }
  return { level: 'ok', text: `Policy check: ${type} request for ${days} day(s) is valid.` };
}

// Default (empty) cycle summary — the Apr-Mar allocations.
function emptyLeaveSummary() {
  return {
    cycle_label: 'Apr-Mar',
    cycle_start: null,
    cycle_end: null,
    pl: { allocated: 8, applied: 0, taken: 0, remaining: 8 },
    cl: { allocated: 8, applied: 0, taken: 0, remaining: 8 },
    sl: { allocated: 12, applied: 0, taken: 0, remaining: 12 },
    archive: []
  };
}

// Balance numbers render without float noise: "8", "7.5", "0.33".
function leaveDayText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  const rounded = Math.round(numeric * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/\.?0+$/, '');
}

function leaveStatusMeta(status) {
  if (status === 'approved') return { chipClass: 'approved', label: 'Approved' };
  if (status === 'rejected') return { chipClass: 'rejected', label: 'Rejected' };
  if (status === 'cancelled') return { chipClass: 'warn', label: 'Cancelled' };
  return { chipClass: 'pending', label: 'Pending' };
}

function formatShortDate(inputDate) {
  if (!inputDate) return '';
  const [year, month, day] = inputDate.split('-').map(Number);
  if (!year || !month || !day) return '';
  const dt = new Date(year, month - 1, day);
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatLeaveDateRange(startValue, endValue) {
  const start = formatShortDate(startValue);
  const end = formatShortDate(endValue);
  if (!start) return '';
  if (!end || start === end) return start;
  return `${start} – ${end}`;
}

// Streak rewards (27 Sep 2026): a half-day every 50 streak days, 90 days to
// use. `rows` are the viewer's app.streak_rewards; a reward is available while
// no leave request holds it and it has not expired. The DB trigger enforces
// the same rule on submit; this only decides what the form offers.
function streakRewardSummary(rows, todayIso) {
  const open = (Array.isArray(rows) ? rows : [])
    .filter((r) => !r.leave_request_id && String(r.expires_on || '') >= todayIso)
    .sort((a, b) => String(a.expires_on).localeCompare(String(b.expires_on)));
  return { count: open.length, days: open.length * 0.5, nextExpiry: open[0]?.expires_on || null };
}

// Leave type as a person reads it in a table: SR is not an acronym anyone knows.
function leaveTypeDisplay(type) {
  return type === 'SR' ? 'Streak reward' : String(type || '');
}

// The plain word, for lists people read (Leave, 13 Oct 2026).
function leaveTypeShort(type) {
  return { PL: 'privilege', CL: 'casual', SL: 'sick', SR: 'streak reward', OOO: 'out of office' }[type] || String(type || '').toLowerCase();
}
