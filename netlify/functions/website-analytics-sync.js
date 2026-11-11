// Mondays 10:00 IST: pull last week's website traffic from Google Analytics
// for every client in app_config.website_analytics (26 Oct 2026). Weekly, on
// the same Monday the LinkedIn / Meta reports go up (Alex: not daily).
// Also Google Search from Search Console for clients with a search_site (3 Nov 2026).
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { withCronHeartbeat } = require('./lib/notifications');
const { syncWebsiteAnalytics } = require('./lib/website-analytics');

const run = async (event) => {
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return { statusCode: 403, body: JSON.stringify({ error: 'Scheduled function only' }) };
  const summary = await syncWebsiteAnalytics(getSupabaseAdmin());
  return { statusCode: summary.errors.length ? 207 : 200, body: JSON.stringify(summary) };
};

exports.handler = withCronHeartbeat('website-analytics-sync', run);
