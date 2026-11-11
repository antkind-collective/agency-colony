const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { isHolidayInIst } = require('./lib/holidays');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { formatDateInIST, formatDateTimeInIST, getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');
const { planTaskRollover } = require('./lib/task-rollover');
const { birthdayRecipients } = require('./lib/birthdays');
const { isLastDayOfMonth, groupByApprover, reminderEmail } = require('./lib/reimbursement-reminder');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeEmails(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function toDateRange(startDate, endDate) {
  const start = formatDateInIST(startDate);
  const end = formatDateInIST(endDate);
  return start === end ? start : `${start} to ${end}`;
}

// Netlify sometimes starts this job a second time a few seconds after the
// first when a run is slow (most days since 4 Oct 2026). The task rollover
// was already safe to repeat; the emails were not, and Modeera's birthday
// went to everyone twice (4 Nov 2026). Each email now checks the log first.
async function sentToday(supabase, kind, recipientEmail, todayIso) {
  const { data, error } = await supabase.from('notification_log').select('id')
    .eq('kind', kind).eq('recipient_email', recipientEmail)
    .gte('created_at', `${todayIso}T00:00:00+05:30`).limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

const run = async (event) => {
  // Allow only Netlify-scheduler invocations. Scheduled functions ARE invoked
  // via HTTP POST under the hood, so checking event.httpMethod alone rejected
  // the scheduler itself (all crons silently dead 13 Apr - 10 Jun 2026). Only
  // the scheduler payload carries next_run.
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Scheduled function only' }) };
  }

  const runAt = new Date();
  const runLabel = formatDateTimeInIST(runAt);
  const { appBaseUrl } = getConfig();
  const supabase = getSupabaseAdmin();

  // Agency clock, deliberately: leave cycles and task rollover are data
  // operations on the agency's day, not any individual's (per-person clocks
  // would make "which day did this roll over on" unanswerable).
  // This was runAt.toISOString() — UTC — while every neighbouring line was IST.
  // The two agree only because the cron runs at 04:30 UTC (10:00 IST); any
  // schedule between 18:30 and 23:59 UTC would have silently rolled the wrong
  // day. Same value today, no longer a trap.
  const todayIso = zonedParts(runAt, IST_TIME_ZONE).iso;

  const summary = {
    runAtIst: runLabel,
    leaveCycleRowsProcessed: 0,
    dailyTasksRolledOver: 0,
    dailyTasksArchivedAsDuplicates: 0,
    dailyTasklistRemindersSent: 0,
    birthdayNotificationsSent: 0,
    skippedAlreadySent: 0,
    pendingLeaveDigestsSent: 0,
    reimbursementRemindersSent: 0,
    errors: []
  };

  try {
    const rolloverResult = await supabase.rpc('rollover_all_leave_cycles', {
      p_as_of_date: todayIso
    });
    if (rolloverResult.error) {
      summary.errors.push(`Leave cycle rollover failed: ${rolloverResult.error.message}`);
    } else {
      summary.leaveCycleRowsProcessed = Number(rolloverResult.data || 0);
    }
  } catch (error) {
    summary.errors.push(`Leave cycle rollover failed: ${error.message}`);
  }

  // Roll over unfinished daily tasks to today (lib/task-rollover.js, Q2 24 Sep
  // 2026). This used to be one UPDATE of every past row that wasn't 'done' —
  // archived rows included, so each run re-dated the task archive, and one
  // duplicate title on today aborted the whole batch (failing daily since
  // 8 Sep). Now: plan per person and title, archive the copies that would
  // duplicate, then move the rest one row at a time so a single clash (a
  // browser carrying the same task forward at this minute) can't sink the rest.
  try {
    const { data: pastRows, error: pastError } = await supabase
      .from('daily_tasks')
      .select('id, employee_id, task_title, task_date, status')
      .lt('task_date', todayIso)
      .in('status', ['pending', 'in_progress'])
      .limit(5000);
    if (pastError) throw pastError;
    const employeeIds = [...new Set((pastRows || []).map((r) => r.employee_id))];
    let todayActive = [];
    if (employeeIds.length) {
      const { data, error } = await supabase
        .from('daily_tasks')
        .select('employee_id, task_title')
        .eq('task_date', todayIso)
        .neq('status', 'archived')
        .in('employee_id', employeeIds);
      if (error) throw error;
      todayActive = data || [];
    }
    const plan = planTaskRollover(pastRows, todayActive, todayIso);
    const stamp = () => new Date().toISOString();
    if (plan.archive.length) {
      // Archived rows sit outside uniq_daily_tasks_active, so this cannot clash.
      const { error } = await supabase.from('daily_tasks')
        .update({ status: 'archived', updated_at: stamp() }).in('id', plan.archive);
      if (error) summary.errors.push(`Daily task rollover: archiving duplicates failed: ${error.message}`);
      else summary.dailyTasksArchivedAsDuplicates = plan.archive.length;
    }
    let moved = 0;
    for (const id of plan.move) {
      const { error } = await supabase.from('daily_tasks')
        .update({ task_date: todayIso, updated_at: stamp() }).eq('id', id);
      if (!error) { moved += 1; continue; }
      if (error.code === '23505') {
        // Someone's browser put this task on today since we looked: keep theirs.
        const { error: archiveError } = await supabase.from('daily_tasks')
          .update({ status: 'archived', updated_at: stamp() }).eq('id', id);
        if (archiveError) summary.errors.push(`Daily task rollover: ${id}: ${archiveError.message}`);
        else summary.dailyTasksArchivedAsDuplicates = (summary.dailyTasksArchivedAsDuplicates || 0) + 1;
      } else {
        summary.errors.push(`Daily task rollover: ${id}: ${error.message}`);
      }
    }
    summary.dailyTasksRolledOver = moved;
  } catch (error) {
    summary.errors.push(`Daily task rollover failed: ${error.message}`);
  }

  // Skip email notifications on weekends (IST = UTC+5:30) — data operations above still run
  // Spawn recurring tasks BEFORE the weekend skip — a rule's day can land on a
  // Saturday/Sunday and must still fire, and for a weekly rule the owner picked
  // that weekday deliberately. Title-key dedupe vs any non-archived task
  // already on today.
  try {
    const ist = zonedParts(runAt, IST_TIME_ZONE);
    const todayIso = ist.iso;
    const [istYear, istMonth, istDayOfMonth] = ist.iso.split('-').map(Number);
    const lastDay = new Date(Date.UTC(istYear, istMonth, 0)).getUTCDate();
    const rulesRes = await supabase.from('recurring_tasks').select('*').eq('is_active', true);
    // Weekly matches the IST weekday (0=Sunday, the same numbering zonedParts
    // returns and the DB stores); monthly clamps to the month's last day.
    const due = (rulesRes.data || []).filter((r) => (r.frequency === 'weekly'
      ? ist.day === r.day_of_week
      : istDayOfMonth === Math.min(r.day_of_month, lastDay)));
    if (due.length) {
      const existingRes = await supabase.from('daily_tasks').select('employee_id, task_title')
        .eq('task_date', todayIso).neq('status', 'archived').limit(3000);
      const seen = new Set((existingRes.data || []).map((t) => `${t.employee_id}|${String(t.task_title).toLowerCase().trim()}`));
      const inserts = due
        .filter((r) => !seen.has(`${r.employee_id}|${String(r.task_title).toLowerCase().trim()}`))
        .map((r) => ({ employee_id: r.employee_id, task_date: todayIso, task_title: r.task_title, notes: r.notes, description: r.description, status: 'in_progress', sort_order: 0, recurring_task_id: r.id }));
      if (inserts.length) {
        const ins = await supabase.from('daily_tasks').insert(inserts);
        if (ins.error) summary.errors.push(`Recurring spawn: ${ins.error.message}`);
        else summary.recurringSpawned = inserts.length;
      }
    }
  } catch (error) {
    summary.errors.push(`Recurring spawn failed: ${error.message}`);
  }

  // Last day of the month: managers with reimbursements still waiting get one
  // email each (lib/reimbursement-reminder.js). Before the weekend/holiday
  // skip on purpose: Alex asked for the month's last day, whatever day it is.
  if (isLastDayOfMonth(todayIso)) {
    try {
      const [pendingRes, peopleRes] = await Promise.all([
        supabase.from('invoices').select('id, employee_id, approver_id, invoice_month, notes, file_name')
          .eq('invoice_type', 'reimbursement').eq('approval_status', 'pending'),
        supabase.from('employees').select('id, full_name, email, is_active')
      ]);
      if (pendingRes.error) throw pendingRes.error;
      if (peopleRes.error) throw peopleRes.error;
      const byId = new Map((peopleRes.data || []).map((e) => [e.id, e]));
      for (const [email, group] of groupByApprover(pendingRes.data || [], byId)) {
        if (await sentToday(supabase, 'reimbursement_month_end', email, todayIso)) { summary.skippedAlreadySent += 1; continue; }
        const { subject, html, text } = reminderEmail(group, appBaseUrl);
        const result = await sendEmail({ to: email, subject, html, text });
        await logNotification({
          kind: 'reimbursement_month_end', recipientEmail: email, subject,
          payload: { invoice_ids: group.items.map((i) => i.id), sent_for_date: todayIso },
          status: result.skipped ? 'skipped' : 'sent'
        });
        if (!result.skipped) summary.reimbursementRemindersSent += 1;
      }
    } catch (error) {
      summary.errors.push(`Reimbursement reminder failed: ${error.message}`);
    }
  }

  // Was `new Date(runAt + 5.5h).getDay()` — the LOCAL weekday of a UTC-shifted
  // instant, which only equals the IST weekday because Netlify's runtime is
  // itself UTC. zonedParts asks the tz database instead of the host clock.
  const istDay = zonedParts(runAt, IST_TIME_ZONE).day;
  if (istDay === 0 || istDay === 6) {
    summary.skippedWeekend = true;
    return {
      statusCode: 200,
      body: JSON.stringify(summary)
    };
  }

  // Nobody wants a task nudge on Diwali. Data operations above have already run;
  // only the emails are held (24 Aug 2026).
  const holiday = await isHolidayInIst(supabase, runAt);
  if (holiday) {
    summary.skippedHoliday = holiday.name;
    return {
      statusCode: 200,
      body: JSON.stringify(summary)
    };
  }

  const activeEmployeesResponse = await supabase
    .from('employees')
    .select('id, full_name, email, is_active, date_of_birth, access_level, direct_manager_email')
    .eq('is_active', true)
    .order('full_name', { ascending: true });

  if (activeEmployeesResponse.error) {
    summary.errors.push(activeEmployeesResponse.error.message);
    return {
      statusCode: 500,
      body: JSON.stringify(summary)
    };
  }

  const activeEmployees = activeEmployeesResponse.data || [];

  // (The daily tasklist reminder moved to task-nudge.js — 11:00 IST, only
  // for people who have not touched their tasks that day.)

  // Birthdays: leadership plus the person's manager (lib/birthdays.js).
  const istToday = zonedParts(runAt, IST_TIME_ZONE);
  const [, bMonth, bDay] = istToday.iso.split('-').map(Number);
  const birthdayMail = birthdayRecipients(activeEmployees, bMonth, bDay);
  for (const [recipientEmail, people] of birthdayMail.entries()) {
    const names = people.map((emp) => emp.full_name).filter(Boolean);
    const nameList = names.length === 1
      ? escapeHtml(names[0])
      : names.slice(0, -1).map(escapeHtml).join(', ') + ' and ' + escapeHtml(names[names.length - 1]);
    const subject = `\u{1F382} Birthday today: ${names.join(', ')}`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <p>Hello,</p>
        <p>Today is <strong>${nameList}</strong>'s birthday! \u{1F389}</p>
        <p>Don't forget to wish them!</p>
        <p>Open app: <a href="${appBaseUrl}">${appBaseUrl}</a></p>
      </div>
    `;
    const text = [
      `Today is ${names.join(', ')}'s birthday!`,
      "Don't forget to wish them!",
      `Open app: ${appBaseUrl}`
    ].join('\n');
    try {
      if (await sentToday(supabase, 'birthday_notification', recipientEmail, todayIso)) { summary.skippedAlreadySent += 1; continue; }
      const emailResult = await sendEmail({ to: recipientEmail, subject, html, text });
      await logNotification({
        kind: 'birthday_notification',
        recipientEmail,
        subject,
        payload: { birthday_employee_names: names, sent_for_date: formatDateInIST(runAt) },
        status: emailResult.skipped ? 'skipped' : 'sent'
      });
      if (!emailResult.skipped) summary.birthdayNotificationsSent += 1;
    } catch (error) {
      summary.errors.push(`Birthday notification failed for ${recipientEmail}: ${error.message}`);
    }
  }

  // Pending leave digest (tracked departments only, finance excluded via leave_tracking_enabled).
  const pendingLeaveResponse = await supabase
    .from('leave_requests')
    .select('id, employee_id, leave_type, start_date, end_date, status, approver_emails')
    .eq('status', 'pending')
    .order('start_date', { ascending: true });

  if (pendingLeaveResponse.error) {
    summary.errors.push(pendingLeaveResponse.error.message);
  } else {
    const pendingLeaves = pendingLeaveResponse.data || [];
    const employeeIds = [...new Set(pendingLeaves.map((row) => row.employee_id).filter(Boolean))];

    let employeeMap = new Map();
    let departmentMap = new Map();

    if (employeeIds.length) {
      const leaveEmployeesResponse = await supabase
        .from('employees')
        .select('id, full_name, email, leave_tracking_enabled, department_id')
        .in('id', employeeIds);

      if (leaveEmployeesResponse.error) {
        summary.errors.push(leaveEmployeesResponse.error.message);
      } else {
        const rows = leaveEmployeesResponse.data || [];
        employeeMap = new Map(rows.map((row) => [row.id, row]));

        const departmentIds = [...new Set(rows.map((row) => row.department_id).filter(Boolean))];
        if (departmentIds.length) {
          const departmentsResponse = await supabase
            .from('departments')
            .select('id, name, leave_tracking_enabled')
            .in('id', departmentIds);

          if (departmentsResponse.error) {
            summary.errors.push(departmentsResponse.error.message);
          } else {
            departmentMap = new Map((departmentsResponse.data || []).map((row) => [row.id, row]));
          }
        }
      }
    }

    const digestByApprover = new Map();

    for (const leaveRow of pendingLeaves) {
      const employee = employeeMap.get(leaveRow.employee_id);
      if (!employee || employee.leave_tracking_enabled === false) {
        continue;
      }

      const department = departmentMap.get(employee.department_id);
      if (department && department.leave_tracking_enabled === false) {
        continue;
      }

      const approvers = normalizeEmails(leaveRow.approver_emails);
      for (const approverEmail of approvers) {
        const current = digestByApprover.get(approverEmail) || [];
        current.push({
          leaveId: leaveRow.id,
          employeeName: employee.full_name,
          leaveType: leaveRow.leave_type,
          dateRange: toDateRange(leaveRow.start_date, leaveRow.end_date)
        });
        digestByApprover.set(approverEmail, current);
      }
    }

    for (const [approverEmail, items] of digestByApprover.entries()) {
      if (!items.length) continue;

      const subject = `Pending leave digest (${items.length}) - ${formatDateInIST(runAt)}`;
      const listHtml = items
        .map(
          (item) =>
            `<li>${escapeHtml(item.employeeName)} | ${escapeHtml(item.leaveType)} | ${escapeHtml(item.dateRange)} | Request: ${escapeHtml(item.leaveId)}</li>`
        )
        .join('');
      const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.5">
          <p>Hello,</p>
          <p>You have ${items.length} pending leave request(s) awaiting action in Agency Colony.</p>
          <ul>${listHtml}</ul>
          <p><a href="${appBaseUrl}?open=approvals#leave-center">Open leave approvals</a></p>
        </div>
      `;
      const text = [
        `You have ${items.length} pending leave request(s) awaiting action in Agency Colony.`,
        ...items.map((item) => `${item.employeeName} | ${item.leaveType} | ${item.dateRange} | ${item.leaveId}`),
        `Open leave approvals: ${appBaseUrl}?open=approvals#leave-center`
      ].join('\n');

      try {
        if (await sentToday(supabase, 'pending_leave_digest', approverEmail, todayIso)) { summary.skippedAlreadySent += 1; continue; }
        const emailResult = await sendEmail({
          to: approverEmail,
          subject,
          html,
          text
        });

        await logNotification({
          kind: 'pending_leave_digest',
          recipientEmail: approverEmail,
          subject,
          payload: {
            pending_leave_ids: items.map((item) => item.leaveId),
            pending_count: items.length,
            sent_for_date: formatDateInIST(runAt)
          },
          status: emailResult.skipped ? 'skipped' : 'sent'
        });

        if (!emailResult.skipped) {
          summary.pendingLeaveDigestsSent += 1;
        }
      } catch (error) {
        summary.errors.push(`Pending digest failed for ${approverEmail}: ${error.message}`);
      }
    }
  }

  return {
    statusCode: summary.errors.length ? 207 : 200,
    body: JSON.stringify(summary)
  };
};

exports.handler = withCronHeartbeat('daily-reminders', run);
