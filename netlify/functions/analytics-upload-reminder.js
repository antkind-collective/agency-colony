const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { formatDateInIST, formatDateTimeInIST, getConfig, zonedParts, IST_TIME_ZONE } = require('./lib/config');

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

  const summary = {
    runAtIst: runLabel,
    analyticsRemindersSent: 0,
    retainerClients: 0,
    clientsPending: 0,
    errors: []
  };

  // Per-CLIENT staleness, retainer engagements only: a retainer client is
  // "pending" when it has no analytics upload since Monday 00:00 IST. Each
  // pending client is reported to its account owner; project/pitch clients
  // don't have a weekly-report expectation and are never nagged about.
  // Agency clock: "this reporting week" is one shared week, not per-person.
  // No hand-rolled offset here on purpose — applying one to mondayIst is
  // exactly the bug that made the freshness cutoff a day early (see below).
  const nowIst = zonedParts(runAt, IST_TIME_ZONE);
  const [istYear, istMonth, istDayOfMonth] = nowIst.iso.split('-').map(Number);
  const daysSinceMonday = (nowIst.day + 6) % 7;
  const mondayIst = Date.UTC(istYear, istMonth - 1, istDayOfMonth - daysSinceMonday);

  const [clientsRes, uploadsRes] = await Promise.all([
    supabase
      .from('clients')
      .select(`
        id, name,
        account_owner:employees!clients_account_owner_employee_id_fkey ( id, full_name, email, is_active ),
        projects!inner ( engagement_type )
      `)
      .eq('is_active', true)
      .eq('projects.engagement_type', 'retainer'),
    supabase
      .from('client_analytics')
      .select('client_id, uploaded_at, data_through')
  ]);

  if (clientsRes.error || uploadsRes.error) {
    // Without the client list there is nothing sensible to send; surface the
    // failure via the heartbeat (Scheduled Jobs Health) instead of guessing.
    const msg = clientsRes.error?.message || uploadsRes.error?.message;
    return { statusCode: 500, body: JSON.stringify({ ...summary, errors: [`Retainer staleness check failed: ${msg}`] }) };
  }

  // Staleness = what the DATA covers (data_through, computed from report
  // contents), never the upload-click timestamp — uploaded_at lies both ways
  // (frozen stamps under fresh data: Example Materials Jul 2026; fresh re-upload of an old
  // file). uploaded_at only as fallback for rows predating the column.
  const coverageByClient = new Map();
  (uploadsRes.data || []).forEach((u) => {
    const cov = u.data_through || String(u.uploaded_at || '').slice(0, 10);
    if (!cov) return;
    const prev = coverageByClient.get(u.client_id);
    if (!prev || cov > prev) coverageByClient.set(u.client_id, cov);
  });

  const retainers = clientsRes.data || [];
  summary.retainerClients = retainers.length;

  const weeksAgoLabel = (isoDate) => {
    if (!isoDate) return 'no analytics data yet';
    const weeks = Math.floor((runAt - new Date(isoDate + 'T00:00:00Z')) / (7 * 24 * 60 * 60 * 1000));
    const when = formatDateInIST(new Date(isoDate + 'T00:00:00Z'));
    return weeks < 1 ? `data through ${when}` : `data through ${when} (${weeks} week${weeks === 1 ? '' : 's'} ago)`;
  };

  // Group pending clients by owner. Clients with no active owner fall back to
  // Nadia (AM lead) so nothing goes unwatched.
  const FALLBACK_OWNER_EMAIL = 'am-lead@youragency.com';
  const byOwner = new Map();
  // Fresh = the data covers LAST week: coverage end on/after the previous
  // Monday. (A Monday upload of last week's report has data_through around
  // Sat/Sun — that must count as fresh, so we compare against weekStart - 7d.)
  // mondayIst is already a FLOATING date pinned to 00:00 UTC (built with
  // Date.UTC from IST y/m/d parts), so it must not be offset again. The old
  // version subtracted IST_OFFSET_MS a second time before slicing the UTC date,
  // which walked the cutoff back an extra day — for the week of Mon 13 Jul it
  // yielded 05 Jul instead of 06 Jul. The bug was LENIENT (a client whose data
  // ended the Sunday before last week still counted as fresh), so correcting it
  // can only ever ADD reminders. Checked against live coverage before changing
  // it: no client sits in the one-day gap, so no owner is newly nagged today.
  const prevMondayIso = new Date(mondayIst - 7 * 86400000).toISOString().slice(0, 10);
  for (const client of retainers) {
    const coverage = coverageByClient.get(client.id) || null;
    if (coverage && coverage >= prevMondayIso) continue; // covers last week
    summary.clientsPending += 1;

    const owner = client.account_owner;
    const ownerOk = owner && owner.is_active && owner.email;
    const key = ownerOk ? owner.email.toLowerCase() : FALLBACK_OWNER_EMAIL;
    if (!byOwner.has(key)) {
      byOwner.set(key, {
        email: ownerOk ? owner.email : FALLBACK_OWNER_EMAIL,
        firstName: ownerOk ? (owner.full_name || 'there').split(' ')[0] : 'Nadia',
        employeeId: ownerOk ? owner.id : null,
        clients: []
      });
    }
    byOwner.get(key).clients.push({
      name: client.name,
      staleness: weeksAgoLabel(coverage),
      unassigned: !ownerOk
    });
  }

  const base = appBaseUrl.endsWith('/') ? appBaseUrl : `${appBaseUrl}/`;

  for (const recipient of byOwner.values()) {
    const firstName = recipient.firstName;
    const n = recipient.clients.length;
    const subject = `${firstName}, ${n === 1 ? 'a client is' : `${n} clients are`} waiting on analytics 🐜`;

    const clientRowsHtml = recipient.clients.map(c => `
        <li style="margin:0 0 6px"><strong>${escapeHtml(c.name)}</strong>${c.unassigned ? ' (no account owner set)' : ''} <span style="color:#9b948f">· ${escapeHtml(c.staleness)}</span></li>`).join('');
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;max-width:540px;color:#403f3a">
        <p style="font-size:15px;margin:0 0 6px">Hi ${escapeHtml(firstName)}, it's Tuesday. 🐜</p>
        <p style="text-align:center;margin:6px 0"><img src="${base}assets/analytics-ant.png" alt="A worker ant hauling a bar chart" style="width:100%;max-width:380px" /></p>
        <p style="font-size:14px;margin:4px 0 10px">This little one has been hauling last week's analytics around since the weekend, hard hat on, chart held high. Monday came and went. He checked his list this morning, and these retainer clients are still waiting on their reports:</p>
        <ul style="font-size:14px;margin:0 0 14px;padding-left:20px">${clientRowsHtml}
        </ul>
        <p style="font-size:14px;margin:0 0 18px">Two minutes per client does it: open the analytics tab and upload the latest reports. Then he can finally set the chart down.</p>
        <p style="margin:0 0 18px"><a href="${base}#client-projects" style="display:inline-block;padding:11px 22px;background:#bca4b6;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px">Open clients →</a></p>
        <p style="color:#9b948f;font-size:12px;border-top:1px solid #f0ece1;padding-top:12px;margin:14px 0 0">You only get this on Tuesdays when one of your retainer clients is missing last week's reports. Upload by Monday and the data ant never bothers you at all. 🐜</p>
      </div>
    `;
    const text = [
      `Hi ${firstName}, it's Tuesday.`,
      '',
      'These retainer clients are still waiting on last week\'s analytics:',
      ...recipient.clients.map(c => `- ${c.name}${c.unassigned ? ' (no account owner set)' : ''}: ${c.staleness}`),
      '',
      'Two minutes per client does it: open the analytics tab and upload the latest reports.',
      '',
      `Open clients: ${base}#client-projects`,
      '',
      "You only get this on Tuesdays when one of your retainer clients is missing last week's reports."
    ].join('\n');

    try {
      const emailResult = await sendEmail({ to: recipient.email, subject, html, text });

      await logNotification({
        kind: 'analytics_upload_reminder',
        recipientEmail: recipient.email,
        subject,
        payload: {
          employee_id: recipient.employeeId,
          pending_clients: recipient.clients.map(c => c.name),
          sent_for_date: formatDateInIST(runAt)
        },
        status: emailResult.skipped ? 'skipped' : 'sent'
      });

      if (!emailResult.skipped) {
        summary.analyticsRemindersSent += 1;
      }
    } catch (err) {
      summary.errors.push(`Analytics reminder failed for ${recipient.email}: ${err.message}`);
    }
  }

  return {
    statusCode: summary.errors.length ? 207 : 200,
    body: JSON.stringify(summary)
  };
};

exports.handler = withCronHeartbeat('analytics-upload-reminder', run);
