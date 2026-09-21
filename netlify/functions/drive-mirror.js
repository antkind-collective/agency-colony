// POST /api/drive-mirror {kind:'policy', policyKey} — copy a policy page to
// Drive as a Google Doc (14 Sep 2026). Called by the policy editor
// after every save, and by the "Copy to Drive" button. Leadership/admin only,
// the same people who can edit the page.

const { createClient } = require('@supabase/supabase-js');
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { getConfig } = require('./lib/config');
const { syncPolicy, inspectFile } = require('./lib/drive-sync');

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
  const inspect = payload.kind === 'inspect' && typeof payload.key === 'string' && /^[a-z0-9_:-]+$/.test(payload.key);
  if (!inspect && (payload.kind !== 'policy' || typeof payload.policyKey !== 'string' || !/^[a-z0-9_]+$/.test(payload.policyKey))) {
    return json(400, { error: 'Expected {kind:"policy", policyKey} or {kind:"inspect", key}.' });
  }

  const { supabaseUrl } = getConfig();
  const admin = getSupabaseAdmin();
  const who = await admin.auth.getUser(token);
  if (who.error || !who.data?.user) return json(401, { error: 'Invalid auth token.' });
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const asCaller = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const allowed = await asCaller.rpc('is_leadership_or_admin');
  if (allowed.error || allowed.data !== true) return json(403, { error: 'Only leadership can copy policies to Drive.' });

  if (inspect) {
    try { return json(200, await inspectFile(admin, payload.key)); } catch (e) { return json(502, { error: e.message }); }
  }
  const { data: policy, error } = await admin.from('policy_documents').select('*').eq('policy_key', payload.policyKey).maybeSingle();
  if (error || !policy) return json(404, { error: 'Policy not found.' });
  try {
    const row = await syncPolicy(admin, policy);
    return json(200, { ok: true, link: row.web_view_link, name: row.name });
  } catch (e) {
    return json(502, { error: e.message });
  }
};
