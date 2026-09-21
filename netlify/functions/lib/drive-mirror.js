// A copy of every document Colony holds, in Alex's Drive (14 Sep 2026).
//
// Colony is the source of truth; Drive is the copy people can find without
// signing in anywhere. Two kinds of document go across: policy pages (as a
// Google Doc, one per policy, updated in place so Drive's own version history
// holds every edit) and signed agreements from Papersign (as the PDF, one per
// signature). Nothing operational — allocations, leave, briefs — is a
// document, so nothing operational is mirrored.
//
// This file is the PURE part: names, the HTML that becomes the Doc, and the
// multipart body Drive's upload endpoint wants. Tested without Google.

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const GOOGLE_DOC = 'application/vnd.google-apps.document';

// One Doc per policy, named by its title; the version lives inside Drive's
// history, not in the file name, so the link never changes.
function policyDocName(policy) {
  const t = String(policy?.title || 'Policy').trim();
  return t.replace(/\s+/g, ' ');
}

// The Doc body. A title line and a stamp, then the page's own HTML.
function policyHtml(policy) {
  const title = policyDocName(policy);
  const version = policy?.version ? `Version ${policy.version}` : '';
  const updated = policy?.updated_at ? new Date(policy.updated_at).toISOString().slice(0, 10) : '';
  const stamp = [version, updated ? `updated ${updated}` : '', 'Source: Colony'].filter(Boolean).join(' · ');
  return `<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>`
    + `<h1>${escapeHtml(title)}</h1><p><i>${escapeHtml(stamp)}</i></p>${stripOwnHeader(policy?.content_html || '')}</body></html>`;
}

// The page HTML carries its own H1 and "Last updated" line; the Colony page
// hides both behind its header, and so does the Doc.
function stripOwnHeader(html) {
  return String(html)
    .replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, '')
    .replace(/^\s*<(p|div)[^>]*>\s*(<[^>]+>\s*)*last\s+updated[\s\S]*?<\/\1>\s*/i, '');
}

// "Agreement — Asha Rao — 2026-09-08.pdf": readable in a folder listing
// without opening anything.
function agreementFileName(hire, completedAt) {
  const name = String(hire?.full_name || 'Hire').replace(/[^\w .'-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const day = (completedAt ? new Date(completedAt) : new Date()).toISOString().slice(0, 10);
  return `Agreement — ${name} — ${day}.pdf`;
}

// Drive v3 multipart upload: a JSON metadata part then the bytes.
function multipartBody(metadata, contentType, content) {
  const boundary = `colony_${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const body = Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'), tail]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { DRIVE_SCOPE, GOOGLE_DOC, policyDocName, policyHtml, agreementFileName, multipartBody };
