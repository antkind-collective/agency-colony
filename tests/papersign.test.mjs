import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildVariables, signersFor, draftName, readCompletion, VARIABLE_KEYS, indianWords, mapVariablesToTemplate } = require('../netlify/functions/lib/papersign.js');

const asha = { full_name: 'Asha Rao', personal_email: 'new.hire@example.com', hire_type: 'fractional', start_date: '2026-09-15', address: 'A', permanent_address: 'B', pan: 'X' };

test('variables: a fractional carries a monthly fee, formatted for the page', () => {
  const v = Object.fromEntries(buildVariables(asha, { monthly_fee: 60000, notice_period_days: 30, scope_of_work: 'Design' }).map(x => [x.key, x.value]));
  assert.equal(v.compensation, '₹60,000 per month');
  assert.equal(v.compensation_label, 'Monthly fee');
  assert.equal(v.start_date, '15 September 2026');
  assert.equal(v.notice_period_days, '30');
  assert.deepEqual(Object.keys(v).sort(), [...VARIABLE_KEYS].sort());
});

const employeeTerms = {
  ctc_annual: 1200000, notice_period_days: 60, scope_of_work: 'x', designation: 'Designer', department: 'Design',
  ctc_breakup: [{ component: 'Basic', annual: 600000 }, { component: 'HRA', annual: 300000 }, { component: 'Special allowance', annual: 300000 }]
};

test('variables: a consultant agreement gets the fee as a figure and in words', () => {
  // The template prints "Rs. [FEE AMOUNT] (Rupees [FEE IN WORDS] only)", so no ₹ and no "per month".
  const v = Object.fromEntries(buildVariables({ ...asha, hire_type: 'consultant' },
    { monthly_fee: 60000, notice_period_days: 30, scope_of_work: 'Design', designation: 'Consultant' }).map(x => [x.key, x.value]));
  assert.equal(v.fee_amount, '60,000');
  assert.equal(v.fee_words, 'Sixty Thousand');
  assert.equal(v.hire_email, 'new.hire@example.com', 'the notice block writes to the person');
  assert.equal(v.ctc_amount, '', 'CTC fields stay empty for someone who invoices');
  assert.equal(v.ctc_breakup, '');
});

test('variables: a consultant agreement will not draft without PAN or address', () => {
  const base = { monthly_fee: 60000, notice_period_days: 30, scope_of_work: 'Design', designation: 'Consultant' };
  assert.throws(() => buildVariables({ ...asha, hire_type: 'consultant', pan: null }, base), /PAN/);
  assert.throws(() => buildVariables({ ...asha, hire_type: 'consultant', address: null }, base), /address/);
  // Neither template prints a designation (23 Sep 2026), so it is not required.
  assert.ok(buildVariables({ ...asha, hire_type: 'consultant' }, { ...base, designation: null }).length);
  assert.ok(buildVariables({ ...asha, hire_type: 'fractional' }, { ...base, designation: null }).length);
});

test('variables: an employee carries CTC per annum', () => {
  const v = Object.fromEntries(buildVariables({ ...asha, hire_type: 'full-time' }, employeeTerms).map(x => [x.key, x.value]));
  assert.equal(v.compensation, '₹12,00,000 per annum');
  assert.equal(v.compensation_label, 'Cost to Company (annual)');
});

