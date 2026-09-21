import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildVariables, signersFor, draftName, readCompletion, VARIABLE_KEYS } = require('../netlify/functions/lib/papersign.js');

const asha = { full_name: 'Asha Rao', personal_email: 'new.hire@example.com', hire_type: 'fractional', start_date: '2026-09-15', address: 'A', permanent_address: 'B', pan: 'X' };

test('variables: a fractional carries a monthly fee, formatted for the page', () => {
  const v = Object.fromEntries(buildVariables(asha, { monthly_fee: 60000, notice_period_days: 30, scope_of_work: 'Design' }).map(x => [x.key, x.value]));
  assert.equal(v.compensation, '₹60,000 per month');
  assert.equal(v.compensation_label, 'Monthly fee');
  assert.equal(v.start_date, '15 September 2026');
  assert.equal(v.notice_period_days, '30');
  assert.deepEqual(Object.keys(v).sort(), [...VARIABLE_KEYS].sort());
});

test('variables: an employee carries CTC per annum', () => {
  const v = Object.fromEntries(buildVariables({ ...asha, hire_type: 'full-time' }, { ctc_annual: 1200000, notice_period_days: 60, scope_of_work: 'x' }).map(x => [x.key, x.value]));
  assert.equal(v.compensation, '₹12,00,000 per annum');
  assert.equal(v.compensation_label, 'Cost to Company (annual)');
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
  assert.match(draftName(asha), /^Your Agency Asha Rao Consultant Agreement \d{8}$/);
  assert.match(draftName({ ...asha, hire_type: 'full-time' }), /Employment Agreement/);
});

test('completion: read defensively, only a completed event with an id counts', () => {
  assert.deepEqual(readCompletion({ event: 'document.completed', document: { id: 42, completed_document_url: 'u' } }), { id: '42', completed: true, url: 'u' });
  assert.equal(readCompletion({ event: 'document.sent', document: { id: 42 } }).completed, false);
  assert.equal(readCompletion({}).id, null);
});
