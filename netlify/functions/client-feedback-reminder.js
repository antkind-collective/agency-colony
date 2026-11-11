// Chase Alex about client feedback she has not fixed yet (6 Oct 2026).
//
// A client's bug or idea on Circle's wall emails Alex once when it is posted
// (feature-request-notify). This runs every morning and, for each post still
// open on day 2, 4, 6 … after it arrived, sends her one Circle email listing
// them. It stops when she marks the post fixed on Circle.
//
// All the judgement is lib/client-feedback-reminder.js, unit-tested without a
// database.
//
// DRY RUN: ?dry=1 lists exactly what it WOULD send and writes nothing.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');
const { postsDueForReminder, isOpenClientPost, reminderKey } = require('./lib/client-feedback-reminder');

const RECIPIENT = 'admin@youragency.com';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function snippet(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';

  // Netlify invokes scheduled functions over HTTP POST, so only the payload's
  // next_run tells the scheduler from a stranger.
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Scheduled function only' }) };
  }

  const summary = { dryRun, quiet: true, open: 0, due: 0, sent: 0, planned: [], errors: [] };
  const supabase = getSupabaseAdmin();
  const todayIso = zonedParts(new Date(), IST_TIME_ZONE).iso;
  summary.today = todayIso;

  const [postRes, sentRes] = await Promise.all([
    supabase.from('feature_requests')
      .select('id, author_partner_id, author_name, request_text, request_type, status, created_at')
      .not('author_partner_id', 'is', null).limit(2000),
    supabase.from('notification_log').select('id')
      .eq('kind', 'client_feedback_reminder').contains('payload', { reminder_key: reminderKey(todayIso) }).limit(1)
  ]);
  for (const r of [postRes, sentRes]) {
    if (r.error) { summary.errors.push(r.error.message); return json(500, summary); }
  }

  const posts = postRes.data || [];
  summary.open = posts.filter(isOpenClientPost).length;
  const due = postsDueForReminder(posts, todayIso);
  summary.due = due.length;
  if (!due.length) return json(200, summary);
  if ((sentRes.data || []).length) { summary.skippedAlreadySent = true; return json(200, summary); }

  const { circleBaseUrl } = getConfig();
  const link = (p) => `${circleBaseUrl}?open=request:${p.id}#partner-feedback`;
  const n = due.length;
  const subject = n === 1
    ? `Still open after ${due[0].age} days: ${due[0].request_type === 'bug' ? 'bug' : 'idea'} from ${due[0].author_name || 'a client'}`
    : `${n} client posts still open on Circle`;
  summary.planned.push({ to: RECIPIENT, subject, posts: due.map((p) => ({ id: p.id, age: p.age, status: p.status })) });
  summary.quiet = dryRun;
  if (dryRun) return json(200, summary);

  const items = due.map((p) => `<li style="margin-bottom:10px">
      <strong>${p.request_type === 'bug' ? 'Bug' : 'Idea'}</strong> from ${escapeHtml(p.author_name || 'a client')},
      open ${p.age} days${p.status === 'in_progress' ? ' (in progress)' : ''}:<br>
      <span style="color:#555">${escapeHtml(snippet(p.request_text))}</span><br>
      <a href="${escapeHtml(link(p))}">Open it in Circle</a>
    </li>`).join('');
  const others = summary.open - n;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.5">
      <p>Hey Alex,</p>
      <p>${n === 1 ? 'This client post is' : 'These client posts are'} still waiting for a fix:</p>
      <ul style="padding-left:18px">${items}</ul>
      ${others > 0 ? `<p>${others} more ${others === 1 ? 'is' : 'are'} open but not due a reminder today.</p>` : ''}
      <p>Mark each one fixed on Circle and the reminders stop.</p>
    </div>`;
  const text = ['Hey Alex,', 'Still waiting for a fix:', '',
    ...due.map((p) => `- ${p.request_type === 'bug' ? 'Bug' : 'Idea'} from ${p.author_name || 'a client'}, open ${p.age} days: ${snippet(p.request_text)}\n  ${link(p)}`),
    '', 'Mark each one fixed on Circle and the reminders stop.'].join('\n');

  try {
    // Circle-branded: these posts live on Circle and are handled there.
    const result = await sendEmail({ to: RECIPIENT, subject, html, text, audience: 'partner' });
    await logNotification({
      kind: 'client_feedback_reminder',
      recipientEmail: RECIPIENT,
      subject,
      payload: { reminder_key: reminderKey(todayIso), feature_request_ids: due.map((p) => p.id) },
      status: result.skipped ? 'skipped' : 'sent'
    });
    summary.sent = 1;
  } catch (err) {
    summary.errors.push(`send: ${err.message}`);
  }
  return json(200, summary);
}

function json(statusCode, body) {
  return { statusCode, body: JSON.stringify(body, null, 2) };
}

exports.handler = withCronHeartbeat('client-feedback-reminder', handler);
