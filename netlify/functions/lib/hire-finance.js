// What Finance needs about a signed hire, in the email itself, so nobody opens
// Colony to copy a bank account across (7 Oct 2026). Shared by the
// Papersign completion (papersign-webhook) and the by-hand path (hire-notify
// 'signed'), which used to send two different emails, neither with the details.
function financeRows(hire, terms = {}) {
  const salaried = (hire.hire_type || 'full-time') === 'full-time';
  const money = (n, cur = 'INR') => (n == null || n === '' ? null : `${cur} ${Number(n).toLocaleString('en-IN')}`);
  return [
    ['Full name', hire.full_name],
    ['Type', hire.hire_type],
    ['Designation', terms.designation],
    ['Start date', hire.start_date],
    salaried ? ['CTC (annual)', money(terms.ctc_annual, terms.ctc_currency || 'INR')] : ['Monthly fee', money(terms.monthly_fee)],
    ['Contract ends', terms.contract_end_date || 'Ongoing'],
    ['PAN', hire.pan],
    ['Current address', hire.address],
    ['Permanent address', hire.permanent_address],
    ['Phone', hire.phone],
    ['Personal email', hire.personal_email],
    ['Work email', hire.work_email || (hire.workspace_not_needed ? 'none (not needed)' : 'not created yet')],
    ['Bank account name', hire.bank_account_name],
    ['Bank account number', hire.bank_account_number],
    ['IFSC', hire.bank_ifsc],
    ...(salaried ? [['Tax regime', hire.tax_regime]] : [])
  ];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function financeTableHtml(rows) {
  return `<table style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `
    <tr><td style="padding:3px 14px 3px 0;color:#666;vertical-align:top">${escapeHtml(k)}</td>
    <td style="padding:3px 0">${v && String(v).trim() ? escapeHtml(String(v)) : '<em style="color:#b23">missing</em>'}</td></tr>`).join('')}</table>`;
}

function financeTableText(rows) {
  return rows.map(([k, v]) => `${k}: ${v && String(v).trim() ? v : '(missing)'}`).join('\n');
}

module.exports = { financeRows, financeTableHtml, financeTableText };
