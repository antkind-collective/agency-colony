// Every morning (10:10 IST): re-read registrations from Rishi's media
// dashboard sheet (lib/registrations.js, 5 Nov 2026). Read-only, counts only.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { withCronHeartbeat } = require('./lib/notifications');
const { syncRegistrations } = require('./lib/registrations');

const run = async (event) => {
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return { statusCode: 403, body: JSON.stringify({ error: 'Scheduled function only' }) };
  const summary = await syncRegistrations(getSupabaseAdmin());
  return { statusCode: summary.errors.length ? 207 : 200, body: JSON.stringify(summary) };
};

exports.handler = withCronHeartbeat('registrations-sync', run);
