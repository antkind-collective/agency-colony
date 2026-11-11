// Which approved briefs nobody at Your Agency has picked up, and when to chase.
//
// The mirror of approval-nudge.js. That one chases the CLIENT while a brief
// sits at `submitted`; this one chases AGENCY while a brief sits at
// `ready_for_review`. Alice's brief escaped the first gap on 10 Sep 2026 and
// fell straight into this one: approved at 20:24, emailed to three leads,
// still unlocked with no deliverable the next morning — and because deadline
// reminders key on deliverables, nothing was ever going to fire (11 Sep).
//
// "Picked up" means someone has moved it on (Start creative / pending info)
// or at least put a deliverable with an owner under it. Either is proof a
// human has it; before that, the brief is nobody's.
//
// Pure: no Supabase, no mail. Tested without either.

const { waitingWorkingDays } = require('./approval-nudge');
const { workingDaysUntil } = require('./brief-reminders');

const NUDGE_AFTER_WORKING_DAYS = 1;
const URGENT_WITHIN_WORKING_DAYS = 3;

function awaitsPickup(brief, deliverables = []) {
  if (!brief || brief.request_type !== 'brief') return false;
  if (brief.status !== 'ready_for_review') return false;
  if (brief.paused_at) return false;
  // A deliverable with an owner is a human saying "mine". Unowned ones do not
  // count — they can be created by the intake form with nobody behind them.
  // Since 21 Oct 2026 a piece has a copy and a design owner.
  return !deliverables.some((d) => d.brief_id === brief.id
    && (d.assignee_employee_id || d.copy_assignee_id || d.design_assignee_id));
}

// `approvedIso` is the day it entered ready_for_review, from status history —
// NOT created_at, which is the day the client raised it and could be much
// earlier. Chasing Your Agency for the client's own waiting time would be unfair
// and would fire on day one.
function pickupNudgeFor(brief, deliverables, approvedIso, todayIso, holidays = []) {
  if (!awaitsPickup(brief, deliverables)) return null;
  if (!approvedIso) return null;
  const waited = waitingWorkingDays(String(approvedIso).slice(0, 10), todayIso, holidays);
  if (waited < NUDGE_AFTER_WORKING_DAYS) return null;
  const due = String(brief.deadline || '').slice(0, 10) || null;
  const workingDaysLeft = due ? workingDaysUntil(todayIso, due, holidays) : null;
  return {
    waited,
    due,
    workingDaysLeft,
    urgent: Boolean(due) && (workingDaysLeft === null || workingDaysLeft <= URGENT_WITHIN_WORKING_DAYS)
  };
}

function pickupNudgeKey(briefId, todayIso) { return `${briefId}|${todayIso}`; }

// Quick requests nobody has acknowledged (27 Sep 2026). A quick request
// ("notify_only") never goes on the board, so one the client sent on 10 Sep sat as
// "New" for over two weeks with nothing chasing it. Same cadence as a brief:
// after one working day, once per working day, until someone acknowledges or
// closes it. The clock starts when the client sent it — there is no approval step.
function awaitsAcknowledgement(brief) {
  return Boolean(brief) && brief.request_type === 'notify_only'
    && brief.status === 'submitted' && !brief.paused_at;
}
function quickRequestNudgeFor(brief, todayIso, holidays = []) {
  if (!awaitsAcknowledgement(brief) || !brief.created_at) return null;
  const waited = waitingWorkingDays(String(brief.created_at).slice(0, 10), todayIso, holidays);
  return waited >= NUDGE_AFTER_WORKING_DAYS ? { waited } : null;
}
function quickRequestNudgeKey(briefId, todayIso) { return `quick|${briefId}|${todayIso}`; }

module.exports = { awaitsPickup, pickupNudgeFor, pickupNudgeKey, awaitsAcknowledgement, quickRequestNudgeFor, quickRequestNudgeKey, NUDGE_AFTER_WORKING_DAYS, URGENT_WITHIN_WORKING_DAYS };
