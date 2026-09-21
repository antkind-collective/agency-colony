// 11:00 AM LOCAL weekday nudge — ONLY for active employees who haven't touched
// their tasks yet today (no daily_tasks row created/updated since their local
// midnight). Visiting Colony triggers carry-forward writes, and adding or
// updating any task counts — so engaged people never see this. People on
// leave today (approved, or started pending SL) are skipped, as is anyone with
// task_nudge_enabled = false.
//
// "Local" is per-person (employees.timezone), not a global IST midnight: this
// ran once a day at a fixed instant, so Anya in Tokyo was told "it's past 11
// and your tasklist hasn't heard from you" at 14:30 her time, about a window
// that shut mid-morning.
//
// Runs every 30 minutes (see netlify.toml) and emails whoever is currently at
// their local 11. Half-hourly, not hourly, because India is UTC+5:30 — an
// on-the-hour cron would never once land on 11:00 IST, i.e. it would never
// nudge anybody. Consequence: at a 30-minute cadence an IST employee satisfies
// `hour === 11` on TWO consecutive runs (11:00 and 11:30 local), so the
// already-sent-today guard below is what makes this once-a-day, not the cron.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { isHolidayInIst } = require('./lib/holidays');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { getConfig, zonedParts, zonedMidnightUtc } = require('./lib/config');

