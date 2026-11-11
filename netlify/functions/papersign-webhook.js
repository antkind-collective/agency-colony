// Papersign tells us a document is complete (11 Sep 2026).
//
// Papersign webhooks carry no signature, so the URL carries a shared key:
//   https://app.youragency.com/api/papersign-webhook?key=<PAPERSIGN_WEBHOOK_KEY>
// Anything without the right key is ignored. Key rotated 5 Oct 2026 (S15: the
// old one had sat in a committed file); a change of key needs a non-.md push
// to reach the functions (netlify.toml ignore trap). On completion: match the
// document to a hire, download the signed PDF into the hire's files, move the
// pipeline to `signed`, and tell Finance exactly what to set up and from when.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { financeRows, financeTableHtml, financeTableText } = require('./lib/hire-finance');
const { sendEmail } = require('./lib/email');
const { logNotification } = require('./lib/notifications');
const { getConfig } = require('./lib/config');
const { internalFunctionKey } = require('./lib/workspace-provision');
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

// The hire's name is typed by the candidate (submit_hire_details), so it is
// escaped before it goes into Finance's HTML email (audit 23 Sep 2026).
const escapeHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const json = (s, b) =>({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

// A signed NDA: keep the PDF in Colony, file it in Legal > Signed NDAs under
// the standard name, mark it signed, and tell whoever started it.
async function fileSignedNda(admin, nda, id) {
  if (nda.signed_at) return json(200, { ignored: 'already filed' });
  const { ndaFileBase } = require('./lib/nda');
  let pdf;
  try {
    const link = await call('GET', `/papersign/documents/${encodeURIComponent(id)}/completed-document-url`);
    const url = link?.url || link?.completed_document_url || link;
    if (typeof url !== 'string') throw new Error('no download url');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    pdf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    await logNotification({ kind: 'hire_notify', recipientEmail: 'system', subject: `Signed NDA with ${nda.with_name} could not be downloaded`, status: 'failed', payload: { nda_id: nda.id, document_id: id, error: e.message } }).catch(() => {});
    return json(200, { filed: false, error: e.message });
  }
  const name = `${ndaFileBase(nda)}.pdf`;
  const path = `${nda.id}/${name}`;
  const up = await admin.storage.from('ndas').upload(path, pdf, { contentType: 'application/pdf', upsert: true });
  if (up.error) return json(200, { filed: false, error: up.error.message });
  const now = new Date().toISOString();
  let drive = {};
  try {
    const { syncFile } = require('./lib/drive-sync');
    const { data: cfg } = await admin.from('app_config').select('value').eq('key', 'nda_papersign').maybeSingle();
    const folderId = cfg?.value?.drive_folder_id;
    if (folderId) {
      const row = await syncFile({ admin, key: `nda:${nda.id}`, name, contentType: 'application/pdf', content: pdf, folderId, lock: false });
      drive = { drive_file_id: row.file_id, drive_link: row.web_view_link };
    }
  } catch (e) {
    await logNotification({ kind: 'hire_notify', recipientEmail: 'system', subject: `Drive copy of the NDA with ${nda.with_name} failed`, status: 'failed', payload: { nda_id: nda.id, error: e.message } }).catch(() => {});
  }
  await admin.from('ndas').update({ status: 'signed', signed_at: now, signed_file_path: path, ...drive, updated_at: now }).eq('id', nda.id);
  try {
    const { data: starter } = nda.created_by
      ? await admin.from('employees').select('email, full_name').eq('id', nda.created_by).maybeSingle()
      : { data: null };
    // Legal gets a copy of every signed NDA, for the records (22 Oct
    // 2026: no review before sending, a copy after). app_config
    // nda_papersign.signed_cc overrides; [] stops it.
    const { data: ccCfg } = await admin.from('app_config').select('value').eq('key', 'nda_papersign').maybeSingle();
    const cc = Array.isArray(ccCfg?.value?.signed_cc) ? ccCfg.value.signed_cc : ['leo@youragency.com'];
    const to = starter?.email || cc[0];
    if (to) {
      const { appBaseUrl } = getConfig();
      const subject = `Signed: NDA with ${nda.with_name}`;
      const where = drive.drive_link ? ` It's filed in Legal > Signed NDAs: ${drive.drive_link}` : '';
      const first = starter?.full_name ? String(starter.full_name).split(' ')[0] : 'all';
      const ndaHtml = `<div style="font-family:Arial,sans-serif;line-height:1.6"><p>Hi ${escapeHtml(first)},</p><p>The NDA with ${escapeHtml(nda.with_name)} is signed by both sides.${drive.drive_link ? ` It's filed in <a href="${drive.drive_link}">Legal &gt; Signed NDAs</a>.` : ''}</p><p><a href="${appBaseUrl}#ndas">See it in Colony</a></p></div>`;
      await sendEmail({ to, cc: cc.filter((e) => e !== to), subject, html: ndaHtml, text: `The NDA with ${nda.with_name} is signed by both sides.${where}`, audience: 'team' });
    }
  } catch (e) { /* filed; the email is a courtesy */ }
  return json(200, { filed: true, nda: nda.id });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const expected = process.env.PAPERSIGN_WEBHOOK_KEY;
  if (!expected || !sameKey(event.queryStringParameters?.key || '', expected)) return json(401, { error: 'Bad key.' });
  let payload; try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

  const { id, completed } = readCompletion(payload);
  // Every ignore used to be a silent 200. Papersign's payload shape is not
  // documented and readCompletion guesses at it, so a shape it does not
  // recognise looked identical to nothing happening — Sivabalan's agreement was
  // signed by both sides and Colony never knew (7 Oct 2026). Each exit is
  // logged now, with the keys of the payload, so the next one is diagnosable
  // without waiting for another hire.
  const drop = async (reason) => {
    await logNotification({
      // notification_kind is an enum; hire_notify is the hiring one. The reason
      // lives in the subject and payload rather than inventing a kind that the
      // column would reject (and the reject would itself be swallowed).
      kind: 'hire_notify', recipientEmail: 'system', subject: `papersign webhook ignored: ${reason}`, status: 'skipped',
      payload: { reason, documentId: id || null, completed, topKeys: Object.keys(payload || {}).slice(0, 12) }
    }).catch(() => {});
    return json(200, { ignored: reason });
  };
  if (!id) return drop('no document id');
  if (!completed) return drop('not a completion');

  const admin = getSupabaseAdmin();
  // NDAs (22 Oct 2026) live in their own Papersign folder with its own
  // webhook pointing here; they are matched by document id before hires.
  const { data: nda } = await admin.from('ndas').select('*').eq('papersign_document_id', String(id)).maybeSingle();
  if (nda) return fileSignedNda(admin, nda, id);
  const { data: terms } = await admin.from('hire_offer_terms').select('*').eq('papersign_draft_id', String(id)).maybeSingle();
  if (!terms) return drop('not a Colony document');
  if (terms.papersign_completed_at) return drop('already filed');
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
  // Someone who invoices needs nothing set up, so there is no step for Finance
  // to close: the hire moves straight on. It was a "Noted ✓" button that only
  // existed to be clicked (7 Oct 2026). Payroll stays a real step.
  const salariedHire = (hire.hire_type || 'full-time') === 'full-time';
  if (!salariedHire) await admin.from('hires').update({ stage: 'payroll_done', updated_at: new Date().toISOString() }).eq('id', hire.id);


  // Create the @youragency.com account now the agreement is signed, BEFORE
  // Finance is told, so their email carries the real work email instead of
  // 'not created yet' (30 Oct 2026). If it fails, Finance is still
  // emailed and the row says so; setup never waits on Google.
  // The address is one the directory says is free. Switched on by
  // app_config.auto_provision_on_signed (on since Modeera's signing proved it).
  const { appBaseUrl } = getConfig();
  try {
    const { data: flag } = await admin.from('app_config').select('value').eq('key', 'auto_provision_on_signed').maybeSingle();
    const on = flag?.value === true || flag?.value === 'true';
    if (on && !hire.work_email && !hire.workspace_not_needed) {
      const res = await fetch(`${appBaseUrl}/api/workspace-provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalFunctionKey()}` },
        body: JSON.stringify({ hireId: hire.id, autoAddress: true })
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.workEmail) hire.work_email = out.workEmail;
      await logNotification({
        kind: 'hire_notify', recipientEmail: 'system', status: res.ok ? 'sent' : 'failed',
        subject: res.ok ? `account created automatically: ${out.workEmail}` : `auto-provision failed: ${out.error || res.status}`,
        payload: { hire_id: hire.id, ...out }
      }).catch(() => {});
    }
  } catch (e) { /* the agreement is filed; the account can still be made by hand */ }

  // Row 07: Finance is told what to set up, from when, at what number.
  const salaried = (hire.hire_type || 'full-time') === 'full-time';
  const amount = salaried ? terms.ctc_annual : terms.monthly_fee;
  const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
  const ask = salaried
    ? `put ${hire.full_name} on payroll from ${prettyDate(hire.start_date)} at a CTC of ${inr(amount)} per annum`
    : `set ${hire.full_name} up as a vendor from ${prettyDate(hire.start_date)} at ${inr(amount)} per month, invoiced monthly`;
  const subject = `Signed: ${hire.full_name} — ${salaried ? 'payroll' : 'vendor'} setup from ${prettyDate(hire.start_date)}`;
  const financeName = process.env.PAPERSIGN_FINANCE_NAME || 'Blake';
  const rows = financeRows(hire, terms);
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6"><p>Hi ${escapeHtml(financeName)},</p><p>${escapeHtml(hire.full_name)}'s agreement is signed by both sides. Please ${escapeHtml(ask)}.</p>${financeTableHtml(rows)}<p>The signed copy is filed against the hire in Colony: <a href="${appBaseUrl}?open=hire:${hire.id}#hiring">${appBaseUrl}?open=hire:${hire.id}#hiring</a></p></div>`;
  const text = `${hire.full_name}'s agreement is signed by both sides. Please ${ask}.\n\n${financeTableText(rows)}\n\n${appBaseUrl}?open=hire:${hire.id}#hiring`;
  try {
    // Finance sets up payroll or the vendor; leadership is copied. Configurable
    // for other deployments; the fallback is this deployment's own people.
    const financeTo = process.env.PAPERSIGN_FINANCE_EMAIL || 'finance@youragency.com';
    // The hiring manager, not a standing approver list — Nadia was on every
    // hiring email only because she was hardcoded here (7 Oct 2026).
    // Finance acts; Alex and the hire's manager are copied, so the manager
    // knows the agreement is signed (2 Nov 2026; until then they weren't).
    const manager = String(terms.hiring_manager_email || '').trim().toLowerCase();
    const notifyCc = [...new Set([...(process.env.PAPERSIGN_NOTIFY_CC || 'admin@youragency.com')
      .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean), ...(manager ? [manager] : [])])]
      .filter((e) => e !== financeTo.toLowerCase());
    await sendEmail({ to: financeTo, cc: notifyCc, subject, html, text, audience: 'team' });
    await logNotification({ kind: 'hire_notify', recipientEmail: financeTo, subject, payload: { hire_id: hire.id, stage: 'signed', document_id: id, file: path } });
  } catch (e) { /* the file is safe; the email can be resent */ }

  return json(200, { filed: true, path, drive: driveLink });
};
