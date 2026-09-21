// Deadline reminders for brief deliverables — Rhea's workflow doc, step 5,
// and Carmen's board request of 13 Aug 2026.
//
// Two working days before a deliverable is due, one working day before, and on
// the day itself: email the assignee, cc the account leads. One email per
// deliverable per stage, ever.
//
// Every judgement lives in lib/brief-reminders.js and is unit-tested without a
// database or an outbox. This file queries, dedupes and sends — nothing else.
//
// DRY RUN: call with ?dry=1 to get the exact list of emails it WOULD send,
// without sending any or writing to notification_log. Reminder emails were
// silently broken for two months once before; this exists so the first run can
// be read before anyone's inbox is involved.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');
const {
  isReminderRunDay, reminderFor, reminderKey, STAGE_COPY
} = require('./lib/brief-reminders');

// Fallback only — the live list is app_config.brief_reviewer_emails, matching
// getBriefReviewerEmails() in the app. These are the account leads the doc
// wants copied, and the desk an unaccepted timeline escalates to.
const BRIEF_REVIEWER_EMAILS = ['rhea@youragency.com', 'mara@youragency.com'];

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function configList(supabase, key, fallback) {
  const { data, error } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle();
  const value = !error && Array.isArray(data?.value) ? data.value : fallback;
  return value.map((e) => String(e).toLowerCase().trim()).filter(Boolean);
}

function prettyDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';

  // Netlify invokes scheduled functions over HTTP POST, so httpMethod alone
  // cannot tell the scheduler from a stranger — checking it is what left every
  // cron silently dead for two months (13 Apr – 10 Jun 2026). Only the
  // scheduler's own payload carries next_run.
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Scheduled function only' }) };
  }

  const runAt = new Date();
  // quiet: a dry run must leave nothing behind at all, heartbeat row included.
  const summary = { dryRun, quiet: dryRun, ran: false, considered: 0, due: 0, sent: 0, skippedAlreadySent: 0, planned: [], errors: [] };

  const supabase = getSupabaseAdmin();

  // Holidays first: they decide both whether today is a sending day at all and
  // how the working-day countdown runs.
  const { data: holRows, error: holErr } = await supabase
    .from('public_holidays').select('holiday_date');
  if (holErr) { summary.errors.push(`holidays: ${holErr.message}`); return json(500, summary); }
  const holidays = (holRows || []).map((h) => String(h.holiday_date).slice(0, 10));

  const todayIso = zonedParts(runAt, IST_TIME_ZONE).iso;
  summary.today = todayIso;

  // Never chase anyone on a closed day. The countdown itself is happy to say
  // "one working day left" on a Saturday — this is what stops it being sent.
  if (!isReminderRunDay(todayIso, holidays)) {
    summary.skippedNonWorkingDay = true;
    return json(200, summary);
  }
  summary.ran = true;

  const [delivRes, briefRes, empRes, sentRes] = await Promise.all([
    supabase.from('brief_deliverables')
      .select('id, brief_id, title, deliverable_type, status, due_at, delivered_at, assignee_employee_id')
      .not('due_at', 'is', null).limit(2000),
    supabase.from('briefs').select('id, title, status, paused_at, org').limit(2000),
    supabase.from('employees').select('id, email, full_name, is_active').limit(500),
    supabase.from('notification_log').select('payload')
      .eq('kind', 'brief_deadline_reminder').limit(5000)
  ]);
  for (const r of [delivRes, briefRes, empRes, sentRes]) {
    if (r.error) { summary.errors.push(r.error.message); return json(500, summary); }
  }

  const briefById = new Map((briefRes.data || []).map((b) => [b.id, b]));
  const empById = new Map((empRes.data || []).map((e) => [e.id, e]));
  const alreadySent = new Set((sentRes.data || []).map((n) => n.payload?.reminder_key).filter(Boolean));

  const ccList = await configList(supabase, 'brief_reviewer_emails', BRIEF_REVIEWER_EMAILS);
  const { appBaseUrl } = getConfig();

  for (const d of delivRes.data || []) {
    summary.considered += 1;
    const brief = briefById.get(d.brief_id);
    const hit = reminderFor(d, brief, todayIso, holidays);
    if (!hit) continue;

    const assignee = empById.get(d.assignee_employee_id);
    // An assignee who has left keeps the account leads informed rather than
    // silently dropping the deadline.
    if (!assignee?.email || assignee.is_active === false) {
      summary.errors.push(`no active assignee for deliverable ${d.id}`);
      continue;
    }
    summary.due += 1;

    const key = reminderKey(d.id, hit.stage);
    if (alreadySent.has(key)) { summary.skippedAlreadySent += 1; continue; }

    const copy = STAGE_COPY[hit.stage];
    const piece = d.title || d.deliverable_type || 'A deliverable';
    const subject = `${piece} ${copy.lead} — ${brief.title}`;
    const link = `${appBaseUrl}?open=brief:${d.brief_id}#briefs-pipeline`;

    summary.planned.push({
      to: assignee.email, cc: ccList, stage: hit.stage,
      due: hit.dueIso, brief: brief.title, piece, subject
    });

    if (dryRun) continue;

    const html = `<div style="font-family:Arial,sans-serif;line-height:1.6">
      <p>Hi ${escapeHtml((assignee.full_name || '').split(' ')[0] || 'there')},</p>
      <p>Just ${copy.tone}: <strong>${escapeHtml(piece)}</strong> ${copy.lead}
         (${escapeHtml(prettyDate(hit.dueIso))}).</p>
      <p>Brief: <strong>${escapeHtml(brief.title)}</strong></p>
      <p><a href="${escapeHtml(link)}">Open it in Colony</a></p>
      <p style="color:#777;font-size:13px">If the date needs to move, say so on Slack and update it in Colony —
         that is where the deadline lives now.</p>
    </div>`;
    const text = `Hi ${(assignee.full_name || '').split(' ')[0] || 'there'},\n\n`
      + `${piece} ${copy.lead} (${prettyDate(hit.dueIso)}).\nBrief: ${brief.title}\n\n${link}\n`;

    try {
      await sendEmail({ to: assignee.email, cc: ccList, subject, html, text });
      await logNotification({
        kind: 'brief_deadline_reminder',
        recipientEmail: assignee.email,
        subject,
        payload: { reminder_key: key, deliverable_id: d.id, brief_id: d.brief_id, stage: hit.stage, due: hit.dueIso }
      });
      summary.sent += 1;
      alreadySent.add(key);
    } catch (err) {
      summary.errors.push(`send ${d.id}: ${err.message}`);
    }
  }

  return json(200, summary);
}

function json(statusCode, body) {
  return { statusCode, body: JSON.stringify(body, null, 2) };
}

exports.handler = withCronHeartbeat('brief-deadline-reminder', handler);
