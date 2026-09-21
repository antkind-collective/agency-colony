// The thin network layer for Papersign. Everything that decides what to send
// lives in ./papersign.js; this only knows how to talk.
const BASE = 'https://api.paperform.co/v1';

function token() {
  const t = process.env.PAPERSIGN_API_TOKEN;
  if (!t) throw new Error('Papersign is not configured (PAPERSIGN_API_TOKEN).');
  return t;
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.message || json?.error || json?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(`Papersign ${method} ${path}: ${msg}`);
  }
  return json.results ?? json;
}

module.exports = { call };
