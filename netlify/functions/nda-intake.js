// The one public door for NDAs (22 Oct 2026): the form at /nda.html, opened
// from a one-time link, posts here. No login by design; the link IS the
// permission, and it is narrow:
//   * the token is 32 random bytes; only its SHA-256 is stored, so even a read
//     of the database cannot rebuild a working link;
//   * it opens exactly one NDA, only while that NDA is waiting for details,
//     and only for 7 days;
//   * submitting spends it (the hash is cleared in the same update that saves
//     the details), so it works once;
//   * a used, expired, cancelled or wrong link all get the same answer, so the
//     door says nothing about what exists;
//   * before submitting, the form sees only "what it's for"; nothing is ever
//     read back afterwards.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { cleanDetails, hashToken, looksLikeToken } = require('./lib/nda');
const { createNdaDraft } = require('./lib/nda-papersign');

const json = (s, b) => ({
  statusCode: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(b)
});
const CLOSED = { state: 'closed' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (String(event.body || '').length > 4000) return json(413, { error: 'Too large.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
  if (!looksLikeToken(body.token)) return json(200, CLOSED);

  const admin = getSupabaseAdmin();
  const hash = hashToken(body.token);
  const now = new Date().toISOString();

  if (body.action === 'view') {
    const { data } = await admin.from('ndas').select('purpose')
      .eq('intake_token_hash', hash).eq('status', 'awaiting_details').gt('intake_expires_at', now).maybeSingle();
    return json(200, data ? { state: 'open', purpose: data.purpose } : CLOSED);
  }

  if (body.action === 'submit') {
    const c = cleanDetails(body.details);
    if (c.error) return json(422, { error: c.error });
    // Save and spend the link in one update: a second submit finds nothing.
    const { data: row } = await admin.from('ndas').update({
      ...c.details, details_by: 'them', details_at: now, status: 'ready',
      intake_token_hash: null, intake_expires_at: null, updated_at: now
    }).eq('intake_token_hash', hash).eq('status', 'awaiting_details').gt('intake_expires_at', now)
      .select('*').maybeSingle();
    if (!row) return json(200, CLOSED);
    await createNdaDraft(admin, row);
    return json(200, { state: 'done' });
  }

  return json(400, { error: 'Unknown action.' });
};
