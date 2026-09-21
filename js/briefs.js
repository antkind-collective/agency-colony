// Brief pipeline pure logic (the client Brief Tracking Dashboard).
// Status flow, required-field validation, SLA due-date math. No DOM, no
// Supabase — everything here is unit-testable in the vm harness.

// Full-brief pipeline in board order. notify_only requests use NOTIFY_FLOW.
// v2 (10 Aug): 'locked' retired as a visible stage (edit-freeze is stage-
// bound); 'under_revision' added for the client feedback after delivery.
const BRIEF_PIPELINE_COLUMNS = ['submitted', 'pending_info', 'ready_for_review', 'in_creative', 'delivered', 'under_revision', 'completed'];
const NOTIFY_FLOW = ['submitted', 'acknowledged', 'closed'];

// ── On pause (Rhea via Alex, 7 Sep 2026) ──────────────────────────────
// the client's tracker has always had a parked state; Colony hasn't. It is a FLAG,
// not a status: the brief keeps the stage it was paused from so resuming puts
// it back exactly there, and every existing transition stays untouched.
// The board shows paused work in its own column regardless of that stage,
// which is how the tracker reads and how the team looks for it.
const BRIEF_PAUSED_COLUMN = 'on_pause';
const BRIEF_BOARD_COLUMNS = [...BRIEF_PIPELINE_COLUMNS, BRIEF_PAUSED_COLUMN];

// Terminal work cannot be paused — there is nothing left to hold.
const BRIEF_UNPAUSABLE = ['completed', 'closed'];

// ── The the client approval gate (Rhea, board bug 7 Sep 2026) ──────────────────
// "New briefs should go to Grace first before reaching Your Agency."
//
// The Approve & send to Your Agency button already existed, but the gate was
// decorative: our board listed `submitted` as its first column, so a brief was
// on Your Agency's desk the moment a partner pressed send and any reviewer could
// walk it forward without the client ever approving.
//
// Only PARTNER-submitted briefs are gated. One an AM logs internally has no
// client approval to wait for, and gating it would strand it where nobody
// looks.
function briefAwaitsClientApproval(brief) {
  if (!brief || brief.request_type !== 'brief') return false;
  if (brief.status !== 'submitted') return false;
  return Boolean(brief.submitted_by_partner_id);
}

function isBriefPaused(brief) {
  return Boolean(brief && brief.paused_at);
}

function canPauseBrief(brief) {
  return Boolean(brief) && !isBriefPaused(brief) && !BRIEF_UNPAUSABLE.includes(brief.status);
}

// Which board column a brief belongs in. Paused work leaves its stage column
// so nobody counts it as in-flight, but the stage itself is untouched.
function briefBoardColumn(brief) {
  return isBriefPaused(brief) ? BRIEF_PAUSED_COLUMN : brief?.status;
}

// Paused reads as the status everywhere, with the stage it will return to
// kept alongside — "On pause" alone loses the one fact needed to resume.
function briefStatusLabel(brief) {
  if (!brief) return '';
  if (isBriefPaused(brief)) return 'On pause';
  return BRIEF_STATUS_LABEL[brief.status] || brief.status;
}

function briefPauseDetail(brief) {
  if (!isBriefPaused(brief)) return '';
  const stage = BRIEF_STATUS_LABEL[brief.status] || brief.status;
  const why = (brief.pause_reason || '').trim();
  return why ? `Paused from ${stage} — ${why}` : `Paused from ${stage}`;
}

// The one rule the reminder job must honour: never chase parked work.
function briefWantsReminders(brief) {
  return Boolean(brief) && !isBriefPaused(brief) && !BRIEF_UNPAUSABLE.includes(brief.status);
}

const BRIEF_STATUS_LABEL = {
  submitted: 'New brief',
  pending_info: 'Pending info',
  ready_for_review: 'With Your Agency',
  locked: 'Locked',
  in_creative: 'In creative',
  delivered: 'Delivered',
  under_revision: 'Under revision',
  completed: 'Completed',
  acknowledged: 'Acknowledged',
  closed: 'Closed'
};

// Sanctioned transitions. Reopen (delivered → in_creative, per the client feedback
// loop) is deliberate and logged by the status-history trigger.
const BRIEF_TRANSITIONS = {
  brief: {
    submitted: ['ready_for_review', 'pending_info'],
    pending_info: ['ready_for_review', 'submitted'],
    ready_for_review: ['pending_info', 'in_creative'],
    locked: ['in_creative', 'ready_for_review'],  // legacy escape only
    in_creative: ['delivered'],
    delivered: ['under_revision', 'completed'],
    under_revision: ['delivered'],
    completed: []
  },
  notify_only: {
    submitted: ['acknowledged', 'closed'],
    acknowledged: ['closed'],
    closed: []
  }
};

