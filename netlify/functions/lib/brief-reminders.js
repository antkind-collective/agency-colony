// Who gets chased about a brief deadline, and when.
//
// Rhea's internal workflow doc, step 5: two working days before the
// deadline, one working day before, and on the deadline itself if the status
// has not moved. Email plus the notification bell, cc the AM.
//
// Everything here is PURE and free of Supabase so the decision can be tested
// without sending anything — this is the part that, if wrong, emails the whole
// team about work that is finished, paused, or not theirs. The cron does the
// querying and the sending; it makes no judgements of its own.

// Weekends are the only universal non-working days; holidays come from
// app.public_holidays as an array of 'YYYY-MM-DD' IST dates.
function isWorkingDayIso(iso, holidays = []) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !holidays.includes(iso);
}

function shiftIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Working days remaining: counted AFTER today, up to and including the due
// date. So a Friday deadline is "2 working days away" on Wednesday — which is
// the day the doc wants the first nudge to go out. Returns null when the due
// date has already passed; the doc asks for a reminder on the deadline, not a
// standing nag afterwards, and overdue work is already flagged in the app.
function workingDaysUntil(todayIso, dueIso, holidays = []) {
  if (!todayIso || !dueIso) return null;
  if (dueIso < todayIso) return null;
  let count = 0;
  let cursor = todayIso;
  // Bounded: a deadline more than ~3 months out needs no reminder today, and
  // the loop must never depend on data to terminate.
  for (let i = 0; i < 120 && cursor < dueIso; i += 1) {
    cursor = shiftIso(cursor, 1);
    if (isWorkingDayIso(cursor, holidays)) count += 1;
  }
  return cursor === dueIso ? count : null;
}

// Reminders only go out on working days. This is NOT the same question as
// "how many working days are left": from a Saturday there is still exactly one
// working day until a Tuesday deadline, so the arithmetic happily returns 't1'
// and would nudge someone on their weekend. The cron asks this first.
function isReminderRunDay(todayIso, holidays = []) {
  return isWorkingDayIso(todayIso, holidays);
}

const REMINDER_STAGES = { 2: 't2', 1: 't1', 0: 'due' };

// Which reminder, if any, is due today for this deadline.
function reminderStageFor(dueIso, todayIso, holidays = []) {
  const remaining = workingDaysUntil(todayIso, dueIso, holidays);
  if (remaining === null) return null;
  return REMINDER_STAGES[remaining] || null;
}

// A deliverable that is finished or unassigned is nobody's to chase. The enum
// is queued | in_progress | in_review | ready_to_share | delivered — only the
// last is done. 'ready_to_share' is deliberately still chased: ready is not
// delivered, and the deadline is about the handover, not the craft.
const DELIVERABLE_DONE = ['delivered'];
// Mirrors briefWantsReminders() in js/briefs.js — the two must agree.
const BRIEF_DONE = ['completed', 'closed'];

function briefAcceptsReminders(brief) {
  if (!brief) return false;
  if (brief.paused_at) return false;           // On Pause — the whole point
  return !BRIEF_DONE.includes(brief.status);
}

// The single decision. Returns { stage, dueIso } or null.
// `deliverable` carries due_at, status, assignee_employee_id; `brief` carries
// status and paused_at.
function reminderFor(deliverable, brief, todayIso, holidays = []) {
  if (!deliverable || !briefAcceptsReminders(brief)) return null;
  if (!deliverable.assignee_employee_id) return null;
  if (DELIVERABLE_DONE.includes(deliverable.status)) return null;
  if (deliverable.delivered_at) return null;
  const dueIso = String(deliverable.due_at || '').slice(0, 10);
  if (!dueIso) return null;
  const stage = reminderStageFor(dueIso, todayIso, holidays);
  return stage ? { stage, dueIso } : null;
}

// One email per deliverable per stage, ever. The key is deliberately NOT
// date-stamped: if the cron fails and re-runs, or a deadline is moved back and
// forth across a boundary, the person should not be told twice about the same
// stage of the same piece of work.
function reminderKey(deliverableId, stage) {
  return `${deliverableId}|${stage}`;
}

const STAGE_COPY = {
  t2: { lead: 'is due in 2 working days', tone: 'a heads-up' },
  t1: { lead: 'is due tomorrow', tone: 'a nudge' },
  due: { lead: 'is due today', tone: 'a reminder' }
};

module.exports = {
  isWorkingDayIso,
  isReminderRunDay,
  shiftIso,
  workingDaysUntil,
  reminderStageFor,
  briefAcceptsReminders,
  reminderFor,
  reminderKey,
  STAGE_COPY,
  REMINDER_STAGES,
  DELIVERABLE_DONE,
  BRIEF_DONE
};
