// Joiner Slack check (7 Oct 2026): Slack decides, nobody ticks it by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hiresToCheck, hiresToInvite, slackInviteEmail, inAllChannels, CHANNELS } = require('../netlify/functions/lib/joiner-slack.js');

test('in both company channels, or not at all', () => {
  const all = new Set(['U1', 'U2']); const random = new Set(['U1']);
  assert.equal(inAllChannels('U1', [all, random]), true);
  assert.equal(inAllChannels('U2', [all, random]), false);
  assert.equal(inAllChannels(null, [all, random]), false);
  assert.deepEqual(CHANNELS.map((c) => c.name), ['#youragency-all', '#youragency-random']);
});

test('only activated, un-joined, live hires with an account are checked; invited once', () => {
  const h = (over) => ({ work_email: 'siva@youragency.com', stage: 'payroll_done', activated_at: '2026-10-12T04:00:00Z', slack_invited_at: null, slack_joined_at: null, ...over });
  assert.equal(hiresToCheck([h()]).length, 1);
  assert.equal(hiresToCheck([h({ activated_at: null })]).length, 0, 'not before activation');
  assert.equal(hiresToCheck([h({ slack_joined_at: '2026-10-09T00:00:00Z' })]).length, 0);
  assert.equal(hiresToCheck([h({ work_email: null })]).length, 0);
  assert.equal(hiresToCheck([h({ stage: 'cancelled' })]).length, 0);
  assert.equal(hiresToInvite([h()]).length, 1);
  assert.equal(hiresToInvite([h({ slack_invited_at: '2026-10-12T05:00:00Z' })]).length, 0, 'never twice');
});

test('slack invite email names the address and the channels', () => {
  const m = slackInviteEmail({ full_name: 'Sivabalan S', work_email: 'siva@youragency.com' }, { slackUrl: 'https://youragency.slack.com', slackChannels: ['#youragency-all', '#youragency-random'] });
  assert.equal(m.subject, 'Join Your Agency on Slack, Sivabalan');
  assert.match(m.text, /youragency\.slack\.com and sign in with your Your Agency Google account, siva@youragency\.com/);
  assert.match(m.text, /#youragency-all and #youragency-random/);
});
