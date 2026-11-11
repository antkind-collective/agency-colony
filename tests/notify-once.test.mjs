// S24 (audit 11 Nov 2026): notify functions must not email again when POSTed
// again, must still email when the thing really happened again, and must only
// announce what is true. Each handler runs against an in-memory database with
// the real logNotification / alreadyNotified, and email stubbed: nothing sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const ID = (n) => `${String(n).repeat(8)}-1111-1111-1111-111111111111`;

function world(tables = {}) {
  const w = { tables: { notification_log: [], ...tables }, sent: [], clock: Date.parse('2026-11-11T00:00:00Z'),
    user: { id: 'auth-1', email: 'actor@youragency.com' }, caller: { name: 'Actor', employeeId: 'emp-actor', partnerId: null } };
  w.now = () => new Date(w.clock += 1000).toISOString();
  const read = (row, col) => {
    const m = col.match(/^payload->>(.+)$/);
    const v = m ? row.payload?.[m[1]] : row[col];
    return v === undefined || v === null ? null : String(v);
  };
  w.db = { auth: { getUser: async () => ({ data: { user: w.user } }) }, from(table) {
    const rows = () => w.tables[table] || [];
    const tests = []; let sort = null; let cap = Infinity;
    const run = () => {
      const out = rows().filter((r) => tests.every((t) => t(r)));
      if (sort) out.sort((a, b) => (String(a[sort.col]) < String(b[sort.col]) ? -1 : 1) * (sort.asc ? 1 : -1));
      return out.slice(0, cap);
    };
    const q = {
      select: () => q,
      eq: (c, v) => { tests.push((r) => read(r, c) === String(v)); return q; },
      gte: (c, v) => { tests.push((r) => read(r, c) >= v); return q; },
      order: (col, o = {}) => { sort = { col, asc: o.ascending !== false }; return q; },
      limit: (n) => { cap = n; return q; },
      single: async () => { const r = run()[0]; return r ? { data: r, error: null } : { data: null, error: { message: 'none' } }; },
      maybeSingle: async () => ({ data: run()[0] || null, error: null }),
      insert: async (row) => { (w.tables[table] ||= []).push({ id: `row-${w.clock}`, created_at: w.now(), ...row }); return { error: null }; },
      then: (ok, no) => Promise.resolve({ data: run(), error: null }).then(ok, no)
    };
    return q;
  } };
  w.post = async (name, body, event = {}) => {
    const stubs = {
      './lib/supabase-admin': { getSupabaseAdmin: () => w.db }, './supabase-admin': { getSupabaseAdmin: () => w.db },
      './lib/email': { sendEmail: async (m) => { w.sent.push(m); return { skipped: false }; } },
      './lib/config': { getConfig: () => ({ appBaseUrl: 'https://colony.test/', circleBaseUrl: 'https://circle.test/' }), formatDateInIST: (d) => String(d) },
      './lib/caller': { callerCanSee: async () => true, callerCanWorkBrief: async () => true, callerIs: async () => true, callerDisplayName: async () => w.caller }
    };
    const files = [`../netlify/functions/${name}.js`, '../netlify/functions/lib/notifications.js'].map((f) => require.resolve(f));
    const load = Module._load;
    files.forEach((f) => delete require.cache[f]);
    Module._load = function (req, ...rest) { return stubs[req] || load.call(this, req, ...rest); };
    try {
      const { handler } = require(files[0]);
      return await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(body), ...event });
    } finally {
      Module._load = load;
      files.forEach((f) => delete require.cache[f]);
    }
  };
  return w;
}

test('hire-notify answers reviewed and payroll_done without crashing or mailing', async () => {
  for (const event of ['reviewed', 'payroll_done']) {
    const w = world({ hires: [{ id: ID(1), full_name: 'A B', personal_email: 'a@example.com', stage: event }] });
    const res = await w.post('hire-notify', { event, hireId: ID(1) });
    assert.equal(res.statusCode, 200, event);
    assert.equal(w.sent.length, 0, event);
  }
});

test('leave-submitted emails approvers once per request', async () => {
  const row = { id: ID(1), employee_id: 'e', leave_type: 'CL', start_date: '2026-11-20', end_date: '2026-11-20', status: 'pending',
    approver_emails: ['boss@youragency.com'], created_at: 'x', marked_by_employee_id: null, employee: { auth_user_id: 'auth-1', full_name: 'A', email: 'a@youragency.com' } };
  const w = world({ leave_requests: [row, { ...row, id: ID(2) }], employees: [{ id: 'e', auth_user_id: 'auth-1', access_level: 'employee' }] });
  await w.post('leave-submitted', { leaveRequestId: ID(1) });
  await w.post('leave-submitted', { leaveRequestId: ID(1) });
  assert.equal(w.sent.length, 1, 'a re-POST emailed again');
  await w.post('leave-submitted', { leaveRequestId: ID(2) });
  assert.equal(w.sent.length, 2, 'a different request must still email');
});

