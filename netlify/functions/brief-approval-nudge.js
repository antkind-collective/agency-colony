// Chase a brief that is stuck waiting on the client to approve it
// (10 Sep 2026).
//
// Alice raised a brief with a Friday deadline. It went to the client's coordinators at
// 2am, and 36 hours later it was still sitting at `submitted` — unapproved, so
// deliberately off Your Agency's board, with the clock running and nobody at
// Your Agency able to touch it. One email at submission time was not enough.
//
// This runs every working morning and mails the org's coordinators — the only
// people who can pass the gate — copying the person who raised it and the
// Your Agency account leads. Once per brief per working day while it stays stuck.
//
// All the judgement is lib/approval-nudge.js, unit-tested without a database.
//
// DRY RUN: ?dry=1 lists exactly what it WOULD send and writes nothing.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');
const { isReminderRunDay } = require('./lib/brief-reminders');
const { nudgeFor, nudgeKey } = require('./lib/approval-nudge');

// Fallback only — the live list is app_config.brief_reviewer_emails.
const BRIEF_REVIEWER_EMAILS = ['rhea@youragency.com', 'mara@youragency.com'];

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function prettyDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';

  // Netlify invokes scheduled functions over HTTP POST, so httpMethod cannot
  // tell the scheduler from a stranger — only its payload carries next_run.
  // Checking the method is what left every cron dead for two months.
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Scheduled function only' }) };
  }

  const summary = { dryRun, quiet: dryRun, ran: false, considered: 0, stuck: 0, sent: 0, skippedAlreadySent: 0, planned: [], errors: [] };
  const supabase = getSupabaseAdmin();

  const { data: holRows, error: holErr } = await supabase.from('public_holidays').select('holiday_date');
  if (holErr) { summary.errors.push(`holidays: ${holErr.message}`); return json(500, summary); }
  const holidays = (holRows || []).map((h) => String(h.holiday_date).slice(0, 10));

  const todayIso = zonedParts(new Date(), IST_TIME_ZONE).iso;
  summary.today = todayIso;

  // Coordinators are not on Your Agency's calendar, but Your Agency is cc'd on every
  // one of these and a weekend chase would be noise for everyone.
  if (!isReminderRunDay(todayIso, holidays)) {
    summary.skippedNonWorkingDay = true;
    return json(200, summary);
  }
  summary.ran = true;

  const [briefRes, partnerRes, sentRes, cfgRes] = await Promise.all([
    supabase.from('briefs')
      .select('id, org, title, request_type, status, deadline, created_at, paused_at, submitted_by_partner_id')
      .eq('status', 'submitted').limit(2000),
    supabase.from('partners').select('id, email, full_name, org, partner_role, is_active').limit(500),
    supabase.from('notification_log').select('payload').eq('kind', 'brief_approval_nudge').limit(5000),
    supabase.from('app_config').select('value').eq('key', 'brief_reviewer_emails').maybeSingle()
  ]);
  for (const r of [briefRes, partnerRes, sentRes]) {
    if (r.error) { summary.errors.push(r.error.message); return json(500, summary); }
  }

  const partners = (partnerRes.data || []).filter((p) => p.is_active !== false);
  const partnerById = new Map(partners.map((p) => [p.id, p]));
  const alreadySent = new Set((sentRes.data || []).map((n) => n.payload?.nudge_key).filter(Boolean));
  const ccLeads = (Array.isArray(cfgRes.data?.value) ? cfgRes.data.value : BRIEF_REVIEWER_EMAILS)
    .map((e) => String(e).toLowerCase().trim()).filter(Boolean);
  // Partners live on Circle, not Colony — a Colony link would bounce them off
  // a sign-in they do not have. getConfig() owns that mapping now.
  const { circleBaseUrl: circleUrl } = getConfig();

  for (const brief of briefRes.data || []) {
    summary.considered += 1;
    const hit = nudgeFor(brief, todayIso, holidays);
    if (!hit) continue;
    summary.stuck += 1;

    // Only a coordinator can pass the gate (guard_partner_brief_update), so
    // they are the recipients. No coordinator means nobody can approve it at
    // all — that is Alex's problem to fix, not an email to nowhere.
    const coordinators = partners.filter((p) => p.org === brief.org && p.partner_role === 'coordinator' && p.email);
    if (!coordinators.length) {
      summary.errors.push(`${brief.org} has no active coordinator — brief ${brief.id} cannot be approved by anyone`);
      continue;
    }

    const key = nudgeKey(brief.id, todayIso);
    if (alreadySent.has(key)) { summary.skippedAlreadySent += 1; continue; }

    const raisedBy = partnerById.get(brief.submitted_by_partner_id);
    const to = coordinators.map((c) => c.email);
    const cc = [...ccLeads];
    if (raisedBy?.email && !to.includes(raisedBy.email)) cc.push(raisedBy.email);

    const waitedText = plural(hit.waited, 'working day');
    const subject = hit.urgent
      ? `Deadline at risk — "${brief.title}" still needs your approval`
      : `Waiting on you — "${brief.title}" has not been approved yet`;

    const deadlineLine = hit.due
      ? (hit.workingDaysLeft === null
        ? `Its deadline (${prettyDate(hit.due)}) has already passed.`
        : `Its deadline is ${prettyDate(hit.due)} — ${plural(hit.workingDaysLeft, 'working day')} away.`)
      : 'No deadline is set on it.';

    summary.planned.push({ to, cc, brief: brief.title, org: brief.org, waited: hit.waited, due: hit.due, workingDaysLeft: hit.workingDaysLeft, urgent: hit.urgent, subject });
    if (dryRun) continue;

    const html = `<div style="font-family:Arial,sans-serif;line-height:1.6">
      <p>Hi,</p>
      <p><strong>${escapeHtml(brief.title)}</strong>${raisedBy ? `, raised by ${escapeHtml(raisedBy.full_name || raisedBy.email)},` : ''}
         has been waiting ${waitedText} for your approval.</p>
      <p>${escapeHtml(deadlineLine)}</p>
      <p>Your Agency cannot start on it until it is approved, so the clock is running on our side with nothing we can do.</p>
      <p><a href="${escapeHtml(circleUrl)}">Open it in Circle</a> and either send it to Your Agency or ask for changes.</p>
      ${hit.urgent ? '<p style="color:#b3261e"><strong>If the deadline needs to move, tell us now rather than on the day.</strong></p>' : ''}
    </div>`;
    const text = `${brief.title} has been waiting ${waitedText} for your approval.\n`
      + `${deadlineLine}\n\nYour Agency cannot start until it is approved.\n${circleUrl}\n`;

    try {
      // Addressed to the client's coordinators; Your Agency is only cc'd.
      await sendEmail({ to, cc, subject, html, text, audience: 'partner' });
      await logNotification({
        kind: 'brief_approval_nudge',
        recipientEmail: to.join(', '),
        subject,
        payload: { nudge_key: key, brief_id: brief.id, org: brief.org, waited: hit.waited, due: hit.due, urgent: hit.urgent }
      });
      summary.sent += 1;
      alreadySent.add(key);
    } catch (err) {
      summary.errors.push(`send ${brief.id}: ${err.message}`);
    }
  }

  return json(200, summary);
}

function json(statusCode, body) {
  return { statusCode, body: JSON.stringify(body, null, 2) };
}

exports.handler = withCronHeartbeat('brief-approval-nudge', handler);
