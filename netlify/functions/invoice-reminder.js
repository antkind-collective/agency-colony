const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { formatDateInIST, formatDateTimeInIST, getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');

// Fallback only — the live list lives in app_config.invoice_excluded_emails so
// Admin Settings can change it. The cron used to hardcode its own copy, which
// meant an exclusion added in the app was ignored here (28 Aug 2026).
const INVOICE_EXCLUDED_EMAILS = ['admin@youragency.com', 'studio@youragency.com'];

async function configList(supabase, key, fallback) {
  const { data, error } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle();
  const value = !error && Array.isArray(data?.value) ? data.value : fallback;
  return value.map((e) => String(e).toLowerCase().trim());
}

// Employees who still upload invoices but don't receive reminder emails
const INVOICE_REMINDER_SKIP_EMAILS = ['ops-lead@youragency.com', 'finance@youragency.com', 'am-lead@youragency.com'];

// Copied on every "please send your invoice" reminder (30 Sep 2026),
// so Finance sees who is being chased. app_config.invoice_reminder_cc_emails
// overrides this list from Admin Settings.
const INVOICE_REMINDER_CC_EMAILS = ['finance@youragency.com', 'ari@youragency.com'];

// Email to notify when all invoices are received
const INVOICE_COMPLETION_EMAIL = 'finance@youragency.com';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Who owes an invoice for `invoiceMonth` (YYYY-MM) and who has not uploaded.
// Only people who actually raise an invoice: fractional and consultant
// (28 and 31 Aug 2026). A consultant is an employee in every other
// respect — leave, nudges, client access — but is paid against an invoice.
// The old rule keyed off the DEPARTMENT leave flag, which only excludes
// Finance — so eleven salaried staff and the studio@ service account were
// being chased monthly for invoices they never submit.
async function invoiceStatusFor(supabase, invoiceMonth) {
  const employeesResponse = await supabase
    .from('employees')
    .select('id, full_name, email, is_active, employment_type, department:departments!employees_department_id_fkey(leave_tracking_enabled)')
    .eq('is_active', true)
    .in('employment_type', ['fractional', 'consultant'])
    .order('full_name', { ascending: true });
  if (employeesResponse.error) throw new Error(`Employee query failed: ${employeesResponse.error.message}`);

  // Finance still never invoices, and the exclusion list is honoured on top.
  const excluded = await configList(supabase, 'invoice_excluded_emails', INVOICE_EXCLUDED_EMAILS);
  const employees = (employeesResponse.data || []).filter(
    e => e.department?.leave_tracking_enabled !== false &&
      !excluded.includes((e.email || '').toLowerCase().trim())
  );

  const invoicesResponse = await supabase
    .from('invoices')
    .select('employee_id')
    .eq('invoice_month', invoiceMonth);
  if (invoicesResponse.error) throw new Error(`Invoice query failed: ${invoicesResponse.error.message}`);
  const uploadedEmployeeIds = new Set((invoicesResponse.data || []).map(row => row.employee_id));

  const monthLabel = new Date(invoiceMonth + '-15').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return { employees, pendingEmployees: employees.filter(e => !uploadedEmployeeIds.has(e.id)), monthLabel };
}

async function alreadyLogged(supabase, kind, invoiceMonth) {
  const { data } = await supabase.from('notification_log').select('id')
    .eq('kind', kind).contains('payload', { invoice_month: invoiceMonth }).limit(1);
  return (data || []).length > 0;
}

// Missed list (30 Sep 2026): on the 1st-3rd, Blake gets who did not
// upload last month's invoice. Reminders stop when the month turns, so
// without this nobody was told who missed the deadline. Days 1-3 rather than
// only the 1st so one failed run can't lose it; the log makes it once only.
// Nothing is sent when nobody missed (he already had "All invoices received").
async function sendMissedDigest(supabase, invoiceMonth, summary, appBaseUrl) {
  if (await alreadyLogged(supabase, 'invoice_missed_digest', invoiceMonth)) return;
  const { pendingEmployees, monthLabel } = await invoiceStatusFor(supabase, invoiceMonth);
  summary.missedLastMonth = pendingEmployees.map((e) => e.full_name);
  if (!pendingEmployees.length) return;
  const names = pendingEmployees.map((e) => e.full_name || e.email);
  const subject = `Invoices not received for ${monthLabel} (${names.length})`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <p>Hi Blake,</p>
      <p>These invoices for <strong>${escapeHtml(monthLabel)}</strong> were not uploaded by the end of the month:</p>
      <ul>${names.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
      <p>They were reminded daily from the 25th. Colony has stopped reminding them now that the month is over.</p>
      <p><a href="${appBaseUrl}#invoice-center">Open the invoice centre</a></p>
    </div>`;
  const text = [
    'Hi Blake,',
    `These invoices for ${monthLabel} were not uploaded by the end of the month:`,
    ...names.map((n) => `- ${n}`),
    'They were reminded daily from the 25th. Colony has stopped reminding them now that the month is over.',
    `${appBaseUrl}#invoice-center`
  ].join('\n');
  try {
    const emailResult = await sendEmail({ to: INVOICE_COMPLETION_EMAIL, subject, html, text });
    await logNotification({
      kind: 'invoice_missed_digest',
      recipientEmail: INVOICE_COMPLETION_EMAIL,
      subject,
      payload: { invoice_month: invoiceMonth, missed: pendingEmployees.map((e) => e.id) },
      status: emailResult.skipped ? 'skipped' : 'sent'
    });
    summary.missedDigestSent = !emailResult.skipped;
  } catch (error) {
    summary.errors.push(`Missed-invoice digest failed: ${error.message}`);
  }
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

  // Current day-of-month on the agency clock. Invoicing is an agency deadline
  // ("the 25th") — the same date for everyone regardless of where they are.
  const istNow = zonedParts(runAt, IST_TIME_ZONE);
  const [istYear, istMonth, dayOfMonth] = istNow.iso.split('-').map(Number);

  const summary = {
    runAtIst: runLabel,
    dayOfMonth,
    invoiceRemindersSent: 0,
    allInvoicesReceived: false,
    completionEmailSent: false,
    skippedBeforeDeadline: false,
    errors: []
  };

  if (dayOfMonth <= 3) {
    const prev = istMonth === 1 ? `${istYear - 1}-12` : `${istYear}-${String(istMonth - 1).padStart(2, '0')}`;
    try { await sendMissedDigest(supabase, prev, summary, appBaseUrl); }
    catch (error) { summary.errors.push(error.message); }
  }

  // Only send reminders from the 25th onwards
  if (dayOfMonth < 25) {
    summary.skippedBeforeDeadline = true;
    return {
      statusCode: summary.errors.length ? 207 : 200,
      body: JSON.stringify(summary)
    };
  }

  // Determine invoice month: current month in YYYY-MM format (IST)
  const invoiceMonth = `${istYear}-${String(istMonth).padStart(2, '0')}`;

  let status;
  try { status = await invoiceStatusFor(supabase, invoiceMonth); }
  catch (error) {
    summary.errors.push(error.message);
    return { statusCode: 500, body: JSON.stringify(summary) };
  }
  const { employees, pendingEmployees, monthLabel } = status;

  // If all invoices received, notify Blake (only once — check notification log)
  if (pendingEmployees.length === 0) {
    summary.allInvoicesReceived = true;

    // Once a month. This check could never succeed until invoice_all_received
    // was added to app.notification_kind (202609300001): the log insert failed.
    const alreadySent = await alreadyLogged(supabase, 'invoice_all_received', invoiceMonth);

    if (!alreadySent) {
      const subject = `All invoices received — ${monthLabel}`;
      const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.5">
          <p>Hi Blake,</p>
          <p>All team invoices for <strong>${escapeHtml(monthLabel)}</strong> have been uploaded.</p>
          <p>${employees.length} employee${employees.length !== 1 ? 's' : ''} submitted their invoices.</p>
          <p><a href="${appBaseUrl}#invoice-center">View in Invoice Center</a></p>
        </div>
      `;
      const text = [
        'Hi Blake,',
        `All team invoices for ${monthLabel} have been uploaded.`,
        `${employees.length} employees submitted their invoices.`,
        `View: ${appBaseUrl}#invoice-center`
      ].join('\n');

      try {
        const emailResult = await sendEmail({ to: INVOICE_COMPLETION_EMAIL, subject, html, text });

        await logNotification({
          kind: 'invoice_all_received',
          recipientEmail: INVOICE_COMPLETION_EMAIL,
          subject,
          payload: { invoice_month: invoiceMonth, employee_count: employees.length },
          status: emailResult.skipped ? 'skipped' : 'sent'
        });

        if (!emailResult.skipped) {
          summary.completionEmailSent = true;
        }
      } catch (error) {
        summary.errors.push(`Completion email failed: ${error.message}`);
      }
    }

    return {
      statusCode: summary.errors.length ? 207 : 200,
      body: JSON.stringify(summary)
    };
  }

  // Send reminders to employees who haven't uploaded yet (skip silenced ones)
  const reminderCc = await configList(supabase, 'invoice_reminder_cc_emails', INVOICE_REMINDER_CC_EMAILS);
  for (const employee of pendingEmployees) {
    if (INVOICE_REMINDER_SKIP_EMAILS.includes((employee.email || '').toLowerCase().trim())) continue;
    const subject = `Invoice reminder — ${monthLabel}`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <p>Hello ${escapeHtml(employee.full_name || 'there')},</p>
        <p>Your invoice for <strong>${escapeHtml(monthLabel)}</strong> hasn't been uploaded yet.</p>
        <p>Please upload it via your Employee Profile in Agency Colony before the end of this month.</p>
        <p><a href="${appBaseUrl}#employee-profile">Upload Invoice</a></p>
      </div>
    `;
    const text = [
      `Hello ${employee.full_name || 'there'},`,
      `Your invoice for ${monthLabel} hasn't been uploaded yet.`,
      'Please upload it via your Employee Profile in Agency Colony before the end of this month.',
      `Upload: ${appBaseUrl}#employee-profile`
    ].join('\n');

    try {
      const emailResult = await sendEmail({
        to: employee.email,
        cc: reminderCc.filter((e) => e !== (employee.email || '').toLowerCase().trim()),
        subject,
        html,
        text
      });

      await logNotification({
        kind: 'invoice_upload_reminder',
        recipientEmail: employee.email,
        subject,
        payload: {
          employee_id: employee.id,
          invoice_month: invoiceMonth,
          sent_for_date: formatDateInIST(runAt)
        },
        status: emailResult.skipped ? 'skipped' : 'sent'
      });

      if (!emailResult.skipped) {
        summary.invoiceRemindersSent += 1;
      }
    } catch (error) {
      summary.errors.push(`Invoice reminder failed for ${employee.email}: ${error.message}`);
    }
  }

  return {
    statusCode: summary.errors.length ? 207 : 200,
    body: JSON.stringify(summary)
  };
};

exports.handler = withCronHeartbeat('invoice-reminder', run);
