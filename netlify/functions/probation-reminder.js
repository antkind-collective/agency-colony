// Probation end reminder (3 Nov 2026).
//
// 15 days before a full-time hire's three-month probation ends, their hiring
// manager gets one email, Alex copied: the agreement says confirmation is in
// writing, so someone has to decide. Judgement lives in lib/probation.js.
// DRY RUN: ?dry=1.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');
const { probationDue, probationEnd, reminderKey } = require('./lib/probation');
const { daysUntil } = require('./lib/contract-end');

const OWNER = 'admin@youragency.com';

function escapeHtml(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function prettyDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const summary = { dryRun, quiet: true, considered: 0, sent: 0, planned: [], errors: [] };
  const supabase = getSupabaseAdmin();
  const todayIso = zonedParts(new Date(), IST_TIME_ZONE).iso;
  summary.today = todayIso;

  const [hiresRes, sentRes] = await Promise.all([
    supabase.from('hires').select('id, full_name, hire_type, stage, start_date, terms:hire_offer_terms(hiring_manager_email)').eq('hire_type', 'full-time').limit(2000),
    supabase.from('notification_log').select('payload').eq('kind', 'probation_end_reminder').limit(5000)
  ]);
  for (const r of [hiresRes, sentRes]) {
    if (r.error) { summary.errors.push(r.error.message); return json(500, summary); }
  }
  const rows = (hiresRes.data || []).map((h) => {
    const terms = Array.isArray(h.terms) ? h.terms[0] : h.terms;
    return { hire_id: h.id, full_name: h.full_name, hire_type: h.hire_type, stage: h.stage, start_date: h.start_date,
      manager: String(terms?.hiring_manager_email || '').toLowerCase() };
  });
  summary.considered = rows.length;
  const sent = new Set((sentRes.data || []).map((n) => reminderKey(n.payload?.hire_id, n.payload?.probation_end)));
  const { appBaseUrl } = getConfig();

  for (const r of probationDue(rows, todayIso, sent)) {
    const end = probationEnd(r.start_date);
    const left = daysUntil(end, todayIso);
    const to = r.manager || OWNER;
    const cc = to === OWNER ? [] : [OWNER];
    const first = String(r.full_name || '').split(' ')[0];
    summary.quiet = false;
    summary.planned.push({ name: r.full_name, end, daysLeft: left, to, cc });
    if (dryRun) continue;
    const subject = `${r.full_name}'s probation ends ${prettyDate(end)}`;
    const link = `${appBaseUrl}?open=hire:${r.hire_id}#hiring`;
    try {
      await sendEmail({
        to: [to],
        cc,
        subject,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6">
          <p>${escapeHtml(r.full_name)} joined on ${escapeHtml(prettyDate(r.start_date))}, so their 3-month probation ends on <strong>${escapeHtml(prettyDate(end))}</strong>, in ${left} day${left === 1 ? '' : 's'}.</p>
          <p>Should we confirm ${escapeHtml(first)}? Reply to Alex by then: their agreement says confirmation is in writing. Until it's confirmed, either side can end it with 30 days' notice.</p>
          <p><a href="${escapeHtml(link)}">${escapeHtml(r.full_name)} in Colony</a></p>
        </div>`,
        text: `${r.full_name} joined on ${prettyDate(r.start_date)}, so their 3-month probation ends on ${prettyDate(end)}, in ${left} days.\nShould we confirm ${first}? Reply to Alex by then: their agreement says confirmation is in writing. Until it's confirmed, either side can end it with 30 days' notice.\n${link}\n`,
        audience: 'team',
        replyTo: OWNER
      });
      await logNotification({ kind: 'probation_end_reminder', recipientEmail: [to, ...cc].join(', '), subject,
        payload: { hire_id: r.hire_id, probation_end: end } });
      summary.sent += 1;
    } catch (err) { summary.errors.push(`${r.full_name}: ${err.message}`); }
  }
  return json(200, summary);
}

exports.handler = withCronHeartbeat('probation-reminder', handler);
