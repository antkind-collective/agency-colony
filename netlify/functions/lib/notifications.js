const { getSupabaseAdmin } = require('./supabase-admin');

async function logNotification({ kind, recipientEmail, subject, payload = {}, status = 'sent' }) {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase.from('notification_log').insert({
    kind,
    recipient_email: recipientEmail,
    subject,
    payload,
    status,
    sent_at: status === 'sent' ? new Date().toISOString() : null
  });

  if (error) {
    console.error('Failed to write notification log:', error.message);
  }
}

// Has this notification already gone out? Fire-and-forget notify functions can
// be POSTed again (a stale tab, a retry, a script), and each POST used to mean
// another email (audit S22b, S24). `match` compares payload fields; `since`
// limits the search to rows written after a moment, for things that can
// legitimately happen twice (delivered, revised, delivered again). A failed
// lookup answers no: one duplicate beats a lost email.
async function alreadyNotified(supabase, kind, match = {}, since = null) {
  let query = supabase.from('notification_log').select('id').eq('kind', kind);
  for (const [field, value] of Object.entries(match)) query = query.eq(`payload->>${field}`, String(value));
  if (since) query = query.gte('created_at', since);
  const { data, error } = await query.limit(1);
  if (error) { console.error('Notification lookup failed:', error.message); return false; }
  return Boolean(data?.length);
}

// Wrap a scheduled function so every run (success, partial, or crash) writes a
// heartbeat row to notification_log — a dead scheduler must be visible in
// Admin Settings within a day, not discovered months later by accident.
// 403s (direct URL hits rejected by the scheduler guard) are not logged.
//
// A function that polls far more often than it acts may return `quiet: true` to
// suppress the heartbeat on a run that did nothing: task-nudge fires every 30
// minutes to catch each timezone's local 11 AM, but only 2-3 of those 48 daily
// runs are anybody's 11, and 48 heartbeats a day would bury months of real
// notification_log signal within a fortnight. A quiet function must NOT return
// quiet on a run that did real work, or the daily liveness signal is lost.
// Errors and 5xx always heartbeat, quiet or not.
//
// Quiet is not silent (28 Sep 2026): a job that is quiet every day
// (scheduled-activation with nothing due, workspace-group-sync with nothing to
// report) used to write nothing at all, so the daily audit could not tell it
// from a dead one and flagged it every morning. A quiet run now writes ONE
// minimal "beacon" heartbeat per function per UTC day — the first quiet run of
// the day, and only when that function has not heartbeated yet today. Dry runs
// never beacon: they are rehearsals, not proof the scheduler fired.
function quietRunNeedsBeacon(body, lastHeartbeatIso, nowIso) {
  if (!body || body.quiet !== true || body.dryRun === true) return false;
  if (!lastHeartbeatIso) return true;
  return String(lastHeartbeatIso).slice(0, 10) !== String(nowIso).slice(0, 10);
}

async function lastHeartbeatAt(functionName) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from('notification_log')
    .select('created_at')
    .eq('kind', 'cron_heartbeat')
    .eq('payload->>function', functionName)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) { console.error('Heartbeat lookup failed:', error.message); return null; }
  return data?.[0]?.created_at || null;
}

function withCronHeartbeat(functionName, run) {
  return async (event) => {
    const startedAt = new Date().toISOString();
    try {
      const result = await run(event);
      if (result && result.statusCode === 403) return result;
      let body = {};
      try { body = JSON.parse(result.body || '{}'); } catch (parseError) { body = {}; }
      const errors = Array.isArray(body.errors) ? body.errors : [];
      const failed = errors.length > 0 || (result.statusCode >= 500);
      if (body.quiet === true && !failed) {
        const nowIso = new Date().toISOString();
        if (quietRunNeedsBeacon(body, await lastHeartbeatAt(functionName), nowIso)) {
          await logNotification({
            kind: 'cron_heartbeat',
            recipientEmail: 'system',
            subject: `${functionName}: ok (nothing to do)`,
            payload: { function: functionName, started_at: startedAt, status_code: result.statusCode, summary: { beacon: true, quiet: true } },
            status: 'sent'
          });
        }
        return result;
      }
      await logNotification({
        kind: 'cron_heartbeat',
        recipientEmail: 'system',
        subject: `${functionName}: ${failed ? `${errors.length || 1} error(s)` : 'ok'}`,
        payload: { function: functionName, started_at: startedAt, status_code: result.statusCode, summary: body },
        status: failed ? 'error' : 'sent'
      });
      return result;
    } catch (error) {
      await logNotification({
        kind: 'cron_heartbeat',
        recipientEmail: 'system',
        subject: `${functionName}: crashed`,
        payload: { function: functionName, started_at: startedAt, fatal: error.message },
        status: 'error'
      });
      throw error;
    }
  };
}

module.exports = {
  logNotification,
  alreadyNotified,
  withCronHeartbeat,
  quietRunNeedsBeacon
};
