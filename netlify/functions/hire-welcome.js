// Joiner welcome email (7 Oct 2026). Daily; the judgement is
// lib/hire-welcome.js. Two working days before a signed hire's start date,
// one email to their @youragency.com and personal addresses: sign in to Colony,
// the first All Hands and Thirsty Thursday, and Slack. If they have no
// @youragency.com account by then, Alex and the hiring manager get one alert
// instead (an account is what they sign in with). DRY RUN: ?dry=1&today=.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { zonedParts, IST_TIME_ZONE } = require('./lib/config');
const { hireEmailCc } = require('./lib/hire-cc');
const { welcomeDue, firstWeekdayOnOrAfter, firstFortnightlyOnOrAfter, DEFAULTS } = require('./lib/hire-welcome');

function escapeHtml(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function prettyDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }
function firstName(full) { return String(full || '').trim().split(/\s+/)[0] || 'there'; }

function welcomeEmail(hire, cfg) {
  const start = String(hire.start_date).slice(0, 10);
  const allHands = firstWeekdayOnOrAfter(start, cfg.allHands.weekday);
  const thirsty = firstFortnightlyOnOrAfter(start, cfg.thirstyThursday.anchor, cfg.thirstyThursday.everyDays);
  const name = firstName(hire.full_name);
  const subject = `Welcome to Your Agency, ${name}: before ${prettyDate(start).split(',')[0]}`;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;max-width:560px">
    <p>Hi ${escapeHtml(name)},</p>
    <p>Welcome to Your Agency! You start on <strong>${escapeHtml(prettyDate(start))}</strong>. Two things before then:</p>
    <p><strong>1. Sign in to Colony</strong>, our team app, at <a href="${escapeHtml(cfg.colonyUrl)}">${escapeHtml(cfg.colonyUrl.replace(/^https:\/\//, ''))}</a> with your Your Agency Google account, <strong>${escapeHtml(hire.work_email)}</strong>. The first time, it walks you through a short setup.</p>
    <p><strong>2. Join us for All Hands</strong> on <strong>${escapeHtml(prettyDate(allHands))}, ${escapeHtml(cfg.allHands.time)}</strong> IST: <a href="${escapeHtml(cfg.allHands.meet)}">${escapeHtml(cfg.allHands.meet)}</a>. It's every Monday. Thirsty Thursday, our fortnightly catch-up, is next on <strong>${escapeHtml(prettyDate(thirsty))}, ${escapeHtml(cfg.thirstyThursday.time)}</strong> IST: <a href="${escapeHtml(cfg.thirstyThursday.meet)}">${escapeHtml(cfg.thirstyThursday.meet)}</a>.</p>
    <p>Once your manager switches your access on, the team meetings appear in your calendar and a Slack invite follows.</p>
    <p>See you soon,<br>Your Agency</p>
  </div>`;
  const text = [
    `Hi ${name},`,
    `Welcome to Your Agency! You start on ${prettyDate(start)}. Two things before then:`,
    `1. Sign in to Colony at ${cfg.colonyUrl} with your Your Agency Google account, ${hire.work_email}. The first time, it walks you through a short setup.`,
    `2. All Hands: ${prettyDate(allHands)}, ${cfg.allHands.time} IST — ${cfg.allHands.meet} (every Monday). Thirsty Thursday: ${prettyDate(thirsty)}, ${cfg.thirstyThursday.time} IST — ${cfg.thirstyThursday.meet} (fortnightly).`,
    'Once your manager switches your access on, the team meetings appear in your calendar and a Slack invite follows.',
    'See you soon,', 'Your Agency'
  ].join('\n');
  return { subject, html, text };
}

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const asOf = event?.queryStringParameters?.today;
  const todayIso = (dryRun && /^\d{4}-\d{2}-\d{2}$/.test(asOf || '')) ? asOf : zonedParts(new Date(), IST_TIME_ZONE).iso;
  const summary = { dryRun, quiet: true, today: todayIso, sent: 0, alerted: 0, planned: [], errors: [] };
  const supabase = getSupabaseAdmin();

  const [hiresRes, holRes, cfgRes, alertRes] = await Promise.all([
    supabase.from('hires').select('id, full_name, personal_email, work_email, start_date, stage, welcome_sent_at, workspace_not_needed, offer:hire_offer_terms(hiring_manager_email)').in('stage', ['signed', 'payroll_done']).limit(500),
    supabase.from('public_holidays').select('holiday_date'),
    supabase.from('app_config').select('value').eq('key', 'joiner_welcome').maybeSingle(),
    supabase.from('notification_log').select('payload').eq('kind', 'hire_welcome').limit(5000)
  ]);
  for (const r of [hiresRes, holRes, alertRes]) {
    if (r.error) { summary.errors.push(r.error.message); return json(500, summary); }
  }
  const holidays = (holRes.data || []).map((h) => String(h.holiday_date).slice(0, 10));
  const cfg = { ...DEFAULTS, ...(cfgRes.data?.value && typeof cfgRes.data.value === 'object' ? cfgRes.data.value : {}) };
  const alerted = new Set((alertRes.data || []).filter((n) => n.payload?.alert).map((n) => `${n.payload.hire_id}|${n.payload.start_date}`));
  const { send, noAccount } = welcomeDue(hiresRes.data || [], todayIso, holidays);
  if (send.length || noAccount.length) summary.quiet = false;

  const hireCc = await hireEmailCc(supabase);
  for (const h of send) {
    const to = [h.work_email, h.personal_email].filter(Boolean);
    // The hiring manager is copied too, so they see what their joiner was told
    // (9 Oct 2026).
    const manager = String((Array.isArray(h.offer) ? h.offer[0] : h.offer)?.hiring_manager_email || '').trim().toLowerCase();
    const cc = [...new Set([...hireCc, manager].filter(Boolean))].filter((e) => !to.includes(e));
    summary.planned.push({ welcome: h.full_name, to, cc, start: h.start_date });
    if (dryRun) continue;
    try {
      const mail = welcomeEmail(h, cfg);
      await sendEmail({ to, cc, ...mail, audience: 'team' });
      const now = new Date().toISOString();
      await supabase.from('hires').update({ welcome_sent_at: now }).eq('id', h.id);
      await logNotification({ kind: 'hire_welcome', recipientEmail: to.join(', '), subject: mail.subject, payload: { hire_id: h.id, start_date: h.start_date } });
      summary.sent += 1;
    } catch (err) { summary.errors.push(`welcome ${h.full_name}: ${err.message}`); }
  }

  for (const h of noAccount) {
    const key = `${h.id}|${h.start_date}`;
    if (alerted.has(key)) continue;
    const manager = (Array.isArray(h.offer) ? h.offer[0] : h.offer)?.hiring_manager_email;
    const to = [...new Set(['admin@youragency.com', manager].filter(Boolean).map((e) => String(e).toLowerCase()))];
    summary.planned.push({ noAccount: h.full_name, alert: to, start: h.start_date });
    if (dryRun) continue;
    const subject = `${h.full_name} starts ${prettyDate(String(h.start_date).slice(0, 10))} but has no youragency.com account yet`;
    try {
      await sendEmail({
        to, subject, audience: 'team',
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><p>${escapeHtml(h.full_name)} starts on <strong>${escapeHtml(prettyDate(String(h.start_date).slice(0, 10)))}</strong>, but has no @youragency.com account, so Colony can't send their welcome email (Colony sign-in, All Hands, Slack). Create the account from Hiring and the welcome goes out on the next morning's run.</p></div>`,
        text: `${h.full_name} starts on ${prettyDate(String(h.start_date).slice(0, 10))} but has no @youragency.com account, so Colony can't send their welcome email. Create the account from Hiring and the welcome goes out the next morning.\n`
      });
      await logNotification({ kind: 'hire_welcome', recipientEmail: to.join(', '), subject, payload: { hire_id: h.id, start_date: h.start_date, alert: true } });
      summary.alerted += 1;
    } catch (err) { summary.errors.push(`alert ${h.full_name}: ${err.message}`); }
  }
  return json(200, summary);
}

exports.handler = withCronHeartbeat('hire-welcome', handler);
exports._welcomeEmail = welcomeEmail;
