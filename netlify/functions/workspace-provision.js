// Create a hire's @youragency.com Google account from Colony (11 Sep 2026).
//
// Replaces the reseller round-trip: approver clicks once, Colony creates the
// user via the Directory API, sets a one-time password that Google forces them
// to change at first sign-in, sets their Gmail as recovery, and emails the hire
// their sign-in instructions — once, directly, from here.
//
// What this function never does: write the password to the database, to
// notification_log, or to a log line. It exists in memory for one request.
//
// Needs, in Netlify env:
//   GOOGLE_SA_JSON            the service account's JSON key (whole file)
//   GOOGLE_ADMIN_IMPERSONATE  a Workspace super-admin to act as (admin@youragency.com)
// and, in the Google Admin console, domain-wide delegation for that service
// account's client ID with scope
//   https://www.googleapis.com/auth/admin.directory.user
// Without those, runtime-config reports workspaceProvisioning:false and the
// app keeps offering the old reseller email instead of a button that errors.
//
// Only a setup approver may call this — the same people who may activate an
// employee, because creating an account is the step that grants one.

const { createClient } = require('@supabase/supabase-js');
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification } = require('./lib/notifications');
const { getConfig } = require('./lib/config');
const { generateTempPassword, buildDirectoryUser, provisionEmail } = require('./lib/workspace-provision');
const { googleAccessToken } = require('./lib/google-auth');

const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function bearer(headers = {}) {
  const raw = headers.authorization || headers.Authorization;
  const m = raw && raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const token = bearer(event.headers);
  if (!token) return json(401, { error: 'Missing bearer token.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
  const { hireId, workEmail } = payload;
  if (typeof hireId !== 'string' || !UUID_RE.test(hireId)) return json(400, { error: 'hireId must be a UUID.' });
  if (typeof workEmail !== 'string' || !/^[a-z0-9._-]+@youragency\.com$/i.test(workEmail)) {
    return json(400, { error: 'workEmail must be a @youragency.com address.' });
  }

  const { supabaseUrl, appBaseUrl } = getConfig();
  const admin = getSupabaseAdmin();

  // Who is asking, and are they allowed to. The approver check runs AS the
  // caller so app.is_setup_approver() sees their auth.uid().
  const who = await admin.auth.getUser(token);
  if (who.error || !who.data?.user) return json(401, { error: 'Invalid auth token.' });
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const asCaller = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'app' },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const approver = await asCaller.rpc('is_setup_approver');
  if (approver.error || approver.data !== true) return json(403, { error: 'Only a setup approver can create accounts.' });

  const { data: hire, error: hireErr } = await admin.from('hires')
    .select('id, full_name, personal_email, phone, start_date, stage, work_email, workspace_requested_at')
    .eq('id', hireId).maybeSingle();
  if (hireErr || !hire) return json(404, { error: 'Hire not found.' });
  if (hire.stage !== 'payroll_done') return json(409, { error: 'Accounts are created once payroll is done — the hire is not there yet.' });
  if (hire.work_email) return json(409, { error: `An account was already created for this hire: ${hire.work_email}.` });

  // The password lives in this scope and nowhere else.
  const password = generateTempPassword();
  let user;
  try { user = buildDirectoryUser(hire, workEmail, password); } catch (e) { return json(400, { error: e.message }); }

  let access;
  try { access = await googleAccessToken(DIRECTORY_SCOPE); } catch (e) { return json(503, { error: e.message }); }

  const created = await fetch('https://admin.googleapis.com/admin/directory/v1/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(user)
  });
  if (!created.ok) {
    const err = await created.json().catch(() => ({}));
    const message = err?.error?.message || `HTTP ${created.status}`;
    // 409 means Google already has this address. Do not guess whose it is.
    return json(created.status === 409 ? 409 : 502, { error: `Google refused: ${message}` });
  }

  // Record the address and the moment — never the password.
  const stamp = new Date().toISOString();
  await admin.from('hires')
    .update({ work_email: user.primaryEmail, workspace_requested_at: hire.workspace_requested_at || stamp, updated_at: stamp })
    .eq('id', hireId);

  const startDate = hire.start_date
    ? new Date(`${hire.start_date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    : null;
  const mail = provisionEmail({ hire, workEmail: user.primaryEmail, password, startDate, colonyUrl: appBaseUrl });

  let emailed = false;
  try {
    await sendEmail({ to: hire.personal_email, cc: ['am-lead@youragency.com'], subject: mail.subject, html: mail.html, text: mail.text, audience: 'team' });
    emailed = true;
  } catch (e) {
    // The account exists but the hire does not know how to get in. Say so
    // loudly to the approver; the fix is a manual password reset in Admin.
    await logNotification({ kind: 'hire_notify', recipientEmail: hire.personal_email, subject: mail.subject,
      payload: { hire_id: hireId, work_email: user.primaryEmail, status: 'email_failed', error: e.message } });
    return json(207, { created: true, emailed: false, workEmail: user.primaryEmail,
      warning: `Account created, but the email to ${hire.personal_email} failed: ${e.message}. Reset their password in Google Admin and send it by hand.` });
  }
  await logNotification({ kind: 'hire_notify', recipientEmail: hire.personal_email, subject: mail.subject,
    payload: { hire_id: hireId, work_email: user.primaryEmail, status: 'sent' } });

  return json(200, { created: true, emailed, workEmail: user.primaryEmail });
};
