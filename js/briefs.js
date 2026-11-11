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

// May this partner edit, comment on, upload to or request a revision of this
// brief? Mirrors the DB exactly: app.partner_can_edit_brief (coordinator ⇒ any
// brief in their org, otherwise only their own) AND the role test every
// partner write policy adds (submitter or coordinator; client_viewer never).
// Reading is wider — every partner sees the whole org's briefs — so the
// controls must follow this, not visibility. No partner profile (staff on
// Circle) ⇒ false: they act from Colony.
function partnerCanWriteBrief(brief, partner) {
  if (!brief || !partner || !partner.id) return false;
  if (partner.org && brief.org && partner.org !== brief.org) return false;
  if (partner.partner_role === 'coordinator') return true;
  if (partner.partner_role !== 'submitter') return false;
  return brief.submitted_by_partner_id === partner.id;
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
  // v3 (21 Sep 2026, Alex's plan, Mara's go): the form felt like a lot to
  // fill in, so a brief now needs only its four questions: what do you need
  // (a title plus the formats, which drive the turnaround), what's it for, who's
  // it for, and by when. Everything else is under "Add more detail" and is
  // optional; the team asks via Pending info if they need more.
  brief: [
    { key: 'title', label: 'What do you need' },
    { key: 'requested_deliverables', label: 'Format(s)' },
    { key: 'objective', label: "What it's for" },
    { key: 'audience', label: "Who it's for" },
    { key: 'deadline', label: 'By when' }
  ],
  notify_only: [
    { key: 'title', label: 'Title' },
    { key: 'content_text', label: 'Message' }
  ]
};

// "Needed first" only means something when a brief asks for two or more
// formats, and only for formats it still asks for (unticking a format drops
// its needed-first mark). The DB enforces the second rule too.
function neededFirstFor(requested, ticked) {
  const req = Array.isArray(requested) ? requested : [];
  if (req.length < 2) return [];
  return (Array.isArray(ticked) ? ticked : []).filter((t, i, all) => req.includes(t) && all.indexOf(t) === i);
}

// "Request something related": a new brief linked to this one. It carries over
// the context that is usually the same (why, who for, message, platforms,
// approver, who it is for) and leaves blank what a follow-up must decide for
// itself (what, which formats, by when).
function relatedBriefPrefill(parent) {
  if (!parent?.id) return null;
  return {
    request_type: 'brief',
    parent_brief_id: parent.id,
    objective: parent.objective || '',
    audience: parent.audience || '',
    key_message: parent.key_message || '',
    platforms: [...(parent.platforms || [])],
    approver_name: parent.approver_name || '',
    on_behalf_of_name: parent.on_behalf_of_name || '',
    on_behalf_of_email: parent.on_behalf_of_email || '',
    priority: 'P2'
  };
}

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

// A brief that has been handed over is past the point where a date can be
// late: delivered, completed, acknowledged (quick requests) or closed. Its
// dates stay visible but are never red (30 Sep 2026: five delivered
// cards all showed red dates).
const BRIEF_FINISHED_STATUSES = ['delivered', 'completed', 'acknowledged', 'closed'];
function briefIsFinished(brief) {
  return Boolean(brief && BRIEF_FINISHED_STATUSES.includes(brief.status));
}

