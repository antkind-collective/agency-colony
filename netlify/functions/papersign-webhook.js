// Papersign tells us a document is complete (11 Sep 2026).
//
// Papersign webhooks carry no signature, so the URL carries a shared key:
//   https://app.youragency.com/api/papersign-webhook?key=<PAPERSIGN_WEBHOOK_KEY>
// Anything without the right key is ignored. On completion: match the
// document to a hire, download the signed PDF into the hire's files, move the
// pipeline to `signed`, and tell Finance exactly what to set up and from when.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification } = require('./lib/notifications');
const { getConfig } = require('./lib/config');
const { call } = require('./lib/papersign-client');
const { readCompletion, prettyDate } = require('./lib/papersign');

const { createHash, timingSafeEqual } = require('node:crypto');

// Constant-time: `!==` stops at the first differing character, so response
// timing leaks how much of a guess was right (audit 16 Sep 2026). Hashing
// first makes both sides the same length, which timingSafeEqual requires.
const sameKey = (given, expected) => timingSafeEqual(
  createHash('sha256').update(String(given)).digest(),
  createHash('sha256').update(String(expected)).digest()
);

const json = (s, b) =>({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const expected = process.env.PAPERSIGN_WEBHOOK_KEY;
  if (!expected || !sameKey(event.queryStringParameters?.key || '', expected)) return json(401, { error: 'Bad key.' });
  let payload; try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

  const { id, completed } = readCompletion(payload);
  if (!id) return json(200, { ignored: 'no document id' });
  if (!completed) return json(200, { ignored: 'not a completion' });

  const admin = getSupabaseAdmin();
  const { data: terms } = await admin.from('hire_offer_terms').select('hire_id, papersign_completed_at, ctc_annual, monthly_fee').eq('papersign_draft_id', String(id)).maybeSingle();
  if (!terms) return json(200, { ignored: 'not a Colony document' });
  if (terms.papersign_completed_at) return json(200, { ignored: 'already filed' });
  const { data: hire } = await admin.from('hires').select('*').eq('id', terms.hire_id).maybeSingle();
  if (!hire) return json(200, { ignored: 'hire missing' });

  // Fetch the signed PDF through the API rather than trusting a URL in the
  // payload: the key on this endpoint is the only auth a webhook has.
  let pdf, fileName;
  try {
    const link = await call('GET', `/papersign/documents/${encodeURIComponent(id)}/completed-document-url`);
    const url = link?.url || link?.completed_document_url || link;
    if (typeof url !== 'string') throw new Error('no download url');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    pdf = Buffer.from(await res.arrayBuffer());
    const doc = await call('GET', `/papersign/documents/${encodeURIComponent(id)}`).catch(() => ({}));
    fileName = `${Date.now()}_signed_${String((doc.document || doc).name || 'agreement').replace(/[^\w .-]+/g, ' ').trim()}.pdf`;
  } catch (e) {
    await logNotification({ kind: 'hire_notify', recipientEmail: 'system', subject: `Papersign completion for ${hire.full_name} could not be filed`, payload: { hire_id: hire.id, document_id: id, error: e.message } });
    return json(200, { filed: false, error: e.message });
  }
  const path = `${hire.id}/contract/${fileName}`;
  const up = await admin.storage.from('hires').upload(path, pdf, { contentType: 'application/pdf', upsert: false });
  if (up.error) return json(200, { filed: false, error: up.error.message });

  const now = new Date().toISOString();
  // A copy in Alex's Drive (14 Sep 2026). Best effort: Colony's copy is the
  // one Finance is pointed at; a Drive hiccup is noted, not fatal.
  let driveLink = null;
  try {
    const { syncFile } = require('./lib/drive-sync');
    const { agreementFileName } = require('./lib/drive-mirror');
    const row = await syncFile({ admin, key: `agreement:${hire.id}:${id}`, name: agreementFileName(hire, now), contentType: 'application/pdf', content: pdf });
    driveLink = row.web_view_link;
  } catch (e) {
    await logNotification({ kind: 'hire_notify', recipientEmail: 'system', subject: `Drive copy of ${hire.full_name}'s agreement failed`, payload: { hire_id: hire.id, document_id: id, error: e.message } });
  }
  await admin.from('hire_offer_terms').update({ papersign_completed_at: now, updated_at: now }).eq('hire_id', hire.id);
  await admin.from('hires').update({ stage: 'signed', updated_at: now }).eq('id', hire.id);

  // Row 07: Finance is told what to set up, from when, at what number.
  const salaried = (hire.hire_type || 'full-time') === 'full-time';
  const amount = salaried ? terms.ctc_annual : terms.monthly_fee;
  const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
  const ask = salaried
    ? `put ${hire.full_name} on payroll from ${prettyDate(hire.start_date)} at a CTC of ${inr(amount)} per annum`
    : `set ${hire.full_name} up as a vendor from ${prettyDate(hire.start_date)} at ${inr(amount)} per month, invoiced monthly`;
  const { appBaseUrl } = getConfig();
  const subject = `Signed: ${hire.full_name} — ${salaried ? 'payroll' : 'vendor'} setup from ${prettyDate(hire.start_date)}`;
  const financeName = process.env.PAPERSIGN_FINANCE_NAME || 'Blake';
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6"><p>Hi ${financeName},</p><p>${hire.full_name}'s agreement is signed by both sides. Please ${ask}.</p><p>The signed copy is filed against the hire in Colony: <a href="${appBaseUrl}?open=hire:${hire.id}#hiring">${appBaseUrl}?open=hire:${hire.id}#hiring</a></p></div>`;
  const text = `${hire.full_name}'s agreement is signed by both sides. Please ${ask}.\n${appBaseUrl}?open=hire:${hire.id}#hiring`;
  try {
    // Finance sets up payroll or the vendor; leadership is copied. Configurable
    // for other deployments; the fallback is this deployment's own people.
    const financeTo = process.env.PAPERSIGN_FINANCE_EMAIL || 'finance@youragency.com';
    const notifyCc = (process.env.PAPERSIGN_NOTIFY_CC || 'admin@youragency.com,am-lead@youragency.com')
      .split(',').map((e) => e.trim()).filter(Boolean);
    await sendEmail({ to: financeTo, cc: notifyCc, subject, html, text, audience: 'team' });
    await logNotification({ kind: 'hire_notify', recipientEmail: financeTo, subject, payload: { hire_id: hire.id, stage: 'signed', document_id: id, file: path } });
  } catch (e) { /* the file is safe; the email can be resent */ }
  return json(200, { filed: true, path, drive: driveLink });
};
