// Create the filled agreement draft for a hire (11 Sep 2026).
//
// Copies the template for the hire's type into a new Papersign draft with the
// signers and every variable filled from the hire and its offer terms. Nothing
// is sent: the draft sits in Papersign for Leo to review. Approval later
// calls papersign-send.
const { createClient } = require('@supabase/supabase-js');
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { getConfig } = require('./lib/config');
const { call } = require('./lib/papersign-client');
const { buildVariables, signersFor, draftName, mapVariablesToTemplate } = require('./lib/papersign');

const UUID_RE = /^[0-9a-f-]{36}$/i;
// The agency's signer on every agreement — always Alex here (11 Sep 2026).
// Read from the environment so a deployment can name its own signer without
// editing code; the fallback keeps this deployment exactly as it was.
// Where drafts are filed in Papersign — by folder ID, never by path (Alex,
// 7 Oct 2026). The agreements folder is ONE folder whose name is literally
// "Consultants/Employees"; Papersign reads a slash in `path` as nesting, so
// path 'Consultants/Employees' quietly created a NEW "Consultants" > "Employees"
// pair and filed Sivabalan's and Modeera's drafts there. An ID survives renames
// and slashes. Override with app_config.papersign_draft_folder_id.
const PAPERSIGN_DRAFT_FOLDER_ID = 10000532337;

const AGENCY_SIGNER = {
  name: process.env.PAPERSIGN_SIGNER_NAME || 'Alex Morgan',
  email: process.env.PAPERSIGN_SIGNER_EMAIL || 'admin@youragency.com'
};
const json = (s, b) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const bearer = (h = {}) => { const m = (h.authorization || h.Authorization || '').match(/^Bearer\s+(.+)$/i); return m ? m[1].trim() : null; };

async function crewClient(token) {
  const { supabaseUrl } = getConfig();
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const c = createClient(supabaseUrl, anon, { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const r = await c.rpc('is_hiring_crew');
  return r.data === true;
}

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
  if (!await crewClient(token)) return json(403, { error: 'Only the hiring crew can draft agreements.' });

  const [{ data: hire }, { data: terms }, { data: cfg }, { data: folderCfg }] = await Promise.all([
    admin.from('hires').select('*').eq('id', hireId).maybeSingle(),
    admin.from('hire_offer_terms').select('*').eq('hire_id', hireId).maybeSingle(),
    admin.from('app_config').select('value').eq('key', 'papersign_templates').maybeSingle(),
    admin.from('app_config').select('value').eq('key', 'papersign_draft_folder_id').maybeSingle()
  ]);
  const draftFolderId = Number(folderCfg?.value) || PAPERSIGN_DRAFT_FOLDER_ID;
  if (!hire) return json(404, { error: 'Hire not found.' });
  if (terms?.papersign_draft_id) return json(409, { error: 'A draft already exists for this hire.', draftId: terms.papersign_draft_id });
  const template = (cfg?.value || {})[hire.hire_type || 'full-time'];
  if (!template?.document_id) return json(503, { error: `No Papersign template is configured for ${hire.hire_type} hires yet.` });

  let variables, signers;
  try {
    variables = buildVariables(hire, terms || {});
    signers = signersFor(hire, template, AGENCY_SIGNER);
  } catch (e) { return json(422, { error: e.message }); }

  // Translate names to the template's own variable keys (see papersign.js).
  try {
    const tpl = await call('GET', `/papersign/documents/${encodeURIComponent(template.document_id)}`);
    const doc = tpl.document || tpl.sign_document || tpl;
    variables = mapVariablesToTemplate(variables, doc.variables);
  } catch (e) { return json(502, { error: e.message }); }

  let draft;
  try {
    // copy: the template stays a template; the draft gets its own name and
    // lands in the folder Alex already files agreements in (by ID, above).
    const r = await call('POST', `/papersign/documents/${encodeURIComponent(template.document_id)}/create-draft`, {
      copy: { name: draftName(hire), folder_id: draftFolderId },
      signers,
      variables
    });
    draft = r.document || r;
  } catch (e) { return json(502, { error: e.message }); }
  if (!draft?.id) return json(502, { error: 'Papersign returned no document id.' });

  await admin.from('hire_offer_terms').upsert({ hire_id: hireId, papersign_draft_id: String(draft.id), updated_at: new Date().toISOString() }, { onConflict: 'hire_id' });
  // The pipeline's "contract exists" stage — the draft is the contract now.
  if (hire.stage === 'details_submitted') await admin.from('hires').update({ stage: 'contract_uploaded', updated_at: new Date().toISOString() }).eq('id', hireId);
  return json(200, { draftId: String(draft.id), name: draft.name || draftName(hire) });
};