// `brief` is optional: pass it so a finished brief's deliverables never read
// as overdue, whatever their own status says.
function deliverableIsOverdue(deliverable, nowIso, brief) {
  if (briefIsFinished(brief)) return false;
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
  const due = briefDueDate(brief);
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

// ── The brief list's track (13 Oct 2026: option B) ─────────────────
// One line per brief instead of stage columns: five dots, each named, the
// current one bold with "with <who>" under it. The team's view and the client's use the
// same five positions with their own words. Off-track statuses sit on the dot they
// belong to and say what they are: Pending info on the first, Under revision
// on the third.
const BRIEF_TRACK = {
  team: ['New brief', 'With Your Agency', 'In creative', 'Delivered', 'Completed'],
  client: ['Sent', 'Approved', 'In creative', 'Delivered', 'Completed']
};
const BRIEF_TRACK_STEP = { submitted: 0, pending_info: 0, ready_for_review: 1, in_creative: 2, under_revision: 2, delivered: 3, completed: 4 };
const BRIEF_TRACK_OWN_LABEL = {
  team: { pending_info: 'Pending info', under_revision: 'Under revision' },
  client: { submitted: 'Sent', pending_info: 'Needs info', under_revision: 'Being revised' }
};

function briefTrack(brief, audience = 'team') {
  const labels = (BRIEF_TRACK[audience] || BRIEF_TRACK.team).slice();
  const step = BRIEF_TRACK_STEP[brief?.status] ?? 0;
  const own = (BRIEF_TRACK_OWN_LABEL[audience] || {})[brief?.status];
  if (own) labels[step] = own;
  if (isBriefPaused(brief)) labels[step] = 'On pause';
  return { labels, step };
}

// Due date for the list: "2 Oct", and how late an unfinished brief is.
// The date a brief is due now. A new date agreed with the client wins over
// the one they asked for; `deadline` itself never changes, so a slip stays
// visible (Alex and Rhea, 21 Oct 2026).
function briefDueDate(brief) {
  return String(brief?.revised_deadline || brief?.deadline || '').slice(0, 10) || null;
}

// The date the client asked for, only when a new date replaced it.
function briefWasDate(brief) {
  const revised = String(brief?.revised_deadline || '').slice(0, 10);
  const asked = String(brief?.deadline || '').slice(0, 10);
  return revised && asked && revised !== asked ? asked : null;
}

function briefDueInfo(deadline, todayIso, finished) {
  if (!deadline) return { text: '', late: false };
  const d = new Date(`${String(deadline).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { text: '', late: false };
  const text = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (finished || String(deadline).slice(0, 10) >= todayIso) return { text, late: false };
  const days = Math.round((Date.parse(`${todayIso}T00:00:00Z`) - d.getTime()) / 86400000);
  return { text: `${text} · ${days} day${days === 1 ? '' : 's'} late`, late: true };
}

// Which tab a brief sits under on the list.
function briefListTab(brief) {
  if (brief?.request_type === 'notify_only') return 'quick';
  if (isBriefPaused(brief)) return 'paused';
  if (brief?.status === 'completed') return 'completed';
  return 'active';
}

// ── Pieces (21 Oct 2026, Rhea's workflow) ──
// A brief is split into pieces; each needs copy, design or both, with one
// owner per part. The stage moves by itself in the database
// (guard_brief_deliverable_update); these only read it.
const PIECE_STAGE_LABEL = {
  queued: 'To assign',
  in_progress: 'In progress',
  in_review: 'Lead review',
  ready_to_share: 'AM review',
  delivered: 'Shared'
};

function pieceStageLabel(piece, clientName) {
  if (!piece) return '';
  if (piece.status === 'in_progress' && piece.sent_back_at) return 'Changes needed';
  if (piece.status === 'delivered') return `Shared with ${clientName || 'the client'}`;
  return PIECE_STAGE_LABEL[piece.status] || piece.status;
}

// Creative leads by client name (app_config.creative_leads).
function isCreativeLeadFor(org, email, leadsMap) {
  const list = (leadsMap && leadsMap[org]) || [];
  const me = String(email || '').trim().toLowerCase();
  return Boolean(me) && list.some((e) => String(e).trim().toLowerCase() === me);
}

// What a piece is waiting on the viewer to do. Leads assign only once the
// brief has gone to creative (Start creative = shared with the team), and
// nothing waits on anyone while the brief is paused.
// Returns any of: 'assign', 'copy', 'design', 'lead_review', 'am_review'.
function pieceActionsFor(piece, brief, { me, reviewer = false, lead = false } = {}) {
  const out = [];
  if (!piece || !brief || brief.archived_at || isBriefPaused(brief)) return out;
  const atCreative = ['in_creative', 'under_revision'].includes(brief.status);
  if (piece.status === 'queued' && lead && atCreative) out.push('assign');
  if (piece.status === 'in_progress') {
    if (piece.needs_copy && me && piece.copy_assignee_id === me && !piece.copy_done_at) out.push('copy');
    if (piece.needs_design && me && piece.design_assignee_id === me && !piece.design_done_at) out.push('design');
  }
  if (piece.status === 'in_review' && lead) out.push('lead_review');
  if (piece.status === 'ready_to_share' && reviewer) out.push('am_review');
  return out;
}

// Counts for the bell, one per kind of action.
function pieceActionCounts(pieces, briefsById, ctx) {
  const counts = { assign: 0, mine: 0, lead_review: 0, am_review: 0 };
  (pieces || []).forEach((p) => {
    const brief = briefsById[p.brief_id];
    const lead = isCreativeLeadFor(brief?.org, ctx.email, ctx.leadsMap);
    const acts = pieceActionsFor(p, brief, { me: ctx.me, reviewer: ctx.reviewer, lead });
    if (acts.includes('assign')) counts.assign += 1;
    if (acts.includes('copy') || acts.includes('design')) counts.mine += 1;
    if (acts.includes('lead_review')) counts.lead_review += 1;
    if (acts.includes('am_review')) counts.am_review += 1;
  });
  return counts;
}
