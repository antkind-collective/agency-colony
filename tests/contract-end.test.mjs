// Fixed-term contracts (6 Oct 2026): the 30-day reminder and the agreement
// variable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contractEndDue, reminderKey, REMIND_DAYS } = require('../netlify/functions/lib/contract-end.js');
const { buildVariables } = require('../netlify/functions/lib/papersign.js');

const row = (over) => ({ hire_id: 'h1', full_name: 'Aisha Rao', hire_type: 'consultant', stage: 'payroll_done', contract_end_date: '2027-04-30', ...over });

test('reminds from 30 days before the end, not 31', () => {
  assert.equal(REMIND_DAYS, 30);
  assert.equal(contractEndDue([row()], '2027-03-31').length, 1);
  assert.equal(contractEndDue([row()], '2027-03-30').length, 0);
  assert.equal(contractEndDue([row()], '2027-04-30').length, 1); // the day itself still counts
  assert.equal(contractEndDue([row()], '2027-05-01').length, 0); // past: too late to remind
});

test('ongoing, full-time and cancelled hires are never reminded', () => {
  assert.equal(contractEndDue([row({ contract_end_date: null })], '2027-04-01').length, 0);
  assert.equal(contractEndDue([row({ hire_type: 'full-time' })], '2027-04-01').length, 0);
  assert.equal(contractEndDue([row({ stage: 'cancelled' })], '2027-04-01').length, 0);
});

test('once per hire and end date; a changed end date reminds again', () => {
  const sent = new Set([reminderKey('h1', '2027-04-30')]);
  assert.equal(contractEndDue([row()], '2027-04-10', sent).length, 0);
  assert.equal(contractEndDue([row({ contract_end_date: '2027-05-05' })], '2027-04-10', sent).length, 1);
});

test('the agreement gets end_date for a fixed term, blank when ongoing or full-time', () => {
  const hire = { full_name: 'Aisha Rao', start_date: '2026-11-01', hire_type: 'consultant', pan: 'ABCDE1234F', address: 'Mumbai', personal_email: 'a@example.com' };
  const terms = { monthly_fee: 60000, notice_period_days: 30, scope_of_work: 'x', contract_end_date: '2027-04-30' };
  const get = (vars, k) => (Array.isArray(vars) ? vars : vars.variables || []).find((v) => v.key === k)?.value;
  const fixed = buildVariables(hire, terms);
  assert.match(String(get(fixed, 'end_date')), /30.*Apr.*2027/);
  assert.equal(get(buildVariables(hire, { ...terms, contract_end_date: null }), 'end_date'), '');
  const ft = { ...terms, ctc_annual: 1200000, designation: 'Strategist', department: 'Strategy', ctc_breakup: [{ component: 'Basic', annual: 1200000 }] };
  assert.equal(get(buildVariables({ ...hire, hire_type: 'full-time' }, ft), 'end_date'), '');
});
