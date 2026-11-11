// S7: just after the emergency contact deadline (00:05 IST the next day),
// pause anyone still without one (7 Oct 2026: "whoever does not share
// it by Friday, system temporarily disables their sign in"). The database
// enforces the pause; saving a contact on the pause screen lifts it
// (app.save_my_emergency_contact). Daily, so a late joiner past the deadline
// is caught too. Judgement in lib/emergency-contact.js. DRY RUN: ?dry=1&today=.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');
const { DEFAULT_DEADLINE, toPause, pausedEmail } = require('./lib/emergency-contact');

function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const asOf = event?.queryStringParameters?.today;
  const todayIso = (dryRun && /^\d{4}-\d{2}-\d{2}$/.test(asOf || '')) ? asOf : zonedParts(new Date(), IST_TIME_ZONE).iso;
  const supabase = getSupabaseAdmin();
  const { data: cfg } = await supabase.from('app_config').select('value').eq('key', 'emergency_contact_deadline').maybeSingle();
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(cfg?.value || '')) ? String(cfg.value) : DEFAULT_DEADLINE;
  const summary = { dryRun, quiet: true, today: todayIso, deadline, paused: [], errors: [] };

  const { data: emps, error } = await supabase.from('employees')
    .select('id, full_name, email, is_active, onboarding_completed, emergency_contact_phone, access_paused_at');
  if (error) { summary.errors.push(error.message); return json(500, summary); }
  const due = toPause(emps, todayIso, deadline);
  if (!due.length) return json(200, summary);
  summary.quiet = false;
  const { appBaseUrl } = getConfig();
  for (const e of due) {
    summary.paused.push(e.full_name);
    if (dryRun) continue;
    const now = new Date().toISOString();
    const up = await supabase.from('employees')
      .update({ access_paused_at: now, access_pause_reason: 'emergency_contact', access_pause_note: `No emergency contact by ${deadline}`, updated_at: now })
      .eq('id', e.id).is('access_paused_at', null);
    if (up.error) { summary.errors.push(`${e.full_name}: ${up.error.message}`); continue; }
    const mail = pausedEmail(e, appBaseUrl);
    try {
      const r = await sendEmail({ to: e.email, cc: ['admin@youragency.com'], subject: mail.subject, html: mail.html, text: mail.text, audience: 'team' });
      await logNotification({ kind: 'emergency_contact_reminder', recipientEmail: e.email, subject: mail.subject, status: r.skipped ? 'skipped' : 'sent', payload: { employee_id: e.id, deadline, paused: true } });
    } catch (err) { summary.errors.push(`${e.full_name} (email): ${err.message}`); }
  }
  return json(200, summary);
}

exports.handler = withCronHeartbeat('emergency-contact-pause', handler);
