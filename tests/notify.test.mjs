// Tests for js/notify.js — the action-item builder behind the notification bell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object, Array, JSON, Map, Set });
for (const file of ['js/config.js', 'js/utils.js', 'js/notify.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
const u = (n) => vm.runInContext(n, ctx);

const ROWS = [
  { id: '1', status: 'pending', leave_type: 'SL', start_date: '2026-06-09', created_at: '2026-06-09T03:00:00Z',
    approver_emails: ['am-lead@youragency.com'], employee: { full_name: 'Rhea Kapoor' } },
  { id: '2', status: 'pending', leave_type: 'CL', start_date: '2026-05-08', created_at: '2026-04-30T11:00:00Z',
    approver_emails: '{am-lead@youragency.com}', employee: { full_name: 'Tara Bell' } }, // raw PG string form
  { id: '3', status: 'approved', leave_type: 'PL', start_date: '2026-06-01', created_at: '2026-05-20T11:00:00Z',
    approver_emails: ['am-lead@youragency.com'], employee: { full_name: 'Max Webb' } },
  { id: '4', status: 'pending', leave_type: 'PL', start_date: '2026-06-20', created_at: '2026-06-10T11:00:00Z',
    approver_emails: ['creative-lead@youragency.com'], employee: { full_name: 'Jo Park' } }
];

test('buildActionItems: only pending rows routed to me, oldest first, both email formats', () => {
  const items = u('buildActionItems')({ myEmail: 'am-lead@youragency.com', leaveRows: ROWS, todayIso: '2026-06-11' });
  assert.equal(items.length, 2);
  assert.match(items[0].text, /Tara's CL/);          // oldest request first
  assert.match(items[0].detail, /waiting 42 days/);
  assert.match(items[1].text, /Rhea's SL/);
  assert.equal(items[1].icon, '🤒');
  assert.equal(items[1].screen, 'leave-center');
});

test('buildActionItems: decided/invoice/policy/escalation sources', () => {
  const f = u('buildActionItems');
  const rows = [
    { id: 'd1', status: 'approved', leave_type: 'SL', start_date: '2026-06-09', decided_at: '2026-06-11T05:00:00Z',
      created_at: '2026-06-09T03:00:00Z', employee_id: 'me-id', approver_emails: ['am-lead@youragency.com'], employee: { full_name: 'Me Person' } },
    { id: 'old', status: 'approved', leave_type: 'PL', start_date: '2026-05-01', decided_at: '2026-06-01T05:00:00Z',
      created_at: '2026-05-01T03:00:00Z', employee_id: 'me-id', approver_emails: [], employee: { full_name: 'Me Person' } },
    { id: 'stuck', status: 'pending', leave_type: 'CL', start_date: '2026-05-08', created_at: '2026-04-30T11:00:00Z',
      employee_id: 'other', approver_emails: ['am-lead@youragency.com'], employee: { full_name: 'Tara Bell' } }
  ];
  // requester sees own decision (3-day window) but not the old one
  const mine = f({ myEmail: 'me@youragency.com', myEmployeeId: 'me-id', leaveRows: rows, todayIso: '2026-06-12', signals: {} });
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /Your SL .* was approved/);
  // superadmin gets the >7d escalation for someone else's queue
  const sa = f({ myEmail: 'admin@youragency.com', isSuperadmin: true, leaveRows: rows, todayIso: '2026-06-12', signals: {} });
  assert.equal(sa.filter(i => i.key.startsWith('escalation-')).length, 1);
  assert.match(sa[0].text, /stuck 43 days/);
  // invoice + policy signals
  const sig = f({ myEmail: 'me@youragency.com', leaveRows: [], todayIso: '2026-06-26', signals: { invoiceDue: true, policyAckPending: true } });
  assert.deepEqual(JSON.parse(JSON.stringify(sig.map(i => i.screen))), ['invoice-center', 'policy']);
});

test('countUnseenItems: panel-open semantics', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.equal(u('countUnseenItems')(items, new Set(['a'])), 2);
  assert.equal(u('countUnseenItems')(items, ['a', 'b', 'c']), 0);
  assert.equal(u('countUnseenItems')([], new Set()), 0);
});

test('buildActionItems: empty for non-approvers and signed-out', () => {
  assert.equal(u('buildActionItems')({ myEmail: 'max@youragency.com', leaveRows: ROWS, todayIso: '2026-06-11' }).length, 0);
  assert.equal(u('buildActionItems')({ myEmail: '', leaveRows: ROWS, todayIso: '2026-06-11' }).length, 0);
});

test('buildActionItems: replies to my board requests surface via signals', () => {
  const f = u('buildActionItems');
  const items = f({
    myEmail: 'me@youragency.com', myEmployeeId: 'emp-1', isSuperadmin: false,
    leaveRows: [], todayIso: '2026-07-02',
    signals: { featureReplies: [
      { id: 'r1', replierName: 'Alex Morgan', requestText: 'i havent been able to add tasks to my work all day today, help', createdAt: '2026-07-02T12:00:00Z' }
    ] }
  });
  const reply = items.find(i => i.key === 'feature-reply-r1');
  assert.ok(reply, JSON.stringify(items));
  assert.match(reply.text, /^Alex replied to your "/);
  assert.ok(reply.text.includes('…'), 'long request text is truncated');
  assert.equal(reply.screen, 'feature-requests');
});

// ── pending setup: new joiners awaiting an approver ──
test('buildActionItems: pending setups surface, fractional flagged as blocked', () => {
  const items = u('buildActionItems')({
    myEmail: 'am-lead@youragency.com',
    leaveRows: [],
    todayIso: '2026-07-18',
    signals: { pendingSetups: [
      { id: 'e1', fullName: 'Nikhil Rao', employmentType: 'fractional', requestedTeam: 'AM', createdAt: '2026-07-18T04:00:00Z' },
      { id: 'e2', fullName: 'Priya Nair', employmentType: 'full-time', requestedTeam: 'Copy', createdAt: '2026-07-18T05:00:00Z' },
      { id: 'e3', fullName: 'Asha Menon', employmentType: 'consultant', requestedTeam: 'Video', createdAt: '2026-07-18T06:00:00Z' }
    ] }
  });
  const project = items.find(i => i.key === 'setup-pending-e1');
  const fullTime = items.find(i => i.key === 'setup-pending-e2');
  const consultant = items.find(i => i.key === 'setup-pending-e3');
  assert.ok(project && fullTime && consultant, JSON.stringify(items));
  // A fractional person is locked out of every client until actioned, so the
  // item must say so rather than reading like routine admin. 'Project-based'
  // was retired as a second name for this in Aug 2026.
  assert.match(project.text, /fractional/);
  assert.match(project.detail, /no client access until activated/);
  assert.match(project.detail, /asked for AM/);
  assert.match(fullTime.text, /full-time/);
  assert.doesNotMatch(fullTime.detail, /no client access/);
  // A consultant is an employee: named as one, and NOT locked out.
  assert.match(consultant.text, /consultant/);
  assert.doesNotMatch(consultant.detail, /no client access/);
  assert.equal(project.screen, 'admin-settings');
});

test('buildActionItems: pending setups sort above older, lower-stakes items', () => {
  const items = u('buildActionItems')({
    myEmail: 'am-lead@youragency.com',
    leaveRows: [],
    todayIso: '2026-07-18',
    signals: {
      invoiceDue: true,
      policyAckPending: true,
      featureReplies: [{ id: 'r9', replierName: 'Alex', requestText: 'old thing', createdAt: '2026-07-04T09:00:00Z' }],
      pendingSetups: [{ id: 'e1', fullName: 'Nikhil Rao', employmentType: 'fractional', requestedTeam: 'AM', createdAt: '2026-07-18T04:00:00Z' }]
    }
  });
  assert.equal(items[0].key, 'setup-pending-e1', `expected setup first, got ${items.map(i => i.key).join(', ')}`);
});

test('buildActionItems: no pending setups (or non-approver) adds nothing', () => {
  const none = u('buildActionItems')({ myEmail: 'max@youragency.com', leaveRows: [], todayIso: '2026-07-18', signals: {} });
  assert.equal(none.filter(i => i.key.startsWith('setup-pending-')).length, 0);
});
