// Authorisation AS THE CALLER (security audit, 16 Sep 2026).
//
// Every function here reads with the service-role client, which sees every
// row. "The token is valid" only proves someone is signed in — a partner, a
// candidate and the superadmin all pass it. Before this helper, hire-notify,
// brief-notify, client-status-notify and feature-request-notify acted on any
// id in the payload for any signed-in caller, and echoed the recipients'
// addresses back.
//
// The rule is RLS, asked with the caller's own JWT: if their token cannot
// SELECT the row, the function behaves as if the row does not exist. That
// keeps one source of truth for who may see what — the policies — instead of
// a second copy in JavaScript that drifts.
const { createClient } = require('@supabase/supabase-js');
const { getConfig } = require('./config');

function bearerToken(headers = {}) {
  const raw = headers.authorization || headers.Authorization || '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function callerClient(token) {
  const { supabaseUrl } = getConfig();
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'app' },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
}

// True only when the caller's RLS lets them read this row. Errors fail closed.
async function callerCanSee(token, table, id) {
  const { data, error } = await callerClient(token).from(table).select('id').eq('id', id).maybeSingle();
  return !error && Boolean(data);
}

// True only when an app.* boolean function says yes for the caller.
async function callerIs(token, fn) {
  const { data, error } = await callerClient(token).rpc(fn);
  return !error && data === true;
}

// True only when the caller may MOVE this brief (the briefs_update_employee
// rule), which is more than reading it: brief viewers read every brief and
// can work none. Errors fail closed.
async function callerCanWorkBrief(token, briefId) {
  const { data, error } = await callerClient(token).rpc('can_work_brief', { p_brief_id: briefId });
  return !error && data === true;
}

// The caller's own display name, from their row — never from the payload.
// Mirrors displayPersonName() in app.js (first + last word).
async function callerDisplayName(admin, authUserId) {
  const [emp, partner] = await Promise.all([
    admin.from('employees').select('id, full_name').eq('auth_user_id', authUserId).maybeSingle(),
    admin.from('partners').select('id, full_name').eq('auth_user_id', authUserId).eq('is_active', true).maybeSingle()
  ]);
  const full = emp.data?.full_name || partner.data?.full_name || '';
  const words = String(full).trim().split(/\s+/).filter(Boolean);
  return {
    employeeId: emp.data?.id || null,
    partnerId: partner.data?.id || null,
    name: !words.length ? 'Someone' : words.length === 1 ? words[0] : `${words[0]} ${words[words.length - 1]}`
  };
}

module.exports = { bearerToken, callerClient, callerCanSee, callerCanWorkBrief, callerIs, callerDisplayName };
