const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, alreadyNotified } = require('./lib/notifications');
const { getConfig } = require('./lib/config');
const { callerCanSee, callerDisplayName } = require('./lib/caller');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function extractBearerToken(headers = {}) {
  const raw = headers.authorization || headers.Authorization;
  if (!raw) return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed.' });
  }

  const token = extractBearerToken(event.headers);
  if (!token) {
    return jsonResponse(401, { error: 'Missing bearer token.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON payload.' });
  }

  const { type, featureRequestId } = payload;
  if (!type || !featureRequestId) {
    return jsonResponse(400, { error: 'type and featureRequestId are required.' });
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof featureRequestId !== 'string' || !UUID_RE.test(featureRequestId)) {
    return jsonResponse(400, { error: 'featureRequestId must be a valid UUID.' });
  }

  const validTypes = ['reply', 'upvote', 'status_change', 'new_bug'];
  if (!validTypes.includes(type)) {
    return jsonResponse(400, { error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
  }

  const { appBaseUrl } = getConfig();
  const supabase = getSupabaseAdmin();

  // Verify the caller is authenticated
  const userResponse = await supabase.auth.getUser(token);
  if (userResponse.error || !userResponse.data?.user) {
    return jsonResponse(401, { error: 'Invalid auth token.' });
  }

  // Audit 16 Sep 2026: nothing that reaches the owner's inbox comes from the
  // payload any more. Before, any signed-in token could put 4,000 characters
  // of its own text, under any name it liked, into an email "from Your Agency
  // Circle" to a client — the payload's actorName, replyText and newStatus.
  // Now the caller's RLS must see the post, the actor is the token's owner,
  // the reply is their latest stored reply and the status is the stored one.
  if (!await callerCanSee(token, 'feature_requests', featureRequestId)) {
    return jsonResponse(404, { error: 'Feature request not found.' });
  }
  const caller = await callerDisplayName(supabase, userResponse.data.user.id);

  // Look up the feature request and its owner
  const frResponse = await supabase
    .from('feature_requests')
    .select(`
      id,
      employee_id,
      author_partner_id,
      author_name,
      request_text,
      request_type,
      status,
      employee:employees!feature_requests_employee_id_fkey (
        id,
        full_name,
        email
      ),
      author_partner:partners!feature_requests_author_partner_id_fkey (
        id,
        full_name,
        email,
        email_opt_out
      )
    `)
    .eq('id', featureRequestId)
    .single();

  if (frResponse.error || !frResponse.data) {
    return jsonResponse(404, { error: 'Feature request not found.' });
  }

  const fr = frResponse.data;
  // Owner is an employee OR a partner (partner feedback posts).
  const ownerEmail = fr.employee?.email || fr.author_partner?.email;
  const ownerName = fr.employee?.full_name || fr.author_partner?.full_name || 'there';

  // A client posted it, so every word and link they receive must be Circle.
  // Until today this said "View it on Colony" and linked to a platform they
  // are locked out of — Mira got exactly that email on 10 Sep 2026.
  const ownerIsPartner = !fr.employee?.email && Boolean(fr.author_partner?.email);
  const { circleBaseUrl } = getConfig();
  const ownerProduct = ownerIsPartner ? 'Circle' : 'Colony';
  const ownerLink = ownerIsPartner ? `${circleBaseUrl}?open=request:${fr.id}#partner-feedback` : `${appBaseUrl}?open=request:${fr.id}#feature-requests`;

  if (!ownerEmail) {
    return jsonResponse(422, { error: 'Feature request owner has no email.' });
  }

  const callerEmail = String(userResponse.data.user.email || '').toLowerCase();
  const actor = caller.name;
  const snippet = fr.request_text.length > 80
    ? fr.request_text.slice(0, 80) + '...'
    : fr.request_text;
  const typeLabel = fr.request_type === 'bug' ? 'bug report' : 'feature request';

  // --- New post (bug or feature) → notify admin@youragency.com ---
  if (type === 'new_bug') {
    // Once per post and caller (audit S24).
    if (await alreadyNotified(supabase, 'new_bug_report', { feature_request_id: featureRequestId, reporter_email: callerEmail })) {
      return jsonResponse(200, { ok: true, skipped: true, reason: 'Already sent.' });
    }
    const adminEmail = 'admin@youragency.com';
    const isBug = fr.request_type === 'bug';
    const subject = isBug ? `🐛 New bug reported by ${actor}` : `💡 New feature request from ${actor}`;
    // Alex wants one alert per new post on EITHER wall, so it has to say which
    // wall — the two are different audiences and different follow-ups.
    const postedOn = fr.author_partner_id ? 'Circle' : 'Colony';
    const who = fr.author_partner_id ? `${actor} (client, on Circle)` : actor;
    const bodyLine = `<p>${escapeHtml(who)} posted a new ${escapeHtml(typeLabel)} on ${postedOn}:</p>`;
    // A client post lives on Circle only (6 Oct 2026): Colony's wall no longer
    // shows it, so the alert is a Circle email that links to Circle, where
    // Alex replies and marks it fixed. Reminders follow every 2 days until
    // then (client-feedback-reminder.js).
    const openLink = fr.author_partner_id
      ? `${circleBaseUrl}?open=request:${fr.id}#partner-feedback`
      : `${appBaseUrl}?open=request:${fr.id}#feature-requests`;

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <p>Hey Alex,</p>
        ${bodyLine}
        <blockquote style="border-left:3px solid ${isBug ? '#e74c3c' : '#b8a04a'};margin:8px 0;padding:4px 12px;color:#555">${escapeHtml(snippet)}</blockquote>
        <p>Open it in ${postedOn}: <a href="${openLink}">${openLink}</a></p>
      </div>
    `;
    const text = `New ${typeLabel} from ${who}:\n"${snippet}"\nOpen in ${postedOn}: ${openLink}`;

    try {
      const emailResult = await sendEmail({ to: adminEmail, subject, html, text, audience: fr.author_partner_id ? 'partner' : 'team' });
      await logNotification({
        kind: 'new_bug_report',
        recipientEmail: adminEmail,
        subject,
        payload: { feature_request_id: featureRequestId, reporter_email: callerEmail },
        status: emailResult.skipped ? 'skipped' : 'sent'
      });
      return jsonResponse(200, { ok: true, skipped: Boolean(emailResult.skipped) });
    } catch (error) {
      console.error('feature-request-notify send failed:', error.message);
      return jsonResponse(500, { error: 'Email send failed.' });
    }
  }

  // --- Owner notifications (reply, upvote, status_change) ---
  // Don't notify yourself
  if (callerEmail === ownerEmail.toLowerCase()) {
    return jsonResponse(200, { ok: true, skipped: true, reason: 'Actor is the owner.' });
  }
  // Opted-out client logins (Your Agency people posting on a client's behalf,
  // 30 Sep 2026) get no client emails, as in the brief nudges.
  if (ownerIsPartner && fr.author_partner?.email_opt_out) {
    return jsonResponse(200, { ok: true, skipped: true, reason: 'Owner opted out.' });
  }

  let subject;
  let bodyLine;
  let notifKind;

  if (type === 'reply') {
    subject = `${actor} commented on your ${typeLabel}`;
    bodyLine = `<p>${escapeHtml(actor)} left a comment on your ${typeLabel}:</p>`;
    notifKind = 'feature_request_reply';
  } else if (type === 'upvote') {
    subject = `${actor} upvoted your ${typeLabel}`;
    bodyLine = `<p>${escapeHtml(actor)} upvoted your ${typeLabel}:</p>`;
    notifKind = 'feature_request_upvote';
  } else {
    const statusLabel = fr.status === 'done' ? 'Completed'
      : fr.status === 'in_progress' ? 'In Progress' : fr.status;
    subject = `Your ${typeLabel} was marked as ${statusLabel}`;
    bodyLine = `<p>Your ${typeLabel} status was changed to <strong>${escapeHtml(statusLabel)}</strong>:</p>`;
    notifKind = 'feature_request_status';
  }

  const skipRepeat = () => jsonResponse(200, { ok: true, skipped: true, reason: 'Already sent.' });

  // Upvotes: only a real one, and one email per post and caller however often
  // it is toggled (audit S24).
  if (type === 'upvote') {
    const { data: vote } = caller.employeeId
      ? await supabase.from('feature_request_upvotes').select('employee_id')
        .eq('feature_request_id', featureRequestId).eq('employee_id', caller.employeeId).limit(1)
      : { data: [] };
    if (!vote?.length) return jsonResponse(200, { ok: true, skipped: true, reason: 'No upvote by the caller.' });
    if (await alreadyNotified(supabase, notifKind, { feature_request_id: featureRequestId, actor_email: callerEmail })) return skipRepeat();
  }

  // Status: skip only if the last status email already announced this status.
  // Compared on the subject because older rows have no status in the payload,
  // and so done → in progress → done again still tells the owner.
  if (type === 'status_change') {
    const { data: last } = await supabase.from('notification_log').select('subject')
      .eq('kind', notifKind).eq('payload->>feature_request_id', featureRequestId)
      .order('created_at', { ascending: false }).limit(1);
    if (last?.[0]?.subject === subject) return skipRepeat();
  }

  // Include the comment itself for replies — "someone commented" without the
  // comment forces a login just to find out what was said.
  let replyText = '';
  let replyId = null;
  if (type === 'reply') {
    const authorCol = caller.employeeId ? 'employee_id' : 'author_partner_id';
    const authorId = caller.employeeId || caller.partnerId;
    const { data: latest } = authorId
      ? await supabase.from('feature_request_replies').select('id, reply_text')
        .eq('feature_request_id', featureRequestId).eq(authorCol, authorId)
        .order('created_at', { ascending: false }).limit(1)
      : { data: [] };
    if (!latest?.length) return jsonResponse(200, { ok: true, skipped: true, reason: 'No reply by the caller.' });
    replyId = latest[0].id;
    // Once per reply (audit S24): a new reply mails, a re-POST of this one doesn't.
    if (await alreadyNotified(supabase, notifKind, { feature_request_id: featureRequestId, reply_id: replyId })) return skipRepeat();
    replyText = String(latest[0].reply_text || '').trim();
  }
  const replyHtml = replyText
    ? `<div style="background:#faf7f0;border-radius:8px;padding:12px 14px;margin:8px 0 12px;color:#403f3a">${escapeHtml(replyText)}</div>`
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <p>Hello ${escapeHtml(ownerName)},</p>
      ${bodyLine}
      <blockquote style="border-left:3px solid #ccc;margin:8px 0;padding:4px 12px;color:#555">${escapeHtml(snippet)}</blockquote>
      ${replyHtml}
      <p>View it on ${ownerProduct}: <a href="${ownerLink}">${ownerLink}</a></p>
    </div>
  `;

  const text = [
    `Hello ${ownerName},`,
    type === 'reply' ? `${actor} commented on your ${typeLabel}:` :
    type === 'upvote' ? `${actor} upvoted your ${typeLabel}:` :
    `Your ${typeLabel} status was changed:`,
    `"${snippet}"`,
    ...(replyText ? ['', replyText] : []),
    `View it on ${ownerProduct}: ${ownerLink}`
  ].join('\n');

  try {
    const emailResult = await sendEmail({
      to: ownerEmail, subject, html, text,
      audience: ownerIsPartner ? 'partner' : 'team'
    });

    await logNotification({
      kind: notifKind,
      recipientEmail: ownerEmail,
      subject,
      payload: {
        feature_request_id: featureRequestId,
        type,
        actor_email: callerEmail,
        ...(replyId ? { reply_id: replyId } : {}),
        ...(type === 'status_change' ? { status: fr.status } : {})
      },
      status: emailResult.skipped ? 'skipped' : 'sent'
    });

    // No emailResult: it carries the owner's address, which a caller who is
    // not the owner has no business receiving.
    return jsonResponse(200, { ok: true, skipped: Boolean(emailResult.skipped) });
  } catch (error) {
    console.error('feature-request-notify send failed:', error.message);
    return jsonResponse(500, { error: 'Email send failed.' });
  }
};
