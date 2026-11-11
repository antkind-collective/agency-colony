// The 10:00 cron's task rollover plan (Q2, 24 Sep 2026). Pure: the function
// in daily-reminders.js does the I/O.
//
// What went wrong before: the cron moved EVERY past task that was not 'done'
// to today in one UPDATE. That (1) included 'archived' rows, so each run
// re-dated the whole task archive to that day (~3,000 rows carry a cron
// timestamp), and (2) moved two copies of the same task — or a copy of one
// already on today — onto today together, which uniq_daily_tasks_active
// (employee_id, lower(task_title), task_date, non-archived) rejects. One
// duplicate aborted the whole batch: no one's tasks rolled over from 8 Sep.
//
// The rule now mirrors the browser's carry-forward (planDailyCleanup in
// js/tasks.js): only unfinished dailies move; one task per person and title
// lands on today; everything else it would duplicate is archived, exactly as
// the browser archives an original after copying it forward.
//
// pastRows:     [{ id, employee_id, task_title, task_date, status }] — past, unfinished
// todayActive:  [{ employee_id, task_title }] — non-archived rows already on today
// returns { move: [id…], archive: [id…] }
const UNFINISHED = new Set(['pending', 'in_progress', 'todo']);

// Must match the index exactly: lower(task_title), no trim.
const keyOf = (row) => `${row.employee_id}|${String(row.task_title || '').toLowerCase()}`;

function planTaskRollover(pastRows, todayActive, todayIso) {
  const onToday = new Set((todayActive || []).map(keyOf));
  const groups = new Map();
  for (const row of pastRows || []) {
    if (!row || !row.task_date || row.task_date >= todayIso) continue;
    if (!UNFINISHED.has(row.status)) continue;
    const k = keyOf(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  const move = [];
  const archive = [];
  for (const [k, rows] of groups) {
    // The most recent copy carries the latest edits (description, deadline).
    rows.sort((a, b) => (a.task_date < b.task_date ? 1 : a.task_date > b.task_date ? -1 : String(b.id).localeCompare(String(a.id))));
    const [newest, ...older] = rows;
    if (onToday.has(k)) archive.push(newest.id);
    else move.push(newest.id);
    for (const r of older) archive.push(r.id);
  }
  return { move, archive };
}

module.exports = { planTaskRollover };
