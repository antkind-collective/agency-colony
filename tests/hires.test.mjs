// Tests for js/hires.js — hiring pipeline stages and candidate validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object, Array, JSON, RegExp });
for (const file of ['js/config.js', 'js/hires.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
const u = (n) => vm.runInContext(n, ctx);

test('isValidHireTransition: happy path in order', () => {
  const f = u('isValidHireTransition');
  assert.equal(f('invited', 'details_submitted'), true);
  assert.equal(f('details_submitted', 'contract_uploaded'), true);
  assert.equal(f('contract_uploaded', 'reviewed'), true);
  assert.equal(f('reviewed', 'signed'), true);
  assert.equal(f('signed', 'payroll_done'), true);
});

test('isValidHireTransition: send-backs and cancel, no jumps', () => {
  const f = u('isValidHireTransition');
  assert.equal(f('contract_uploaded', 'details_submitted'), true); // review bounce
  assert.equal(f('reviewed', 'contract_uploaded'), true);
  assert.equal(f('invited', 'cancelled'), true);
  assert.equal(f('invited', 'signed'), false);
  assert.equal(f('payroll_done', 'signed'), false);
  assert.equal(f('cancelled', 'invited'), false);
});

test('hireMissingDetails: complete details with slips pass', () => {
  const f = u('hireMissingDetails');
  const complete = {
    full_name: 'Dev Rao', date_of_birth: '2000-01-01', phone: '+91 90000 00000', pan: 'ABCDE1234F',
    address: 'Mumbai', permanent_address: 'Pune', bank_account_name: 'Dev Rao',
    bank_account_number: '123456', bank_ifsc: 'HDFC0000123', tax_regime: 'new',
    start_date: '2026-09-01'
  };
  assert.equal(f(complete, true).length, 0);
});

test('hireMissingDetails: regime required; old regime needs declarations', () => {
  const f = u('hireMissingDetails');
  const base = {
    full_name: 'Dev Rao', date_of_birth: '2000-01-01', phone: '+91 90000 00000', pan: 'ABCDE1234F',
    address: 'Mumbai', permanent_address: 'Pune', bank_account_name: 'Dev Rao',
    bank_account_number: '123456', bank_ifsc: 'HDFC0000123',
    start_date: '2026-09-01'
  };
  assert.ok(f(base, true).map(m => m.key).includes('tax_regime'));
  assert.ok(f({ ...base, tax_regime: 'old' }, true).map(m => m.key).includes('tax_declarations'));
  assert.equal(f({ ...base, tax_regime: 'old', tax_declarations_note: 'HRA 20k/mo, 80C PPF 1.5L' }, true).length, 0);
});

test('fiscalYearStartLabel: Indian FY boundaries', () => {
  const f = u('fiscalYearStartLabel');
  assert.equal(f('2026-08-05'), '1 April 2026');
  assert.equal(f('2026-02-10'), '1 April 2025');
  assert.equal(f('2026-04-01'), '1 April 2026');
});

test('hireMissingDetails: no slips needs the explicit checkbox; single-word name flagged', () => {
  const f = u('hireMissingDetails');
  const d = {
    full_name: 'Dev', date_of_birth: '2000-01-01', pan: 'ABCDE1234F',
    address: 'Mumbai', bank_account_name: 'S', bank_account_number: '1', bank_ifsc: 'HDFC0000123'
  };
  const keys = f(d, false).map(m => m.key);
  assert.ok(keys.includes('salary_slips'));
  assert.ok(keys.includes('full_name_words'));
  // A note alone is NOT enough — the explicit "I did not have salary slips"
  // selection is the valid path (11 Aug 2026); the note is optional context.
  const noteOnly = f({ ...d, full_name: 'Dev Rao', salary_slips_note: 'Fresh graduate' }, false).map(m => m.key);
  assert.ok(noteOnly.includes('salary_slips'));
  const ticked = f({ ...d, full_name: 'Dev Rao', no_salary_slips: true }, false).map(m => m.key);
  assert.ok(!ticked.includes('salary_slips'));
  assert.ok(!ticked.includes('full_name_words'));
});

test('PAN and IFSC validators', () => {
  assert.equal(u('isValidPan')('ABCDE1234F'), true);
  assert.equal(u('isValidPan')('abcde1234f'), true);   // case-insensitive input
  assert.equal(u('isValidPan')('ABC1234567'), false);
  assert.equal(u('isValidIfsc')('HDFC0000123'), true);
  assert.equal(u('isValidIfsc')('HDFC1000123'), false); // 5th char must be 0
});

test('stage owner mapping covers every stage', () => {
  const stages = u('HIRE_STAGES');
  const owner = u('HIRE_STAGE_OWNER');
  for (const s of stages) assert.ok(s in owner, `owner missing for ${s}`);
  assert.equal(owner.details_submitted, 'legal');
  assert.equal(owner.signed, 'finance');
});

test('hireMissingDetails: the candidate must give a start date (24 Aug 2026)', () => {
  const f = u('hireMissingDetails');
  const base = {
    full_name: 'Dev Rao', date_of_birth: '2000-01-01', pan: 'ABCDE1234F',
    address: 'Mumbai', bank_account_name: 'Dev Rao', bank_account_number: '1',
    bank_ifsc: 'HDFC0000123', tax_regime: 'new', no_salary_slips: true
  };
  assert.ok(f(base, false).map(m => m.key).includes('start_date'));
  assert.ok(!f({ ...base, start_date: '2026-09-01' }, false).map(m => m.key).includes('start_date'));
});

test('hireMissingDetails: permanent address is required too (Legal, 24 Aug 2026)', () => {
  const f = u('hireMissingDetails');
  const base = {
    full_name: 'Dev Rao', date_of_birth: '2000-01-01', phone: '+91 90000 00000', pan: 'ABCDE1234F',
    address: 'Mumbai', bank_account_name: 'S', bank_account_number: '1',
    bank_ifsc: 'HDFC0000123', tax_regime: 'new', no_salary_slips: true, start_date: '2026-09-01'
  };
  assert.ok(f(base, false).map(m => m.key).includes('permanent_address'));
  assert.equal(f({ ...base, permanent_address: 'Pune' }, false).length, 0);
});

test('employment vocabulary is shared with hires (31 Aug 2026)', () => {
  assert.equal(u('EMPLOYMENT_TYPES').join('|'), 'full-time|fractional|consultant');
  assert.equal(u('HIRE_TYPE_LABEL').consultant, 'Consultant');
  assert.equal(u('employmentTypeLabel')('fractional'), 'Fractional');
  assert.equal(u('employmentTypeLabel')('nonsense'), 'Full-time');
});

test('who invoices, and who is client-scoped', () => {
  const invoices = u('employmentRaisesInvoice');
  const scoped = u('employmentIsScoped');
  // A consultant raises an invoice but is NOT scoped — an employee whose
  // contract is structured differently, not a part-timer.
  assert.equal(invoices('consultant'), true);
  assert.equal(scoped('consultant'), false);
  assert.equal(invoices('fractional'), true);
  assert.equal(scoped('fractional'), true);
  assert.equal(invoices('full-time'), false);
  assert.equal(scoped('full-time'), false);
});

// ── Skipping a stage done outside Colony (8 Sep 2026) ──────────────
test('nextHireStage walks forward one stage, never past the end', () => {
  const f = u('nextHireStage');
  assert.equal(f('invited'), 'details_submitted');
  assert.equal(f('details_submitted'), 'contract_uploaded');
  assert.equal(f('contract_uploaded'), 'reviewed');
  assert.equal(f('reviewed'), 'signed');
  assert.equal(f('signed'), 'payroll_done');
  assert.equal(f('payroll_done'), null);   // nothing left to skip to
  assert.equal(f('cancelled'), null);      // not on the ladder at all
  assert.equal(f('nonsense'), null);
});

test('skip only ever uses a transition the normal flow already allows', () => {
  // Otherwise Skip becomes a back door to a state the pipeline forbids.
  const next = u('nextHireStage');
  const valid = u('isValidHireTransition');
  for (const stage of u('HIRE_STAGES')) {
    const to = next(stage);
    if (to) assert.equal(valid(stage, to), true, `${stage} -> ${to} must be a sanctioned transition`);
  }
  assert.equal(u('canSkipHireStage')('reviewed'), true);
  assert.equal(u('canSkipHireStage')('payroll_done'), false);
  assert.equal(u('canSkipHireStage')('cancelled'), false);
});

test('a skipped stage stays distinguishable from a completed one', () => {
  const hire = { stage: 'signed', skipped_stages: ['contract_uploaded', 'reviewed'] };
  assert.equal(u('hireStageWasSkipped')(hire, 'contract_uploaded'), true);
  assert.equal(u('hireStageWasSkipped')(hire, 'signed'), false);
  assert.equal(u('hireStageWasSkipped')({ stage: 'signed' }, 'reviewed'), false);
  assert.equal(u('skippedHireStageLabels')(hire).join(' · '), 'Review needed · Awaiting signature');
});

test('mobile number is required — the Workspace request needs it (8 Sep 2026)', () => {
  const f = u('hireMissingDetails');
  const base = {
    full_name: 'Dev Rao', date_of_birth: '2000-01-01', pan: 'ABCDE1234F',
    address: 'Mumbai', permanent_address: 'Pune', bank_account_name: 'Dev Rao',
    bank_account_number: '1', bank_ifsc: 'HDFC0000123', tax_regime: 'new',
    no_salary_slips: true, start_date: '2026-09-01'
  };
  // Example Reseller are sent Name / Email to create / Recovery email / Phone — without
  // this the request cannot be prefilled and someone has to go and ask.
  assert.ok(f(base, false).map(m => m.key).includes('phone'));
  assert.equal(f({ ...base, phone: '+91 90295 51357' }, false).length, 0);
});

// ── Workspace account request (8 Sep 2026) ─────────────────────────
test('suggestWorkEmail follows the firstname convention', () => {
  const f = u('suggestWorkEmail');
  assert.equal(f('Maya Rao'), 'maya@youragency.com');
  assert.equal(f('Dev Iyer'), 'dev@youragency.com');
  assert.equal(f("Mary-Jane O'Neill"), 'maryjane@youragency.com');  // punctuation stripped
  assert.equal(f(''), '');
});

test('payroll done is not the end — three states until they sign in', () => {
  const f = u('hireWorkspaceState');
  const done = { stage: 'payroll_done', workspace_requested_at: null };
  assert.equal(f(done, false), 'needed');
  assert.equal(f({ ...done, workspace_requested_at: '2026-09-08T12:00:00Z' }, false), 'requested');
  // The employee row existing is the proof they actually signed in.
  assert.equal(f({ ...done, workspace_requested_at: '2026-09-08T12:00:00Z' }, true), 'joined');
  // Earlier stages have their own next step; this one does not apply yet.
  assert.equal(f({ stage: 'signed' }, false), null);
  assert.equal(f(null, false), null);
});

test('the request carries what the reseller needs, and nothing secret', () => {
  const { subject, body } = u('workspaceRequestEmail')({
    full_name: 'Asha Rao', personal_email: 'new.hire@example.com',
    phone: '+91 90295 51357', start_date: '2026-09-14'
  });
  assert.equal(subject, 'New Google Workspace user setup — asha@youragency.com');
  assert.ok(body.includes('Name: Asha Rao'));
  assert.ok(body.includes('Email to create: asha@youragency.com'));
  assert.ok(body.includes('Recovery email: new.hire@example.com'));
  assert.ok(body.includes('Phone: +91 90295 51357'));
  assert.ok(body.includes('They start on 2026-09-14'));
  // Greeting follows the To: address, so a contact change cannot leave the
  // previous person's name in the body (contact moved Sky -> Kay, 8 Sep).
  assert.ok(body.startsWith(`Hi ${u('WORKSPACE_VENDOR_GREETING')},`));
  assert.equal(u('WORKSPACE_VENDOR_TO'), 'reseller@example.com');
  assert.ok(u('WORKSPACE_VENDOR_CC').includes('am-lead@youragency.com'));
  // Nothing here is a credential — the password comes back to a human and
  // never enters Colony.
  assert.ok(!/password/i.test(body));
});

test('skipping stays silent, except when it hands someone a real job', () => {
  const f = u('skipShouldNotify');
  // These describe work that did not happen — announcing them would be a lie.
  assert.equal(f('details_submitted'), false);
  assert.equal(f('contract_uploaded'), false);
  assert.equal(f('reviewed'), false);
  // These announce where the hire has ARRIVED. Dev reached 'signed' by
  // Skip on 8 Sep 2026 and finance was never told to set him up, so he sat at
  // "Hiring complete" with payroll never actually requested.
  assert.equal(f('signed'), true);
  assert.equal(f('payroll_done'), true);
});

// ── hireSignInPrompt: the moment a hire must switch accounts ──────────────
test('hireSignInPrompt: nothing to say until the account has been requested', () => {
  const f = u('hireSignInPrompt');
  const hire = { full_name: 'Asha Rao', stage: 'payroll_done' };
  assert.equal(f(hire, { requested_at: null, joined: false, work_email: 'asha@youragency.com' }), null);
  assert.equal(f(hire, null), null);
  // Before payroll the account cannot exist yet, whatever the status says.
  assert.equal(f({ ...hire, stage: 'signed' }, { requested_at: '2026-09-08', joined: false }), null);
});

test('hireSignInPrompt: requested but unused → tell them the account is ready', () => {
  const r = u('hireSignInPrompt')({ full_name: 'Asha Rao', stage: 'payroll_done' },
    { requested_at: '2026-09-08T12:19:00Z', joined: false, work_email: 'asha@youragency.com' });
  assert.equal(r.kind, 'ready');
  assert.equal(r.workEmail, 'asha@youragency.com');
});

test('hireSignInPrompt: already joined on the youragency account → this is the wrong door', () => {
  const r = u('hireSignInPrompt')({ full_name: 'Dev Iyer', stage: 'payroll_done' },
    { requested_at: null, joined: true, work_email: 'dev@youragency.com' });
  assert.equal(r.kind, 'joined');
  // Falls back to the suggested address when the RPC gave none.
  const r2 = u('hireSignInPrompt')({ full_name: 'Dev Iyer', stage: 'payroll_done' }, { joined: true });
  assert.equal(r2.workEmail, 'dev@youragency.com');
});

// ── hireChecklist: one row per thing, owner per row, by type ──────────────
test('hireChecklist: a consultant has no breakup row and a vendor pay row', () => {
  const rows = u('hireChecklist')({ hire_type: 'consultant', stage: 'invited', start_date: '2026-09-15' }, { monthly_fee: 60000, scope_of_work: 'x' });
  const keys = rows.map(r => r.key);
  assert.ok(!keys.includes('breakup'));
  assert.equal(rows.find(r => r.key === 'pay').label, 'Finance notified');
  assert.equal(rows[0].state, 'done');            // open: fee + scope + date present
  assert.equal(rows[0].detail, '₹60,000 a month');
  assert.equal(rows[1].state, 'current');         // waiting on the candidate
  assert.equal(rows[1].label, 'Details and bank');
});

test('hireChecklist: the account comes before Finance, the order the webhook runs them', () => {
  for (const hire_type of ['consultant', 'full-time']) {
    const keys = u('hireChecklist')({ hire_type, stage: 'signed', start_date: '2026-11-01' }, { monthly_fee: 60000, ctc_annual: 1200000, scope_of_work: 'x' }).map(r => r.key);
    assert.ok(keys.indexOf('account') < keys.indexOf('pay'), `${hire_type}: ${keys.join(',')}`);
  }
});

test('hireChecklist: an employee has the breakup row and payroll wording', () => {
  const rows = u('hireChecklist')({ hire_type: 'full-time', stage: 'details_submitted', start_date: '2026-09-24' }, { ctc_annual: 1200000, scope_of_work: 'x' });
  const breakup = rows.find(r => r.key === 'breakup');
  assert.equal(breakup.owner, 'finance');
  assert.equal(breakup.state, 'current');          // details done, breakup is next
  assert.equal(rows.find(r => r.key === 'pay').label, 'On payroll from the start date');
  assert.equal(rows[0].detail, 'CTC ₹12,00,000 a year');
});

test('hireChecklist: the breakup row is done once Finance enters it in Colony', () => {
  const hire = { hire_type: 'full-time', stage: 'details_submitted', start_date: '2026-09-24' };
  const rows = u('hireChecklist')(hire, { ctc_annual: 1200000, scope_of_work: 'x', ctc_breakup: [{ component: 'Basic', annual: 1200000 }] });
  assert.equal(rows.find(r => r.key === 'breakup').state, 'done');
  const empty = u('hireChecklist')(hire, { ctc_annual: 1200000, scope_of_work: 'x', ctc_breakup: [{ component: '', annual: 0 }] });
  assert.equal(empty.find(r => r.key === 'breakup').state, 'current');
});

test('hireChecklist: open is not done until compensation and scope exist', () => {
  const rows = u('hireChecklist')({ hire_type: 'full-time', stage: 'invited', start_date: '2026-09-24' }, {});
  assert.equal(rows[0].state, 'current');
  assert.equal(rows[0].detail, 'compensation not set');
});

test('hireChecklist: the end of a hire, in order — welcome, sign-in, activation, meetings, Slack', () => {
  const h = { hire_type: 'consultant', stage: 'payroll_done', start_date: '2026-10-12', work_email: 'siva@youragency.com' };
  const t = { monthly_fee: 45000, scope_of_work: 'x' };
  const at = (rows, k) => rows.find((r) => r.key === k);
  const before = u('hireChecklist')(h, t, { hasEmployeeRow: false, activated: false });
  assert.equal(at(before, 'account').state, 'done');
  assert.equal(at(before, 'welcome').state, 'current');
  assert.equal(at(before, 'signin').label, 'Signs in to Colony');
  assert.equal(at(before, 'signin').detail, 'as siva@youragency.com');
  assert.equal(at(before, 'activate').detail, 'after they sign in');

  const signedIn = u('hireChecklist')({ ...h, welcome_sent_at: '2026-10-08T03:30:00Z' }, t, { hasEmployeeRow: true, activated: false, signedInAt: '2026-10-07T18:06:00Z' });
  assert.equal(at(signedIn, 'welcome').label, 'Welcome email sent');
  assert.equal(at(signedIn, 'welcome').detail, 'Thu 8 Oct');
  assert.equal(at(signedIn, 'signin').label, 'Signed in to Colony');
  assert.equal(at(signedIn, 'signin').detail, 'Wed 7 Oct · as siva@youragency.com');
  assert.equal(at(signedIn, 'activate').state, 'current');
  assert.equal(u('hireStepStatus')(signedIn, 'payroll_done'), 'Ready to activate');
  assert.equal(at(signedIn, 'meetings').detail, 'on activation');

  const scheduled = u('hireChecklist')({ ...h, welcome_sent_at: '2026-10-08T03:30:00Z', activation_scheduled_on: '2026-10-12' }, t, { hasEmployeeRow: true, activated: false });
  assert.equal(at(scheduled, 'activate').detail, 'switches on Mon 12 Oct, 9:30 am');
  assert.equal(u('hireStepStatus')(scheduled, 'payroll_done'), 'Activates Mon 12 Oct');

  const on = u('hireChecklist')({ ...h, welcome_sent_at: '2026-10-08T03:30:00Z', activated_at: '2026-10-12T04:00:00Z', calendar_added_at: '2026-10-12T04:20:00Z', slack_invited_at: '2026-10-12T04:25:00Z' }, t, { hasEmployeeRow: true, activated: true });
  assert.equal(at(on, 'activate').label, 'Colony access switched on');
  assert.equal(at(on, 'activate').detail, 'Mon 12 Oct');
  // Slack is one row: invite sent, waiting for them, then joined.
  assert.equal(at(on, 'slackinvite'), undefined);
  assert.equal(at(on, 'slack').state, 'current');
  assert.equal(at(on, 'slack').label, 'Slack invite sent');
  assert.match(at(on, 'slack').detail, /^Mon 12 Oct · waiting for .+ to join$/);
  assert.match(u('hireStepStatus')(on, 'payroll_done'), /^Waiting for .+ to join Slack$/);
  const joined = u('hireChecklist')({ ...h, welcome_sent_at: '2026-10-08T03:30:00Z', activated_at: '2026-10-12T04:00:00Z', calendar_added_at: '2026-10-12T04:20:00Z', slack_invited_at: '2026-10-12T04:25:00Z', slack_joined_at: '2026-10-12T06:00:00Z' }, t, { hasEmployeeRow: true, activated: true });
  assert.equal(at(joined, 'slack').label, 'Joined Slack');
  assert.ok(joined.every((r) => r.state === 'done'), 'the hire ends at Slack');
});

test('hireChecklist: cancelled freezes the rows', () => {
  const rows = u('hireChecklist')({ hire_type: 'consultant', stage: 'cancelled' }, {});
  assert.ok(rows.every(r => r.state === 'cancelled' || r.state === 'done'));
});

test('hireCompensationSpec: CTC for employees, monthly fee for everyone else', () => {
  assert.equal(u('hireCompensationSpec')('full-time').key, 'ctc_annual');
  assert.equal(u('hireCompensationSpec')('consultant').key, 'monthly_fee');
  assert.equal(u('hireCompensationSpec')('fractional').key, 'monthly_fee');
});

// A hire opened before terms lived in Colony still shows row one done once
// it has moved on; an employee row ticks the account row on its own.
test('hireChecklist: legacy hires past opened count row one done; employee row implies account', () => {
  const rows = u('hireChecklist')({ hire_type: 'full-time', stage: 'payroll_done', start_date: '2026-09-09' }, {}, { hasEmployeeRow: true, activated: true });
  const by = Object.fromEntries(rows.map((r) => [r.key, r.state]));
  assert.equal(by.open, 'done');
  assert.equal(by.account, 'done');
  assert.equal(by.signin, 'done');
  assert.equal(by.welcome, 'done');
  for (const k of ['activate', 'meetings', 'slack']) assert.equal(by[k], 'done', k); // active before the joiner steps existed
  assert.ok(!rows.some((r) => r.state === 'current'));
  const fresh = u('hireChecklist')({ hire_type: 'full-time', stage: 'invited', start_date: '2026-10-01' }, {});
  assert.equal(fresh.find((r) => r.key === 'open').state, 'current');
});

// No approval of the submitted details (7 Oct 2026): the row carries the day
// they were submitted, like every finished step, and nothing else.
test('hireChecklist: details row has no approval, and finished steps carry dates', () => {
  const waiting = u('hireChecklist')(
    { hire_type: 'consultant', stage: 'invited', start_date: '2026-10-12', created_at: '2026-10-06T05:00:00Z' },
    { monthly_fee: 45000, scope_of_work: 'design' });
  assert.ok(!waiting.some((r) => r.key === 'approve'), 'no separate check step');
  // While waiting it says the invite went (30 Oct 2026), not a completion date.
  assert.equal(waiting.find((r) => r.key === 'details').detail, 'invite emailed · Tue 6 Oct');
  assert.equal(u('hireChecklist')({ hire_type: 'consultant', stage: 'invited', personal_email: 'a@example.com', created_at: '2026-10-06T05:00:00Z' }, {})
    .find((r) => r.key === 'details').detail, 'invite emailed to a@example.com · Tue 6 Oct');
  assert.equal(waiting.find((r) => r.key === 'open').detail, '₹45,000 a month · Tue 6 Oct');

  const rows = u('hireChecklist')(
    { hire_type: 'consultant', stage: 'payroll_done', start_date: '2026-10-12', created_at: '2026-10-06T05:00:00Z' },
    { monthly_fee: 45000, scope_of_work: 'design', papersign_sent_at: '2026-10-07T10:06:57Z', papersign_completed_at: '2026-10-08T10:00:00Z' },
    { stageAt: { details_submitted: '2026-10-07T05:00:00Z', contract_uploaded: '2026-10-07T08:56:00Z', payroll_done: '2026-10-09T05:00:00Z' } });
  const at = (k) => rows.find((r) => r.key === k);
  assert.equal(at('details').detail, 'Wed 7 Oct');
  assert.equal(at('contract').detail, 'Wed 7 Oct');
  assert.equal(at('review').label, 'Sent for signature');
  assert.equal(at('review').detail, 'Wed 7 Oct');
  assert.equal(at('sign').detail, 'Thu 8 Oct');
  assert.equal(at('pay').detail, 'Thu 8 Oct', 'consultant: Finance is told at signing');
});

// The collapsed row names the step it is on; "Complete" only when every row is.
test('hireStepStatus: current step, not the pipeline stage', () => {
  const s = u('hireStepStatus');
  const h = { hire_type: 'consultant', stage: 'payroll_done', start_date: '2026-10-12', work_email: 'x@youragency.com' };
  const rows = u('hireChecklist')(h, { monthly_fee: 1, scope_of_work: 'x' }, {});
  assert.equal(s(rows, 'payroll_done'), 'Welcome email next');
  const all = rows.map((r) => ({ ...r, state: 'done' }));
  assert.equal(s(all, 'payroll_done'), 'Complete');
  assert.equal(s(rows, 'cancelled'), 'Cancelled');
  const signing = u('hireChecklist')({ ...h, stage: 'reviewed' }, { monthly_fee: 1, scope_of_work: 'x' }, {});
  assert.equal(s(signing, 'reviewed'), 'Awaiting signature');
});

// A late reviewer sees that the draft went, and who sent it (30 Oct 2026).
test('hireChecklist: Sent for signature names the sender when known', () => {
  const h = { hire_type: 'fractional', stage: 'reviewed', start_date: '2026-11-01' };
  const terms = { papersign_sent_at: '2026-10-30T09:29:40Z' };
  const by = u('hireChecklist')(h, terms, { sentBy: 'Nadia' }).find((r) => r.key === 'review');
  assert.equal(by.label, 'Sent for signature');
  assert.match(by.detail, /^by Nadia · /);
  const unknown = u('hireChecklist')(h, terms, {}).find((r) => r.key === 'review');
  assert.doesNotMatch(unknown.detail, /by/);
});

// Reviewers: Alex, Leo or Nadia; only Alex signs.
test('hireChecklist: review is counsel\'s and signing the signers\', not the hiring lead', () => {
  for (const type of ['full-time', 'consultant', 'fractional']) {
    const rows = u('hireChecklist')({ hire_type: type, stage: 'contract_uploaded', start_date: '2026-10-12' }, {});
    assert.equal(rows.find((r) => r.key === 'review').owner, 'counsel', type);
    assert.equal(rows.find((r) => r.key === 'sign').owner, 'signer', type);
  }
  assert.equal(u('HIRE_OWNER_LABEL').counsel, 'Reviewers');
  assert.equal(u('HIRE_OWNER_LABEL').signer, 'Signatories');
});

// Whatever the candidate types prints inside a paragraph of the agreement, so a
// multi-line address has to become one line first (Modeera, 7 Oct 2026).
test('normalizeAgreementText: folds multi-line entries into one line', () => {
  const f = u('normalizeAgreementText');
  assert.equal(
    f('301, ROYAL GARDEN APARTMENT,\nNEAR ZAKARYA COMPLEX\nINDRAPURI, PATNA - 800014'),
    '301, ROYAL GARDEN APARTMENT, NEAR ZAKARYA COMPLEX, INDRAPURI, PATNA - 800014');
  // a line already ending in punctuation does not gain a second comma
  assert.equal(f('Flat 2,\nMG Road'), 'Flat 2, MG Road');
  // blank lines and runs of spaces collapse
  assert.equal(f('  A  B \n\n\n  C  '), 'A B, C');
  // a single clean line is returned untouched
  assert.equal(f('12 Vaswani Chambers, Worli, Mumbai 400030'), '12 Vaswani Chambers, Worli, Mumbai 400030');
  assert.equal(f(''), '');
  assert.equal(f(null), '');
});

// Someone who invoices has no salary slips and no tax regime to declare.
test('hireMissingDetails: payroll fields are asked of salaried hires only', () => {
  const f = u('hireMissingDetails');
  const base = {
    full_name: 'Modeera Fatima', date_of_birth: '2000-01-01', phone: '+91 87091 09569',
    pan: 'ABCDE1234F', address: 'Patna', permanent_address: 'Patna',
    bank_account_name: 'Modeera', bank_account_number: '1', bank_ifsc: 'SBIN0001513',
    start_date: '2026-10-12'
  };
  const asConsultant = f(base, false, false).map((m) => m.key);
  assert.ok(!asConsultant.includes('salary_slips'), 'no slips for a consultant');
  assert.ok(!asConsultant.includes('tax_regime'), 'no tax regime for a consultant');
  assert.equal(asConsultant.length, 0);
  const asSalaried = f(base, false, true).map((m) => m.key);
  assert.ok(asSalaried.includes('salary_slips'));
  assert.ok(asSalaried.includes('tax_regime'));
});

// Creating accounts without a human picking means the options have to be
// ordered and then checked against the directory (7 Oct 2026).
test('workEmailCandidates: first name, then ways of disambiguating it', () => {
  const f = u('workEmailCandidates');
  assert.deepEqual([...f('Sivabalan S').slice(0, 3)],
    ['sivabalan@youragency.com', 'sivabalan.s@youragency.com', 'sivabalans@youragency.com']);
  assert.deepEqual([...f('Modeera Fatima').slice(0, 3)],
    ['modeera@youragency.com', 'modeera.fatima@youragency.com', 'modeeraf@youragency.com']);
  // a single name still gets numbered fallbacks, never an empty list
  assert.deepEqual([...f('Prince')], ['prince@youragency.com', 'prince2@youragency.com', 'prince3@youragency.com', 'prince4@youragency.com']);
  // punctuation and case are stripped, middle names ignored in favour of the last
  assert.equal(f("Ruby O'Brien-Ford")[1], 'ruby.obrienford@youragency.com');
  assert.equal(f('Ana Priya Sharma')[1], 'ana.sharma@youragency.com');
  assert.deepEqual([...f('')], []);
  assert.deepEqual([...f(null)], []);
  // no duplicates even when first and last collapse to the same slug
  const same = f('Kai Kai');
  assert.equal(same.length, new Set(same).size);
});

// A pending welcome email says when it goes out (7 Oct 2026).
test('hireChecklist: pending welcome email names its day', () => {
  const h = { hire_type: 'consultant', stage: 'payroll_done', start_date: '2026-10-12', work_email: 's@youragency.com' };
  const rows = u('hireChecklist')(h, { monthly_fee: 1, scope_of_work: 'x' }, {});
  assert.equal(rows.find((r) => r.key === 'welcome').detail, 'goes out Thu 8 Oct, 9 am');
  // A public holiday on Friday pushes it back a working day.
  const withHol = u('hireChecklist')(h, { monthly_fee: 1, scope_of_work: 'x' }, { holidays: ['2026-10-09'] });
  assert.equal(withHol.find((r) => r.key === 'welcome').detail, 'goes out Wed 7 Oct, 9 am');
  assert.equal(rows.find((r) => r.key === 'meetings').detail, 'on activation');
});

// Signed in before the welcome email went out: the hire moves on to
// activation; the email still goes out but no longer blocks (8 Oct 2026).
test('hireChecklist: a joiner who signed in early is ready to activate, not waiting on the welcome email', () => {
  const h = { hire_type: 'consultant', stage: 'payroll_done', start_date: '2026-10-12', work_email: 'modeera@youragency.com', full_name: 'Modeera Fatima' };
  const rows = u('hireChecklist')(h, { monthly_fee: 1, scope_of_work: 'x' }, { hasEmployeeRow: true, activated: false, signedInAt: '2026-10-08T09:00:00Z' });
  assert.equal(rows.find((r) => r.key === 'welcome').state, 'todo');
  assert.equal(rows.find((r) => r.key === 'activate').state, 'current');
  assert.equal(u('hireStepStatus')(rows, 'payroll_done'), 'Ready to activate');
});

// Access parity (audit 20 Oct 2026): only leadership may change who a hire
// reports to (trg_guard_hiring_manager), so the form locks it for everyone else.
test('the hire form locks "Reports to" for non-leadership', () => {
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function reportsToField('), src.indexOf('function reportsToField(') + 700);
  assert.match(body, /isLeadershipRole\(\) \? '' : ' disabled/);
  assert.equal((body.match(/\$\{locked\}/g) || []).length, 2, 'both the select and the plain field are locked');
});

// No @youragency.com account: the hire ends once Finance is told (30 Oct 2026).
test('hireChecklist: no account needed ends the hire at Finance', () => {
  const h = { hire_type: 'fractional', stage: 'payroll_done', start_date: '2026-11-01', workspace_not_needed: true };
  const rows = u('hireChecklist')(h, { papersign_sent_at: '2026-10-30T09:00:00Z' }, {});
  const keys = rows.map((r) => r.key);
  assert.ok(keys.includes('account'));
  for (const k of ['welcome', 'signin', 'activate', 'meetings', 'slack']) assert.ok(!keys.includes(k), k);
  assert.equal(rows.find((r) => r.key === 'account').label, 'No youragency.com account');
  assert.ok(rows.every((r) => r.state === 'done'));
  assert.equal(u('hireStepStatus')(rows, h.stage), 'Complete');
});

// A link to a hire must land on that hire and stay there: the list re-renders
// as data arrives, and that used to fold it and leave the page on another
// hire (Manisha's link landed on Payal, 30 Oct 2026).
test('hire links: open through focusPendingHire; re-renders keep open hires open', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const opener = src.slice(src.indexOf('const LINK_OPEN_ITEMS = {'), src.indexOf('hireterms:', src.indexOf('const LINK_OPEN_ITEMS = {')));
  assert.match(opener, /pendingHireFocus = id;[\s\S]*focusPendingHire\(\)/);
  const render = src.slice(src.indexOf('async function renderHiringList()'), src.indexOf('function focusPendingHire()'));
  assert.match(render, /const keepOpen = /);
  assert.match(render, /keepOpen\.forEach/);
  assert.match(render, /keepSteps\.forEach/);
});

// The welcome line never names a day already gone (Manisha, 30 Oct 2026).
test('welcomeWhen: a late signing goes at the next 9 am, not on a past day', () => {
  const w = u('welcomeWhen');
  assert.equal(w('2026-11-01', { today: '2026-10-30', istHour: 17 }), 'tomorrow');
  assert.equal(w('2026-11-01', { today: '2026-10-30', istHour: 8 }), 'today');
  assert.equal(w('2026-11-01', { today: '2026-11-01', istHour: 10 }), 'too late: past the start date');
  assert.equal(w('2026-11-16', { today: '2026-10-30', istHour: 17 }), 'Thu 12 Nov');
});

// ── startDateWarning: weekend / holiday start dates (Manisha, 31 Oct 2026) ──
test('startDateWarning: a Sunday start names the next working day', () => {
  const f = u('startDateWarning');
  assert.equal(f('2026-11-01'), '1 Nov is a Sunday. The next working day is Mon 2 Nov.');
  assert.equal(f('2026-10-31'), '31 Oct is a Saturday. The next working day is Mon 2 Nov.');
  assert.equal(f('2026-11-02'), '');
  assert.equal(f(''), '');
  assert.equal(f(null), '');
});

test('startDateWarning: an office holiday counts, and is skipped when finding the next day', () => {
  const f = u('startDateWarning');
  const hol = [{ date: '2026-11-09', name: 'Diwali' }, { date: '2026-11-10', name: 'Govardhan' }];
  assert.equal(f('2026-11-09', hol), '9 Nov is an office holiday (Diwali). The next working day is Wed 11 Nov.');
  assert.equal(f('2026-11-08', hol), '8 Nov is a Sunday. The next working day is Wed 11 Nov.');
  assert.equal(f('2026-11-09', ['2026-11-09']), '9 Nov is an office holiday. The next working day is Tue 10 Nov.');
});
