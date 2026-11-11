// Reimbursement approvals (5 Nov 2026): managers approve reimbursements,
// a month-end email chases what is still waiting, Finance sees the state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isLastDayOfMonth, groupByApprover, reminderEmail } = require('../netlify/functions/lib/reimbursement-reminder.js');
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('month-end runs on the last day of every month, leap years included', () => {
  for (const d of ['2026-11-30', '2026-12-31', '2027-02-28', '2028-02-29', '2026-04-30']) assert.ok(isLastDayOfMonth(d), d);
  for (const d of ['2026-11-29', '2026-10-30', '2028-02-28', '2026-12-01']) assert.ok(!isLastDayOfMonth(d), d);
});


test('the email escapes what people typed', () => {
  const mail = reminderEmail({ name: '<b>K</b>', items: [{ who: 'A', what: '<script>x</script>', month: '2026-11' }] }, 'https://c/');
  assert.doesNotMatch(mail.html, /<script>|<b>K/);
});

test('daily-reminders sends it once a day, before the weekend/holiday skip', () => {
  const src = read('netlify/functions/daily-reminders.js');
  const block = src.indexOf('if (isLastDayOfMonth(todayIso))');
  assert.ok(block > 0 && block < src.indexOf("summary.skippedWeekend = true"), 'runs before the weekend return');
  assert.match(src, /sentToday\(supabase, 'reimbursement_month_end', email, todayIso\)/);
});

test('migration: the database stamps the approver and nothing in the browser can set the status', () => {
  const sql = read('supabase/migrations/202611050001_reimbursement_approvals.sql');
  assert.match(sql, /before insert on app\.invoices[\s\S]*stamp_reimbursement_approval/);
  assert.match(sql, /revoke update on app\.invoices from authenticated, anon/);
  assert.doesNotMatch(sql, /grant (insert|update)[^;]*approval_status/i);
  assert.match(sql, /insert into app_private\.callable_definer_functions[\s\S]*decide_reimbursement\(uuid,boolean,text\)/);
  assert.match(sql, /grant execute on function app\.decide_reimbursement\(uuid, boolean, text\) to authenticated/);
  assert.match(sql, /'Add a note saying what to fix\.'/);
  assert.match(sql, /alter type app\.notification_kind add value if not exists 'reimbursement_month_end'/);
  assert.match(sql, /set approval_status = 'approved'[\s\S]*where invoice_type = 'reimbursement' and approval_status is null/, 'old ones count as approved');
});

test('Colony: approvals panel, badges for the person and Finance, bell, email link', () => {
  const app = read('app.js');
  const html = read('index.html');
  assert.match(html, /id="reimbApprovalsPanel"/);
  assert.match(app, /rpc\('decide_reimbursement'/);
  assert.match(app, /reimbStatusHtml\(i, \{ own: true \}\)/);
  assert.match(app, /reimbStatusHtml\(i\)\}\$\{del\(i\)\}/, 'Finance view shows the state');
  assert.match(app, /reimbursements: \(\) =>/, 'month-end link opener');
  assert.match(read('js/notify.js'), /waiting for your approval/);
  assert.equal((app.match(/const isOwnProfile = viewingOwnProfile\(\);/g) || []).length, 2, 'Pay and approvals use the real own-profile check');
});