function isValidBriefTransition(fromStatus, toStatus, requestType = 'brief') {
  const flow = BRIEF_TRANSITIONS[requestType] || BRIEF_TRANSITIONS.brief;
  return Array.isArray(flow[fromStatus]) && flow[fromStatus].includes(toStatus);
}

// Moving a paused brief would quietly resume it under a different stage than
// the one it will be put back to, so the pause has to be lifted first.
function allowedBriefActions(brief, requestType = 'brief') {
  if (isBriefPaused(brief)) return [];
  const flow = BRIEF_TRANSITIONS[requestType] || BRIEF_TRANSITIONS.brief;
  return flow[brief?.status] || [];
}

// Required fields per request type — per the SLA doc's "Brief Requirement"
// checklist merged with the intake form. Field keys match app.briefs columns.
const BRIEF_REQUIRED_FIELDS = {
  // v2 (10 Aug, Rhea): all substantive questions required. Still optional:
  // links, media credits, publish date, notes, attachments.
  brief: [
    { key: 'title', label: 'Title' },
    { key: 'objective', label: 'Objective' },
    { key: 'key_message', label: 'Key message' },
    { key: 'audience', label: 'Audience' },
    { key: 'content_text', label: 'Copy / content inputs' },
    { key: 'key_dates', label: 'Key dates' },
    { key: 'platforms', label: 'Platform(s)' },
    { key: 'requested_deliverables', label: 'Deliverable(s)' },
    { key: 'deadline', label: 'Deadline' },
    { key: 'approver_name', label: 'Who approves this content' }
  ],
  notify_only: [
    { key: 'title', label: 'Title' },
    { key: 'content_text', label: 'Message' }
  ]
};

function briefMissingFields(brief) {
  const type = brief?.request_type === 'notify_only' ? 'notify_only' : 'brief';
  return BRIEF_REQUIRED_FIELDS[type].filter(({ key }) => {
    const v = brief?.[key];
    if (Array.isArray(v)) return v.length === 0;
    return v === null || v === undefined || String(v).trim() === '';
  });
}

// Deliverable options partners can request. Labels follow the signed SLA
// (app.client_sla), which is readable by partners; this list also carries the
// few types the SLA does not quote (caption, emailer, other).
const BRIEF_DELIVERABLE_OPTIONS = [
  { type: 'static', label: 'Social media static' },
  { type: 'caption', label: 'Caption' },
  { type: 'emailer', label: 'Emailer' },
  { type: 'carousel', label: 'Carousel' },
  { type: 'story_set', label: 'Story set (2)' },
  { type: 'short_form', label: 'Short video (~30s)' },
  { type: 'reel', label: 'Reel (45–60s)' },
  { type: 'event_highlight', label: 'Event highlight video' },
  { type: 'motion_graphics', label: 'Motion graphics' },
  { type: 'complex_animation', label: 'Complex animation' },
  { type: 'newsletter', label: 'Newsletter' },
  { type: 'slides_10', label: 'Presentation slides (10)' },
  { type: 'slides_20', label: 'Presentation slides (20)' },
  { type: 'announcement_board', label: 'Announcement board' },
  { type: 'content_calendar', label: 'Content calendar' },
  { type: 'campaign_concept', label: 'Campaign concept' },
  { type: 'toolkit', label: 'Campaign toolkit' },
  { type: 'adaptations', label: 'Campaign adaptations' },
  { type: 'event_collateral', label: 'Event collateral suite' },
  { type: 'other', label: 'Other (describe in notes)' }
];

// 'Other' added 11 Sep 2026 (Rhea's board request). Alice had already hit
// the gap: a print postcard, "selected Website as nothing else matched". The
// specifics go in the brief's own copy field; this just stops a wrong platform
// being recorded because the right one was missing.
const BRIEF_PLATFORM_OPTIONS = ['Instagram', 'Facebook', 'LinkedIn', 'TikTok', 'Newsletter', 'Email', 'Website', 'Other'];

const BRIEF_PRIORITY_META = {
  // Inclusive working days, same convention as the SLA: 1 = due end of the day
  // work starts, 2 = end of the next working day.
  P0: { label: 'P0 — Critical (same day)', short: 'P0', slaOverrideDays: 1 },
  P1: { label: 'P1 — High (24h)', short: 'P1', slaOverrideDays: 2 },
  P2: { label: 'P2 — Standard (per SLA)', short: 'P2', slaOverrideDays: null },
  P3: { label: 'P3 — Low (scheduled)', short: 'P3', slaOverrideDays: null }
};

