// The same read as the morning job, on demand: the superadmin only, from the
// "Refresh registrations now" link under a client's analytics Overview
// (5 Nov 2026). Returns counts and errors, never the sheet itself.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { bearerToken, callerIs } = require('./lib/caller');
const { syncRegistrations } = require('./lib/registrations');

const json = (s, b) => ({ statusCode: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(b) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const token = bearerToken(event.headers);
  if (!token) return json(401, { error: 'Missing bearer token.' });
  const admin = getSupabaseAdmin();
  const who = await admin.auth.getUser(token);
  if (who.error || !who.data?.user) return json(401, { error: 'Invalid auth token.' });
  if (!await callerIs(token, 'is_superadmin')) return json(403, { error: 'Not allowed.' });
  const summary = await syncRegistrations(admin);
  return json(summary.errors.length ? 207 : 200, summary);
};