test('leave-submitted tells a marked person once', async () => {
  const row = { id: ID(1), employee_id: 'e', leave_type: 'SL', start_date: '2026-11-20', end_date: '2026-11-20', status: 'approved',
    approver_emails: ['actor@youragency.com'], marked_by_employee_id: 'mgr', employee: { auth_user_id: 'auth-2', full_name: 'A', email: 'a@youragency.com' } };
  const w = world({ leave_requests: [row], employees: [{ id: 'mgr', auth_user_id: 'auth-1', access_level: 'employee', full_name: 'M' }] });
  await w.post('leave-submitted', { leaveRequestId: ID(1) });
  await w.post('leave-submitted', { leaveRequestId: ID(1) });
  assert.equal(w.sent.length, 1);
});

const post = (over = {}) => ({ id: ID(1), employee_id: 'owner', author_partner_id: null, request_text: 'Text', request_type: 'feature', status: 'open',
  employee: { id: 'owner', full_name: 'Owner', email: 'owner@youragency.com' }, author_partner: null, ...over });

test('new_bug alerts once per post and caller', async () => {
  const w = world({ feature_requests: [post()] });
  const body = { type: 'new_bug', featureRequestId: ID(1) };
  await w.post('feature-request-notify', body);
  await w.post('feature-request-notify', body);
  assert.equal(w.sent.length, 1, 'a re-POST alerted again');
  w.user = { id: 'auth-2', email: 'other@youragency.com' };
  await w.post('feature-request-notify', body);
  assert.equal(w.sent.length, 2, 'another caller is keyed separately');
});

test('an upvote email needs a real upvote and goes once per caller', async () => {
  const w = world({ feature_requests: [post()], feature_request_upvotes: [] });
  const body = { type: 'upvote', featureRequestId: ID(1) };
  await w.post('feature-request-notify', body);
  assert.equal(w.sent.length, 0, 'emailed without an upvote');
  w.tables.feature_request_upvotes.push({ feature_request_id: ID(1), employee_id: 'emp-actor' });
  await w.post('feature-request-notify', body);
  await w.post('feature-request-notify', body);
  assert.equal(w.sent.length, 1);
});

test('a status email goes once per status change, and again if it really changes back', async () => {
  const fr = post({ status: 'done' });
  const w = world({ feature_requests: [fr] });
  const body = { type: 'status_change', featureRequestId: ID(1) };
  await w.post('feature-request-notify', body);
  await w.post('feature-request-notify', body);
  assert.equal(w.sent.length, 1, 'a re-POST emailed again');
  fr.status = 'in_progress';
  await w.post('feature-request-notify', body);
  assert.equal(w.sent.length, 2);
  fr.status = 'done';
  await w.post('feature-request-notify', body);
  assert.equal(w.sent.length, 3, 'done again is a real change');
});

test('a reply email goes once per reply; a new reply still mails', async () => {
  const w = world({ feature_requests: [post()], feature_request_replies: [
    { id: 'r1', feature_request_id: ID(1), employee_id: 'emp-actor', reply_text: 'One', created_at: '2026-11-10T00:00:00Z' }] });
  const body = { type: 'reply', featureRequestId: ID(1) };
  await w.post('feature-request-notify', body);
  await w.post('feature-request-notify', body);
  assert.equal(w.sent.length, 1, 'a re-POST emailed again');
  w.tables.feature_request_replies.push({ id: 'r2', feature_request_id: ID(1), employee_id: 'emp-actor', reply_text: 'Two', created_at: '2026-11-10T01:00:00Z' });
  await w.post('feature-request-notify', body);
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1].text, /Two/);
});

test('a client owner still gets a Circle email', async () => {
  const w = world({ feature_requests: [post({ employee_id: null, employee: null, author_partner_id: 'p', author_partner: { id: 'p', full_name: 'Client', email: 'c@example.com' }, status: 'done' })] });
  await w.post('feature-request-notify', { type: 'status_change', featureRequestId: ID(1) });
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].audience, 'partner');
  assert.doesNotMatch(w.sent[0].html + w.sent[0].text + w.sent[0].subject, /colony/i);
});

test('client_archived needs a really archived client, once per archive', async () => {
  const client = { id: ID(1), name: 'C', is_active: true, updated_at: '2026-11-10T00:00:00Z' };
  const w = world({ clients: [client] });
  const body = { type: 'client_archived', clientId: ID(1) };
  await w.post('client-status-notify', body);
  assert.equal(w.sent.length, 0, 'announced a client that is not archived');
  client.is_active = false;
  await w.post('client-status-notify', body);
  await w.post('client-status-notify', body);
  assert.equal(w.sent.length, 1, 'a re-POST emailed again');
  client.updated_at = w.now();
  await w.post('client-status-notify', body);
  assert.equal(w.sent.length, 2, 'archiving again after a restore must email');
});

