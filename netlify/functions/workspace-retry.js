// Every six hours: create the @youragency.com accounts Google refused for want of
// a licence (7 Oct 2026). Someone has already said yes in Colony and
// the reseller was asked for the seat; this just tries again until it is
// there, so nobody has to watch for the reply. It never emails the reseller,
// and skips anyone marked as not needing an account (4 Nov 2026). Goes through workspace-provision
// itself (authenticated with the webhook key, as papersign-webhook does), so
// the account, the all@ add and the sign-in email are made exactly one way.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { withCronHeartbeat } = require('./lib/notifications');
const { getConfig } = require('./lib/config');
const { internalFunctionKey } = require('./lib/workspace-provision');

function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }

async function handler(event) {
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const summary = { quiet: true, waiting: 0, created: [], stillWaiting: [], errors: [] };
  const key = internalFunctionKey();
  if (!key) { summary.skipped = 'SUPABASE_SERVICE_ROLE_KEY not set'; return json(200, summary); }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from('hires')
    .select('id, full_name, stage')
    .not('workspace_licence_requested_at', 'is', null)
    .is('work_email', null)
    .eq('workspace_not_needed', false)
    .in('stage', ['signed', 'payroll_done']);
  if (error) { summary.errors.push(error.message); return json(500, summary); }
  summary.waiting = (data || []).length;
  if (!summary.waiting) return json(200, summary);

  const { appBaseUrl } = getConfig();
  for (const h of data) {
    const res = await fetch(`${appBaseUrl}/api/workspace-provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ hireId: h.id, autoAddress: true })
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok || res.status === 207) { summary.quiet = false; summary.created.push({ name: h.full_name, workEmail: out.workEmail }); }
    else if (out.licence) summary.stillWaiting.push(h.full_name);
    else summary.errors.push(`${h.full_name}: ${out.error || res.status}`);
  }
  return json(200, summary);
}

exports.handler = withCronHeartbeat('workspace-retry', handler);
