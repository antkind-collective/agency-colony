// Daily: make sure every hire Colony made a @youragency.com account for is on
// all@youragency.com (21 Sep 2026).
//
// workspace-provision adds the account the moment it is created; this is the
// retry for the adds that failed there (the group scope not yet granted, or
// Google not having the brand-new user ready). It only ADDS hires Colony
// created. For everyone else it REPORTS: active employees whose address is not
// on the list are named in the heartbeat, and nobody is added or removed
// without a person deciding.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { withCronHeartbeat } = require('./lib/notifications');
const { googleAccessToken } = require('./lib/google-auth');
const { GROUP_MEMBER_SCOPE, allGroupAddress, addGroupMember, listGroupMembers } = require('./lib/workspace-groups');

async function handler(event) {
  // Only the scheduler's payload carries next_run (see scheduled-activation).
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return { statusCode: 403, body: JSON.stringify({ error: 'Scheduled function only' }) };

  const summary = { group: allGroupAddress(), added: [], alreadyMember: [], notOnList: [], errors: [] };
  if (!process.env.GOOGLE_SA_JSON || !process.env.GOOGLE_ADMIN_IMPERSONATE) {
    summary.quiet = true;
    summary.skipped = 'Google service account not configured';
    return { statusCode: 200, body: JSON.stringify(summary, null, 2) };
  }

  const supabase = getSupabaseAdmin();
  let access;
  try { access = await googleAccessToken(GROUP_MEMBER_SCOPE); } catch (e) {
    summary.errors.push(`Cannot manage ${summary.group}: ${e.message}. Grant ${GROUP_MEMBER_SCOPE} to the service account under Google Admin → Security → API controls → Domain-wide delegation.`);
    return { statusCode: 200, body: JSON.stringify(summary, null, 2) };
  }

  const { data: pending, error } = await supabase.from('hires')
    .select('id, full_name, work_email')
    .not('work_email', 'is', null).is('all_group_added_at', null).neq('stage', 'cancelled');
  if (error) { summary.errors.push(error.message); return { statusCode: 500, body: JSON.stringify(summary, null, 2) }; }

  for (const hire of pending || []) {
    const res = await addGroupMember(access, summary.group, hire.work_email);
    if (!res.ok) { summary.errors.push(`${hire.work_email}: ${res.error}`); continue; }
    await supabase.from('hires').update({ all_group_added_at: new Date().toISOString() }).eq('id', hire.id);
    (res.already ? summary.alreadyMember : summary.added).push(hire.work_email);
  }

  // Report only: active employees missing from the list, minus the accounts
  // that are not a person (app_config.all_group_exempt_emails).
  try {
    const members = new Set(await listGroupMembers(access, summary.group));
    const exemptRow = await supabase.from('app_config').select('value').eq('key', 'all_group_exempt_emails').maybeSingle();
    const exempt = new Set((Array.isArray(exemptRow.data?.value) ? exemptRow.data.value : []).map((e) => String(e).toLowerCase()));
    const { data: staff } = await supabase.from('employees').select('full_name, email').eq('is_active', true);
    summary.notOnList = (staff || [])
      .filter((e) => /@youragency\.com$/i.test(e.email || '')
        && !members.has(e.email.toLowerCase()) && !exempt.has(e.email.toLowerCase()))
      .map((e) => `${e.full_name} <${e.email}>`);
  } catch (e) { summary.errors.push(`Could not read ${summary.group}: ${e.message}`); }

  if (!summary.added.length && !summary.alreadyMember.length && !summary.notOnList.length && !summary.errors.length) summary.quiet = true;
  return { statusCode: 200, body: JSON.stringify(summary, null, 2) };
}

exports.handler = withCronHeartbeat('workspace-group-sync', handler);
