// Probation (3 Nov 2026) — pure logic, no Supabase, no mail.
//
// The employment agreement puts every full-time hire on probation for three
// months from the date of joining, confirmed in writing at the end. Colony
// tells the hiring manager REMIND_DAYS before it ends, once per hire and end
// date. Consultants and fractionals have no probation.

const { daysUntil } = require('./contract-end');

const PROBATION_MONTHS = 3;
const REMIND_DAYS = 15;

// "Three (03) months commencing from the Date of Joining": joined 9 Sep, the
// last day of probation is 8 Dec. A short month clamps (joined 30 Nov, last
// day 28 Feb).
function probationEnd(startIso) {
  const [y, m, d] = String(startIso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const lastOfTarget = new Date(Date.UTC(y, m - 1 + PROBATION_MONTHS + 1, 0)).getUTCDate();
  const same = new Date(Date.UTC(y, m - 1 + PROBATION_MONTHS, Math.min(d, lastOfTarget)));
  if (d > lastOfTarget) return same.toISOString().slice(0, 10);
  return new Date(same.getTime() - 86400000).toISOString().slice(0, 10);
}

function reminderKey(hireId, endIso) { return `${hireId}|${endIso}`; }

// Only signed hires are on probation; a cancelled or unsigned one is not.
const ON_PROBATION_STAGES = new Set(['signed', 'payroll_done']);

// rows: [{ hire_id, full_name, hire_type, stage, start_date }]
function probationDue(rows, todayIso, sentKeys = new Set()) {
  return (rows || []).filter((r) => {
    if (r.hire_type !== 'full-time' || !ON_PROBATION_STAGES.has(r.stage) || !r.start_date) return false;
    const end = probationEnd(r.start_date);
    if (!end) return false;
    const left = daysUntil(end, todayIso);
    return left >= 0 && left <= REMIND_DAYS && !sentKeys.has(reminderKey(r.hire_id, end));
  });
}

module.exports = { probationEnd, probationDue, reminderKey, REMIND_DAYS, PROBATION_MONTHS };
