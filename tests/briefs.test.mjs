// Tests for js/briefs.js — brief pipeline transitions, required fields, SLA math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object, Array, JSON });
for (const file of ['js/utils.js', 'js/briefs.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
const u = (n) => vm.runInContext(n, ctx);

test('isValidBriefTransition: v2 full-brief flow with the client gate + revisions', () => {
  const f = u('isValidBriefTransition');
  assert.equal(f('submitted', 'ready_for_review', 'brief'), true);   // the client approve
  assert.equal(f('ready_for_review', 'in_creative', 'brief'), true); // locked stage retired
  assert.equal(f('in_creative', 'delivered', 'brief'), true);
  assert.equal(f('delivered', 'under_revision', 'brief'), true);     // the client feedback
  assert.equal(f('under_revision', 'delivered', 'brief'), true);
  assert.equal(f('delivered', 'completed', 'brief'), true);
  assert.equal(f('ready_for_review', 'pending_info', 'brief'), true);
  // legacy locked rows can still escape
  assert.equal(f('locked', 'in_creative', 'brief'), true);
  // illegal jumps
  assert.equal(f('submitted', 'in_creative', 'brief'), false);
  assert.equal(f('submitted', 'delivered', 'brief'), false);
  assert.equal(f('delivered', 'in_creative', 'brief'), false);       // replaced by under_revision
  assert.equal(f('completed', 'in_creative', 'brief'), false);
});

test('briefTimelinePosition: the client view — no In-creative step, revision is real', () => {
  const f = u('briefTimelinePosition');
  assert.equal(f('in_creative').step, 1);            // still 'With Your Agency' to the client
  assert.equal(f('pending_info').badge, 'needs your info');
  assert.equal(f('pending_info').step, 0);
  assert.equal(f('delivered').step, 2);              // 'Deliverables received'
  assert.equal(f('under_revision').step, 3);
  assert.equal(f('under_revision').badge, '');
  assert.equal(f('completed').step, 4);
});

test('isValidBriefTransition: notify_only uses the lightweight subset', () => {
  const f = u('isValidBriefTransition');
  assert.equal(f('submitted', 'acknowledged', 'notify_only'), true);
  assert.equal(f('acknowledged', 'closed', 'notify_only'), true);
  assert.equal(f('submitted', 'ready_for_review', 'notify_only'), false);
  assert.equal(f('submitted', 'acknowledged', 'brief'), false);
});

test('briefMissingFields: full brief requires the checklist fields', () => {
  const f = u('briefMissingFields');
  const complete = {
    request_type: 'brief', title: 'T', objective: 'O', key_message: 'K',
    audience: 'A', content_text: 'C', key_dates: 'D', approver_name: 'Grace',
    platforms: ['Instagram'], requested_deliverables: ['reel'], deadline: '2026-08-07'
  };
  assert.equal(f(complete).length, 0);
  const missing = f({ request_type: 'brief', title: 'T', platforms: [], requested_deliverables: [] });
  const keys = missing.map(m => m.key);
  assert.ok(keys.includes('objective'));
  assert.ok(keys.includes('platforms'));
  assert.ok(keys.includes('requested_deliverables'));
  assert.ok(keys.includes('deadline'));
  assert.ok(!keys.includes('title'));
});

test('briefMissingFields: notify_only needs only title + message', () => {
  const f = u('briefMissingFields');
  assert.equal(f({ request_type: 'notify_only', title: 'T', content_text: 'M' }).length, 0);
  assert.equal(f({ request_type: 'notify_only', title: '  ' }).length, 2);
});

test('deliverableDueAt: SLA days from creative start, end of day', () => {
  const f = u('deliverableDueAt');
  // 4 WORKING days from Wed 1 Jul: Wed, Thu, Fri, then Mon 6th — the weekend is
  // skipped. This used to be 4 calendar days and landed on Sunday the 5th, a day
  // nobody was going to deliver on (changed 24 Aug 2026 when the internal and
  // client SLA became one number).
  const due = f('2026-07-01T09:00:00.000Z', 4, 'P2');
  assert.ok(due.startsWith('2026-07-06'), due);
  assert.equal(f(null, 4, 'P2'), null);
  assert.equal(f('garbage', 4, 'P2'), null);
});

test('deliverableDueAt: P0 same day, P1 next working day, override any SLA', () => {
  const f = u('deliverableDueAt');
  const p0 = f('2026-07-01T09:00:00.000Z', 10, 'P0');   // Wed
  assert.ok(p0.startsWith('2026-07-01'));
  const p1 = f('2026-07-01T09:00:00.000Z', 10, 'P1');
  assert.ok(p1.startsWith('2026-07-02'));
});

test('deliverableDueAt: counts WORKING days, matching the client promise', () => {
  const f = u('deliverableDueAt');
  const hols = ['2026-09-14'];
  // 3 working days from Thu 10 Sep: Thu, Fri, Mon 14th is a holiday → Tue 15th
  assert.ok(f('2026-09-10T09:00:00.000Z', 3, 'P2', hols).startsWith('2026-09-15'));
  // A P1 raised on Friday is due Monday, not Saturday
  assert.ok(f('2026-09-11T09:00:00.000Z', 5, 'P1', hols).startsWith('2026-09-15'));
  // Work started on a closed day: the clock starts the next working day
  assert.ok(f('2026-09-12T09:00:00.000Z', 1, 'P2', hols).startsWith('2026-09-15'));
});

test('deliverableIsOverdue: due in past and not delivered', () => {
  const f = u('deliverableIsOverdue');
  const now = '2026-07-10T12:00:00.000Z';
  assert.equal(f({ status: 'in_progress', due_at: '2026-07-09T23:59:59.000Z' }, now), true);
  assert.equal(f({ status: 'delivered', due_at: '2026-07-09T23:59:59.000Z' }, now), false);
  assert.equal(f({ status: 'in_progress', due_at: '2026-07-11T23:59:59.000Z' }, now), false);
  assert.equal(f({ status: 'in_progress', due_at: null }, now), false);
});

// ── SLA turnaround maths (signed SLA, 17 Jul 2026) ──────────────────────────
// Real 2026 Your Agency holidays used below: 15 Aug (Independence Day, a Saturday)
// and 14 Sep (Ganesh Chaturthi, a Monday).
const HOLIDAYS_2026 = ['2026-08-15', '2026-09-14', '2026-10-02'];

test('isWorkingDay: weekends and holidays are not working days', () => {
  const f = u('isWorkingDay');
  assert.equal(f('2026-09-10', HOLIDAYS_2026), true);   // Thursday
  assert.equal(f('2026-09-12', HOLIDAYS_2026), false);  // Saturday
  assert.equal(f('2026-09-13', HOLIDAYS_2026), false);  // Sunday
  assert.equal(f('2026-09-14', HOLIDAYS_2026), false);  // Ganesh Chaturthi
});

test('slaStartDate: 2 PM IST cut-off, then roll to a working day', () => {
  const f = u('slaStartDate');
  assert.equal(f('2026-09-10', 11, HOLIDAYS_2026), '2026-09-10'); // before cut-off
  assert.equal(f('2026-09-10', 14, HOLIDAYS_2026), '2026-09-11'); // 2 PM is "after"
  // Friday after cut-off → skips the weekend
  // Friday after cut-off → Sat/Sun skipped, Mon 14th is Ganesh Chaturthi → Tue 15th
  assert.equal(f('2026-09-11', 16, HOLIDAYS_2026), '2026-09-15');
});

test('addWorkingDays: day 1 is the start day; weekends and holidays skipped', () => {
  const f = u('addWorkingDays');
  assert.equal(f('2026-09-10', 1, HOLIDAYS_2026), '2026-09-10'); // same day
  assert.equal(f('2026-09-10', 2, HOLIDAYS_2026), '2026-09-11');
  // 3 working days from Thu 10 Sep: Thu, Fri, then Mon 14th is a holiday → Tue 15th
  assert.equal(f('2026-09-10', 3, HOLIDAYS_2026), '2026-09-15');
});

test('suggestedDeadline: the slowest deliverable governs the date', () => {
  const f = u('suggestedDeadline');
  const sla = { static: { max_days: 2 }, reel: { max_days: 5 }, complex_animation: {} };
  // Static alone from Thu 10 Sep, before cut-off: Thu + Fri = Fri 11th
  assert.equal(f(['static'], sla, '2026-09-10', 10, HOLIDAYS_2026), '2026-09-11');
  // Adding a reel (5 days) pushes it past the weekend and the 14th holiday
  assert.equal(f(['static', 'reel'], sla, '2026-09-10', 10, HOLIDAYS_2026), '2026-09-17');
  // A deliverable the SLA refuses to quote contributes nothing
  assert.equal(f(['complex_animation'], sla, '2026-09-10', 10, HOLIDAYS_2026), null);
});

test('formatSlaDays: ranges kept, unquotable work says so', () => {
  const f = u('formatSlaDays');
  assert.equal(f({ min_days: 3, max_days: 3 }), '3 working days');
  assert.equal(f({ min_days: 4, max_days: 5 }), '4–5 working days');
  assert.equal(f({ min_days: null, max_days: null, note: 'Scoped per project.' }), 'Scoped per project.');
});

test('nextHoliday: the next one on or after today', () => {
  const f = u('nextHoliday');
  const hs = [{ date: '2026-08-15', name: 'Independence Day' }, { date: '2026-09-14', name: 'Ganesh Chaturthi' }];
  assert.equal(f('2026-08-24', hs).name, 'Ganesh Chaturthi');
  assert.equal(f('2026-08-15', hs).name, 'Independence Day'); // today counts
  assert.equal(f('2026-12-31', hs), null);
});

// ── On pause (Rhea via Alex, 7 Sep 2026) ──────────────────────────────
// A flag, not a status: the client's tracker parks work, and the deadline reminders
// we are about to build must never chase it.
const paused = (status, extra = {}) => ({ status, paused_at: '2026-09-07T10:00:00Z', ...extra });
const live = (status) => ({ status, paused_at: null });

test('isBriefPaused reads the flag, not the status', () => {
  assert.equal(u('isBriefPaused')(paused('in_creative')), true);
  assert.equal(u('isBriefPaused')(live('in_creative')), false);
  assert.equal(u('isBriefPaused')(null), false);
});

test('a paused brief keeps the stage it will return to', () => {
  // The whole reason pause is a flag: resuming has to know where to go back to.
  assert.equal(paused('in_creative').status, 'in_creative');
  assert.equal(u('briefBoardColumn')(paused('in_creative')), 'on_pause');
  assert.equal(u('briefBoardColumn')(live('in_creative')), 'in_creative');
});

test('paused reads as On pause but names its stage alongside', () => {
  assert.equal(u('briefStatusLabel')(paused('in_creative')), 'On pause');
  assert.equal(u('briefStatusLabel')(live('in_creative')), 'In creative');
  assert.equal(u('briefPauseDetail')(paused('in_creative')), 'Paused from In creative');
  assert.equal(
    u('briefPauseDetail')(paused('delivered', { pause_reason: 'on hold from client' })),
    'Paused from Delivered — on hold from client'
  );
  assert.equal(u('briefPauseDetail')(live('in_creative')), '');
});

test('reminders skip paused and finished work — the point of the whole change', () => {
  const wants = u('briefWantsReminders');
  assert.equal(wants(live('in_creative')), true);
  assert.equal(wants(paused('in_creative')), false);
  assert.equal(wants(live('completed')), false);
  assert.equal(wants(live('closed')), false);
});

test('finished work cannot be paused; live work can, but only once', () => {
  const can = u('canPauseBrief');
  assert.equal(can(live('in_creative')), true);
  assert.equal(can(live('submitted')), true);
  assert.equal(can(paused('in_creative')), false);   // already paused
  assert.equal(can(live('completed')), false);
  assert.equal(can(live('closed')), false);
});

test('a paused brief offers no status moves until it resumes', () => {
  // Otherwise a move would silently change the stage it gets put back into.
  // Compare joined strings: a vm-realm array is not reference-equal to a host [].
  assert.equal(u('allowedBriefActions')(paused('ready_for_review')).join('|'), '');
  assert.equal(u('allowedBriefActions')(live('ready_for_review')).join('|'), 'pending_info|in_creative');
});

test('the pause column sits outside the pipeline, not inside it', () => {
  assert.ok(!u('BRIEF_PIPELINE_COLUMNS').includes('on_pause'));
  assert.equal(u('BRIEF_BOARD_COLUMNS').at(-1), 'on_pause');
});

// ── Client Timeline grouped by stage (7 Sep 2026) ────────────────
test('groupBriefsByTimelineStage: briefs land under the stage the client sees', () => {
  const g = u('groupBriefsByTimelineStage')([
    { id: 1, status: 'submitted', paused_at: null },
    { id: 2, status: 'pending_info', paused_at: null },
    { id: 3, status: 'ready_for_review', paused_at: null },
    { id: 4, status: 'in_creative', paused_at: null },
    { id: 5, status: 'completed', paused_at: null }
  ]);
  const shape = g.map(x => `${x.label}:${x.briefs.map(b => b.id).join('+')}`).join(' | ');
  // in_creative reads as "With Your Agency" to the client — they do not see our
  // internal stages — and pending_info stays under New brief with its badge.
  assert.equal(shape, 'New brief:1+2 | With Your Agency:3+4 | Completed:5');
});

test('groupBriefsByTimelineStage: paused leaves its stage, and empty groups vanish', () => {
  const g = u('groupBriefsByTimelineStage')([
    { id: 1, status: 'in_creative', paused_at: '2026-09-07T10:00:00Z' },
    { id: 2, status: 'in_creative', paused_at: null }
  ]);
  assert.equal(g.map(x => x.label).join(' | '), 'With Your Agency | On pause');
  assert.equal(g[1].briefs[0].id, 1);
  // Nothing at all is an empty list, not a page of empty headings.
  assert.equal(u('groupBriefsByTimelineStage')([]).length, 0);
});

// ── The the client approval gate (Rhea's board bug, 7 Sep 2026) ────────────────
test('only partner-submitted briefs wait on client approval', () => {
  const f = u('briefAwaitsClientApproval');
  const partnerSent = { request_type: 'brief', status: 'submitted', submitted_by_partner_id: 'p1' };
  assert.equal(f(partnerSent), true);
  // Approved and moved on — ours now.
  assert.equal(f({ ...partnerSent, status: 'ready_for_review' }), false);
  // Logged internally by an AM: there is no client approval to wait for, and
  // gating it would strand it somewhere nobody looks.
  assert.equal(f({ request_type: 'brief', status: 'submitted', submitted_by_employee_id: 'e1', submitted_by_partner_id: null }), false);
  // Quick notify-only requests never went through this flow.
  assert.equal(f({ request_type: 'notify_only', status: 'submitted', submitted_by_partner_id: 'p1' }), false);
  assert.equal(f(null), false);
});

// ── briefApprovalWait: the banner the board shows for stuck briefs ─────────
// Sat 12, Sun 13, Ganesh Chaturthi Mon 14 — the real September 2026 shape, and
// the reason this cannot be measured in calendar days.
const WAIT_HOLS = ['2026-09-14'];
const stuck = {
  id: 'b1', title: 'Media asset for New York Climate Week', request_type: 'brief',
  status: 'submitted', submitted_by_partner_id: 'p1',
  created_at: '2026-09-09T02:26:22Z', deadline: '2026-09-15', paused_at: null
};

test('briefApprovalWait: Alice\'s brief — urgency is in working days', () => {
  const w = u('briefApprovalWait')(stuck, '2026-09-10', WAIT_HOLS);
  assert.equal(w.waited, 1);
  // Five calendar days to the 15th, but only two working ones.
  assert.equal(w.workingDaysLeft, 2);
  assert.equal(w.urgent, true);
  assert.equal(w.overdue, false);
  assert.match(u('briefApprovalWaitLabel')(w), /waiting 1 working day · 2 working days until the deadline/);
});

test('briefApprovalWait: a distant deadline is not urgent', () => {
  const w = u('briefApprovalWait')({ ...stuck, deadline: '2026-10-20' }, '2026-09-10', WAIT_HOLS);
  assert.equal(w.urgent, false);
  assert.ok(w.workingDaysLeft > 3);
});

test('briefApprovalWait: a passed deadline is overdue, not negative runway', () => {
  const w = u('briefApprovalWait')({ ...stuck, deadline: '2026-09-08' }, '2026-09-10', WAIT_HOLS);
  assert.equal(w.overdue, true);
  assert.equal(w.workingDaysLeft, null);
  assert.equal(w.urgent, true);
  assert.match(u('briefApprovalWaitLabel')(w), /deadline already passed/);
});

test('briefApprovalWait: no deadline is shown, never shouted about', () => {
  const w = u('briefApprovalWait')({ ...stuck, deadline: null }, '2026-09-10', WAIT_HOLS);
  assert.equal(w.urgent, false);
  assert.match(u('briefApprovalWaitLabel')(w), /no deadline set/);
});

test('briefApprovalWait: on pause is never urgent', () => {
  const w = u('briefApprovalWait')({ ...stuck, paused_at: '2026-09-09T10:00:00Z' }, '2026-09-10', WAIT_HOLS);
  assert.equal(w.paused, true);
  assert.equal(w.urgent, false);
  assert.match(u('briefApprovalWaitLabel')(w), /on pause/);
});

test('briefApprovalWait: only briefs behind the gate', () => {
  const f = u('briefApprovalWait');
  assert.equal(f({ ...stuck, status: 'ready_for_review' }, '2026-09-10', WAIT_HOLS), null);
  assert.equal(f({ ...stuck, request_type: 'notify_only' }, '2026-09-10', WAIT_HOLS), null);
  assert.equal(f({ ...stuck, submitted_by_partner_id: null }, '2026-09-10', WAIT_HOLS), null);
});

test('briefApprovalWait: submitted today reads as today, not "0 days"', () => {
  const w = u('briefApprovalWait')(stuck, '2026-09-09', WAIT_HOLS);
  assert.equal(w.waited, 0);
  assert.match(u('briefApprovalWaitLabel')(w), /^submitted today/);
});

// ── Raised for someone else (Mira Holt, 10 Sep 2026) ────────────────────
test('briefRequesterLine: credits the person who actually asked', () => {
  const f = u('briefRequesterLine');
  assert.equal(f({ on_behalf_of_name: 'Adam' }, 'Mira Holt'), 'Adam · via Mira Holt');
  // The ordinary case is untouched — no marker, no "via".
  assert.equal(f({}, 'Mira Holt'), 'Mira Holt');
  assert.equal(f({ on_behalf_of_name: '   ' }, 'Mira Holt'), 'Mira Holt');
  // A brief with no known submitter must not read "· via undefined".
  assert.equal(f({ on_behalf_of_name: 'Adam' }, ''), 'Adam');
});

test('briefOnBehalfDetail: the drawer row, empty when it does not apply', () => {
  const f = u('briefOnBehalfDetail');
  assert.equal(f({ on_behalf_of_name: 'Adam', on_behalf_of_email: 'contact@example.org' }), 'Adam (contact@example.org)');
  assert.equal(f({ on_behalf_of_name: 'Adam' }), 'Adam');
  // Empty means the row is filtered out of the summary entirely.
  assert.equal(f({}), '');
  assert.equal(f(null), '');
});

// Hard-wrapped replies read as a narrow column in a wide bubble.
test('unwrapHardBreaks joins single line breaks and keeps paragraph breaks', () => {
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const fn = src.match(/function unwrapHardBreaks\(text\) \{[\s\S]*?\n\}/)[0];
  const unwrap = new Function(`${fn}; return unwrapHardBreaks;`)();
  assert.equal(unwrap('Done — Other is now in\nthe list.\n\nSecond para\nhere.'), 'Done — Other is now in the list.\n\nSecond para here.');
  assert.equal(unwrap('one line'), 'one line');
});
