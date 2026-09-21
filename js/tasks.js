/* ── Your Agency task logic: pure planning/selection helpers ──
   Classic script — loads after utils.js (uses taskTitleKey), before app.js.
   PURE ONLY: no DOM, no `state`, no Supabase. Functions take task arrays and
   return decisions; app.js executes the I/O and mutates local state. This is
   the most bug-prone area of the app (carry-forward zombies, done-cascade —
   see CLAUDE.md → Task System), which is why the decisions live here where
   tests/tasks.test.mjs can pin them down.

   Task shape: { id, employee_id, task_date (ISO date | null = weekly),
                 task_title, status: 'todo'|'in_progress'|'done'|'archived',
                 notes, description, deadline, sort_order, updated_at, created_at } */

// Linked tasks that must follow a status change on `task`. Matching is by
// taskTitleKey + same employee (the DB's lower(task_title) unique index rule).
// mode 'cascade-done' (marking done): daily → weekly original AND all other
//   daily copies; weekly → all daily copies. Skips done + archived (already
//   terminal). Without this cascade, old copies stay in_progress and get
//   re-carried forward — zombie tasks.
// mode 'sync-status' (any status change): daily → the weekly original only;
//   weekly → all daily copies. Skips archived only (done may be reopened).
function linkedTasksFor(task, allTasks, mode) {
  const key = taskTitleKey(task.task_title);
  const isDaily = task.task_date !== null;
  const cascade = mode === 'cascade-done';
  return allTasks.filter((t) => {
    if (t.id === task.id) return false;
    if (t.employee_id !== task.employee_id) return false;
    if (taskTitleKey(t.task_title) !== key) return false;
    if (t.status === 'archived') return false;
    if (cascade && t.status === 'done') return false;
    if (isDaily) {
      // daily → cascade touches everything (weekly + other dailies);
      // sync touches only the weekly original
      return cascade ? true : t.task_date === null;
    }
    // weekly → only daily copies, in both modes
    return t.task_date !== null;
  });
}

// The daily-cleanup plan (carry-forward). Pure decision phase of the block in
// loadDailyTasksFromSupabase; app.js executes the three I/O steps.
// opts: { todayIso, weekStartIso, dayOfWeek (0=Sun..6), employeeId }
// Returns task-object references so app.js can mutate local state post-I/O:
//   pastDoneDaily  — done dailies from PAST days → archive (today's stay visible)
//   carryTasks     — past unfinished dailies to carry forward (deduped by title
//                    against today's existing + among themselves), then archive
//   copies         — fresh insert templates for today (preserve title/notes/
//                    description/deadline/status/sort_order)
//   weeklyDone     — done weekly tasks to archive (all on Monday; other days
//                    only those finished before this week started)
function planDailyCleanup(myTasks, opts) {
  const { todayIso, weekStartIso, dayOfWeek, employeeId } = opts;

  const pastDoneDaily = myTasks.filter(
    (t) => t.status === 'done' && t.task_date && t.task_date < todayIso
  );

  const todayExisting = new Set(
    myTasks
      .filter((t) => t.task_date === todayIso && t.status !== 'archived')
      .map((t) => taskTitleKey(t.task_title))
  );
  const seenCarry = new Set();
  const carryTasks = myTasks.filter((t) => {
    if (!t.task_date || t.task_date >= todayIso) return false;
    if (t.status !== 'in_progress' && t.status !== 'todo') return false;
    const k = taskTitleKey(t.task_title);
    if (todayExisting.has(k) || seenCarry.has(k)) return false;
    seenCarry.add(k);
    return true;
  });
  const copies = carryTasks.map((t) => ({
    employee_id: employeeId,
    task_date: todayIso,
    task_title: t.task_title,
    notes: t.notes || null,
    description: t.description || null,
    deadline: t.deadline || null,
    status: t.status,
    sort_order: t.sort_order || 0,
    recurring_task_id: t.recurring_task_id || null
  }));

  const weeklyDone = myTasks.filter((t) => {
    if (t.status !== 'done' || t.task_date !== null) return false;
    if (dayOfWeek === 1) return true; // Monday: fresh weekly slate
    const ts = (t.updated_at || t.created_at || '').slice(0, 10);
    return ts && ts < weekStartIso;
  });

  return { pastDoneDaily, carryTasks, copies, weeklyDone };
}

// Weekly Planner "today ✓" chip: does this weekly task already have a live
// copy in TODAY's daily list? Same title-key matching as the cascade rules.
function hasDailyCopyToday(task, allTasks, todayIso) {
  const key = taskTitleKey(task.task_title);
  return (allTasks || []).some((t) =>
    t.id !== task.id &&
    t.employee_id === task.employee_id &&
    t.task_date === todayIso &&
    t.status !== 'archived' &&
    taskTitleKey(t.task_title) === key
  );
}

// Weekdays as the DB stores them: 0=Sunday..6=Saturday, matching JS getDay()
// and the cron's zonedParts().day, so no side has to translate.
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Is a recurring rule due on todayIso? Monthly clamps day_of_month to the
// month's last day (a "31st" rule fires on Feb 28/29, Apr 30, ...); weekly
// matches the weekday. Takes the rule row so a caller can never pair the wrong
// cadence with the wrong day.
function recurringRuleDueOn(rule, todayIso) {
  const d = parseIsoDateLocal(todayIso);
  if (!d || !rule) return false;
  if (rule.frequency === 'weekly') {
    return Number.isInteger(rule.day_of_week) && d.getDay() === rule.day_of_week;
  }
  if (!rule.day_of_month) return false;
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return d.getDate() === Math.min(rule.day_of_month, lastDay);
}

// How the rule reads in the manage list and the save confirmation.
function recurringRuleLabel(rule) {
  if (!rule) return '';
  return rule.frequency === 'weekly'
    ? `weekly on ${WEEKDAY_NAMES[rule.day_of_week] || '?'}`
    : `monthly on the ${rule.day_of_month}`;
}
