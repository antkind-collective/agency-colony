// Contract end reminder (6 Oct 2026).
//
// 30 days before a fractional or consultant hire's contract end date, the
// setup approvers (app_config.setup_approver_emails; Alex + Nadia) get one
// email: renew, extend, or let it end. Nobody is switched off automatically.
// Judgement lives in lib/contract-end.js. DRY RUN: ?dry=1.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');
const { contractEndDue, reminderKey, daysUntil } = require('./lib/contract-end');

const FALLBACK_APPROVERS = ['admin@youragency.com', 'am-lead@youragency.com'];

function escapeHtml(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function prettyDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }
const TYPE_LABEL = { fractional: 'fractional', consultant: 'consultant' };

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const summary = { dryRun, quiet: true, considered: 0, sent: 0, planned: [], errors: [] };
  const supabase = getSupabaseAdmin();
  const todayIso = zonedParts(new Date(), IST_TIME_ZONE).iso;
  summary.today = todayIso;

  const [termsRes, sentRes, cfgRes] = await Promise.all([
    supabase.from('hire_offer_terms').select('hire_id, contract_end_date, hire:hires(full_name, hire_type, stage)').not('contract_end_date', 'is', null).limit(2000),
    supabase.from('notification_log').select('payload').eq('kind', 'contract_end_reminder').limit(5000),
    supabase.from('app_config').select('value').eq('key', 'setup_approver_emails').maybeSingle()
  ]);
  for (const r of [termsRes, sentRes]) {
    if (r.error) { summary.errors.push(r.error.message); return json(500, summary); }
  }
  const rows = (termsRes.data || []).map((t) => ({
    hire_id: t.hire_id, contract_end_date: t.contract_end_date,
    full_name: t.hire?.full_name, hire_type: t.hire?.hire_type, stage: t.hire?.stage
  }));
  summary.considered = rows.length;
  const sent = new Set((sentRes.data || []).map((n) => reminderKey(n.payload?.hire_id, n.payload?.contract_end_date)));
  const to = (Array.isArray(cfgRes.data?.value) ? cfgRes.data.value : FALLBACK_APPROVERS).map((e) => String(e).toLowerCase());
  const { appBaseUrl } = getConfig();

  for (const r of contractEndDue(rows, todayIso, sent)) {
    const end = String(r.contract_end_date).slice(0, 10);
    const left = daysUntil(end, todayIso);
    summary.quiet = false;
    summary.planned.push({ name: r.full_name, end, daysLeft: left });
    if (dryRun) continue;
    const subject = `${r.full_name}'s contract ends ${prettyDate(end)}`;
    const link = `${appBaseUrl}#hiring`;
    try {
      await sendEmail({
        to,
        subject,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6">
          <p>${escapeHtml(r.full_name)}'s ${escapeHtml(TYPE_LABEL[r.hire_type] || '')} contract ends on <strong>${escapeHtml(prettyDate(end))}</strong>, in ${left} day${left === 1 ? '' : 's'}.</p>
          <p>Renew, extend, or let it end? To extend, change the end date in their offer terms in <a href="${escapeHtml(link)}">Hiring</a>. Nothing happens automatically.</p>
        </div>`,
        text: `${r.full_name}'s ${TYPE_LABEL[r.hire_type] || ''} contract ends on ${prettyDate(end)}, in ${left} days.\nRenew, extend, or let it end? To extend, change the end date in their offer terms in Hiring: ${link}\nNothing happens automatically.\n`,
        audience: 'team'
      });
      await logNotification({ kind: 'contract_end_reminder', recipientEmail: to.join(', '), subject,
        payload: { hire_id: r.hire_id, contract_end_date: end } });
      summary.sent += 1;
    } catch (err) { summary.errors.push(`${r.full_name}: ${err.message}`); }
  }
  return json(200, summary);
}

exports.handler = withCronHeartbeat('contract-end-reminder', handler);
