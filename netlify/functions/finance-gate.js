// The second lock on Invoices (28 Oct 2026). Finance (the hard-coded three on
// app.is_invoice_viewer) asks for a 6-digit code, gets it by email, enters it;
// this function records the session as verified in app.finance_gate, which is
// what app.finance_unlocked() and every finance read in the database check.
// Replaces the PIN, whose check sat in the page code.
//   { action: 'send' }            email a fresh code to the caller
//   { action: 'verify', code }    unlock this session for 24 hours
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { bearerToken, callerIs } = require('./lib/caller');
const { sendEmail } = require('./lib/email');
const { CODE_MINUTES, MAX_TRIES, newCode, hashCode, sessionIdOf, sendAllowed, checkCode } = require('./lib/finance-gate');

const json = (s, b) => ({ statusCode: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(b) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const token = bearerToken(event.headers);
  if (!token) return json(401, { error: 'Missing bearer token.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

  const admin = getSupabaseAdmin();
  const who = await admin.auth.getUser(token);
  if (who.error || !who.data?.user) return json(401, { error: 'Invalid auth token.' });
  if (!await callerIs(token, 'is_invoice_viewer')) return json(403, { error: 'Not allowed.' });
  const sessionId = sessionIdOf(token);
  if (!sessionId) return json(400, { error: 'Sign out and in again, then try.' });
  const { data: emp } = await admin.from('employees').select('id, email').eq('auth_user_id', who.data.user.id).maybeSingle();
  if (!emp) return json(403, { error: 'Not allowed.' });

  const { data: row } = await admin.from('finance_gate').select('*').eq('employee_id', emp.id).eq('session_id', sessionId).maybeSingle();

  if (body.action === 'send') {
    const allowed = sendAllowed(row);
    if (!allowed.ok) return json(429, { error: 'Too many codes this hour. Try again later.' });
    const code = newCode();
    const fields = {
      code_hash: hashCode(code, emp.id, sessionId),
      code_expires_at: new Date(Date.now() + CODE_MINUTES * 60000).toISOString(),
      attempts: 0, sends: allowed.sends, window_started_at: allowed.windowStartedAt
    };
    // Claim the send against the count as read (audit S22a): a parallel
    // request that already moved sends on gets no row back and is refused.
    if (row) {
      let claim = admin.from('finance_gate').update(fields)
        .eq('employee_id', emp.id).eq('session_id', sessionId).eq('sends', Number(row.sends || 0));
      claim = row.window_started_at ? claim.eq('window_started_at', row.window_started_at) : claim.is('window_started_at', null);
      const { data: claimed, error } = await claim.select('employee_id');
      if (error) return json(500, { error: 'Could not start. Try again.' });
      if (!claimed?.length) return json(429, { error: 'Try again.' });
    } else {
      const { error } = await admin.from('finance_gate').insert({ employee_id: emp.id, session_id: sessionId, ...fields });
      if (error) return json(429, { error: 'Try again.' });
    }
    await sendEmail({
      to: emp.email,
      private: true,
      subject: `${code} is your Colony Invoices code`,
      text: `Your code to open Invoices in Colony: ${code}\n\nIt works for ${CODE_MINUTES} minutes, on the device that asked for it. If you didn't ask for it, tell Alex.`,
      html: `<p>Your code to open Invoices in Colony:</p><p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:12px 0">${code}</p><p style="color:#666">It works for ${CODE_MINUTES} minutes, on the device that asked for it. If you didn't ask for it, tell Alex.</p>`
    });
    return json(200, { sent: true });
  }

  if (body.action === 'verify') {
    // Claim the try before comparing (audit S22a): parallel guesses can't
    // all pass the MAX_TRIES check on the same count.
    const n = Number(row?.attempts || 0);
    if (row?.code_hash) {
      const { data: claimed } = await admin.from('finance_gate').update({ attempts: n + 1 })
        .eq('employee_id', emp.id).eq('session_id', sessionId).eq('attempts', n).select('employee_id');
      if (!claimed?.length) return json(429, { error: 'Try again.' });
    }
    const result = checkCode(row, body.code, emp.id, sessionId);
    if (result === 'ok') {
      await admin.from('finance_gate').update({ verified_at: new Date().toISOString(), code_hash: null, code_expires_at: null, attempts: 0 })
        .eq('employee_id', emp.id).eq('session_id', sessionId);
      return json(200, { unlocked: true });
    }
    if (result === 'wrong') {
      const left = MAX_TRIES - n - 1;
      return json(422, { error: left > 0 ? 'That code isn\'t right.' : 'Too many tries. Ask for a new code.' });
    }
    return json(422, { error: result === 'expired' ? 'That code has expired. Ask for a new one.' : 'Ask for a new code.' });
  }

  return json(400, { error: 'Unknown action.' });
};
