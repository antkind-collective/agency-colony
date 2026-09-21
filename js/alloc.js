/* ── Your Agency allocation week math: pure helpers ──
   Classic script — loads after utils.js, before app.js. PURE ONLY: no DOM,
   no `state`, no Supabase. Allocations are week-based and weeks start on
   MONDAY; month-boundary queries must align to the Monday of the overlapping
   week (CLAUDE.md → Business Rules). Tested in tests/alloc.test.mjs. */

// Monday of the week containing dateValue (Sunday belongs to the PREVIOUS week).
function mondayWeekStartDate(dateValue = new Date()) {
  const date = new Date(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate());
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diffToMonday);
  return date;
}

function getCurrentWeekStartIso() {
  return toISODateLocal(mondayWeekStartDate());
}

function formatPlannerMonthLabel(dateValue) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(dateValue);
}

// Month window from a 'YYYY-MM' string; anything else falls back to `now`'s
// month. (Named monthWindowFor — app.js has DOM wrappers allocMonthWindow/
// plannerMonthWindow reading their own <select>s.)
function monthWindowFor(yearMonthRaw, now = new Date()) {
  const match = String(yearMonthRaw || '').trim().match(/^(\d{4})-(\d{2})$/);
  const year = match ? Number(match[1]) : now.getFullYear();
  const month = match ? Number(match[2]) : now.getMonth() + 1;
  const monthStartDate = new Date(year, month - 1, 1);
  const monthEndDate = new Date(year, month, 0);
  return {
    monthStartDate,
    monthEndDate,
    monthStartIso: toISODateLocal(monthStartDate),
    monthEndIso: toISODateLocal(monthEndDate),
    monthLabel: formatPlannerMonthLabel(monthStartDate)
  };
}

// Mondays of every week overlapping the month — INCLUDING the Monday from the
// previous month when the 1st falls midweek (the month-boundary rule).
function plannerWeekStartsForMonth(monthWindow) {
  const starts = [];
  const cursor = mondayWeekStartDate(monthWindow.monthStartDate);
  while (cursor <= monthWindow.monthEndDate) {
    starts.push(toISODateLocal(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  if (!starts.length) {
    starts.push(getCurrentWeekStartIso());
  }
  return starts.sort((a, b) => String(a).localeCompare(String(b)));
}

function shortWeekLabel(weekStartIso) {
  const parsed = parseIsoDateLocal(weekStartIso);
  if (!parsed) return 'W-';
  const { week } = isoWeekMetaFromDate(parsed);
  return `W${week}`;
}

// Utilization status: <60 under, 60-100 balanced, >100 over — measured against
// the PERSON'S capacity, not a full week. Someone at 40% capacity allocated 40%
// is fully committed; the old capacity-blind version compared 40 to a fixed
// 60/100 scale and labelled them "Under", inviting more work onto a part-timer
// who had none left. Omit capacityPercent (or pass 100) for the full-time case,
// where allocated% and allocated-of-capacity% coincide.
function utilizationStatusMeta(value, capacityPercent = 100) {
  const allocated = Number(value) || 0;
  const capacity = Number(capacityPercent);
  const ceiling = Number.isFinite(capacity) && capacity > 0 ? capacity : 100;
  const numeric = (allocated / ceiling) * 100;
  if (numeric > 100) return { key: 'over', label: 'Over', chipClass: 'rejected' };
  if (numeric < 60) return { key: 'under', label: 'Under', chipClass: 'warn' };
  return { key: 'balanced', label: 'Balanced', chipClass: 'approved' };
}

// Suggest weekly allocation percentages from the task planner (Sam's board
// request, Mar 2026): tasks are already tagged to clients, so pre-fill the
// allocation editor from their distribution instead of starting blank.
// Counts this week's dated tasks (any status except archived — done work
// still consumed the week) plus active undated weekly-planner tasks.
// Percentages come out in steps of 5 summing to exactly 100. This is a
// SUGGESTION the user adjusts and saves — task counts are a proxy for
// attention, not hours.
function suggestAllocationsFromTasks(tasks, weekStartIso) {
  const start = String(weekStartIso || '');
  if (!start) return [];
  const endDate = new Date(start + 'T00:00:00');
  if (isNaN(endDate)) return [];
  endDate.setDate(endDate.getDate() + 7);
  const pad = (n) => String(n).padStart(2, '0');
  const end = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}`;

  const counts = new Map(); // lower(client) -> { client, tasks }
  (tasks || []).forEach((t) => {
    if (!t || t.status === 'archived') return;
    const dated = Boolean(t.task_date);
    if (dated && (t.task_date < start || t.task_date >= end)) return;
    if (!dated && t.status === 'done') return;
    const client = String(t.notes || '').trim();
    if (!client) return;
    const key = client.toLowerCase();
    if (!counts.has(key)) counts.set(key, { client, tasks: 0 });
    counts.get(key).tasks += 1;
  });

  // 20 clients × the 5% floor = 100, so cap there (nobody real gets close)
  const rows = [...counts.values()]
    .sort((a, b) => b.tasks - a.tasks || a.client.localeCompare(b.client))
    .slice(0, 20);
  const total = rows.reduce((s, r) => s + r.tasks, 0);
  if (!total) return [];

  rows.forEach((r) => { r.percent = Math.max(5, Math.round((r.tasks / total) * 20) * 5); });
  // True up rounding drift to exactly 100, biggest buckets first
  let diff = 100 - rows.reduce((s, r) => s + r.percent, 0);
  for (let i = 0; diff !== 0 && i < rows.length * 40; i++) {
    const r = rows[i % rows.length];
    if (diff > 0) { r.percent += 5; diff -= 5; }
    else if (r.percent > 5) { r.percent -= 5; diff += 5; }
  }
  return rows;
}
