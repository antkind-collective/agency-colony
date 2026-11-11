// Ticks a joiner's Slack chip when Slack says they're in #youragency-all and
// #youragency-random (7 Oct 2026). Hourly; judgement in lib/joiner-slack.js.
// Read-only Slack app: SLACK_BOT_TOKEN with users:read, users:read.email and
// channels:read. Without the token it does nothing (and says so in its
// heartbeat) — it never fails loudly before Slack is connected.
// DRY RUN: ?dry=1.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { withCronHeartbeat, logNotification } = require('./lib/notifications');
const { CHANNELS, hiresToCheck, hiresToInvite, slackInviteEmail, inAllChannels } = require('./lib/joiner-slack');
const { sendEmail } = require('./lib/email');
const { DEFAULTS: WELCOME } = require('./lib/hire-welcome');
const { hireEmailCc } = require('./lib/hire-cc');
const { onboardingRows, onboardingCompleteEmail } = require('./lib/onboarding-complete');
const { getConfig } = require('./lib/config');

function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }

async function slack(token, method, params) {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  return data;
}

async function channelMembers(token, channelId) {
  const ids = new Set();
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const r = await slack(token, 'conversations.members', { channel: channelId, limit: '1000', ...(cursor ? { cursor } : {}) });
    if (!r.ok) throw new Error(`Slack conversations.members ${channelId}: ${r.error}`);
    (r.members || []).forEach((m) => ids.add(m));
    cursor = r.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }
  return ids;
}

async function sendOnboardingComplete(supabase, h) {
  const terms = (Array.isArray(h.offer) ? h.offer[0] : h.offer) || {};
  const [histRes, empRes] = await Promise.all([
    supabase.from('hire_stage_history').select('stage, entered_at').eq('hire_id', h.id),
    supabase.from('employees').select('created_at').eq('email', String(h.work_email || '').trim().toLowerCase()).maybeSingle()
  ]);
  const stageAt = {};
  (histRes.data || []).forEach((r) => { if (!stageAt[r.stage] || r.entered_at > stageAt[r.stage]) stageAt[r.stage] = r.entered_at; });
  const rows = onboardingRows(h, terms, stageAt, empRes.data?.created_at || null);
  const link = `${getConfig().appBaseUrl}?open=hire:${h.id}#hiring`;
  const mail = onboardingCompleteEmail(h, rows, link);
  const manager = String(terms.hiring_manager_email || '').trim().toLowerCase();
  const to = manager || 'admin@youragency.com';
  const cc = to === 'admin@youragency.com' ? [] : ['admin@youragency.com'];
  const r = await sendEmail({ to, cc, subject: mail.subject, html: mail.html, text: mail.text, audience: 'team' });
  await logNotification({ kind: 'hire_notify', recipientEmail: to, subject: mail.subject, status: r.skipped ? 'skipped' : 'sent', payload: { hire_id: h.id, event: 'onboarding_complete' } });
}

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const summary = { dryRun, quiet: true, invited: [], checked: 0, joined: 0, planned: [], errors: [] };
  const supabase = getSupabaseAdmin();
  const [hiresRes, cfgRes] = await Promise.all([
    supabase.from('hires').select('*, offer:hire_offer_terms(hiring_manager_email, papersign_completed_at)').is('slack_joined_at', null).not('activated_at', 'is', null).limit(500),
    supabase.from('app_config').select('value').eq('key', 'joiner_slack_channels').maybeSingle()
  ]);
  if (hiresRes.error) { summary.errors.push(hiresRes.error.message); return json(500, summary); }

  // The invite goes out once their Colony access is on (8 Oct 2026). It needs
  // no Slack token: youragency.slack.com takes any @youragency.com address.
  const hireCc = await hireEmailCc(supabase);
  for (const h of hiresToInvite(hiresRes.data || [])) {
    summary.quiet = false;
    summary.invited.push(h.full_name);
    if (dryRun) continue;
    const mail = slackInviteEmail(h, WELCOME);
    try {
      // Their hiring manager is copied too (9 Oct 2026).
      const manager = String((Array.isArray(h.offer) ? h.offer[0] : h.offer)?.hiring_manager_email || '').trim().toLowerCase();
      const cc = [...new Set([...hireCc, manager].filter(Boolean))].filter((e) => e !== String(h.work_email).toLowerCase());
      const r = await sendEmail({ to: h.work_email, cc, subject: mail.subject, html: mail.html, text: mail.text, audience: 'team' });
      await supabase.from('hires').update({ slack_invited_at: new Date().toISOString() }).eq('id', h.id);
      await logNotification({ kind: 'hire_welcome', recipientEmail: h.work_email, subject: mail.subject, status: r.skipped ? 'skipped' : 'sent', payload: { hire_id: h.id, slack_invite: true } });
    } catch (e) { summary.errors.push(`${h.full_name} (invite): ${e.message}`); }
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { summary.skipped = 'SLACK_BOT_TOKEN not set'; return json(200, summary); }
  const due = hiresToCheck(hiresRes.data || []);
  summary.checked = due.length;
  if (!due.length) return json(200, summary);

  const channels = Array.isArray(cfgRes.data?.value) && cfgRes.data.value.length ? cfgRes.data.value : CHANNELS;
  let memberSets;
  try { memberSets = await Promise.all(channels.map((c) => channelMembers(token, c.id))); }
  catch (e) { summary.errors.push(e.message); return json(500, summary); }

  for (const h of due) {
    const r = await slack(token, 'users.lookupByEmail', { email: h.work_email });
    if (!r.ok) {
      if (r.error !== 'users_not_found') summary.errors.push(`${h.full_name}: ${r.error}`);
      continue; // not on Slack yet
    }
    if (!inAllChannels(r.user?.id, memberSets)) continue;
    summary.quiet = false;
    summary.planned.push({ joined: h.full_name });
    if (dryRun) continue;
    const joinedAt = new Date().toISOString();
    const { data: marked } = await supabase.from('hires').update({ slack_joined_at: joinedAt }).eq('id', h.id).is('slack_joined_at', null).select('id');
    summary.joined += 1;
    // Joining Slack is the last step: tell the hiring manager (Alex copied)
    // that onboarding is complete, with every step and its day (9 Oct
    // 2026). Only on the run that marks it, so it is sent once.
    if (marked?.length) {
      try { await sendOnboardingComplete(supabase, { ...h, slack_joined_at: joinedAt }); }
      catch (e) { summary.errors.push(`${h.full_name} (onboarding complete): ${e.message}`); }
    }
  }
  return json(200, summary);
}

exports.handler = withCronHeartbeat('joiner-slack', handler);
