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
  assert.equal(rows.find(r => r.key === 'pay').label, 'Set up as a vendor from the start date');
  assert.equal(rows[0].state, 'done');            // open: fee + scope + date present
  assert.equal(rows[0].detail, '₹60,000 a month');
  assert.equal(rows[1].state, 'current');         // waiting on the candidate
  assert.equal(rows[1].label, 'Details and bank');
});

test('hireChecklist: an employee has the breakup row and payroll wording', () => {
  const rows = u('hireChecklist')({ hire_type: 'full-time', stage: 'details_submitted', start_date: '2026-09-24' }, { ctc_annual: 1200000, scope_of_work: 'x' });
  const breakup = rows.find(r => r.key === 'breakup');
  assert.equal(breakup.owner, 'finance');
  assert.equal(breakup.state, 'current');          // details done, breakup is next
  assert.equal(rows.find(r => r.key === 'pay').label, 'On payroll from the start date');
  assert.equal(rows[0].detail, 'CTC ₹12,00,000 a year');
});

test('hireChecklist: open is not done until compensation and scope exist', () => {
  const rows = u('hireChecklist')({ hire_type: 'full-time', stage: 'invited', start_date: '2026-09-24' }, {});
  assert.equal(rows[0].state, 'current');
  assert.equal(rows[0].detail, 'compensation not set');
});

test('hireChecklist: account, sign-in and activation come from outside the stage', () => {
  const h = { hire_type: 'fractional', stage: 'payroll_done', start_date: '2026-09-15', work_email: 'asha@youragency.com' };
  const rows = u('hireChecklist')(h, { monthly_fee: 50000, scope_of_work: 'x' }, { hasEmployeeRow: false, activated: false });
  assert.equal(rows.find(r => r.key === 'account').state, 'done');
  assert.equal(rows.find(r => r.key === 'signin').state, 'current');
  assert.equal(rows.find(r => r.key === 'activate').state, 'todo');
  const done = u('hireChecklist')(h, { monthly_fee: 50000, scope_of_work: 'x' }, { hasEmployeeRow: true, activated: true });
  assert.ok(done.every(r => r.state === 'done'));
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
  assert.equal(by.activate, 'done');
  assert.ok(!rows.some((r) => r.state === 'current'));
  const fresh = u('hireChecklist')({ hire_type: 'full-time', stage: 'invited', start_date: '2026-10-01' }, {});
  assert.equal(fresh.find((r) => r.key === 'open').state, 'current');
});
