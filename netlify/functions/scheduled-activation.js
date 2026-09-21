// Activates new joiners on their start date (9 Sep 2026).
//
// Maya finished her paperwork on 9 Sep but does not start until the 22nd.
// Activating early hands over leave accrual, task nudges and client access two
// weeks too soon; leaving it relies on someone remembering on the day.
//
// All the judgement is app.run_due_activations() — dated in IST, skips anyone
// activated by hand in the meantime, and records a failure on its own row
// without stopping the others. This function exists only to call it daily and
// report what happened.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { zonedParts, IST_TIME_ZONE } = require('./lib/config');

async function handler(event) {
  // Same guard as every other cron here: Netlify invokes these over HTTP POST,
  // so httpMethod cannot tell the scheduler from a stranger — only the
  // scheduler's payload carries next_run. Checking the method instead is what
  // left every cron silently dead for two months (13 Apr – 10 Jun 2026).
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Scheduled function only' }) };
  }

  const supabase = getSupabaseAdmin();
  const summary = { today: zonedParts(new Date(), IST_TIME_ZONE).iso, activated: 0, skipped: 0, results: [], errors: [] };

  const { data, error } = await supabase.rpc('run_due_activations');
  if (error) {
    summary.errors.push(error.message);
    return { statusCode: 500, body: JSON.stringify(summary, null, 2) };
  }

  for (const row of data || []) {
    summary.results.push(row);
    if (row.applied) summary.activated += 1;
    else {
      summary.skipped += 1;
      // "already activated" is a normal race, not a fault: someone activated by
      // hand before the date arrived. Anything else is worth surfacing.
      if (row.detail !== 'already activated') summary.errors.push(`${row.employee_id}: ${row.detail}`);
    }
  }

  // Nothing due is the usual case — stay quiet so the heartbeat log is not
  // buried under a daily "did nothing" entry.
  if (!summary.results.length) {
    summary.quiet = true;
    return { statusCode: 200, body: JSON.stringify(summary, null, 2) };
  }

  await logNotification({
    kind: 'cron_heartbeat',
    recipientEmail: 'system',
    subject: `Scheduled activation — ${summary.activated} activated, ${summary.skipped} skipped`,
    payload: summary
  });

  return { statusCode: 200, body: JSON.stringify(summary, null, 2) };
}

exports.handler = withCronHeartbeat('scheduled-activation', handler);
