// Service-account JWT → Google access token, impersonating the Workspace
// admin. Shared by Workspace provisioning (Directory scope) and the Drive
// mirror (Drive scope). No SDK: one RS256 signature and one POST.
//
// Env: GOOGLE_SA_JSON (compact {client_email, private_key} — Netlify caps
// every variable at 4KB, the full key file is bigger), GOOGLE_ADMIN_IMPERSONATE.
// Each scope also has to be listed against the service account's client ID
// under Admin console → Security → API controls → Domain-wide delegation, or
// the token exchange fails with "unauthorized_client".

const { createSign } = require('node:crypto');

function b64url(input) {
  return Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url');
}

async function googleAccessToken(scope) {
  const raw = process.env.GOOGLE_SA_JSON;
  const subject = process.env.GOOGLE_ADMIN_IMPERSONATE;
  if (!raw || !subject) throw new Error('Google service account is not configured (GOOGLE_SA_JSON / GOOGLE_ADMIN_IMPERSONATE).');
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { throw new Error('GOOGLE_SA_JSON is not valid JSON.'); }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_SA_JSON is missing client_email or private_key.');

  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: sa.client_email, sub: subject, scope,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 300
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(sa.private_key).toString('base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token exchange failed: ${body.error_description || body.error || res.status}`);
  }
  return body.access_token;
}

module.exports = { googleAccessToken };
