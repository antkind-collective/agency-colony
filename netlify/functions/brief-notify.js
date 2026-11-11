// Brief pipeline emails — Section 7 notification matrix of the the client doc.
// Called fire-and-forget by the client after brief events. Recipients are the
// specific stakeholders per event (never a broadcast): org coordinators
// (Grace), the submitter, internal reviewers (Rhea/Mara via
// app_config brief_reviewer_emails), or a deliverable assignee.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, alreadyNotified } = require('./lib/notifications');
const { getConfig } = require('./lib/config');
const { callerCanSee, callerCanWorkBrief } = require('./lib/caller');
const { approverRecipients, shortDate } = require('./lib/brief-approvers');

const FALLBACK_REVIEWERS = ['rhea@youragency.com', 'mara@youragency.com'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EVENTS = ['submitted', 'ga_approved', 'changes_requested', 'locked', 'delivered', 'reopened', 'revision_requested', 'deliverable_assigned', 'deliverable_ready', 'date_changed'];
// What a client's own buttons fire (submit, approve, ask for a revision). The
// rest are Your Agency's moves; a partner token announcing "Delivered" is forged.
const PARTNER_EVENTS = ['submitted', 'ga_approved', 'revision_requested'];
// The state each event announces (audit S24): it can only be true of a brief
// that is there. date_changed isn't about a state and has its own check below.
const IN_PRODUCTION = ['in_creative', 'under_revision'];
const EVENT_STATES = {
  submitted: ['submitted'],
  ga_approved: ['ready_for_review'],
  changes_requested: ['pending_info'],
  locked: ['locked', 'in_creative'],
  delivered: ['delivered'],
  reopened: IN_PRODUCTION,
  revision_requested: ['under_revision'],
  deliverable_assigned: IN_PRODUCTION,
  deliverable_ready: IN_PRODUCTION
};
function briefIsInEventState(brief, briefEvent) {
  if (briefEvent === 'date_changed') return true;
  // A coordinator's quick request has no approval step: it stays 'submitted',
  // and their screen announces it as ga_approved.
  if (briefEvent === 'ga_approved' && brief.request_type === 'notify_only' && brief.status === 'submitted') return true;
  return (EVENT_STATES[briefEvent] || []).includes(brief.status);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' });

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (authHeader.match(/^Bearer\s+(.+)$/i) || [])[1];
  if (!token) return jsonResponse(401, { error: 'Missing bearer token.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { error: 'Invalid JSON payload.' }); }

  const { event: briefEvent, briefId, assigneeEmployeeId } = payload;
  if (!EVENTS.includes(briefEvent)) return jsonResponse(400, { error: 'Invalid event.' });
  if (typeof briefId !== 'string' || !UUID_RE.test(briefId)) return jsonResponse(400, { error: 'briefId must be a UUID.' });

  const { appBaseUrl, circleBaseUrl } = getConfig();
  const supabase = getSupabaseAdmin();

  const userResponse = await supabase.auth.getUser(token);
  if (userResponse.error || !userResponse.data?.user) return jsonResponse(401, { error: 'Invalid auth token.' });
  const actorEmail = String(userResponse.data.user.email || '').toLowerCase();

  // Audit 16 Sep 2026: any signed-in token could fire any event for any brief
  // — including another org's — and got the recipients' addresses back. Now
  // the caller's own RLS must see the brief, and a partner may only fire the
  // events their own screens fire.
  if (!await callerCanSee(token, 'briefs', briefId)) return jsonResponse(404, { error: 'Brief not found.' });
  const callerPartner = await supabase.from('partners').select('id')
    .eq('auth_user_id', userResponse.data.user.id).eq('is_active', true).maybeSingle();
  if (callerPartner.data && !PARTNER_EVENTS.includes(briefEvent)) {
    return jsonResponse(403, { error: 'Not allowed to send this.' });
  }
  // Audit 11 Nov 2026: staff fire these only after moving the brief, so they
  // must be able to move it. Read-only brief viewers passed the check above
  // and could email the client "Delivered" for a brief nobody had delivered.
  if (!callerPartner.data && !await callerCanWorkBrief(token, briefId)) {
    return jsonResponse(403, { error: 'Not allowed to send this.' });
  }

  const briefRes = await supabase.from('briefs')
    .select('id, title, org, status, request_type, priority, submitted_by_partner_id, on_behalf_of_name, on_behalf_of_email, approver_name, deadline, revised_deadline, revised_deadline_at')
    .eq('id', briefId).single();
  if (briefRes.error || !briefRes.data) return jsonResponse(404, { error: 'Brief not found.' });
  const brief = briefRes.data;

  if (!briefIsInEventState(brief, briefEvent)) return jsonResponse(200, { ok: true, skipped: true, reason: 'Brief is not in that state.' });

  // Once per brief, event and time it entered that state (audit S24), so
  // delivered, revised, delivered again mails twice but a re-POST doesn't.
  // A new date counts from when that date was set.
  let since = brief.revised_deadline_at;
  if (briefEvent !== 'date_changed') {
    const { data: entry } = await supabase.from('brief_status_history').select('entered_at')
      .eq('brief_id', briefId).order('entered_at', { ascending: false }).limit(1);
    since = entry?.[0]?.entered_at || null;
  }
  const assigneeMatch = briefEvent === 'deliverable_assigned' ? { assignee_employee_id: assigneeEmployeeId } : {};
  if (await alreadyNotified(supabase, 'brief_notify', { brief_id: briefId, event: briefEvent, ...assigneeMatch }, since)) {
    return jsonResponse(200, { ok: true, skipped: true, reason: 'Already sent.' });
  }

  const partnersRes = await supabase.from('partners')
    .select('id, email, full_name, partner_role, is_active, email_opt_out')
    .eq('org', brief.org).eq('is_active', true);
  const partners = partnersRes.data || [];
  const submitter = partners.find(p => p.id === brief.submitted_by_partner_id) || null;
  const coordinators = partners.filter(p => p.partner_role === 'coordinator');
  const clientViewers = partners.filter(p => p.partner_role === 'client_viewer');

  let reviewers = FALLBACK_REVIEWERS;
  const cfgRes = await supabase.from('app_config').select('value').eq('key', 'brief_reviewer_emails').maybeSingle();
  if (!cfgRes.error && Array.isArray(cfgRes.data?.value)) reviewers = cfgRes.data.value;

  // recipient -> which surface their link points at
  const recipients = new Map(); // email -> {name, side}
  // email_opt_out: a client-side login that gets no Circle emails (Alex's and
  // Rhea's Gmail, which approve on the client's behalf; 30 Sep 2026).
  const addPartner = (p) => { if (p?.email && !p.email_opt_out) recipients.set(p.email.toLowerCase(), { name: p.full_name, side: 'partner' }); };
  const addInternal = (email) => { if (email) recipients.set(String(email).toLowerCase(), { name: null, side: 'internal' }); };

  const title = brief.title;
  let subject;
  let line;

  switch (briefEvent) {
    case 'submitted': {
      const isQuick = brief.request_type === 'notify_only';
      subject = isQuick ? `📣 Quick request from the client: ${title}` : `📨 New brief awaiting your approval: ${title}`;
      if (isQuick) {
        // Quick notes skip the the client gate and go straight to the team.
        line = 'A quick notification was submitted and needs acknowledging.';
        reviewers.forEach(addInternal);
      } else {
        // v2 the client gate: a new brief sits with the coordinator until approved —
        // Your Agency is deliberately NOT notified yet.
        line = 'A new brief was submitted by your team. Review it and approve to send it to Your Agency.';
        coordinators.forEach(addPartner);
      }
      break;
    }
    case 'ga_approved':
      subject = `📝 client-approved brief: ${title}`;
      line = 'Grace\'s team has approved this brief — it\'s now with Your Agency for review.';
      reviewers.forEach(addInternal);
      break;
    case 'revision_requested':
      subject = `🔁 Revision requested: ${title}`;
      line = 'the client has asked for changes on the delivered work — check their comment on the brief.';
      reviewers.forEach(addInternal);
      break;
    case 'changes_requested':
      subject = `✏️ More info needed: ${title}`;
      line = 'The Your Agency team needs more information on this brief. Open it to edit and resubmit.';
      addPartner(submitter);
      coordinators.forEach(addPartner);
      break;
    case 'locked':
      subject = `🔒 Brief locked: ${title}`;
      line = 'This brief is confirmed and locked — production is being set up.';
      coordinators.forEach(addPartner);
      reviewers.forEach(addInternal);
      break;
    case 'delivered':
      subject = `✅ Delivered: ${title}`;
      line = 'The deliverables for this brief are ready — sign in to view and download them.';
      addPartner(submitter);
      coordinators.forEach(addPartner);
      clientViewers.forEach(addPartner);
      break;
    case 'reopened':
      subject = `🔁 Reopened after feedback: ${title}`;
      line = 'This brief went back into production based on the client feedback.';
      reviewers.forEach(addInternal);
      break;
    case 'deliverable_assigned': {
      subject = `🎨 Assigned to you: ${title}`;
      line = 'A deliverable on this brief was assigned to you.';
      // Only someone actually assigned a deliverable on THIS brief — otherwise
      // the payload could mail any employee this brief's title.
      const assigned = typeof assigneeEmployeeId === 'string' && UUID_RE.test(assigneeEmployeeId)
        ? await supabase.from('brief_deliverables').select('id').eq('brief_id', briefId)
          .eq('assignee_employee_id', assigneeEmployeeId).limit(1)
        : null;
      if (assigned?.data?.length) {
        const empRes = await supabase.from('employees').select('email').eq('id', assigneeEmployeeId).single();
        if (!empRes.error) addInternal(empRes.data?.email);
      }
      break;
    }
    case 'date_changed': {
      // A new date for the client (21 Oct 2026). Only the people who can set
      // one may announce it, only just after it was set, and the dates come
      // from the brief, never the payload.
      const admin = 'admin@youragency.com';
      const allowed = actorEmail === admin || reviewers.map((e) => String(e).toLowerCase()).includes(actorEmail);
      const setAt = Date.parse(brief.revised_deadline_at || '');
      if (!allowed || !brief.revised_deadline || !(Date.now() - setAt < 10 * 60 * 1000)) {
        return jsonResponse(403, { error: 'Not allowed to send this.' });
      }
      subject = `📅 New date: ${title}`;
      line = brief.deadline && brief.deadline !== brief.revised_deadline
        ? `The date for this brief has moved to ${shortDate(brief.revised_deadline)} (was ${shortDate(brief.deadline)}).`
        : `The date for this brief is now ${shortDate(brief.revised_deadline)}.`;
      approverRecipients(brief.approver_name, partners).forEach(addPartner);
      break;
    }
    case 'deliverable_ready':
      subject = `👀 Ready for internal review: ${title}`;
      line = 'A deliverable was marked ready to share and needs an internal check.';
      reviewers.forEach(addInternal);
      break;
  }

  recipients.delete(actorEmail); // never notify the actor

  // Clients are on Circle, the team is on Colony (7 Sep 2026). The recipient's
  // side already decides the link, so it decides the name with it — sending a
  // client to "Colony" would name a product they cannot reach.
  // When a brief was logged for someone else, say so in the mail as well as in
  // the app — this is the line that tells an AM who to go back to, and the
  // named person often has no account to read it in.
  const onBehalf = String(brief.on_behalf_of_name || '').trim();
  const onBehalfContact = String(brief.on_behalf_of_email || '').trim();
  const onBehalfLine = onBehalf
    ? `Raised for ${onBehalf}${onBehalfContact ? ` (${onBehalfContact})` : ''}.`
    : '';
  const results = [];
  for (const [email, meta] of recipients) {
    const isPartner = meta.side === 'partner';
    const productLabel = isPartner ? 'Circle' : 'Colony';
    // Both sides land on the brief itself, not the list.
    const link = isPartner ? `${circleBaseUrl}?open=brief:${briefId}#partner-home` : `${appBaseUrl}?open=brief:${briefId}#briefs-pipeline`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <p>Hello${meta.name ? ' ' + escapeHtml(meta.name.split(' ')[0]) : ''},</p>
        <p>${escapeHtml(line)}</p>
        <blockquote style="border-left:3px solid #b8a04a;margin:8px 0;padding:4px 12px;color:#555">${escapeHtml(title)}</blockquote>
        ${onBehalfLine ? `<p>${escapeHtml(onBehalfLine)}</p>` : ''}
        <p><a href="${link}">Open in ${productLabel}</a></p>
      </div>`;
    const text = `${line}\n"${title}"\n${onBehalfLine ? onBehalfLine + '\n' : ''}Open: ${link}`;
    try {
      const emailResult = await sendEmail({
        to: email, subject, html, text,
        // Partners must see Circle in the sender too, not just in the link.
        audience: isPartner ? 'partner' : 'team'
      });
      await logNotification({
        kind: 'brief_notify',
        recipientEmail: email,
        subject,
        payload: { brief_id: briefId, event: briefEvent, actor_email: actorEmail, ...assigneeMatch },
        status: emailResult.skipped ? 'skipped' : 'sent'
      });
      results.push({ email, ok: true });
    } catch (error) {
      results.push({ email, ok: false, error: error.message });
    }
  }

  // Counts only — a partner caller must not receive internal or other
  // people's addresses.
  const failed = results.filter((r) => !r.ok).length;
  return jsonResponse(200, { ok: true, sent: results.length - failed, failed });
};