test('variables: the employment agreement gets its own fields, formatted for its sentences', () => {
  // The template reads "Rs. [CTC AMOUNT] (Rupees [CTC IN WORDS] only)" and
  // "[NOTICE PERIOD] ([NOTICE PERIOD IN WORDS]) days'" — so no ₹, no "per annum".
  const v = Object.fromEntries(buildVariables({ ...asha, hire_type: 'full-time', permanent_address: null }, employeeTerms).map(x => [x.key, x.value]));
  assert.equal(v.ctc_amount, '12,00,000');
  assert.equal(v.ctc_words, 'Twelve Lakh');
  assert.equal(v.notice_period_words, 'sixty');
  assert.equal(v.department, 'Design');
  assert.equal(v.permanent_address, 'A', '"same as current" falls back to the current address');
  assert.equal(v.ctc_breakup, 'Basic: Rs. 6,00,000 per annum\nHRA: Rs. 3,00,000 per annum\nSpecial allowance: Rs. 3,00,000 per annum\nTotal (CTC): Rs. 12,00,000 per annum');
  // Papersign drops line breaks inside a value, so Annexure B reads numbered lines.
  assert.equal(v.ctc_breakup_1, 'Basic: Rs. 6,00,000 per annum');
  assert.equal(v.ctc_breakup_3, 'Special allowance: Rs. 3,00,000 per annum');
  assert.equal(v.ctc_breakup_4, 'Total (CTC): Rs. 12,00,000 per annum');
  assert.equal(v.ctc_breakup_5, '');
  assert.equal(v.ctc_breakup_10, '');
});

test('variables: Annexure B fits nine components plus the total, no more', () => {
  const hire = { ...asha, hire_type: 'full-time' };
  const rows = n => Array.from({ length: n }, (_, i) => ({ component: `C${i + 1}`, annual: 1200000 / n }));
  const nine = Object.fromEntries(buildVariables(hire, { ...employeeTerms, ctc_breakup: rows(8) }).map(x => [x.key, x.value]));
  assert.match(nine.ctc_breakup_9, /^Total/);
  const ok = Object.fromEntries(buildVariables(hire, { ...employeeTerms, ctc_breakup: Array.from({ length: 9 }, (_, i) => ({ component: `C${i + 1}`, annual: i < 8 ? 100000 : 400000 })) }).map(x => [x.key, x.value]));
  assert.match(ok.ctc_breakup_10, /^Total \(CTC\): Rs\. 12,00,000/);
  assert.throws(() => buildVariables(hire, { ...employeeTerms, ctc_breakup: Array.from({ length: 10 }, (_, i) => ({ component: `C${i + 1}`, annual: 120000 })) }), /more than 9 components/);
});

test('variables: a consultant draft sends the breakup lines blank', () => {
  const v = Object.fromEntries(buildVariables({ ...asha }, { monthly_fee: 60000, notice_period_days: 30, scope_of_work: 'Design' }).map(x => [x.key, x.value]));
  assert.equal(v.ctc_breakup_1, '');
});

test('variables: an employee agreement will not draft without the breakup, or with one that does not add up', () => {
  const hire = { ...asha, hire_type: 'full-time' };
  assert.throws(() => buildVariables(hire, { ...employeeTerms, ctc_breakup: null }), /CTC breakup/);
  assert.throws(() => buildVariables(hire, { ...employeeTerms, ctc_breakup: [{ component: 'Basic', annual: 600000 }] }), /adds up to ₹6,00,000, not the CTC of ₹12,00,000/);
  assert.throws(() => buildVariables({ ...hire, pan: null }, employeeTerms), /PAN/);
  assert.throws(() => buildVariables(hire, { ...employeeTerms, department: null }), /department/);
});

test('indianWords: lakh and crore, the way an Indian contract writes them', () => {
  assert.equal(indianWords(1500000), 'Fifteen Lakh');
  assert.equal(indianWords(1550000), 'Fifteen Lakh Fifty Thousand');
  assert.equal(indianWords(845250), 'Eight Lakh Forty Five Thousand Two Hundred Fifty');
  assert.equal(indianWords(12500000), 'One Crore Twenty Five Lakh');
  assert.equal(indianWords(999), 'Nine Hundred Ninety Nine');
});

test('variables: a missing number is an error, never a blank in a contract', () => {
  assert.throws(() => buildVariables(asha, { notice_period_days: 30, scope_of_work: 'x' }), /monthly fee/);
  assert.throws(() => buildVariables(asha, { monthly_fee: 1, scope_of_work: 'x' }), /notice period/);
  assert.throws(() => buildVariables({ ...asha, start_date: null }, { monthly_fee: 1, notice_period_days: 30, scope_of_work: 'x' }), /start date/);
});