// Due date for a deliverable. Now that the internal and client SLA are the same
// number, this must land on the SAME day the client was promised — which means WORKING
// days (weekends and Your Agency holidays skipped), not calendar days, and counted
// inclusively: "2 working days" started on Monday is due end of Tuesday.
// P0 = same working day, P1 = the next one, per the priority matrix.
function deliverableDueAt(startedAtIso, slaDays, priority, holidays = []) {
  if (!startedAtIso) return null;
  const start = new Date(startedAtIso);
  if (Number.isNaN(start.getTime())) return null;
  const override = BRIEF_PRIORITY_META[priority]?.slaOverrideDays;
  const days = (override !== null && override !== undefined)
    ? override
    : (Number.isFinite(Number(slaDays)) ? Number(slaDays) : 1);
  // Work cannot begin on a closed day, so neither can the clock.
  let startIso = start.toISOString().slice(0, 10);
  while (!isWorkingDay(startIso, holidays)) startIso = shiftIsoDays(startIso, 1);
  const dueIso = addWorkingDays(startIso, Math.max(days, 1), holidays);
  // Due END of that day, not the instant work started.
  return `${dueIso}T23:59:59.999Z`;
}

function deliverableIsOverdue(deliverable, nowIso) {
  if (!deliverable || deliverable.status === 'delivered' || !deliverable.due_at) return false;
  const now = nowIso ? new Date(nowIso) : new Date();
  return now.getTime() > new Date(deliverable.due_at).getTime();
}

// Partner timeline — the client's view per Rhea (10 Aug follow-up): no 'In
// creative' step (that's internal detail; while in creative the brief is
// simply still 'With Your Agency'), 'Deliverables received' instead of
// 'Delivered', and 'Under revision' as a real step. pending_info renders as
// a badge on the first step.
const BRIEF_TIMELINE_STEPS = ['submitted', 'ready_for_review', 'delivered', 'under_revision', 'completed'];
const BRIEF_TIMELINE_STEP_LABELS = {
  submitted: 'New brief',
  ready_for_review: 'With Your Agency',
  delivered: 'Deliverables received',
  under_revision: 'Under revision',
  completed: 'Completed'
};

function briefTimelinePosition(status) {
  if (status === 'pending_info') return { step: 0, badge: 'needs your info' };
  if (status === 'in_creative' || status === 'locked') return { step: 1, badge: '' };
  const i = BRIEF_TIMELINE_STEPS.indexOf(status);
  return { step: i === -1 ? 0 : i, badge: '' };
}

// The client Timeline grouped by stage (7 Sep 2026). The old view drew
// a five-dot stepper on every brief, so answering "what is with Your Agency right
// now?" meant reading every card and decoding a row of circles. Same stage
// vocabulary, listed instead of drawn — plus On pause, which the stepper had no
// way to show at all. Empty groups are dropped: a client should see the four
// stages their work is actually in, not eleven headings.
function groupBriefsByTimelineStage(briefs = []) {
  const order = [...BRIEF_TIMELINE_STEPS, BRIEF_PAUSED_COLUMN];
  const buckets = new Map(order.map((k) => [k, []]));
  briefs.forEach((b) => {
    // Paused wins over the stage, exactly as it does on the internal board.
    const key = isBriefPaused(b)
      ? BRIEF_PAUSED_COLUMN
      : BRIEF_TIMELINE_STEPS[briefTimelinePosition(b.status).step];
    if (buckets.has(key)) buckets.get(key).push(b);
  });
  return order
    .map((key) => ({
      key,
      label: key === BRIEF_PAUSED_COLUMN ? 'On pause' : BRIEF_TIMELINE_STEP_LABELS[key],
      briefs: buckets.get(key) || []
    }))
    .filter((g) => g.briefs.length);
}

// ── SLA turnaround maths (Your Agency × Example Collective SLA, 17 Jul 2026) ────────
// The generic working-day helpers (isWorkingDay / shiftIsoDays / addWorkingDays)
// live in js/utils.js — EVERY deadline Colony computes has to skip weekends and
// Your Agency holidays, not just brief SLAs (24 Aug 2026).

function slaStartDate(iso, istHour, holidays = []) {
  let start = iso;
  if (istHour >= 14) start = shiftIsoDays(start, 1);
  while (!isWorkingDay(start, holidays)) start = shiftIsoDays(start, 1);
  return start;
}

// Day 1 is the start day itself, so `days` working days means advancing
// (days - 1) further working days.
function addWorkingDays(startIso, days, holidays = []) {
  if (!Number.isFinite(days) || days <= 0) return startIso;
  let cursor = startIso;
  let remaining = days - 1;
  while (remaining > 0) {
    cursor = shiftIsoDays(cursor, 1);
    if (isWorkingDay(cursor, holidays)) remaining -= 1;
  }
  return cursor;
}