const NUDGE_HOUR = 11;

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const run = async (event) => {
  // Allow only Netlify-scheduler invocations (next_run guard — see CLAUDE.md)
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Scheduled function only' }) };
  }

  const runAt = new Date();
  const summary = { nudgesSent: 0, skippedTouched: 0, skippedOnLeave: 0, skippedAlreadySent: 0, cohort: 0, errors: [] };

  const supabase = getSupabaseAdmin();
  const { appBaseUrl } = getConfig();

  const [empRes, hiddenRes] = await Promise.all([
    supabase.from('employees').select('id, full_name, email, timezone')
      .eq('is_active', true).eq('task_nudge_enabled', true),
    supabase.from('app_config').select('value').eq('key', 'hidden_employee_emails').maybeSingle()
  ]);
  if (empRes.error) { summary.errors.push(empRes.error.message); return { statusCode: 500, body: JSON.stringify(summary) }; }

  const hidden = new Set(((hiddenRes.data && hiddenRes.data.value) || []).map((e) => String(e).toLowerCase()));

  // Your Agency is closed today (IST), so nobody is nudged about tasks (Alex,
  // 24 Aug 2026). Deliberately NOT an early return: the daily heartbeat below
  // still has to fire, or a holiday would look like a broken cron.
  const holiday = await isHolidayInIst(supabase, runAt);
  if (holiday) summary.skippedHoliday = holiday.name;

  // Whose local clock reads 11-something right now, on a weekday?
  const cohort = (holiday ? [] : (empRes.data || []))
    .filter((e) => !hidden.has(String(e.email).toLowerCase()))
    .map((e) => ({ employee: e, local: zonedParts(runAt, e.timezone) }))
    .filter(({ local }) => local.hour === NUDGE_HOUR && !local.isWeekend);

  summary.cohort = cohort.length;

  // One guaranteed heartbeat a day, at the 00:00 UTC slot, even though that run
  // is nobody's 11 AM. Without it a quiet run and a cron that was never
  // registered are indistinguishable — both write nothing — so a rejected
  // schedule would stay invisible until people noticed they'd silently stopped
  // being nudged. The beacon also covers weekends, when there is no cohort at
  // all, which keeps the Admin Settings health row honest on a 26h window.
  const isDailyBeacon = runAt.getUTCHours() === 0 && runAt.getUTCMinutes() < 30;

  // Nobody's 11 AM — the overwhelmingly common case at a 30-minute cadence.
  // Return `quiet` so no heartbeat is written: 48 rows a day would bury five
  // months of real notification_log signal inside a fortnight.
  if (!cohort.length && !isDailyBeacon) {
    return { statusCode: 200, body: JSON.stringify({ ...summary, quiet: true }) };
  }
  if (!cohort.length) {
    return { statusCode: 200, body: JSON.stringify({ ...summary, beacon: true }) };
  }

  // Per-person windows: each person's own local day, and the UTC instant their
  // local day began.
  const isoDates = [...new Set(cohort.map(({ local }) => local.iso))];
  const earliestMidnight = cohort
    .map(({ employee, local }) => zonedMidnightUtc(local.iso, employee.timezone))
    .sort()[0];

  const [touchedRes, leaveRes, sentRes] = await Promise.all([
    supabase.from('daily_tasks').select('employee_id, updated_at').gte('updated_at', earliestMidnight).limit(3000),
    supabase.from('leave_requests').select('employee_id, leave_type, status, start_date, end_date')
      .in('status', ['approved', 'pending'])
      .lte('start_date', isoDates[isoDates.length - 1]).gte('end_date', isoDates[0]),
    // The once-a-day guard. Two local days of history covers every zone offset.
    supabase.from('notification_log').select('payload')
      .eq('kind', 'daily_tasklist_reminder')
      .gte('created_at', new Date(runAt.getTime() - 48 * 60 * 60 * 1000).toISOString())
      .limit(3000)
  ]);
  for (const r of [touchedRes, leaveRes, sentRes]) {
    if (r.error) { summary.errors.push(r.error.message); return { statusCode: 500, body: JSON.stringify(summary) }; }
  }

  const alreadySent = new Set((sentRes.data || [])
    .map((n) => `${n.payload?.employee_id}|${n.payload?.sent_for_date}`));

  for (const { employee, local } of cohort) {
    const todayIso = local.iso;
    if (alreadySent.has(`${employee.id}|${todayIso}`)) { summary.skippedAlreadySent += 1; continue; }

    const midnightUtc = zonedMidnightUtc(todayIso, employee.timezone);
    const touched = (touchedRes.data || [])
      .some((t) => t.employee_id === employee.id && t.updated_at >= midnightUtc);
    if (touched) { summary.skippedTouched += 1; continue; }

    const onLeave = (leaveRes.data || []).some((l) => l.employee_id === employee.id
      && (l.status === 'approved' || l.leave_type === 'SL')
      && l.start_date <= todayIso && l.end_date >= todayIso);
    if (onLeave) { summary.skippedOnLeave += 1; continue; }

    const firstName = (employee.full_name || 'there').split(' ')[0];
    const subject = `${firstName}, Nadia is smiling at you 🙂`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:480px">
        <p>Good morning ${escapeHtml(firstName)}!</p>
        <p>It's past 11 and your Colony tasklist hasn't heard from you today.</p>
        <img src="${appBaseUrl.replace(/\/+$/, '')}/assets/analytics-ant.png" alt="An ant, waiting patiently" style="width:100%;max-width:420px;border-radius:12px;margin:8px 0" />
        <p>This ant is waiting <em>patiently</em>. It would love to keep it that way.</p>
        <p>Take two minutes, log your day: <a href="${appBaseUrl}#daily-tasklist">open My Work →</a></p>
        <p style="color:#888;font-size:12px">You get this only on days you haven't touched your tasks by 11 AM. Update them and Nadia's smile stays warm.</p>
      </div>
    `;
    const text = [
      `Good morning ${firstName}!`,
      "It's past 11 AM and your Colony tasklist hasn't heard from you today.",
      "Nadia is smiling politely. Keep it that way — take two minutes and log your day:",
      `${appBaseUrl}#daily-tasklist`
    ].join('\n');

    try {
      const emailResult = await sendEmail({ to: employee.email, subject, html, text });
      await logNotification({
        kind: 'daily_tasklist_reminder',
        recipientEmail: employee.email,
        subject,
        payload: { employee_id: employee.id, sent_for_date: todayIso, nudge: true, timezone: local.zone },
        status: emailResult.skipped ? 'skipped' : 'sent'
      });
      if (!emailResult.skipped) summary.nudgesSent += 1;
    } catch (error) {
      summary.errors.push(`Nudge failed for ${employee.email}: ${error.message}`);
    }
  }

  return { statusCode: summary.errors.length ? 207 : 200, body: JSON.stringify(summary) };
};

exports.handler = withCronHeartbeat('task-nudge', run);
