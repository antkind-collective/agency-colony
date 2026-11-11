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
// and, to add the new account to all@youragency.com (21 Sep 2026),
//   https://www.googleapis.com/auth/admin.directory.group.member
// A missing group scope never blocks account creation: the approver is told,
// and workspace-group-sync retries daily.
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
const { generateTempPassword, buildDirectoryUser, provisionEmail, firstFreeWorkEmail, isInternalCaller } = require('./lib/workspace-provision');
const { googleAccessToken } = require('./lib/google-auth');
const { hireEmailCc } = require('./lib/hire-cc');
const { VENDOR, REPLY_TO, isLicenceError, licenceRequestEmail } = require('./lib/workspace-licence');
const { GROUP_MEMBER_SCOPE, allGroupAddress, addGroupMember, groupFailureNote } = require('./lib/workspace-groups');

const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
// Email the reseller for one licence. Only reached after a person said yes,
// and only once per hire. Returns whether an email went out.
async function askForLicence(admin, hire) {
  const { data: cfg } = await admin.from('app_config').select('value').eq('key', 'workspace_vendor').maybeSingle();
  const vendor = { ...VENDOR, ...(cfg?.value && typeof cfg.value === 'object' ? cfg.value : {}) };
  const mail = licenceRequestEmail(hire, vendor);
  try {
    await sendEmail({ to: vendor.to, cc: vendor.cc, subject: mail.subject, html: mail.html, text: mail.text, replyTo: REPLY_TO, audience: 'team' });
  } catch (e) {
    await logNotification({ kind: 'hire_notify', recipientEmail: vendor.to, subject: mail.subject, status: 'failed', payload: { hire_id: hire.id, error: e.message } }).catch(() => {});
    return false;
  }
  await admin.from('hires').update({ workspace_licence_requested_at: new Date().toISOString() }).eq('id', hire.id);
  await logNotification({ kind: 'hire_notify', recipientEmail: vendor.to, subject: mail.subject, payload: { hire_id: hire.id, event: 'licence_request' } }).catch(() => {});
  return true;
}

