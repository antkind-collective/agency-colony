// Which briefs are stuck waiting on the client, and when to chase.
//
// A brief a partner submitted sits at `submitted` until a the client coordinator
// approves it. Until then it is deliberately off Your Agency's board — the gate
// Rhea asked for. That makes it the ONE state where a deadline is running
// and nobody at Your Agency can do a thing about it, so it is the state most worth
// chasing (10 Sep 2026: Alice's brief sat 36 hours with a Friday
// deadline after a single 2am email).
//
// Pure: no Supabase, no mail. Tested without either.

const { isWorkingDayIso, shiftIso, workingDaysUntil } = require('./brief-reminders');

// Working days a brief has been waiting, counting the day it was submitted as
// zero — a brief raised this morning is not "a day late" this afternoon.
function waitingWorkingDays(submittedIso, todayIso, holidays = []) {
  if (!submittedIso || !todayIso || submittedIso > todayIso) return 0;
  let days = 0;
  let cursor = submittedIso;
  for (let i = 0; i < 120 && cursor < todayIso; i += 1) {
    cursor = shiftIso(cursor, 1);
    if (isWorkingDayIso(cursor, holidays)) days += 1;
  }
  return days;
}

// Only a real brief from a partner is gated; notify_only quick requests reach
// Your Agency immediately and are nobody's approval to give.
function awaitsClientApproval(brief) {
  return Boolean(brief)
    && brief.request_type === 'brief'
    && brief.status === 'submitted'
    && Boolean(brief.submitted_by_partner_id)
    // On Pause is a decision to stop, not a thing to chase — the same contract
    // briefAcceptsReminders() honours for deadline reminders.
    && !brief.paused_at;
}

// One full working day of silence is the trigger. Less would fire on briefs
// raised overnight before anyone has had a chance to look.
const NUDGE_AFTER_WORKING_DAYS = 1;

// Matches the T-2 deadline reminder: by three working days out, an unapproved
// brief can no longer be delivered on time without something giving.
const URGENT_WITHIN_WORKING_DAYS = 3;

function nudgeFor(brief, todayIso, holidays = []) {
  if (!awaitsClientApproval(brief)) return null;
  const submitted = String(brief.created_at || '').slice(0, 10);
  const waited = waitingWorkingDays(submitted, todayIso, holidays);
  if (waited < NUDGE_AFTER_WORKING_DAYS) return null;
  const due = String(brief.deadline || '').slice(0, 10) || null;
  // Runway in WORKING days, not calendar days. On 10 Sep a 15 Sep deadline
  // looks five days off, but the weekend and Ganesh Chaturthi leave a single
  // working day — which is exactly the situation worth shouting about. Null
  // means the deadline has already gone, which is as urgent as it gets.
  const workingDaysLeft = due ? workingDaysUntil(todayIso, due, holidays) : null;
  return {
    waited,
    due,
    workingDaysLeft,
    // The deadline arriving while the brief is still unapproved is the part
    // that actually costs something, so it leads the message.
    urgent: Boolean(due) && (workingDaysLeft === null || workingDaysLeft <= URGENT_WITHIN_WORKING_DAYS)
  };
}

// Chased once per working day while it stays stuck: this is blocking, so a
// single message is not enough, but more than daily is nagging.
function nudgeKey(briefId, todayIso) {
  return `${briefId}|${todayIso}`;
}

module.exports = { waitingWorkingDays, awaitsClientApproval, nudgeFor, nudgeKey, NUDGE_AFTER_WORKING_DAYS, URGENT_WITHIN_WORKING_DAYS };
