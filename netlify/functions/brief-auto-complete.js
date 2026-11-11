// Close delivered briefs the client has not answered in 7 days (30 Sep 2026).
//
// Silence counts as approval: after AUTO_COMPLETE_DAYS a delivered brief moves
// to completed. No email to anyone (Mara: keep emails to a minimum; only a
// revision request emails Your Agency). The status-history trigger records the
// move like any other. Judgement lives in lib/brief-auto-complete.js.
//
// DRY RUN: ?dry=1 lists what would close; nothing is written.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { withCronHeartbeat } = require('./lib/notifications');
const { autoCompleteDue, AUTO_COMPLETE_DAYS } = require('./lib/brief-auto-complete');

function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const summary = { dryRun, quiet: true, days: AUTO_COMPLETE_DAYS, considered: 0, completed: 0, planned: [], errors: [] };
  const supabase = getSupabaseAdmin();

  const [briefRes, histRes] = await Promise.all([
    supabase.from('briefs').select('id, title, org, status, paused_at').eq('status', 'delivered').is('archived_at', null).limit(2000),
    supabase.from('brief_status_history').select('brief_id, entered_at').eq('status', 'delivered').is('exited_at', null).limit(5000)
  ]);
  for (const r of [briefRes, histRes]) {
    if (r.error) { summary.errors.push(r.error.message); return json(500, summary); }
  }
  const deliveredAt = new Map();
  for (const h of histRes.data || []) {
    const prev = deliveredAt.get(h.brief_id);
    if (!prev || h.entered_at > prev) deliveredAt.set(h.brief_id, h.entered_at);
  }
  summary.considered = (briefRes.data || []).length;
  const due = autoCompleteDue(briefRes.data || [], deliveredAt, new Date().toISOString());
  if (due.length) summary.quiet = false;

  for (const b of due) {
    summary.planned.push({ title: b.title, org: b.org, deliveredAt: deliveredAt.get(b.id) });
    if (dryRun) continue;
    // Guard the status in the update too: the client may have answered a moment ago.
    const { data, error } = await supabase.from('briefs').update({ status: 'completed' })
      .eq('id', b.id).eq('status', 'delivered').select('id');
    if (error) summary.errors.push(`${b.title}: ${error.message}`);
    else if (data?.length) summary.completed += 1;
  }
  return json(200, summary);
}

exports.handler = withCronHeartbeat('brief-auto-complete', handler);
