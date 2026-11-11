// "Your October salary slip is in Colony" (28 Oct 2026, Alex: slips go to
// people's email automatically once uploaded and assigned). Finance calls this
// after saving a month's slips; each slip emails its own person once
// (emailed_at), with a link to their profile, never the file itself.
//   { ids: [payslip uuid, ...] }
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { bearerToken, callerIs } = require('./lib/caller');
const { sendEmail } = require('./lib/email');
const { getConfig } = require('./lib/config');

const json = (s, b) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const UUID_RE = /^[0-9a-f-]{36}$/i;
const escapeHtml = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function slipEmail(firstName, payMonth, link) {
  const [y, m] = String(payMonth).split('-').map(Number);
  const month = `${MONTHS[m - 1]} ${y}`;
  return {
    subject: `Your ${month} salary slip is in Colony`,
    text: `Hi ${firstName},\n\nYour salary slip for ${month} is in Colony. Open your profile to download it: ${link}`,
    html: `<p>Hi ${escapeHtml(firstName)},</p><p>Your salary slip for ${month} is in Colony.</p><p><a href="${link}">Open your profile to download it</a></p>`
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const token = bearerToken(event.headers);
  if (!token) return json(401, { error: 'Missing bearer token.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
  const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === 'string' && UUID_RE.test(x)).slice(0, 100);
  if (!ids.length) return json(400, { error: 'No slips.' });

  const admin = getSupabaseAdmin();
  const who = await admin.auth.getUser(token);
  if (who.error || !who.data?.user) return json(401, { error: 'Invalid auth token.' });
  // Finance, behind the second lock: the same check the slips table uses.
  if (!await callerIs(token, 'finance_unlocked')) return json(403, { error: 'Not allowed.' });

  const { data: slips } = await admin.from('payslips')
    .select('id, pay_month, emailed_at, employee:employees!payslips_employee_id_fkey(full_name, email, is_active)')
    .in('id', ids).is('emailed_at', null);
  const link = `${getConfig().appBaseUrl}/#employee-profile`;
  let sent = 0;
  const errors = [];
  for (const s of slips || []) {
    if (!s.employee?.email || s.employee.is_active === false) continue;
    try {
      const first = String(s.employee.full_name || '').trim().split(/\s+/)[0] || 'there';
      await sendEmail({ to: s.employee.email, private: true, ...slipEmail(first, s.pay_month, link) });
      await admin.from('payslips').update({ emailed_at: new Date().toISOString() }).eq('id', s.id);
      sent += 1;
    } catch (e) {
      errors.push(e.message);
    }
  }
  return json(errors.length ? 207 : 200, { sent, failed: errors.length });
};

exports.slipEmail = slipEmail;
