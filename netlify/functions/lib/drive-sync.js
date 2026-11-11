// The network half of the Drive mirror: create or update one file in the
// mirror folder and remember its id in app.drive_mirror, so the next sync of
// the same key updates the same file instead of making a twin.
//
// Everything runs as the impersonated admin (Alex), so the files are his,
// in his folder, with his quota — a service account owns nothing.
//
// Never throws past its callers' choice: the policy save and the Papersign
// webhook both treat a failed mirror as "note it and carry on"; the Colony
// copy is the one that matters.

const { googleAccessToken } = require('./google-auth');
const { DRIVE_SCOPE, GOOGLE_DOC, multipartBody } = require('./drive-mirror');

const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES = 'https://www.googleapis.com/drive/v3/files';

async function driveRequest(token, url, init, step = 'request') {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
  if (!res.ok) throw new Error(`Drive ${step} ${res.status}: ${json?.error?.message || text.slice(0, 200)}`);
  return json;
}

// What Drive thinks of a mirrored file — for a leadership "inspect" call
// when a sync misbehaves. Capabilities say who may do what.
async function inspectFile(admin, key) {
  const token = await googleAccessToken(DRIVE_SCOPE);
  const existing = await admin.from('drive_mirror').select('file_id').eq('key', key).maybeSingle();
  if (!existing.data?.file_id) return { key, mirrored: false };
  return driveRequest(token, `${FILES}/${encodeURIComponent(existing.data.file_id)}?supportsAllDrives=true&fields=id,name,mimeType,driveId,owners(emailAddress),contentRestrictions,capabilities(canEdit,canModifyContent,canModifyContentRestriction,canRename)`, { method: 'GET' }, 'inspect');
}

async function mirrorFolderId(admin) {
  const res = await admin.from('app_config').select('value').eq('key', 'drive_mirror_folder_id').maybeSingle();
  const v = res.data?.value;
  const id = typeof v === 'string' ? v : (v && typeof v === 'object' ? v.id : null);
  if (!id) throw new Error('Drive mirror folder is not configured (app_config.drive_mirror_folder_id).');
  return String(id).replace(/^"|"$/g, '');
}

// Drive's own file lock. Locked, nobody — Alex included — can edit, rename
// or move the file in Drive; it has to be unlocked first. That is the point:
// Colony is where these are edited, the Doc is a copy (14 Sep 2026).
const LOCK_REASON = 'Managed by Colony — edit it there. This copy is overwritten on every save.';
async function setLock(token, fileId, locked) {
  await driveRequest(token, `${FILES}/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentRestrictions: [locked ? { readOnly: true, reason: LOCK_REASON } : { readOnly: false }] })
  }, locked ? 'lock' : 'unlock');
}

async function withRetry(fn, retryOn, delays = [1500, 3000, 5000]) {
  for (let i = 0; ; i += 1) {
    try { return await fn(); } catch (e) {
      if (i >= delays.length || !retryOn.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

// key: what this file IS ("policy:remote_working_policy", "agreement:<hire>:<doc>").
// convertTo: a Google MIME type to import as (a Doc), or null to keep the bytes.
// folderId: file somewhere other than the mirror folder (signed NDAs go to
// Legal > Signed NDAs on the shared drive). lock: false leaves it editable.
async function syncFile({ admin, key, name, contentType, content, convertTo = null, folderId: targetFolder = null, lock = true }) {
  const [token, folderId] = await Promise.all([googleAccessToken(DRIVE_SCOPE), targetFolder ? Promise.resolve(String(targetFolder)) : mirrorFolderId(admin)]);
  const existing = await admin.from('drive_mirror').select('file_id').eq('key', key).maybeSingle();
  const fields = 'id,name,webViewLink,modifiedTime';
  let file;
  const priorId = existing.data?.file_id || null;
  try {
    if (priorId) {
      const { body, contentType: ct } = multipartBody({ name, ...(convertTo ? { mimeType: convertTo } : {}) }, contentType, content);
      try {
        // A locked file refuses content updates; lift the lock for the write.
        // The unlock lands a beat before Drive honours it — the first write
        // after it can still come back 403 — so the update gets a few tries.
        if (lock) await setLock(token, priorId, false);
        file = await withRetry(() => driveRequest(token, `${UPLOAD}/${encodeURIComponent(priorId)}?uploadType=multipart&supportsAllDrives=true&fields=${fields}`,
          { method: 'PATCH', headers: { 'Content-Type': ct }, body }, 'update'), / 403:/);
      } catch (e) {
        // The file was deleted or moved out of reach in Drive — make a fresh
        // one rather than failing forever on a ghost id.
        if (!/ 404:/.test(e.message)) throw e;
        file = null;
      }
    }
    if (!file) {
      const { body, contentType: ct } = multipartBody({ name, parents: [folderId], ...(convertTo ? { mimeType: convertTo } : {}) }, contentType, content);
      file = await driveRequest(token, `${UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=${fields}`,
        { method: 'POST', headers: { 'Content-Type': ct }, body }, 'create');
    }
  } finally {
    // Whatever happened, the copy must not be left editable.
    const lockId = file?.id || priorId;
    if (lock && lockId) await setLock(token, lockId, true).catch(() => {});
  }
  const row = { key, file_id: file.id, name: file.name || name, web_view_link: file.webViewLink || null, synced_at: new Date().toISOString() };
  await admin.from('drive_mirror').upsert(row, { onConflict: 'key' });
  return row;
}

async function syncPolicy(admin, policy) {
  const { policyDocName, policyHtml } = require('./drive-mirror');
  return syncFile({ admin, key: `policy:${policy.policy_key}`, name: policyDocName(policy), contentType: 'text/html; charset=UTF-8', content: policyHtml(policy), convertTo: GOOGLE_DOC });
}

module.exports = { syncFile, syncPolicy, inspectFile, mirrorFolderId, FILES };