test('signers: the hire and Your Agency, on the keys the template defines', () => {
  const s = signersFor(asha, { signer_hire_key: 'hire', signer_agency_key: 'youragency' }, { name: 'Alex Morgan', email: 'admin@youragency.com' });
  assert.equal(s[0].email, 'new.hire@example.com');
  assert.equal(s[1].key, 'youragency');
  assert.throws(() => signersFor(asha, {}, { name: 'M', email: 'm@youragency.com' }), /signer keys/);
});

test('draft name follows the convention Alex already uses', () => {
  assert.match(draftName(asha), /^Your Agency Asha Rao Fractional Consultant Agreement \d{8}$/);
  assert.match(draftName({ ...asha, hire_type: 'consultant' }), /Consultant Agreement/);
  assert.match(draftName({ ...asha, hire_type: 'full-time' }), /Employment Agreement/);
});

test('completion: read defensively, only a completed event with an id counts', () => {
  assert.deepEqual(readCompletion({ event: 'document.completed', document: { id: 42, completed_document_url: 'u' } }), { id: '42', completed: true, url: 'u' });
  assert.equal(readCompletion({ event: 'document.sent', document: { id: 42 } }).completed, false);
  assert.equal(readCompletion({}).id, null);
});

test('template mapping: names become the template\'s own variable keys; unused names drop', () => {
  const tpl = [{ key: '3at3oyb', name: 'hire_name', value: '' }, { key: 'pwu3ozv', name: 'pan', value: '' }, { key: 'zz9', name: 'ctc_breakup_1', value: '' }];
  const out = mapVariablesToTemplate([{ key: 'hire_name', value: 'Asha' }, { key: 'pan', value: 'X' }, { key: 'fee_amount', value: '60,000' }, { key: 'ctc_breakup_1', value: '' }], tpl);
  assert.deepEqual(out, [{ key: '3at3oyb', value: 'Asha' }, { key: 'pwu3ozv', value: 'X' }, { key: 'zz9', value: '' }]);
});

test('template mapping: refuses a template it cannot trust', () => {
  assert.throws(() => mapVariablesToTemplate([{ key: 'hire_name', value: 'R' }], []), /no named variables/);
  assert.throws(() => mapVariablesToTemplate([{ key: 'hire_name', value: 'R' }], [{ key: 'a', name: 'pan' }]), /no hire_name/);
  assert.throws(() => mapVariablesToTemplate([{ key: 'hire_name', value: 'R' }], [{ key: 'a', name: 'hire_name' }, { key: 'b', name: 'hire_name' }]), /two variables named "hire_name"/);
});

// Drafts are filed by folder ID (7 Oct 2026): Papersign reads a slash in a
// `path` as nesting, so 'Consultants/Employees' created a second folder pair
// beside the real one and drafts went astray.
test('papersign drafts are filed by folder_id, never by path', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../netlify/functions/papersign-draft.js', import.meta.url), 'utf8');
  assert.match(src, /copy:\s*\{[^}]*folder_id:/);
  assert.doesNotMatch(src, /copy:\s*\{[^}]*\bpath:/);
});

// A fixed term still has a notice period, for ending it early (3 Nov
// 2026; replaces 30 Oct's "no notice for fixed term").
test('variables: a fixed-term consultant needs a notice period too', () => {
  const v = Object.fromEntries(buildVariables(asha, { monthly_fee: 60000, notice_period_days: 30, scope_of_work: 'Design', contract_end_date: '2027-03-14' }).map(x => [x.key, x.value]));
  assert.equal(v.notice_period_days, '30');
  assert.equal(v.notice_period_words, 'thirty');
  assert.equal(v.end_date, '14 March 2027');
  assert.throws(() => buildVariables(asha, { monthly_fee: 60000, scope_of_work: 'Design', contract_end_date: '2027-03-14' }), /notice period/);
  assert.throws(() => buildVariables(asha, { monthly_fee: 60000, scope_of_work: 'Design' }), /notice period/);
});

