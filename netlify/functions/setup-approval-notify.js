// Pings the setup approvers (Alex + Nadia) when a new joiner finishes
// onboarding and needs confirming.
//
// This is the EPHEMERAL half of the notification. The durable half is the
// "Awaiting Setup" panel in Admin Settings, which is computed from
// setup_pending and stays until the work is actually done. An email alone
// would be a to-do that gets missed on a busy day, and the cost of missing
// this one is a fractional person locked out of every client (or a
// full-time joiner whose team never gets applied).
//
// Nothing here trusts the request body: the employee is resolved from the
// caller's own token, so this can't be used to fire a notification about
// somebody else.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification } = require('./lib/notifications');
const { getConfig } = require('./lib/config');


function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function extractBearerToken(headers) {
  const auth = headers?.authorization || headers?.Authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' });

  const token = extractBearerToken(event.headers);
  if (!token) return jsonResponse(401, { error: 'Missing bearer token.' });

  const supabase = getSupabaseAdmin();
  const userResponse = await supabase.auth.getUser(token);
  if (userResponse.error || !userResponse.data?.user) {
    return jsonResponse(401, { error: 'Invalid auth token.' });
  }

  // Resolve the person from their OWN token — never from the payload.
  const authUserId = userResponse.data.user.id;
  const { data: emp, error: empError } = await supabase
    .from('employees')
    .select('id, full_name, email, employment_type, setup_pending, current_city, requested_department:departments!employees_requested_department_id_fkey(name)')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (empError) return jsonResponse(500, { error: empError.message });
  if (!emp) return jsonResponse(404, { error: 'No employee for this session.' });
  // Only notify for someone actually awaiting setup — so a replayed call after
  // activation can't re-ping the approvers.
  if (!emp.setup_pending) return jsonResponse(200, { skipped: 'not pending' });

  const { appBaseUrl } = getConfig();

  // A hire behind this account (8 Oct 2026): switching them on is a step in
  // their hire, the hiring manager's to press, so the ping goes to them (Alex
  // copied) and lands on the hire, not on Admin Settings.
  const { data: hire } = await supabase.from('hires').select('id, full_name').eq('work_email', String(emp.email || '').trim().toLowerCase()).maybeSingle();
  if (hire) {
    const { data: terms } = await supabase.from('hire_offer_terms').select('hiring_manager_email').eq('hire_id', hire.id).maybeSingle();
    const manager = String(terms?.hiring_manager_email || '').trim();
    const to = manager || 'admin@youragency.com';
    const cc = manager && manager.toLowerCase() !== 'admin@youragency.com' ? ['admin@youragency.com'] : [];
    const first = String(emp.full_name || hire.full_name || 'Your new joiner').split(' ')[0];
    const link = `${appBaseUrl}?open=hire:${hire.id}#hiring`;
    const hSubject = `${first} signed in to Colony: switch their access on`;
    const hHtml = `<div style="font-family:Arial,sans-serif;line-height:1.6;max-width:520px">
      <p><strong>${escapeHtml(emp.full_name || first)}</strong> signed in to Colony as ${escapeHtml(emp.email || '')}.</p>
      <p>Their access is off until you switch it on. Activate it now, or schedule it for their start date.</p>
      <p><a href="${link}">Open their hire →</a></p></div>`;
    const hText = `${emp.full_name || first} signed in to Colony as ${emp.email || ''}.\n\nTheir access is off until you switch it on. Activate it now, or schedule it for their start date.\n\n${link}`;
    try {
      const r = await sendEmail({ to, cc, subject: hSubject, html: hHtml, text: hText });
      await logNotification({ kind: 'new_employee_joined', recipientEmail: to, subject: hSubject,
        payload: { employee_id: emp.id, hire_id: hire.id, setup_approval: true }, status: r.skipped ? 'skipped' : 'sent' });
      return jsonResponse(200, { ok: true, notified: 1 + cc.length });
    } catch (error) {
      return jsonResponse(500, { error: error.message });
    }
  }

  // No hire behind it (an account made outside Colony): Alex sets them up.
  const recipients = ['admin@youragency.com'];
  const name = emp.full_name || 'A new joiner';
  const isProject = emp.employment_type === 'fractional';
  // full-time | fractional | consultant since 31 Aug 2026. The old two-way
  // ternary described a consultant as "full-time" — the single thing about
  // their contract that is not true.
  const typeLabel = { 'full-time': 'full-time', fractional: 'fractional', consultant: 'consultant' }[emp.employment_type] || 'full-time';
  const team = emp.requested_department?.name || 'not specified';

  const subject = `Set up ${name} — ${typeLabel}`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:520px">
      <p><strong>${escapeHtml(name)}</strong>${emp.email ? ` (${escapeHtml(emp.email)})` : ''} finished onboarding and needs setting up.</p>
      <ul>
        <li>Says they are: <strong>${escapeHtml(typeLabel)}</strong></li>
        <li>Asked for team: <strong>${escapeHtml(team)}</strong></li>
        ${emp.current_city ? `<li>Based in: ${escapeHtml(emp.current_city)}</li>` : ''}
      </ul>
      ${isProject
        ? '<p><strong>They cannot see any clients until you activate them.</strong> Set their capacity and pick the clients they work on.</p>'
        : '<p>Confirm their team and capacity — their team only applies once you activate them.</p>'}
      <p><a href="${appBaseUrl}#hiring">Open Hiring →</a></p>
    </div>`;
  const text = [
    `${name}${emp.email ? ` (${emp.email})` : ''} finished onboarding and needs setting up.`,
    `Says they are: ${typeLabel}. Asked for team: ${team}.`,
    isProject ? 'They cannot see any clients until you activate them.' : 'Their team only applies once you activate them.',
    `${appBaseUrl}#hiring`
  ].join('\n');

  try {
    const emailResult = await sendEmail({ to: recipients, subject, html, text });
    await logNotification({
      kind: 'new_employee_joined',
      recipientEmail: recipients.join(', '),
      subject,
      payload: { employee_id: emp.id, setup_approval: true, employment_type: emp.employment_type, requested_team: team },
      status: emailResult.skipped ? 'skipped' : 'sent'
    });
    return jsonResponse(200, { ok: true, notified: recipients.length });
  } catch (error) {
    return jsonResponse(500, { error: error.message });
  }
};
