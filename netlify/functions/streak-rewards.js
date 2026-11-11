// Grant streak rewards (27 Sep 2026): a half-day off every 50 streak
// days, 90 days to use it.
//
// Runs each working morning. For every active employee it computes the streak
// exactly as the home page does (lib/streak-rewards.js, parity-tested against
// js/streaks.js), grants any 50-rung this unbroken streak has reached and not
// yet been given, then emails:
//   * the earner — congratulations, how to take it, the use-by date;
//   * their leave approver(s) — an FYI only: the half-day will reach them as an
//     ordinary leave request, so there is nothing to do until it arrives.
// The home feed celebrates it from the same row (no email to anyone else).
//
// Granting is the ONLY write to app.streak_rewards; nobody signed in can write
// it. Idempotent: the (employee, milestone, streak_started_on) unique key means
// a re-run, or a missed day caught up later, never grants twice.
//
// DRY RUN: ?dry=1 lists who WOULD be rewarded and emailed; nothing is written.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');
const { isReminderRunDay, shiftIso } = require('./lib/brief-reminders');
const { computeStreak, rewardsDue, rewardExpiry, REWARD_VALID_DAYS } = require('./lib/streak-rewards');

const HIDDEN_EMPLOYEE_EMAILS = ['finance@youragency.com']; // mirrors js/config.js

