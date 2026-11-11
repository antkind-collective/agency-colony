// S7: one reminder, from Colony, on the working day before the emergency
// contact deadline (7 Oct 2026: "this should go from the colony so it
// looks automated"). Daily at 09:00 IST; sends only on that day, once per
// person. Judgement in lib/emergency-contact.js. DRY RUN: ?dry=1&today=.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');
const { DEFAULT_DEADLINE, reminderDayIso, missingContact, reminderEmail } = require('./lib/emergency-contact');

function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const asOf = event?.queryStringParameters?.today;
  const todayIso = (dryRun && /^\d{4}-\d{2}-\d{2}$/.test(asOf || '')) ? asOf : zonedParts(new Date(), IST_TIME_ZONE).iso;
  const supabase = getSupabaseAdmin();
  const [cfgRes, holRes] = await Promise.all([
    supabase.from('app_config').select('value').eq('key', 'emergency_contact_deadline').maybeSingle(),
    supabase.from('public_holidays').select('holiday_date')
  ]);
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(cfgRes.data?.value || '')) ? String(cfgRes.data.value) : DEFAULT_DEADLINE;
  const holidays = (holRes.data || []).map((h) => String(h.holiday_date).slice(0, 10));
  const summary = { dryRun, quiet: true, today: todayIso, deadline, reminderDay: reminderDayIso(deadline, holidays), sent: [], errors: [] };
  if (todayIso !== summary.reminderDay) return json(200, summary);

  const { data: emps, error } = await supabase.from('employees')
    .select('id, full_name, email, is_active, onboarding_completed, emergency_contact_phone');
  if (error) { summary.errors.push(error.message); return json(500, summary); }
  const { appBaseUrl } = getConfig();
  for (const e of missingContact(emps)) {
    const { data: already } = await supabase.from('notification_log').select('id')
      .eq('kind', 'emergency_contact_reminder').eq('recipient_email', e.email).gte('created_at', `${todayIso}T00:00:00+05:30`).limit(1);
    if (already?.length) continue;
    summary.quiet = false;
    summary.sent.push(e.full_name);
    if (dryRun) continue;
    const mail = reminderEmail(e, deadline, appBaseUrl);
    try {
      const r = await sendEmail({ to: e.email, subject: mail.subject, html: mail.html, text: mail.text, audience: 'team' });
      await logNotification({ kind: 'emergency_contact_reminder', recipientEmail: e.email, subject: mail.subject, status: r.skipped ? 'skipped' : 'sent', payload: { employee_id: e.id, deadline } });
    } catch (err) { summary.errors.push(`${e.full_name}: ${err.message}`); }
  }
  return json(200, summary);
}

exports.handler = withCronHeartbeat('emergency-contact-reminder', handler);
