// Papersign, the pure parts: what goes into a draft, who signs, and how to
// read a completion. No network. Tested without Papersign.
//
// Variable KEYS are defined by the template in Papersign and must match these
// names exactly — that is the whole contract between the two systems.
const VARIABLE_KEYS = ['hire_name', 'start_date', 'notice_period_days', 'compensation', 'compensation_label', 'scope_of_work', 'designation', 'current_address', 'permanent_address', 'pan'];

function inr(n) { return `₹${Number(n).toLocaleString('en-IN')}`; }
function prettyDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Everything the agreement needs, from the hire and its offer terms. Missing
// values are an error, not a blank in a contract.
function buildVariables(hire, terms) {
  const salaried = (hire.hire_type || 'full-time') === 'full-time';
  const comp = salaried ? terms.ctc_annual : terms.monthly_fee;
  const missing = [];
  if (!hire.full_name) missing.push('name');
  if (!hire.start_date) missing.push('start date');
  if (![30, 60].includes(Number(terms.notice_period_days))) missing.push('notice period');
  if (!comp) missing.push(salaried ? 'CTC' : 'monthly fee');
  if (!terms.scope_of_work) missing.push('scope of work');
  if (missing.length) throw new Error(`Cannot draft the agreement yet — missing ${missing.join(', ')}.`);
  const vars = {
    hire_name: hire.full_name,
    start_date: prettyDate(hire.start_date),
    notice_period_days: String(terms.notice_period_days),
    compensation: salaried ? `${inr(comp)} per annum` : `${inr(comp)} per month`,
    compensation_label: salaried ? 'Cost to Company (annual)' : 'Monthly fee',
    scope_of_work: terms.scope_of_work,
    designation: terms.designation || '',
    current_address: hire.address || '',
    permanent_address: hire.permanent_address || '',
    pan: hire.pan || ''
  };
  return Object.entries(vars).map(([key, value]) => ({ key, value }));
}

function signersFor(hire, template, agencySigner) {
  if (!template?.signer_hire_key || !template?.signer_agency_key) throw new Error('Template is missing its signer keys.');
  return [
    { key: template.signer_hire_key, name: hire.full_name, email: hire.personal_email },
    { key: template.signer_agency_key, name: agencySigner.name, email: agencySigner.email }
  ];
}

function draftName(hire) {
  const kind = (hire.hire_type || 'full-time') === 'full-time' ? 'Employment' : 'Consultant';
  const d = new Date();
  const stamp = `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${d.getUTCFullYear()}`;
  return `Your Agency ${hire.full_name} ${kind} Agreement ${stamp}`;
}

// Papersign's webhook payload shape is not documented; read defensively and
// accept only a completion that names a document we can look up.
function readCompletion(payload) {
  const p = payload || {};
  const doc = p.document || p.data?.document || p.data || p;
  const id = doc?.id || p.document_id || p.id;
  const event = String(p.event || p.type || p.trigger || doc?.status || '').toLowerCase();
  const completed = /complet/.test(event);
  const url = doc?.completed_document_url || p.completed_document_url || p.download_url || null;
  return { id: id ? String(id) : null, completed, url };
}

module.exports = { VARIABLE_KEYS, buildVariables, signersFor, draftName, readCompletion, prettyDate };
