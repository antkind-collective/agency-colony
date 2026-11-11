const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');

// Scheduled function: runs weekly via Netlify cron
// Checks policy_documents for reminder_month matching the current month
// If the policy hasn't been updated this month, sends a reminder to admin

const escapeHtml = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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

  const supabase = getSupabaseAdmin();
  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1-12

  const { data: policies, error } = await supabase
    .from('policy_documents')
    .select('*')
    .eq('reminder_month', currentMonth);

  if (error) {
    console.error('policy-update-reminder: Failed to load policies:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  if (!policies?.length) {
    return { statusCode: 200, body: JSON.stringify({ message: 'No policies due for reminder this month.' }) };
  }

  const recipients = ['admin@youragency.com', 'am-lead@youragency.com'];
  let sentCount = 0;

  for (const policy of policies) {
    // Check if already updated this month
    const updatedAt = new Date(policy.updated_at);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    if (updatedAt >= startOfMonth) {
      console.log(`policy-update-reminder: "${policy.title}" already updated this month, skipping.`);
      continue;
    }

    const updatedDate = updatedAt.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
    const subject = `Reminder: Review "${policy.title}"`;
    const html = `<p>The <strong>${escapeHtml(policy.title)}</strong> was last updated on ${updatedDate}.</p><p>Please review and update it for the coming year.</p><p><a href="https://app.youragency.com/#admin-settings">Open Admin Settings</a></p>`;
    const text = `The ${policy.title} was last updated on ${updatedDate}. Please review and update it. https://app.youragency.com/#admin-settings`;

    try {
      const emailResult = await sendEmail({ to: recipients, subject, html, text });

      await Promise.all(recipients.map(recipientEmail =>
        logNotification({
          kind: 'policy_update_reminder',
          recipientEmail,
          subject,
          payload: { policyKey: policy.policy_key, policyTitle: policy.title },
          status: emailResult.skipped ? 'skipped' : 'sent'
        })
      ));
      sentCount++;
    } catch (err) {
      console.error(`policy-update-reminder: Failed to send for "${policy.title}":`, err);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: `Sent ${sentCount} reminder(s).` })
  };
};

exports.handler = withCronHeartbeat('policy-update-reminder', run);
