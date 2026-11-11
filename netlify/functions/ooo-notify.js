// Out of office FYI (4 Nov 2026). Someone the leave form is closed to
// (fractional, or leave not tracked) marks themselves out on the Leave page;
// this tells their manager. Nothing to approve, so the email says so. Only
// the person who marked it can trigger it.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification } = require('./lib/notifications');
const { formatDateInIST, getConfig } = require('./lib/config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const escapeHtml = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const first = (n, fallback) => String(n || '').trim().split(/\s+/)[0] || fallback;

function oooWhen(row) {
  const start = formatDateInIST(row.start_date);
  const end = formatDateInIST(row.end_date);
  return (start === end ? start : `${start} to ${end}`) + (row.is_half_day ? ' (half day)' : '');
}

function oooEmail(row, appBaseUrl) {
  const name = first(row.employee?.full_name, 'Someone');
  const when = oooWhen(row);
  const subject = `FYI: ${name} is out of office ${when}`;
  const lines = [
    `${name} has marked themselves out of office for ${when}.`,
    row.note ? `Their note: ${row.note}` : null,
    'Nothing to approve, this is just so you know. It shows under Who\'s out in Colony.'
  ].filter(Boolean);
  const link = `${appBaseUrl}#leave-center`;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}<p><a href="${link}">Open Leave in Colony</a></p></div>`;
  return { subject, html, text: [...lines, link].join('\n\n') };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const raw = event.headers?.authorization || event.headers?.Authorization || '';
  const token = (raw.match(/^Bearer\s+(.+)$/i) || [])[1];
  if (!token) return json(401, { error: 'Missing bearer token.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON payload.' }); }
  const id = payload.outOfOfficeId;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return json(400, { error: 'outOfOfficeId must be a valid UUID.' });

  const supabase = getSupabaseAdmin();
  const userResponse = await supabase.auth.getUser(token);
  const requester = userResponse.data?.user;
  if (userResponse.error || !requester) return json(401, { error: 'Invalid auth token.' });

  const { data: me } = await supabase.from('employees').select('id').eq('auth_user_id', requester.id).maybeSingle();
  const { data: row } = await supabase.from('out_of_office')
    .select('id, employee_id, start_date, end_date, is_half_day, note, employee:employees!out_of_office_employee_id_fkey(full_name, email, direct_manager_email)')
    .eq('id', id).maybeSingle();
  if (!row) return json(404, { error: 'Not found.' });
  if (!me || me.id !== row.employee_id) return json(403, { error: 'Not allowed to trigger this notification.' });

  const to = String(row.employee?.direct_manager_email || '').trim().toLowerCase();
  if (!to || to === String(row.employee?.email || '').toLowerCase()) return json(200, { ok: true, skipped: true });

  // Once per entry (audit S22b): a re-POST of the same id must not email again.
  const { data: already } = await supabase.from('notification_log').select('id')
    .eq('kind', 'out_of_office').eq('payload->>out_of_office_id', row.id).limit(1);
  if (already?.length) return json(200, { ok: true, skipped: true });

  const { subject, html, text } = oooEmail(row, getConfig().appBaseUrl);
  let result;
  try {
    result = await sendEmail({ to: [to], subject, html, text, replyTo: row.employee?.email || null, private: true });
  } catch (error) {
    return json(500, { error: `Email send failed: ${error.message}` });
  }
  try {
    await logNotification({ kind: 'out_of_office', recipientEmail: to, subject,
      payload: { out_of_office_id: row.id, employee_id: row.employee_id, start_date: row.start_date, end_date: row.end_date },
      status: result?.skipped ? 'skipped' : 'sent' });
  } catch (error) {
    console.error('Notification logging failed:', error.message);
  }
  return json(200, { ok: true });
};

exports.oooEmail = oooEmail;
