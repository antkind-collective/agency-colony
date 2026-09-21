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

  // Only send reminders from the 25th onwards
  if (dayOfMonth < 25) {
    summary.skippedBeforeDeadline = true;
    return {
      statusCode: 200,
      body: JSON.stringify(summary)
    };
  }

  // Determine invoice month: current month in YYYY-MM format (IST)
  const invoiceMonth = `${istYear}-${String(istMonth).padStart(2, '0')}`;

  // Only people who actually raise an invoice: fractional and consultant
  // (28 and 31 Aug 2026). A consultant is an employee in every other
  // respect — leave, nudges, client access — but is paid against an invoice.
  // The old rule keyed
  // off the DEPARTMENT leave flag, which only excludes Finance — so eleven
  // salaried staff and the studio@ service account were being chased monthly
  // for invoices they never submit.
  const employeesResponse = await supabase
    .from('employees')
    .select('id, full_name, email, is_active, employment_type, department:departments!employees_department_id_fkey(leave_tracking_enabled)')
    .eq('is_active', true)
    .in('employment_type', ['fractional', 'consultant'])
    .order('full_name', { ascending: true });

  if (employeesResponse.error) {
    summary.errors.push(`Employee query failed: ${employeesResponse.error.message}`);
    return { statusCode: 500, body: JSON.stringify(summary) };
  }

  // Finance still never invoices, and the exclusion list is honoured on top.
  const excluded = await configList(supabase, 'invoice_excluded_emails', INVOICE_EXCLUDED_EMAILS);
  const employees = (employeesResponse.data || []).filter(
    e => e.department?.leave_tracking_enabled !== false &&
      !excluded.includes((e.email || '').toLowerCase().trim())
  );

  // Get all invoice uploads for this month
  const invoicesResponse = await supabase
    .from('invoices')
    .select('employee_id')
    .eq('invoice_month', invoiceMonth);

  if (invoicesResponse.error) {
    summary.errors.push(`Invoice query failed: ${invoicesResponse.error.message}`);
    return { statusCode: 500, body: JSON.stringify(summary) };
  }

  const uploadedEmployeeIds = new Set(
    (invoicesResponse.data || []).map(row => row.employee_id)
  );

  const monthLabel = new Date(invoiceMonth + '-15').toLocaleDateString('en-IN', {
    month: 'long', year: 'numeric'
  });

  // Find employees who still need to upload
  const pendingEmployees = employees.filter(e => !uploadedEmployeeIds.has(e.id));

  // If all invoices received, notify Blake (only once — check notification log)
  if (pendingEmployees.length === 0) {
    summary.allInvoicesReceived = true;

    // Check if we already sent the completion email for this month
    const alreadySentResponse = await supabase
      .from('notification_log')
      .select('id')
      .eq('kind', 'invoice_all_received')
      .contains('payload', { invoice_month: invoiceMonth })
      .limit(1);

    const alreadySent = (alreadySentResponse.data || []).length > 0;

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
