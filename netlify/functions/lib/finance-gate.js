// Finance's second lock (28 Oct 2026). Pure helpers, tested in
// tests/finance-gate.test.mjs. The code is 6 random digits, valid 10 minutes,
// 5 tries; at most 5 codes an hour per session. Only its hash is stored, salted
// with who asked and from which session, so a code is useless anywhere else.
const { createHash, randomInt } = require('node:crypto');

const CODE_MINUTES = 10;
const MAX_TRIES = 5;
const MAX_SENDS_PER_HOUR = 5;

function newCode() { return String(randomInt(0, 1000000)).padStart(6, '0'); }

function hashCode(code, employeeId, sessionId) {
  return createHash('sha256').update(`${String(code).trim()}|${employeeId}|${sessionId}`).digest('hex');
}

// The session_id claim of an access token the caller has ALREADY verified
// with auth.getUser. Supabase puts one in every access token; it is the same
// value app.finance_unlocked() reads from auth.jwt() in the database.
function sessionIdOf(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const id = String(payload.session_id || '');
    return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch { return null; }
}

// May this session have another code now? Returns the window to store.
function sendAllowed(row, now = Date.now()) {
  const start = row?.window_started_at ? Date.parse(row.window_started_at) : 0;
  const fresh = !start || now - start > 3600000;
  const sends = fresh ? 0 : Number(row?.sends || 0);
  return { ok: sends < MAX_SENDS_PER_HOUR, sends: sends + 1, windowStartedAt: fresh ? new Date(now).toISOString() : row.window_started_at };
}

// Check an entered code against the stored row. Never says which part failed.
function checkCode(row, code, employeeId, sessionId, now = Date.now()) {
  if (!row?.code_hash || !row.code_expires_at) return 'none';
  if (Date.parse(row.code_expires_at) < now) return 'expired';
  if (Number(row.attempts || 0) >= MAX_TRIES) return 'locked';
  return row.code_hash === hashCode(code, employeeId, sessionId) ? 'ok' : 'wrong';
}

module.exports = { CODE_MINUTES, MAX_TRIES, MAX_SENDS_PER_HOUR, newCode, hashCode, sessionIdOf, sendAllowed, checkCode };
