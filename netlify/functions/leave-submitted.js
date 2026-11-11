const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification } = require('./lib/notifications');
const { formatDateInIST, getConfig } = require('./lib/config');

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
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  };
}

function extractBearerToken(headers = {}) {
  const raw = headers.authorization || headers.Authorization;
  if (!raw) return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function normalizeEmails(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function formatDateRange(startDate, endDate) {
  const start = formatDateInIST(startDate);
  const end = formatDateInIST(endDate);
  if (start === end) return start;
  return `${start} to ${end}`;
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

  const leaveRequestId = payload.leaveRequestId;
  if (!leaveRequestId) {
    return jsonResponse(400, { error: 'leaveRequestId is required.' });
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof leaveRequestId !== 'string' || !UUID_RE.test(leaveRequestId)) {
    return jsonResponse(400, { error: 'leaveRequestId must be a valid UUID.' });
  }

  const { appBaseUrl } = getConfig();
  const supabase = getSupabaseAdmin();

  const userResponse = await supabase.auth.getUser(token);
  if (userResponse.error || !userResponse.data?.user) {
    return jsonResponse(401, { error: 'Invalid auth token.' });
  }

  const requester = userResponse.data.user;

  const leaveResponse = await supabase
    .from('leave_requests')
    .select(`
      id,
      employee_id,
      leave_type,
      start_date,
      end_date,
      reason,
      is_half_day,
      status,
      approver_emails,
      created_at,
      marked_by_employee_id,
      employee:employees!leave_requests_employee_id_fkey (
        id,
        auth_user_id,
        full_name,
        email
      )
    `)
    .eq('id', leaveRequestId)
    .single();

  if (leaveResponse.error || !leaveResponse.data) {
    return jsonResponse(404, { error: 'Leave request not found.' });
  }

  const leaveRequest = leaveResponse.data;

  const requesterEmployeeResponse = await supabase
    .from('employees')
    .select('id, email, access_level')
    .eq('auth_user_id', requester.id)
    .maybeSingle();

  if (requesterEmployeeResponse.error) {
    return jsonResponse(500, { error: 'Failed to look up requester employee record.' });
  }

  const requesterAccessLevel = requesterEmployeeResponse.data?.access_level || 'employee';
  const requesterEmail = String(requester.email || '').toLowerCase();
  const requesterIsOwner = leaveRequest.employee?.auth_user_id === requester.id;
  const requesterIsApprover = normalizeEmails(leaveRequest.approver_emails).includes(requesterEmail);
  const requesterIsLeadership = requesterAccessLevel === 'leadership' || requesterAccessLevel === 'admin';

  if (!requesterIsOwner && !requesterIsApprover && !requesterIsLeadership) {
    return jsonResponse(403, { error: 'Not allowed to trigger this notification.' });
  }

  // A manager marked their report out (14 Oct 2026): the leave is already
  // approved, so the email goes to the person, from the manager who did it.
  // Only that manager can trigger it.
  if (leaveRequest.marked_by_employee_id) {
    if (requesterEmployeeResponse.data?.id !== leaveRequest.marked_by_employee_id) {
      return jsonResponse(403, { error: 'Not allowed to trigger this notification.' });
    }
    const to = String(leaveRequest.employee?.email || '').toLowerCase();
    if (!to) return jsonResponse(200, { ok: true, skipped: true, reason: 'No email for this person.' });
    const { data: marker } = await supabase.from('employees').select('full_name').eq('id', leaveRequest.marked_by_employee_id).maybeSingle();
    const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'Your manager';
    const who = first(marker?.full_name);
    const name = first(leaveRequest.employee?.full_name);
    const kind = { SL: 'out sick', CL: 'on casual leave', PL: 'on leave' }[leaveRequest.leave_type] || 'on leave';
    const when = formatDateRange(leaveRequest.start_date, leaveRequest.end_date) + (leaveRequest.is_half_day ? ' (half day)' : '');
    const markedSubject = `You're marked ${kind}: ${when}`;
    const lines = [`Hi ${name},`, `${who} marked you ${kind} for ${when}.${leaveRequest.leave_type === 'SL' ? ' Get well soon.' : ''}`, `If that's not right, let ${who} know.`];
    try {
      await sendEmail({ to: [to], subject: markedSubject,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}</div>`,
        text: lines.join('\n\n') });
      await logNotification({ kind: 'leave_submitted', recipientEmail: to, subject: markedSubject,
        payload: { leave_request_id: leaveRequest.id, employee_id: leaveRequest.employee_id, marked_by: leaveRequest.marked_by_employee_id } });
    } catch (error) {
      return jsonResponse(500, { error: `Email send failed: ${error.message}` });
    }
    return jsonResponse(200, { ok: true, marked: true });
  }

  if (leaveRequest.status !== 'pending') {
    return jsonResponse(200, {
      ok: true,
      skipped: true,
      reason: `Leave status is ${leaveRequest.status}; no pending notification sent.`
    });
  }

  const recipients = normalizeEmails(leaveRequest.approver_emails);
  if (!recipients.length) {
    return jsonResponse(422, {
      error: 'No approver emails configured for this leave request.'
    });
  }

  const employeeName = leaveRequest.employee?.full_name || 'Employee';
  const leaveDateRange = formatDateRange(leaveRequest.start_date, leaveRequest.end_date);
  const subject = `Leave approval needed: ${employeeName} (${leaveRequest.leave_type}${leaveRequest.is_half_day ? ' · half day' : ''})`;
  const reasonText = leaveRequest.reason ? `<p><strong>Reason:</strong> ${escapeHtml(leaveRequest.reason)}</p>` : '';

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <p>Hello,</p>
      <p>A new leave request needs approval in Agency Colony.</p>
      <ul>
        <li><strong>Employee:</strong> ${escapeHtml(employeeName)}</li>
        <li><strong>Type:</strong> ${escapeHtml(leaveRequest.leave_type)}</li>
        <li><strong>Dates:</strong> ${escapeHtml(leaveDateRange)}</li>
        <li><strong>Submitted:</strong> ${escapeHtml(formatDateInIST(leaveRequest.created_at))}</li>
      </ul>
      ${reasonText}
      <p>Open leave center: <a href="${appBaseUrl}?open=leave:${leaveRequest.id}#leave-center">${appBaseUrl}?open=leave:${leaveRequest.id}#leave-center</a></p>
    </div>
  `;

  const text = [
    'A new leave request needs approval in Agency Colony.',
    `Employee: ${employeeName}`,
    `Type: ${leaveRequest.leave_type}`,
    `Dates: ${leaveDateRange}`,
    leaveRequest.reason ? `Reason: ${leaveRequest.reason}` : null,
    `Open leave center: ${appBaseUrl}?open=leave:${leaveRequest.id}#leave-center`
  ]
    .filter(Boolean)
    .join('\n');

  let emailResult;
  try {
    emailResult = await sendEmail({
      to: recipients,
      subject,
      html,
      text
    });
  } catch (error) {
    return jsonResponse(500, { error: `Email send failed: ${error.message}` });
  }

  try {
    await Promise.all(
      recipients.map((recipientEmail) =>
        logNotification({
          kind: 'leave_submitted',
          recipientEmail,
          subject,
          payload: {
            leave_request_id: leaveRequest.id,
            employee_id: leaveRequest.employee_id,
            leave_type: leaveRequest.leave_type,
            start_date: leaveRequest.start_date,
            end_date: leaveRequest.end_date
          },
          status: emailResult.skipped ? 'skipped' : 'sent'
        })
      )
    );
  } catch (error) {
    console.error('Notification logging failed:', error.message);
  }

  return jsonResponse(200, {
    ok: true,
    leaveRequestId: leaveRequest.id,
    recipients,
    emailResult
  });
};
