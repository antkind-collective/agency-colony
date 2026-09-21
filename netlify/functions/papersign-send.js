// Send the reviewed draft for signature (11 Sep 2026). Called when the
// hiring lead approves; the hire and Alex each get Papersign's own email.
const { createClient } = require('@supabase/supabase-js');
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { getConfig } = require('./lib/config');
const { call } = require('./lib/papersign-client');

const UUID_RE = /^[0-9a-f-]{36}$/i;
const json = (s, b) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const bearer = (h = {}) => { const m = (h.authorization || h.Authorization || '').match(/^Bearer\s+(.+)$/i); return m ? m[1].trim() : null; };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const token = bearer(event.headers);
  if (!token) return json(401, { error: 'Missing bearer token.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
  const { hireId } = body;
  if (typeof hireId !== 'string' || !UUID_RE.test(hireId)) return json(400, { error: 'hireId must be a UUID.' });

  const admin = getSupabaseAdmin();
  const who = await admin.auth.getUser(token);
  if (who.error || !who.data?.user) return json(401, { error: 'Invalid auth token.' });
  const { supabaseUrl } = getConfig();
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const asCaller = createClient(supabaseUrl, anon, { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' }, global: { headers: { Authorization: `Bearer ${token}` } } });
  // Sending commits Your Agency to a contract: approvers only, same as activation.
  const ok = await asCaller.rpc('is_setup_approver');
  if (ok.data !== true) return json(403, { error: 'Only a setup approver can send an agreement for signature.' });

  const [{ data: hire }, { data: terms }] = await Promise.all([
    admin.from('hires').select('id, full_name, stage').eq('id', hireId).maybeSingle(),
    admin.from('hire_offer_terms').select('papersign_draft_id, papersign_sent_at').eq('hire_id', hireId).maybeSingle()
  ]);
  if (!hire) return json(404, { error: 'Hire not found.' });
  if (!terms?.papersign_draft_id) return json(409, { error: 'No draft exists for this hire yet.' });
  if (terms.papersign_sent_at) return json(409, { error: 'Already sent for signature.' });

  try {
    await call('POST', `/papersign/documents/${encodeURIComponent(terms.papersign_draft_id)}/send`, {
      invite_message: `Hi ${hire.full_name.split(' ')[0]} — here is your agreement with Your Agency for signature. Reply to Alex with any questions.`,
      automatic_reminders: { first_after_days: 2, follow_up_every_days: 3 }
    });
  } catch (e) { return json(502, { error: e.message }); }

  const now = new Date().toISOString();
  await admin.from('hire_offer_terms').update({ papersign_sent_at: now, updated_at: now }).eq('hire_id', hireId);
  await admin.from('hires').update({ stage: 'reviewed', updated_at: now }).eq('id', hireId);
  return json(200, { sent: true });
};