function escapeHtml(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function prettyDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function firstName(full) { return String(full || '').trim().split(/\s+/)[0] || 'there'; }
function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const summary = { dryRun, quiet: dryRun, ran: false, considered: 0, granted: 0, emailed: 0, planned: [], errors: [] };
  const supabase = getSupabaseAdmin();

  const { data: holRows, error: holErr } = await supabase.from('public_holidays').select('holiday_date');
  if (holErr) { summary.errors.push(`holidays: ${holErr.message}`); return json(500, summary); }
  const holidays = (holRows || []).map((h) => String(h.holiday_date).slice(0, 10));
  // A dry run may evaluate another day (?dry=1&today=YYYY-MM-DD) to rehearse
  // what a given morning would grant. A real run always uses today.
  const asOf = event?.queryStringParameters?.today;
  const todayIso = (dryRun && /^\d{4}-\d{2}-\d{2}$/.test(asOf || '')) ? asOf : zonedParts(new Date(), IST_TIME_ZONE).iso;
  summary.today = todayIso;
  if (!isReminderRunDay(todayIso, holidays)) { summary.skippedNonWorkingDay = true; return json(200, summary); }
  summary.ran = true;

  // 420 days covers the longest streak computeStreak will walk (400 counted).
  const since = shiftIso(todayIso, -420);
  const [empRes, actRes, leaveRes, grantedRes, cfgRes, freezeRes] = await Promise.all([
    supabase.from('employees').select('id, full_name, email, approver_emails, leave_tracking_enabled, is_active').eq('is_active', true),
    supabase.from('task_activity').select('employee_id, activity_date').gte('activity_date', since).limit(100000),
    supabase.from('leave_requests').select('employee_id, start_date, end_date').eq('status', 'approved').gte('end_date', since).limit(20000),
    supabase.from('streak_rewards').select('employee_id, milestone, streak_started_on').limit(20000),
    supabase.from('app_config').select('value').eq('key', 'hidden_employee_emails').maybeSingle(),
    // Freezes people chose to use (from 1 Oct 2026); same input as the home page.
    supabase.from('streak_freezes').select('employee_id, missed_on').gte('missed_on', since).limit(20000)
  ]);
  for (const r of [empRes, actRes, leaveRes, grantedRes, freezeRes]) {
    if (r.error) { summary.errors.push(r.error.message); return json(500, summary); }
  }
  const hidden = (Array.isArray(cfgRes.data?.value) ? cfgRes.data.value : HIDDEN_EMPLOYEE_EMAILS).map((e) => String(e).toLowerCase());

  const active = new Map();
  for (const r of actRes.data || []) {
    if (!active.has(r.employee_id)) active.set(r.employee_id, new Set());
    active.get(r.employee_id).add(String(r.activity_date).slice(0, 10));
  }
  // Approved leave, expanded to days, exactly as the home page does.
  const leave = new Map();
  for (const r of leaveRes.data || []) {
    if (!leave.has(r.employee_id)) leave.set(r.employee_id, new Set());
    const set = leave.get(r.employee_id);
    let d = String(r.start_date).slice(0, 10);
    const end = String(r.end_date).slice(0, 10);
    for (let i = 0; i < 60 && d <= end; i++) { set.add(d); d = shiftIso(d, 1); }
  }
  const freezes = new Map();
  for (const r of freezeRes.data || []) {
    if (!freezes.has(r.employee_id)) freezes.set(r.employee_id, new Set());
    freezes.get(r.employee_id).add(String(r.missed_on).slice(0, 10));
  }
  const grantedBy = new Map();
  for (const g of grantedRes.data || []) {
    if (!grantedBy.has(g.employee_id)) grantedBy.set(g.employee_id, []);
    grantedBy.get(g.employee_id).push(g);
  }
  const { appBaseUrl } = getConfig();
  const expiresOn = rewardExpiry(todayIso);

  for (const emp of empRes.data || []) {
    const email = String(emp.email || '').toLowerCase();
    if (hidden.includes(email)) continue;
    // No leave workflow (Finance): a half-day they could never request is not a reward.
    if (emp.leave_tracking_enabled === false) continue;
    summary.considered += 1;
    const streak = computeStreak(active.get(emp.id) || new Set(), todayIso, holidays, leave.get(emp.id) || new Set(), freezes.get(emp.id) || new Set());
    const due = rewardsDue(streak, grantedBy.get(emp.id) || []);
    if (!due.length) continue;

    const approvers = (emp.approver_emails || []).map((e) => String(e).toLowerCase()).filter((e) => e && e !== email);
    for (const milestone of due) {
      summary.planned.push({ employee: emp.full_name, milestone, streak: streak.count, startedOn: streak.startedOn, expiresOn, approvers });
      if (dryRun) continue;

      const { error: insErr } = await supabase.from('streak_rewards').insert({
        employee_id: emp.id, milestone, streak_started_on: streak.startedOn, earned_on: todayIso, expires_on: expiresOn
      });
      if (insErr) {
        // 23505: already granted by a parallel run. Anything else is a real failure.
        if (insErr.code !== '23505') summary.errors.push(`grant ${emp.full_name} ${milestone}: ${insErr.message}`);
        continue;
      }
      summary.granted += 1;

      const leaveLink = `${appBaseUrl}#leave-center`;
      const name = firstName(emp.full_name);
      try {
        await sendEmail({
          to: [email],
          subject: `${milestone} days in a row — you've earned a half-day off`,
          html: `<div style="font-family:Arial,sans-serif;line-height:1.6">
            <p>Hi ${escapeHtml(name)},</p>
            <p>You've kept your Colony streak going for <strong>${milestone} working days</strong>. That earns you a <strong>half-day off</strong>.</p>
            <p>To take it, open <a href="${escapeHtml(leaveLink)}">My Leave</a>, choose <strong>Streak reward</strong> as the leave type, pick a date and tick Half day. It goes to your usual approver like any leave.</p>
            <p>Use it by <strong>${escapeHtml(prettyDate(expiresOn))}</strong> (${REWARD_VALID_DAYS} days). Another one comes every 50 days you keep the streak.</p>
          </div>`,
          text: `Hi ${name},\nYou've kept your Colony streak going for ${milestone} working days, which earns you a half-day off.\nTake it from My Leave: choose "Streak reward", pick a date, tick Half day. Use it by ${prettyDate(expiresOn)}.\n${leaveLink}\n`,
          audience: 'team'
        });
        await logNotification({ kind: 'streak_reward_earned', recipientEmail: email, subject: `Streak reward: ${milestone} days`,
          payload: { employee_id: emp.id, milestone, streak_started_on: streak.startedOn, expires_on: expiresOn } });
        summary.emailed += 1;
      } catch (err) { summary.errors.push(`email ${emp.full_name}: ${err.message}`); }

      if (approvers.length) {
        try {
          await sendEmail({
            to: approvers,
            subject: `FYI: ${emp.full_name} earned a streak half-day`,
            html: `<div style="font-family:Arial,sans-serif;line-height:1.6">
              <p>Hi,</p>
              <p>${escapeHtml(emp.full_name)} has kept their Colony streak going for <strong>${milestone} working days</strong> and has earned a half-day off.</p>
              <p>Nothing to do now. When they want it, it will reach you as an ordinary leave request (type: Streak reward), valid until ${escapeHtml(prettyDate(expiresOn))}.</p>
            </div>`,
            text: `${emp.full_name} has kept their Colony streak going for ${milestone} working days and earned a half-day off. Nothing to do now: it will reach you as an ordinary leave request (Streak reward), valid until ${prettyDate(expiresOn)}.\n`,
            audience: 'team'
          });
          await logNotification({ kind: 'streak_reward_manager_fyi', recipientEmail: approvers.join(', '), subject: `FYI: ${emp.full_name} streak reward`,
            payload: { employee_id: emp.id, milestone } });
        } catch (err) { summary.errors.push(`FYI for ${emp.full_name}: ${err.message}`); }
      }
    }
  }
  return json(200, summary);
}

exports.handler = withCronHeartbeat('streak-rewards', handler);