function bearer(headers = {}) {
  const raw = headers.authorization || headers.Authorization;
  const m = raw && raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Same ordering as js/hires.js workEmailCandidates, kept in step by the test
// in tests/hires.test.mjs. Duplicated rather than imported because js/hires.js
// is a browser file with no module wrapper.
function workEmailCandidates(fullName) {
  const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean).map(slug).filter(Boolean);
  if (!parts.length) return [];
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const out = [first];
  if (last) { out.push(`${first}.${last}`); out.push(`${first}${last[0]}`); }
  for (let n = 2; n <= 4; n += 1) out.push(`${first}${n}`);
  return [...new Set(out)].map((local) => `${local}@youragency.com`);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const token = bearer(event.headers);
  if (!token) return json(401, { error: 'Missing bearer token.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
  const { hireId, workEmail } = payload;
  // Example Reseller is only emailed once a person has said yes in Colony (Alex,
  // 4 Nov 2026), never by the signing webhook or the six-hourly retry.
  const requestLicence = payload.requestLicence === true;
  if (typeof hireId !== 'string' || !UUID_RE.test(hireId)) return json(400, { error: 'hireId must be a UUID.' });

  // Two callers. A setup approver pressing the button, with an address they
  // chose. Or the Papersign webhook the moment an agreement is signed
  // (auto_provision_on_signed), which proves itself with INTERNAL_FUNCTION_KEY and
  // always lets Colony pick a free address. Until 7 Oct 2026 the webhook's call
  // could never succeed: its key is not a user token, `autoAddress` was never
  // read from the payload, and a hire on payroll is only 'signed' at that point.
  const internal = isInternalCaller(token);
  const autoAddress = internal || payload.autoAddress === true;
  if (!autoAddress && (typeof workEmail !== 'string' || !/^[a-z0-9._-]+@youragency\.com$/i.test(workEmail))) {
    return json(400, { error: 'workEmail must be a @youragency.com address.' });
  }

  const { supabaseUrl, appBaseUrl } = getConfig();
  const admin = getSupabaseAdmin();

  // Who is asking, and are they allowed to. The approver check runs AS the
  // caller so app.is_setup_approver() sees their auth.uid().
  if (!internal) {
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
  }

  const { data: hire, error: hireErr } = await admin.from('hires')
    .select('id, full_name, personal_email, phone, start_date, stage, work_email, workspace_not_needed, workspace_requested_at, workspace_licence_requested_at')
    .eq('id', hireId).maybeSingle();
  if (hireErr || !hire) return json(404, { error: 'Hire not found.' });
  // By hand: once payroll is done. On signing: the agreement is the moment,
  // so 'signed' counts too (an employee waits there for Finance).
  const ready = internal ? ['signed', 'payroll_done'] : ['payroll_done'];
  if (!ready.includes(hire.stage)) return json(409, { error: 'Accounts are created once payroll is done — the hire is not there yet.' });
  if (hire.work_email) return json(409, { error: `An account was already created for this hire: ${hire.work_email}.` });
  // No account unless one was asked for (4 Nov 2026: Payal got a seat
  // nobody wanted). Every caller stops here, the webhook and the retry too.
  if (hire.workspace_not_needed) return json(409, { error: 'This hire is marked as not needing a @youragency.com account. Choose "Needed after all" first.' });

  // The password lives in this scope and nowhere else.
  const password = generateTempPassword();

  let access;
  try { access = await googleAccessToken(DIRECTORY_SCOPE); } catch (e) { return json(503, { error: e.message }); }

  // Read-only: find an address nobody has. Only reached when the caller asked
  // for one to be chosen; naming an address skips this entirely.
  let chosen = workEmail;
  if (autoAddress) {
    const candidates = workEmailCandidates(hire.full_name);
    if (!candidates.length) return json(400, { error: 'Cannot build an address from that name.' });
    let free;
    try { free = await firstFreeWorkEmail(access, candidates); } catch (e) { return json(503, { error: e.message }); }
    if (!free.email) return json(409, { error: `Every address for ${hire.full_name} is taken — choose one by hand.`, tried: candidates });
    chosen = free.email;
  }

  let user;
  try { user = buildDirectoryUser(hire, chosen, password); } catch (e) { return json(400, { error: e.message }); }

  const created = await fetch('https://admin.googleapis.com/admin/directory/v1/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(user)
  });
  if (!created.ok) {
    const err = await created.json().catch(() => ({}));
    const message = err?.error?.message || `HTTP ${created.status}`;
    // Out of licences. A seat costs money and can't be removed, so Colony
    // asks in Colony first and emails Example Reseller only on a person's yes (Alex,
    // 4 Nov 2026; from 7 Oct it emailed them by itself). Once asked,
    // workspace-retry creates the account when the seat exists.
    if (isLicenceError(message)) {
      if (hire.workspace_licence_requested_at) {
        return json(409, { licence: true, asked: false,
          error: `No free Google licence yet. Example Reseller was asked on ${new Date(hire.workspace_licence_requested_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}; Colony retries every six hours and creates the account once it's added.` });
      }
      if (internal || !requestLicence) {
        return json(409, { licence: true, needsApproval: true, asked: false,
          error: 'The Google Workspace licence limit is over. Nothing has been sent to Example Reseller.' });
      }
      const asked = await askForLicence(admin, hire);
      return json(asked ? 409 : 502, { licence: asked, asked,
        error: asked
          ? `Asked Example Reseller for one more licence. Colony creates the account by itself once it's added.`
          : 'Could not email Example Reseller. Nothing was sent; try again.' });
    }
    // 409 means Google already has this address. Do not guess whose it is.
    return json(created.status === 409 ? 409 : 502, { error: `Google refused: ${message}` });
  }

  // Record the address and the moment — never the password.
  const stamp = new Date().toISOString();
  await admin.from('hires')
    .update({ work_email: user.primaryEmail, workspace_requested_at: hire.workspace_requested_at || stamp, updated_at: stamp })
    .eq('id', hireId);

  // Everyone with a @youragency.com account is on all@youragency.com. Best effort:
  // the account already exists, so a failure here is reported, not fatal.
  let groupNote = null;
  try {
    const groupAccess = await googleAccessToken(GROUP_MEMBER_SCOPE);
    const added = await addGroupMember(groupAccess, allGroupAddress(), user.primaryEmail);
    if (added.ok) {
      await admin.from('hires').update({ all_group_added_at: new Date().toISOString() }).eq('id', hireId);
    } else {
      groupNote = groupFailureNote(user.primaryEmail, added.error);
    }
  } catch (e) {
    groupNote = groupFailureNote(user.primaryEmail, e.message);
  }

  const startDate = hire.start_date
    ? new Date(`${hire.start_date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    : null;
  const mail = provisionEmail({ hire, workEmail: user.primaryEmail, password, startDate, colonyUrl: appBaseUrl });

  let emailed = false;
  try {
    // The hiring manager is copied like on every other email to the hire,
    // password and all: Google forces a new one at first sign-in (Alex,
    // 2 Nov 2026; until then the manager was left off). Alex stays on it
    // under her see-every-hire-email rule (lib/hire-cc.js).
    const { data: offer } = await admin.from('hire_offer_terms').select('hiring_manager_email').eq('hire_id', hire.id).maybeSingle();
    const manager = String(offer?.hiring_manager_email || '').trim().toLowerCase();
    const cc = [...new Set([...(await hireEmailCc(admin)), ...(manager ? [manager] : [])])];
    await sendEmail({ to: hire.personal_email, cc, subject: mail.subject, html: mail.html, text: mail.text, audience: 'team' });
    emailed = true;
  } catch (e) {
    // The account exists but the hire does not know how to get in. Say so
    // loudly to the approver; the fix is a manual password reset in Admin.
    await logNotification({ kind: 'hire_notify', recipientEmail: hire.personal_email, subject: mail.subject,
      payload: { hire_id: hireId, work_email: user.primaryEmail, status: 'email_failed', error: e.message } });
    return json(207, { created: true, emailed: false, workEmail: user.primaryEmail,
      warning: `Account created, but the email to ${hire.personal_email} failed: ${e.message}. Reset their password in Google Admin and send it by hand.${groupNote ? ` ${groupNote}` : ''}` });
  }
  await logNotification({ kind: 'hire_notify', recipientEmail: hire.personal_email, subject: mail.subject,
    payload: { hire_id: hireId, work_email: user.primaryEmail, status: 'sent' } });

  return json(200, { created: true, emailed, workEmail: user.primaryEmail, groupNote });
};