test('template: a blank notice period is refused if the template prints one', () => {
  const tpl = [{ name: 'hire_name', key: 'a1' }, { name: 'notice_period_days', key: 'a2' }];
  assert.throws(() => mapVariablesToTemplate([{ key: 'hire_name', value: 'R' }, { key: 'notice_period_days', value: '' }], tpl), /prints a notice period/);
  // A template without the clause takes the draft.
  const out = mapVariablesToTemplate([{ key: 'hire_name', value: 'R' }, { key: 'notice_period_days', value: '' }], [{ name: 'hire_name', key: 'a1' }]);
  assert.deepEqual(out, [{ key: 'a1', value: 'R' }]);
});

// 7 days' notice is for consultants and fractionals, not employees (31 Oct 2026).
test('variables: 7 days notice for a fractional or a consultant, refused for an employee', () => {
  for (const hire_type of ['fractional', 'consultant']) {
    const v = Object.fromEntries(buildVariables({ ...asha, hire_type }, { monthly_fee: 60000, notice_period_days: 7, scope_of_work: 'Design' }).map(x => [x.key, x.value]));
    assert.equal(v.notice_period_days, '7');
    assert.equal(v.notice_period_words, 'seven');
  }
  assert.throws(() => buildVariables({ ...asha, hire_type: 'full-time' }, { ctc_annual: 1200000, notice_period_days: 7, scope_of_work: 'x', designation: 'D', department: 'D' }), /notice period/);
});

test('template: a notice other than 30 is refused when the template prints a fixed 30 days', () => {
  const fixed30 = [{ name: 'hire_name', key: 'a1' }];
  assert.throws(() => mapVariablesToTemplate([{ key: 'hire_name', value: 'R' }, { key: 'notice_period_days', value: '7' }], fixed30), /fixed 30-day notice/);
  assert.deepEqual(mapVariablesToTemplate([{ key: 'hire_name', value: 'R' }, { key: 'notice_period_days', value: '30' }], fixed30), [{ key: 'a1', value: 'R' }]);
  const withVar = [{ name: 'hire_name', key: 'a1' }, { name: 'notice_period_days', key: 'a2' }];
  assert.deepEqual(mapVariablesToTemplate([{ key: 'hire_name', value: 'R' }, { key: 'notice_period_days', value: '7' }], withVar), [{ key: 'a1', value: 'R' }, { key: 'a2', value: '7' }]);
});

// Annexure A: "shall continue to remain in force [TERM]" (Leo's 02 Nov 2026 templates).
test('variables: [TERM] reads "until <end date>" for fixed term, "on an ongoing basis" otherwise, blank for employees', () => {
  const fixed = Object.fromEntries(buildVariables(asha, { monthly_fee: 60000, notice_period_days: 7, scope_of_work: 'Design', contract_end_date: '2027-03-14' }).map(x => [x.key, x.value]));
  assert.equal(fixed.contract_term, 'until 14 March 2027');
  const ongoing = Object.fromEntries(buildVariables(asha, { monthly_fee: 60000, notice_period_days: 7, scope_of_work: 'Design' }).map(x => [x.key, x.value]));
  assert.equal(ongoing.contract_term, 'on an ongoing basis');
  const emp = Object.fromEntries(buildVariables({ ...asha, hire_type: 'full-time' }, { ctc_annual: 1200000, notice_period_days: 30, scope_of_work: 'x', designation: 'D', department: 'D', ctc_breakup: [{ component: 'Basic', annual: 1200000 }] }).map(x => [x.key, x.value]));
  assert.equal(emp.contract_term, '');
});

test('template: the new consultant templates take 7 days and the term', () => {
  const tpl = ['hire_name', 'notice_period_days', 'notice_period_words', 'contract_term'].map((name, i) => ({ name, key: `k${i}` }));
  const vars = buildVariables(asha, { monthly_fee: 60000, notice_period_days: 7, scope_of_work: 'Design' });
  const out = Object.fromEntries(mapVariablesToTemplate(vars, tpl).map(x => [x.key, x.value]));
  assert.deepEqual(out, { k0: asha.full_name, k1: '7', k2: 'seven', k3: 'on an ongoing basis' });
});
