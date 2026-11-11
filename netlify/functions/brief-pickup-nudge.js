// Chase Your Agency when an approved brief sits with nobody (11 Sep 2026).
//
// The mirror of brief-approval-nudge: that one chases the client while a brief
// waits for their approval; this one chases the account team while an approved
// brief waits for someone here to pick it up. Alice's brief went through the
// first gap and straight into this one — approved 20:24, still nobody's the
// next morning, and deadline reminders had nothing to fire on because no
// deliverable existed yet.
//
// Runs every working morning after the other two. Emails the account leads.
// Once per brief per working day while it stays unowned. Internal only: no
// client is ever copied on Your Agency being slow.
//
// All the judgement is lib/pickup-nudge.js. DRY RUN: ?dry=1.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');
const { isReminderRunDay } = require('./lib/brief-reminders');
const { pickupNudgeFor, pickupNudgeKey, quickRequestNudgeFor, quickRequestNudgeKey } = require('./lib/pickup-nudge');

const BRIEF_REVIEWER_EMAILS = ['rhea@youragency.com', 'mara@youragency.com'];

function escapeHtml(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function prettyDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const summary = { dryRun, quiet: dryRun, ran: false, considered: 0, stuck: 0, sent: 0, skippedAlreadySent: 0, planned: [], errors: [] };
  const supabase = getSupabaseAdmin();

  const { data: holRows, error: holErr } = await supabase.from('public_holidays').select('holiday_date');
  if (holErr) { summary.errors.push(`holidays: ${holErr.message}`); return json(500, summary); }
  const holidays = (holRows || []).map((h) => String(h.holiday_date).slice(0, 10));
  const todayIso = zonedParts(new Date(), IST_TIME_ZONE).iso;
  summary.today = todayIso;
  if (!isReminderRunDay(todayIso, holidays)) { summary.skippedNonWorkingDay = true; return json(200, summary); }
  summary.ran = true;

  const [briefRes, delivRes, histRes, sentRes, cfgRes, quickRes, quickSentRes] = await Promise.all([
    supabase.from('briefs').select('id, org, title, request_type, status, deadline, paused_at').eq('status', 'ready_for_review').is('archived_at', null).limit(2000),
    supabase.from('brief_deliverables').select('brief_id, assignee_employee_id, copy_assignee_id, design_assignee_id').limit(5000),
    // When each brief ENTERED ready_for_review — the clock starts at approval,
    // not at submission.
    supabase.from('brief_status_history').select('brief_id, entered_at').eq('status', 'ready_for_review').limit(5000),
    supabase.from('notification_log').select('payload').eq('kind', 'brief_pickup_nudge').limit(5000),
    supabase.from('app_config').select('value').eq('key', 'brief_reviewer_emails').maybeSingle(),
    // Quick requests the client sent that nobody here has acknowledged (27 Sep 2026).
    supabase.from('briefs').select('id, org, title, request_type, status, paused_at, created_at').eq('request_type', 'notify_only').eq('status', 'submitted').is('archived_at', null).limit(2000),
    supabase.from('notification_log').select('payload').eq('kind', 'quick_request_nudge').limit(5000)
  ]);
  for (const r of [briefRes, delivRes, histRes, sentRes, quickRes, quickSentRes]) {
    if (r.error) { summary.errors.push(r.error.message); return json(500, summary); }
  }

  const approvedAt = new Map();
  for (const h of histRes.data || []) {
    const prev = approvedAt.get(h.brief_id);
    if (!prev || h.entered_at > prev) approvedAt.set(h.brief_id, h.entered_at);
  }
  const alreadySent = new Set((sentRes.data || []).map((n) => n.payload?.nudge_key).filter(Boolean));
  const to = (Array.isArray(cfgRes.data?.value) ? cfgRes.data.value : BRIEF_REVIEWER_EMAILS)
    .map((e) => String(e).toLowerCase().trim()).filter(Boolean);
  const { appBaseUrl } = getConfig();

  for (const brief of briefRes.data || []) {
    const link = `${appBaseUrl}?open=brief:${brief.id}#briefs-pipeline`;
    summary.considered += 1;
    const hit = pickupNudgeFor(brief, delivRes.data || [], approvedAt.get(brief.id), todayIso, holidays);
    if (!hit) continue;
    summary.stuck += 1;
    const key = pickupNudgeKey(brief.id, todayIso);
    if (alreadySent.has(key)) { summary.skippedAlreadySent += 1; continue; }

    const waitedText = plural(hit.waited, 'working day');
    const subject = hit.urgent
      ? `Nobody has picked up "${brief.title}" — due ${prettyDate(hit.due)}`
      : `"${brief.title}" is approved and waiting for an owner`;
    const deadlineLine = !hit.due ? 'No deadline is set on it.'
      : hit.workingDaysLeft === null ? `Its deadline (${prettyDate(hit.due)}) has already passed.`
      : `Its deadline is ${prettyDate(hit.due)} — ${plural(hit.workingDaysLeft, 'working day')} away.`;

    summary.planned.push({ to, brief: brief.title, org: brief.org, waited: hit.waited, due: hit.due, workingDaysLeft: hit.workingDaysLeft, urgent: hit.urgent, subject });
    if (dryRun) continue;

    const html = `<div style="font-family:Arial,sans-serif;line-height:1.6">
      <p>Hi,</p>
      <p><strong>${escapeHtml(brief.title)}</strong> (${escapeHtml(brief.org)}) was approved by the client
         ${waitedText} ago and nobody at Your Agency has picked it up — it has not been started and has no deliverable with an owner.</p>
      <p>${escapeHtml(deadlineLine)}</p>
      <p>Deadline reminders only work once a deliverable has an owner and a date, so until someone takes this, nothing else will chase it.</p>
      <p><a href="${escapeHtml(link)}">Open it in Colony</a> — hit Start creative, or add the deliverable and assign it.</p>
    </div>`;
    const text = `${brief.title} (${brief.org}) was approved ${waitedText} ago and nobody has picked it up.\n${deadlineLine}\n${link}\n`;

    try {
      await sendEmail({ to, subject, html, text, audience: 'team' });
      await logNotification({ kind: 'brief_pickup_nudge', recipientEmail: to.join(', '), subject,
        payload: { nudge_key: key, brief_id: brief.id, org: brief.org, waited: hit.waited, due: hit.due, urgent: hit.urgent } });
      summary.sent += 1;
      alreadySent.add(key);
    } catch (err) { summary.errors.push(`send ${brief.id}: ${err.message}`); }
  }

  // Quick requests: acknowledge (seen, we have it) or close (done / no action).
  const quickSent = new Set((quickSentRes.data || []).map((n) => n.payload?.nudge_key).filter(Boolean));
  summary.quickConsidered = 0; summary.quickStuck = 0; summary.quickSent = 0;
  for (const req of quickRes.data || []) {
    summary.quickConsidered += 1;
    const hit = quickRequestNudgeFor(req, todayIso, holidays);
    if (!hit) continue;
    summary.quickStuck += 1;
    const key = quickRequestNudgeKey(req.id, todayIso);
    if (quickSent.has(key)) { summary.skippedAlreadySent += 1; continue; }
    const link = `${appBaseUrl}?open=brief:${req.id}#briefs-pipeline`;
    const waitedText = plural(hit.waited, 'working day');
    const subject = `${req.org} sent a quick request ${waitedText} ago — nobody has acknowledged it`;
    summary.planned.push({ to, quickRequest: req.title, org: req.org, waited: hit.waited, subject });
    if (dryRun) continue;
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.6">
      <p>Hi,</p>
      <p>${escapeHtml(req.org)} sent the quick request <strong>${escapeHtml(req.title)}</strong> ${waitedText} ago, and nobody at Your Agency has acknowledged it yet.</p>
      <p>Open it and move it on: <strong>Acknowledge</strong> if we have it in hand, or <strong>Close</strong> if it is done or needs no action. If it needs real work, raise it as a brief.</p>
      <p><a href="${escapeHtml(link)}">Open it in Colony</a></p>
      <p style="color:#666;font-size:12px;">This reminder repeats each working morning until the request is acknowledged or closed.</p>
    </div>`;
    const text = `${req.org} sent the quick request "${req.title}" ${waitedText} ago and nobody has acknowledged it.\nAcknowledge it, close it, or raise it as a brief:\n${link}\n`;
    try {
      await sendEmail({ to, subject, html, text, audience: 'team' });
      await logNotification({ kind: 'quick_request_nudge', recipientEmail: to.join(', '), subject,
        payload: { nudge_key: key, brief_id: req.id, org: req.org, waited: hit.waited } });
      summary.quickSent += 1;
      quickSent.add(key);
    } catch (err) { summary.errors.push(`send quick ${req.id}: ${err.message}`); }
  }
  return json(200, summary);
}
function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }
exports.handler = withCronHeartbeat('brief-pickup-nudge', handler);
