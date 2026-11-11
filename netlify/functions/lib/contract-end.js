// Fixed-term contracts (6 Oct 2026) — pure logic, no Supabase, no mail.
//
// A fractional or consultant hire may have a contract end date
// (hire_offer_terms.contract_end_date; NULL = ongoing). REMIND_DAYS before it,
// the setup approvers get one email: renew, extend, or let it end. Nothing is
// switched off automatically. Keyed (hire, end date) so changing the date
// earns a fresh reminder and a re-run never repeats one.

const REMIND_DAYS = 30;
const DAY_MS = 86400000;

function daysUntil(endIso, todayIso) {
  return Math.round((Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / DAY_MS);
}

function reminderKey(hireId, endIso) { return `${hireId}|${endIso}`; }

// rows: [{ hire_id, full_name, hire_type, stage, contract_end_date }]
function contractEndDue(rows, todayIso, sentKeys = new Set()) {
  return (rows || []).filter((r) => {
    if (!r.contract_end_date || r.stage === 'cancelled' || r.hire_type === 'full-time') return false;
    const end = String(r.contract_end_date).slice(0, 10);
    const left = daysUntil(end, todayIso);
    return left >= 0 && left <= REMIND_DAYS && !sentKeys.has(reminderKey(r.hire_id, end));
  });
}

module.exports = { contractEndDue, reminderKey, daysUntil, REMIND_DAYS };
