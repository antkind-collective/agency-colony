// invoice-reminder (30 Sep 2026): "All invoices received" goes to Blake once a
// month (it used to repeat daily: its log kind was missing from the enum), and
// on the 1st-3rd he gets who missed last month's invoice, once.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// getConfig() insists on these; nothing here reaches Supabase or Resend.
process.env.SUPABASE_URL ||= 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
const fn = (p) => require.resolve(`../netlify/functions/${p}`);

const EMP = [
  { id: 'm', full_name: 'Mara', email: 'mara@youragency.com', department: { leave_tracking_enabled: true } },
  { id: 'r', full_name: 'Ruby Ford', email: 'ruby@youragency.com', department: { leave_tracking_enabled: true } }
];
let INVOICES = []; let LOG = []; let SENT = [];

function query(table) {
  const f = {};
  const q = {
    select: () => q, order: () => q, limit: () => q, in: () => q,
    eq: (k, v) => { f[k] = v; return q; },
    contains: (k, v) => { f.contains = v; return q; },
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (res, rej) => Promise.resolve(run()).then(res, rej)
  };
  function run() {
    if (table === 'employees') return { data: EMP, error: null };
    if (table === 'invoices') return { data: INVOICES.filter((i) => i.invoice_month === f.invoice_month), error: null };
    if (table === 'notification_log') return { data: LOG.filter((l) => l.kind === f.kind && l.payload.invoice_month === f.contains.invoice_month), error: null };
    return { data: [], error: null };
  }
  return q;
}
require.cache[fn('lib/supabase-admin.js')] = { exports: { getSupabaseAdmin: () => ({ from: query }) } };
require.cache[fn('lib/email.js')] = { exports: { sendEmail: async (m) => { SENT.push(m); return {}; } } };
require.cache[fn('lib/notifications.js')] = { exports: {
  logNotification: async (r) => { LOG.push(r); }, withCronHeartbeat: (_n, run) => run
} };
const { handler } = require('../netlify/functions/invoice-reminder.js');
const scheduled = { body: JSON.stringify({ next_run: 'x' }) };

async function runOn(isoIst) {
  mock.timers.enable({ apis: ['Date'], now: new Date(`${isoIst}T05:00:00Z`) }); // 10:30 IST
  try { return JSON.parse((await handler(scheduled)).body); } finally { mock.timers.reset(); }
}
const reset = () => { INVOICES = []; LOG = []; SENT = []; };

test('"All invoices received" goes to Blake once, not every remaining day', async () => {
  reset();
  INVOICES = [{ employee_id: 'm', invoice_month: '2026-10' }, { employee_id: 'r', invoice_month: '2026-10' }];
  await runOn('2026-10-27'); await runOn('2026-10-28'); await runOn('2026-10-29');
  assert.equal(SENT.filter((m) => /All invoices received/.test(m.subject)).length, 1);
});

test('on the 1st Blake gets who missed last month, once', async () => {
  reset();
  INVOICES = [{ employee_id: 'm', invoice_month: '2026-10' }];
  const s = await runOn('2026-11-01'); await runOn('2026-11-02');
  const digests = SENT.filter((m) => /not received/.test(m.subject));
  assert.equal(digests.length, 1);
  assert.equal(digests[0].to, 'finance@youragency.com');
  assert.match(digests[0].subject, /October 2026 \(1\)/);
  assert.match(digests[0].text, /Ruby Ford/);
  assert.doesNotMatch(digests[0].text, /Mara/);
  assert.deepEqual(s.missedLastMonth, ['Ruby Ford']);
});

test('nobody missed: no digest (he already had "All invoices received")', async () => {
  reset();
  INVOICES = [{ employee_id: 'm', invoice_month: '2026-12' }, { employee_id: 'r', invoice_month: '2026-12' }];
  await runOn('2027-01-01');
  assert.equal(SENT.length, 0);
});

test('mid-month runs send nothing', async () => {
  reset();
  const s = await runOn('2026-11-12');
  assert.equal(SENT.length, 0);
  assert.equal(s.skippedBeforeDeadline, true);
});

test('every reminder copies Blake and Ari', async () => {
  reset();
  INVOICES = [{ employee_id: 'm', invoice_month: '2026-10' }];
  await runOn('2026-10-26');
  const reminders = SENT.filter((m) => /Invoice reminder/.test(m.subject));
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].to, 'ruby@youragency.com');
  assert.deepEqual(reminders[0].cc, ['finance@youragency.com', 'ari@youragency.com']);
});