// The realistic date for a whole request: the slowest deliverable governs.
function suggestedDeadline(types, slaByType, todayIso, istHour, holidays = []) {
  const days = (types || [])
    .map((t) => slaByType?.[t]?.max_days)
    .filter((d) => Number.isFinite(d));
  if (!days.length) return null;
  const start = slaStartDate(todayIso, istHour, holidays);
  return addWorkingDays(start, Math.max(...days), holidays);
}

function formatSlaDays(sla) {
  if (!sla) return null;
  if (!Number.isFinite(sla.min_days) || !Number.isFinite(sla.max_days)) {
    return sla.note || 'Scoped per project';
  }
  const range = sla.min_days === sla.max_days ? `${sla.max_days}` : `${sla.min_days}–${sla.max_days}`;
  return `${range} working day${sla.max_days === 1 ? '' : 's'}`;
}

function nextHoliday(todayIso, holidays = []) {
  return (holidays || [])
    .filter((h) => h && h.date >= todayIso)
    .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
}

function holidaysBetween(startIso, endIso, holidays = []) {
  if (!startIso || !endIso) return [];
  return (holidays || []).filter((h) => h.date >= startIso && h.date <= endIso);
}

// ── Waiting on the client ─────────────────────────────────────────────────
// A brief at `submitted` is behind the the client approval gate: the deadline is
// running and nobody at Your Agency can touch it. It used to be one grey line of
// small print above the board, which is how Alice's sat for 36 hours with a
// Friday deadline and nobody noticed (10 Sep 2026). This works out how
// bad each one is so the board can say so loudly.
//
// Urgency is in WORKING days to match brief-reminders.js. On 10 Sep a 15 Sep
// deadline looks five days off; the weekend and Ganesh Chaturthi leave two.
const BRIEF_APPROVAL_URGENT_WORKING_DAYS = 3;

function briefApprovalWait(brief, todayIso, holidays = []) {
  if (!briefAwaitsClientApproval(brief) || !todayIso) return null;
  const submitted = String(brief.created_at || '').slice(0, 10);
  const waited = submitted && submitted <= todayIso
    ? workingDaysBetween(submitted, todayIso, holidays) : 0;
  const due = String(brief.deadline || '').slice(0, 10) || null;
  // Null means there is no runway left to measure — either no deadline, or it
  // has already gone. The two read very differently, so `overdue` separates
  // them rather than leaving the caller to guess.
  const workingDaysLeft = due && due >= todayIso ? workingDaysBetween(todayIso, due, holidays) : null;
  const overdue = Boolean(due) && due < todayIso;
  return {
    id: brief.id,
    title: brief.title,
    waited,
    due,
    workingDaysLeft,
    overdue,
    paused: isBriefPaused(brief),
    // A paused brief is a decision to stop, not something to shout about —
    // the same reason the nudge cron skips it.
    urgent: !isBriefPaused(brief) && Boolean(due)
      && (overdue || workingDaysLeft <= BRIEF_APPROVAL_URGENT_WORKING_DAYS)
  };
}

// Plain English for the banner. Kept next to the maths so the wording and the
// thresholds cannot drift apart.
function briefApprovalWaitLabel(wait) {
  if (!wait) return '';
  const waited = wait.waited <= 0
    ? 'submitted today'
    : `waiting ${wait.waited} working day${wait.waited === 1 ? '' : 's'}`;
  if (wait.paused) return `${waited} · on pause`;
  if (wait.overdue) return `${waited} · deadline already passed`;
  if (wait.workingDaysLeft === null) return `${waited} · no deadline set`;
  if (wait.workingDaysLeft === 0) return `${waited} · due today`;
  return `${waited} · ${wait.workingDaysLeft} working day${wait.workingDaysLeft === 1 ? '' : 's'} until the deadline`;
}

// ── Raised for someone else ───────────────────────────────────────────────
// Who to credit on a card. The submitter stays the audit truth — this only
// decides what a human reads at a glance, and a brief logged for Adam should
// say Adam, not the colleague who typed it in.
function briefRequesterLine(brief, submitterName) {
  const on = String(brief?.on_behalf_of_name || '').trim();
  if (!on) return submitterName || '';
  return submitterName ? `${on} · via ${submitterName}` : on;
}

// Long form for the drawer, where there is room to say who to go back to.
function briefOnBehalfDetail(brief) {
  const on = String(brief?.on_behalf_of_name || '').trim();
  if (!on) return '';
  const email = String(brief?.on_behalf_of_email || '').trim();
  return email ? `${on} (${email})` : on;
}
