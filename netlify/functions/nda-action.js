// Everything the team does to an NDA (22 Oct 2026). Only people on
// app_config.nda_crew_emails (app.is_nda_crew, asked with their own token);
// app.ndas has no write policies, so this function is the only way in.
//
//   create  { with_name, purpose, client_id?, details_by: 'them' | 'us', details? }
//   link    { id }            a fresh one-time link (the old one stops working)
//   fill    { id, details }   we type their details instead
//   draft   { id }            retry a Papersign draft that failed
//   send    { id }            the person who started it (or Alex) sends it
//   cancel  { id }
//
// Sending emails Alex first (she signs first), then the other side. Until
// app_config.nda_live is true (Leo's OK on the wording), only TEST NDAs,
// whose signers are both Alex, can be sent.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { getConfig } = require('./lib/config');
const { bearerToken, callerIs, callerDisplayName } = require('./lib/caller');
const { call } = require('./lib/papersign-client');
const { cleanDetails, oneLine, newLinkToken, hashToken, LINK_DAYS, isTestNda } = require('./lib/nda');
const { createNdaDraft, ndaConfig } = require('./lib/nda-papersign');

const UUID_RE = /^[0-9a-f-]{36}$/i;
const OWNER = 'admin@youragency.com';
const json = (s, b) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

function linkFor(token) {
  const { circleBaseUrl } = getConfig();
  // The token rides in the #fragment: browsers never send it to a server or
  // in a Referer, so it stays out of every log.
  return `${circleBaseUrl}/nda.html#${token}`;
}

async function freshLink(admin, id) {
  const token = newLinkToken();
  const expires = new Date(Date.now() + LINK_DAYS * 86400000).toISOString();
  const { error } = await admin.from('ndas').update({ intake_token_hash: hashToken(token), intake_expires_at: expires, updated_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'awaiting_details');
  if (error) throw new Error(error.message);
  return { link: linkFor(token), expires };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const token = bearerToken(event.headers);
  if (!token) return json(401, { error: 'Missing bearer token.' });
  if (String(event.body || '').length > 8000) return json(413, { error: 'Too large.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

  const admin = getSupabaseAdmin();
  const who = await admin.auth.getUser(token);
  if (who.error || !who.data?.user) return json(401, { error: 'Invalid auth token.' });
  if (!await callerIs(token, 'is_nda_crew')) return json(403, { error: 'Only the NDA team can do this.' });
  const me = await callerDisplayName(admin, who.data.user.id);
  const myEmail = String(who.data.user.email || '').toLowerCase();

  const { action } = body;
  if (action === 'create') {
    const withName = oneLine(body.with_name);
    const purpose = oneLine(body.purpose);
    if (!withName) return json(422, { error: 'Add who it is with.' });
    if (!purpose) return json(422, { error: "Add what it's for." });
    if (withName.length > 120 || purpose.length > 300) return json(422, { error: 'That is too long.' });
    const clientId = typeof body.client_id === 'string' && UUID_RE.test(body.client_id) ? body.client_id : null;
    const byUs = body.details_by === 'us';
    let details = null;
    if (byUs) {
      const c = cleanDetails(body.details);
      if (c.error) return json(422, { error: c.error });
      details = c.details;
    }
    const now = new Date().toISOString();
    const { data: row, error } = await admin.from('ndas').insert({
      with_name: withName, purpose, client_id: clientId, created_by: me.employeeId,
      ...(details ? { ...details, details_by: 'us', details_at: now, status: 'ready' } : {})
    }).select('*').single();
    if (error) return json(500, { error: error.message });
    if (details) {
      const r = await createNdaDraft(admin, row);
      return json(200, { id: row.id, draft: r.draftId || null, draftError: r.error || null });
    }
    const l = await freshLink(admin, row.id);
    return json(200, { id: row.id, ...l });
  }

  if (typeof body.id !== 'string' || !UUID_RE.test(body.id)) return json(400, { error: 'id must be a UUID.' });
  const { data: nda } = await admin.from('ndas').select('*').eq('id', body.id).maybeSingle();
  if (!nda) return json(404, { error: 'NDA not found.' });

  if (action === 'link') {
    if (nda.status !== 'awaiting_details') return json(409, { error: 'Their details are already in.' });
    return json(200, await freshLink(admin, nda.id));
  }

  if (action === 'fill') {
    if (nda.status !== 'awaiting_details') return json(409, { error: 'Their details are already in.' });
    const c = cleanDetails(body.details);
    if (c.error) return json(422, { error: c.error });
    const now = new Date().toISOString();
    const { data: row, error } = await admin.from('ndas').update({
      ...c.details, details_by: 'us', details_at: now, status: 'ready',
      intake_token_hash: null, intake_expires_at: null, updated_at: now
    }).eq('id', nda.id).eq('status', 'awaiting_details').select('*').maybeSingle();
    if (error || !row) return json(409, { error: 'Their details came in meanwhile.' });
    const r = await createNdaDraft(admin, row);
    return json(200, { id: row.id, draft: r.draftId || null, draftError: r.error || null });
  }

  if (action === 'draft') {
    if (nda.status !== 'ready') return json(409, { error: 'Not ready for a draft.' });
    const r = await createNdaDraft(admin, nda);
    return r.error ? json(502, { error: r.error }) : json(200, { draft: r.draftId });
  }

  if (action === 'send') {
    if (nda.status !== 'ready') return json(409, { error: 'Not ready to send.' });
    if (!nda.papersign_document_id) return json(409, { error: 'The draft is not made yet.' });
    // The person who started it presses Send (22 Oct 2026); Alex can too.
    if (nda.created_by && nda.created_by !== me.employeeId && myEmail !== OWNER) {
      return json(403, { error: 'Only the person who started it can send it.' });
    }
    const { live } = await ndaConfig(admin);
    if (!live && !isTestNda(nda)) return json(423, { error: 'Real NDAs are on hold until Leo approves the template.' });
    // Claim it first so a double click cannot send twice.
    const now = new Date().toISOString();
    const { data: claimed } = await admin.from('ndas').update({ status: 'sent', sent_at: now, sent_by: me.employeeId, updated_at: now })
      .eq('id', nda.id).eq('status', 'ready').select('id').maybeSingle();
    if (!claimed) return json(409, { error: 'Already sent.' });
    try {
      await call('POST', `/papersign/documents/${encodeURIComponent(nda.papersign_document_id)}/send`, {
        invite_message: `Hi ${String(nda.signatory_name || '').split(' ')[0]}, here is the mutual NDA with Your Agency for your signature.`,
        automatic_reminders: { first_after_days: 2, follow_up_every_days: 3 }
      });
    } catch (e) {
      await admin.from('ndas').update({ status: 'ready', sent_at: null, sent_by: null, draft_error: String(e.message).slice(0, 300), updated_at: new Date().toISOString() }).eq('id', nda.id);
      return json(502, { error: e.message });
    }
    return json(200, { sent: true });
  }

  if (action === 'cancel') {
    if (['sent', 'signed'].includes(nda.status)) return json(409, { error: 'It has already gone out.' });
    await admin.from('ndas').update({ status: 'cancelled', intake_token_hash: null, intake_expires_at: null, updated_at: new Date().toISOString() }).eq('id', nda.id);
    return json(200, { cancelled: true });
  }

  return json(400, { error: 'Unknown action.' });
};