test('deal_contracted goes once per deal', async () => {
  const w = world({ deals: [{ id: ID(1), deal_name: 'D', amount: 1, currency: 'INR' }] });
  await w.post('client-status-notify', { type: 'deal_contracted', dealId: ID(1) });
  await w.post('client-status-notify', { type: 'deal_contracted', dealId: ID(1) });
  assert.equal(w.sent.length, 1);
});

test('the kinds client-status-notify logs are added to the enum', () => {
  const sql = readFileSync(fileURLToPath(new URL('../supabase/migrations/202611110001_notification_kinds_client_status.sql', import.meta.url)), 'utf8');
  for (const kind of ['client_archived', 'deal_contracted']) assert.match(sql, new RegExp(`add value if not exists '${kind}'`));
});

test('setup-approval pings once while pending, and again if pending anew', async () => {
  const emp = { id: 'e', auth_user_id: 'auth-1', full_name: 'A B', email: 'a@youragency.com', employment_type: 'fractional', setup_pending: true, activated_at: null };
  const w = world({ employees: [emp], hires: [] });
  await w.post('setup-approval-notify', {});
  await w.post('setup-approval-notify', {});
  assert.equal(w.sent.length, 1, 'a re-POST pinged again');
  emp.activated_at = w.now();
  await w.post('setup-approval-notify', {});
  assert.equal(w.sent.length, 2, 'pending again after activation must ping');
});

function briefWorld(status, over = {}) {
  const brief = { id: ID(1), title: 'T', org: 'O', status, request_type: 'brief', ...over };
  const w = world({ briefs: [brief], partners: [{ id: 'p', org: 'O', email: 'client@example.com', full_name: 'Client', partner_role: 'coordinator', is_active: true }],
    brief_status_history: [{ brief_id: ID(1), status, entered_at: '2026-11-10T00:00:00Z' }], app_config: [{ key: 'brief_reviewer_emails', value: ['rev@youragency.com'] }] });
  return { w, brief, send: (event) => w.post('brief-notify', { event, briefId: ID(1) }) };
}

test('brief-notify only announces the state the brief is in', async () => {
  const { w, send } = briefWorld('in_creative');
  await send('delivered');
  assert.equal(w.sent.length, 0, 'announced Delivered for a brief in creative');
});

test('brief-notify: once per time in a state; delivered, revised, delivered again mails twice', async () => {
  const { w, send } = briefWorld('delivered');
  await send('delivered');
  await send('delivered');
  assert.equal(w.sent.length, 1, 'a re-POST emailed again');
  assert.equal(w.sent[0].audience, 'partner');
  assert.doesNotMatch(w.sent[0].html + w.sent[0].text, /colony/i);
  w.tables.brief_status_history.push({ brief_id: ID(1), status: 'delivered', entered_at: w.now() });
  await send('delivered');
  assert.equal(w.sent.length, 2, 'a second real delivery must email');
});

test("a coordinator's quick request still reaches the team", async () => {
  const { w, send } = briefWorld('submitted', { request_type: 'notify_only' });
  await send('ga_approved');
  assert.equal(w.sent.length, 1);
});

test('a new date mails once per date set', async () => {
  const { w, brief } = briefWorld('in_creative', { revised_deadline: '2026-12-01', deadline: '2026-11-20', revised_deadline_at: new Date().toISOString() });
  w.user = { id: 'auth-1', email: 'rev@youragency.com' };
  w.clock = Date.now() + 5000;
  const send = () => w.post('brief-notify', { event: 'date_changed', briefId: ID(1) });
  w.tables.partners[0].full_name = 'Client';
  brief.approver_name = 'Client';
  await send();
  const first = w.sent.length;
  assert.ok(first >= 1, 'the first date email must go');
  await send();
  assert.equal(w.sent.length, first, 'a re-POST emailed again');
  brief.revised_deadline_at = new Date(w.clock + 1000).toISOString();
  w.clock += 5000;
  const realNow = Date.now;
  Date.now = () => Date.parse(brief.revised_deadline_at) + 1000;
  try { await send(); } finally { Date.now = realNow; }
  assert.equal(w.sent.length, first * 2, 'a newly set date must email');
});

test('policy-update-reminder escapes the title', async () => {
  const month = new Date().getMonth() + 1;
  const w = world({ policy_documents: [{ policy_key: 'k', title: '<img src=x>', reminder_month: month, updated_at: '2020-01-01T00:00:00Z' }] });
  await w.post('policy-update-reminder', { next_run: 'x' });
  assert.equal(w.sent.length, 1);
  assert.doesNotMatch(w.sent[0].html, /<img/);
  assert.match(w.sent[0].html, /&lt;img src=x&gt;/);
});
