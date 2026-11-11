// Month-end reimbursement reminder (5 Nov 2026). A reimbursement waits
// for the person's manager; nothing is emailed on upload (it shows in Colony).
// On the last day of the month, every manager with some still waiting gets one
// email listing them, with a link to the approvals on their own profile.
// Runs from daily-reminders before its weekend/holiday skip, so it goes on the
// last day even when that is a Sunday.

const escapeHtml = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// 'YYYY-MM-DD' (IST) → is it the month's last day? (30 Nov, 28/29 Feb, 31 Dec)
function isLastDayOfMonth(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return d === new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthLabel(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return `${MONTHS[m - 1] || ym} ${y}`;
}

// Pending rows → Map(approver email → { name, items }), skipping approvers
// with no address or who are no longer active.
function groupByApprover(rows, employeesById) {
  const out = new Map();
  for (const r of rows) {
    const approver = employeesById.get(r.approver_id);
    const email = String(approver?.email || '').trim().toLowerCase();
    if (!email || approver.is_active === false) continue;
    const entry = out.get(email) || { name: approver.full_name, items: [] };
    entry.items.push({ id: r.id, who: employeesById.get(r.employee_id)?.full_name || 'Someone', what: r.notes || r.file_name || 'Reimbursement', month: r.invoice_month });
    out.set(email, entry);
  }
  return out;
}

function reminderEmail({ name, items }, appBaseUrl) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const n = items.length;
  const subject = `${n} reimbursement${n > 1 ? 's' : ''} waiting for your approval`;
  const link = `${appBaseUrl}?open=reimbursements:waiting#employee-profile`;
  const lines = items.map((i) => `${i.who}: ${i.what} (${monthLabel(i.month)})`);
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6">
<p>Hi ${escapeHtml(first)},</p>
<p>${n === 1 ? 'This reimbursement is' : 'These reimbursements are'} still waiting for you. Finance sees in Colony which ones you've approved.</p>
<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
<p><a href="${link}">Approve or send back in Colony</a></p>
</div>`;
  const text = [`Hi ${first},`, `${n === 1 ? 'This reimbursement is' : 'These reimbursements are'} still waiting for you. Finance sees in Colony which ones you've approved.`, ...lines, `Approve or send back in Colony: ${link}`].join('\n\n');
  return { subject, html, text };
}

module.exports = { isLastDayOfMonth, monthLabel, groupByApprover, reminderEmail };
