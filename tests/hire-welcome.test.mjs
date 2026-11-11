// Joiner welcome email (7 Oct 2026): two working days before the start date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.SUPABASE_URL ||= 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
const w = require('../netlify/functions/lib/hire-welcome.js');
const { _welcomeEmail } = require('../netlify/functions/hire-welcome.js');

const hire = (over) => ({ id: 'h1', full_name: 'Modeera Fatima', stage: 'signed', start_date: '2026-10-12', welcome_sent_at: null, work_email: 'modeera@youragency.com', personal_email: 'modeeraf@example.com', ...over });

test('a Monday joiner hears on the Thursday before; holidays push it earlier', () => {
  assert.equal(w.welcomeSendDate('2026-10-12', []), '2026-10-08');
  assert.equal(w.welcomeSendDate('2026-10-05', ['2026-10-02']), '2026-09-30');
});

test('sent from the send date up to the start day, once, only once signed', () => {
  assert.equal(w.welcomeDue([hire()], '2026-10-07').send.length, 0); // too early
  assert.equal(w.welcomeDue([hire()], '2026-10-08').send.length, 1);
  assert.equal(w.welcomeDue([hire()], '2026-10-12').send.length, 1); // signed late: still on the day
  assert.equal(w.welcomeDue([hire()], '2026-10-13').send.length, 0); // started
  assert.equal(w.welcomeDue([hire({ welcome_sent_at: '2026-10-08T03:30:00Z' })], '2026-10-09').send.length, 0);
  assert.equal(w.welcomeDue([hire({ stage: 'reviewed' })], '2026-10-08').send.length, 0);
});

test('no youragency.com account: an alert instead of the email', () => {
  const r = w.welcomeDue([hire({ work_email: null })], '2026-10-08');
  assert.deepEqual([r.send.length, r.noAccount.length], [0, 1]);
});

test('the email names the first All Hands and Thirsty Thursday on or after the start', () => {
  const m = _welcomeEmail(hire(), w.DEFAULTS);
  assert.match(m.text, /All Hands: Monday, 12 October, 10:30 am IST/);
  assert.match(m.text, /Thirsty Thursday: Thursday, 22 October, 5:30 pm IST/);
  assert.match(m.text, /modeera@youragency\.com/);
  assert.doesNotMatch(m.text, /slack\.com/, 'Slack comes at activation now, not in the welcome');
});

test('welcomeDue: a hire with no account wanted gets no welcome and no alert', () => {
  const out = w.welcomeDue([hire({ work_email: null, workspace_not_needed: true })], '2026-10-08');
  assert.equal(out.send.length, 0);
  assert.equal(out.noAccount.length, 0);
});
