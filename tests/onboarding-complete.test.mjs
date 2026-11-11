// "Onboarding complete" email (9 Oct 2026): sent once when a joiner
// shows up in Slack, to the hiring manager with Alex copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { onboardingRows, onboardingCompleteEmail, istDay } = require('../netlify/functions/lib/onboarding-complete.js');

const hire = {
  full_name: 'Modeera Fatima', hire_type: 'consultant', start_date: '2026-10-12', work_email: 'modeera@youragency.com',
  created_at: '2026-10-01T05:00:00Z', details_submitted_at: '2026-10-02T05:00:00Z', workspace_requested_at: '2026-10-07T05:00:00Z',
  welcome_sent_at: '2026-10-08T03:30:00Z', activated_at: '2026-10-09T05:00:00Z', calendar_added_at: '2026-10-09T05:10:00Z',
  slack_joined_at: '2026-10-09T20:00:00Z'
};

test('IST days: a late-evening UTC time is the next day in India', () => {
  assert.equal(istDay('2026-10-09T20:00:00Z'), '10 Oct');
  assert.equal(istDay('2026-10-12'), '12 Oct');
  assert.equal(istDay(null), null);
});

test('the steps the manager needs, in order, with their day', () => {
  const rows = onboardingRows(hire, { papersign_completed_at: '2026-10-06T10:00:00Z' }, { signed: '2026-10-06T10:00:00Z' }, '2026-10-08T06:00:00Z');
  assert.deepEqual(rows.map((r) => r[0]), ['Hire opened', 'Joining details in', 'Consulting agreement signed',
    'modeera@youragency.com created and welcome email sent', 'Signed in to Colony, access switched on',
    'Added to All Hands and Thirsty Thursday', 'Joined Slack']);
  assert.equal(rows[3][1], '8 Oct'); // the later of account and welcome
  assert.equal(rows[4][1], '9 Oct'); // the later of sign-in and activation
  assert.equal(rows[6][1], '10 Oct');
  assert.ok(!rows.some(([l]) => /finance|payroll/i.test(l)), 'no Finance row for the manager');
});

test('salaried hires read an employment agreement', () => {
  assert.equal(onboardingRows({ ...hire, hire_type: 'full-time' })[2][0], 'Employment agreement signed');
});

test('the email says onboarding is complete and links to the hire', () => {
  const m = onboardingCompleteEmail(hire, onboardingRows(hire), 'https://app.youragency.com/?open=hire:x#hiring');
  assert.equal(m.subject, 'Onboarding complete: Modeera Fatima');
  assert.match(m.text, /Onboarding complete\./);
  assert.match(m.html, /open=hire:x#hiring/);
});
