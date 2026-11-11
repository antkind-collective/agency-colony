// The same pull as the Monday cron, on demand: the superadmin only, for the
// first fill and after a property is added. No button; called from the
// console. Returns counts, never the data.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { bearerToken, callerIs } = require('./lib/caller');
const { syncWebsiteAnalytics } = require('./lib/website-analytics');

const json = (s, b) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const token = bearerToken(event.headers);
  if (!token) return json(401, { error: 'Missing bearer token.' });
  const admin = getSupabaseAdmin();
  const who = await admin.auth.getUser(token);
  if (who.error || !who.data?.user) return json(401, { error: 'Invalid auth token.' });
  if (!await callerIs(token, 'is_superadmin')) return json(403, { error: 'Not allowed.' });
  const summary = await syncWebsiteAnalytics(admin);
  return json(summary.errors.length ? 207 : 200, summary);
};
