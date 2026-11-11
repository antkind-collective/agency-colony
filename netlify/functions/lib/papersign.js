// Papersign, the pure parts: what goes into a draft, who signs, and how to
// read a completion. No network. Tested without Papersign.
//
// Variable KEYS are defined by the template in Papersign and must match these
// names exactly — that is the whole contract between the two systems.
//
// The employment agreement's placeholders map to these keys:
//   [EMPLOYEE NAME] hire_name · [PAN] pan · [PERMANENT ADDRESS] permanent_address
//   [CURRENT ADDRESS] current_address · [DESIGNATION] designation
//   [DEPARTMENT] department · [DATE OF JOINING] start_date
//   [CTC AMOUNT] ctc_amount · [CTC IN WORDS] ctc_words
//   [NOTICE PERIOD] notice_period_days · [NOTICE PERIOD IN WORDS] notice_period_words
//   [SCOPE OF SERVICES] scope_of_work · [CTC BREAKUP] ctc_breakup_1 … _10
//
// Papersign drops line breaks inside a variable (checked in its preview,
// 25 Sep 2026), so the breakup cannot travel as one multi-line value. It goes
// as ten numbered lines, one per component with the total last; the template
// stacks ten chips under Annexure B and unused ones print blank.
//
// The consultant and freelancer agreements (23 Sep 2026) use:
//   [CONSULTANT NAME] / [FREELANCER NAME] hire_name · [PAN] pan
//   [ADDRESS] current_address · [EMAIL] hire_email · [START DATE] start_date
//   [FEE AMOUNT] fee_amount · [FEE IN WORDS] fee_words
//   [END DATE] end_date — fixed-term only, blank when ongoing (6 Oct 2026)
//   [TERM] contract_term — "until 14 March 2027" or "on an ongoing basis"
//   [NOTICE PERIOD] notice_period_days · [NOTICE PERIOD IN WORDS] notice_period_words
//   (Leo's 02 Nov 2026 templates, live in Papersign 3 Nov: Annexure A reads
//   "shall continue to remain in force [TERM], unless terminated earlier …")
//   [SCOPE OF SERVICES] scope_of_work · [DESIGNATION] designation
// They print their own "Rs." and "(Rupees … only)", so they take the bare
// figure and the words, exactly as the employment agreement does for CTC.
// compensation / compensation_label remain for a template that wants one
// phrase ("₹60,000 per month").
const BREAKUP_LINES = 10;
const BREAKUP_LINE_KEYS = Array.from({ length: BREAKUP_LINES }, (_, i) => `ctc_breakup_${i + 1}`);
// The last line is always the total, so this many components fit.
const MAX_BREAKUP_COMPONENTS = BREAKUP_LINES - 1;
const VARIABLE_KEYS = ['hire_name', 'hire_email', 'start_date', 'notice_period_days', 'notice_period_words', 'compensation', 'compensation_label', 'ctc_amount', 'ctc_words', 'ctc_breakup', ...BREAKUP_LINE_KEYS, 'fee_amount', 'fee_words', 'scope_of_work', 'designation', 'department', 'current_address', 'permanent_address', 'pan', 'end_date', 'contract_term'];

function inr(n) { return `₹${Number(n).toLocaleString('en-IN')}`; }
// Bare Indian grouping, for templates that print their own "Rs.": 15,00,000.
function amount(n) { return Number(n).toLocaleString('en-IN'); }

// Whole rupees in Indian words: 1550000 -> "Fifteen Lakh Fifty Thousand".
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function under100(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`; }
function under1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? under100(r) : ''].filter(Boolean).join(' ');
}
function indianWords(value) {
  let n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return '';
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${under100(lakh)} Lakh`);
  if (thousand) parts.push(`${under100(thousand)} Thousand`);
  if (n) parts.push(under1000(n));
  return parts.join(' ');
}

// The breakup as Finance entered it, cleaned: named components with a
// positive amount. Anything else is dropped rather than printed.
function breakupRows(breakup) {
  return (Array.isArray(breakup) ? breakup : [])
    .map(r => ({ component: String(r?.component || '').trim(), annual: Math.round(Number(r?.annual)) }))
    .filter(r => r.component && Number.isFinite(r.annual) && r.annual > 0);
}
function breakupTotal(breakup) { return breakupRows(breakup).reduce((t, r) => t + r.annual, 0); }
function breakupLines(breakup) {
  const rows = breakupRows(breakup);
  const lines = rows.map(r => `${r.component}: Rs. ${amount(r.annual)} per annum`);
  lines.push(`Total (CTC): Rs. ${amount(breakupTotal(rows))} per annum`);
  return lines;
}
function breakupText(breakup) { return breakupLines(breakup).join('\n'); }
function prettyDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Everything the agreement needs, from the hire and its offer terms. Missing
// values are an error, not a blank in a contract.
function noticeChoices(hireType) {
  return (hireType || 'full-time') === 'full-time' ? [30, 60] : [7, 30, 60];
}

function buildVariables(hire, terms) {
  const salaried = (hire.hire_type || 'full-time') === 'full-time';
  const comp = salaried ? terms.ctc_annual : terms.monthly_fee;
  const missing = [];
  if (!hire.full_name) missing.push('name');
  if (!hire.start_date) missing.push('start date');
  // Every contract has a notice period, fixed term included: a fixed term ends
  // on its date with no notice, and 4.2's notice is for ending it early
  // (3 Nov 2026; replaces the 30 Oct "no notice for fixed term").
  const fixedTerm = !salaried && Boolean(terms.contract_end_date);
  // 7 days is for consultants and fractionals, not employees (31 Oct 2026).
  const hasNotice = noticeChoices(hire.hire_type).includes(Number(terms.notice_period_days));
  if (!hasNotice) missing.push('notice period');
  if (!comp) missing.push(salaried ? 'CTC' : 'monthly fee');
  if (!terms.scope_of_work) missing.push('scope of work');
  // Both consultant templates print the PAN and address in the parties
  // clause. Neither prints a designation any more — Leo took that line off
  // the consultant's signature block on 23 Sep 2026.
  if (!salaried) {
    if (!hire.pan) missing.push('PAN');
    if (!hire.address) missing.push('address');
  }
  // The employment agreement prints all of these; a consultant's does not.
  if (salaried) {
    if (!terms.designation) missing.push('designation');
    if (!terms.department) missing.push('department');
    if (!hire.pan) missing.push('PAN');
    if (!hire.address) missing.push('address');
    if (!breakupRows(terms.ctc_breakup).length) missing.push('CTC breakup');
  }
  if (salaried && breakupRows(terms.ctc_breakup).length > MAX_BREAKUP_COMPONENTS) {
    throw new Error(`Cannot draft the agreement yet — the CTC breakup has more than ${MAX_BREAKUP_COMPONENTS} components; Annexure B fits ${MAX_BREAKUP_COMPONENTS} plus the total.`);
  }
  if (missing.length) throw new Error(`Cannot draft the agreement yet — missing ${missing.join(', ')}.`);
  if (salaried && breakupTotal(terms.ctc_breakup) !== Math.round(Number(comp))) {
    throw new Error(`Cannot draft the agreement yet — the CTC breakup adds up to ${inr(breakupTotal(terms.ctc_breakup))}, not the CTC of ${inr(comp)}.`);
  }
  const notice = Number(terms.notice_period_days);
  const vars = {
    hire_name: hire.full_name,
    // The notice block writes to the person, not to their Your Agency account:
    // a consultant may not have one, and the agreement predates it anyway.
    hire_email: hire.personal_email || '',
    start_date: prettyDate(hire.start_date),
    // Fixed-term fractional/consultant contracts (6 Oct 2026); empty = ongoing.
    // A template only gets it once it has an [END DATE] variable — until then
    // mapVariablesToTemplate drops it.
    end_date: !salaried && terms.contract_end_date ? prettyDate(terms.contract_end_date) : '',
    // Annexure A, "shall continue to remain in force [TERM]" (3 Nov 2026).
    contract_term: salaried ? '' : fixedTerm ? `until ${prettyDate(terms.contract_end_date)}` : 'on an ongoing basis',
    notice_period_days: hasNotice ? String(notice) : '',
    notice_period_words: hasNotice ? ({ 7: 'seven', 30: 'thirty', 60: 'sixty' })[notice] : '',
    compensation: salaried ? `${inr(comp)} per annum` : `${inr(comp)} per month`,
    compensation_label: salaried ? 'Cost to Company (annual)' : 'Monthly fee',
    ctc_amount: salaried ? amount(comp) : '',
    ctc_words: salaried ? indianWords(comp) : '',
    ctc_breakup: salaried ? breakupText(terms.ctc_breakup) : '',
    ...Object.fromEntries(BREAKUP_LINE_KEYS.map((k, i) => [k, salaried ? (breakupLines(terms.ctc_breakup)[i] || '') : ''])),
    fee_amount: salaried ? '' : amount(comp),
    fee_words: salaried ? '' : indianWords(comp),
    scope_of_work: terms.scope_of_work,
    designation: terms.designation || '',
    department: terms.department || '',
    current_address: hire.address || '',
    // "Same as current" on the details form leaves permanent_address empty.
    permanent_address: hire.permanent_address || hire.address || '',
    pan: hire.pan || ''
  };
  return Object.entries(vars).map(([key, value]) => ({ key, value }));
}

// Papersign matches a variable by its own generated key ("3at3oyb"), not by
// the name typed in the editor ("hire_name") — its create-draft docs mark the
// key as the identifier (seen 25 Sep 2026). Colony speaks in names, so the
// draft reads the template's variables and translates. Names the template
// does not use are dropped (a consultant template has no ctc_amount); a name
// the template uses twice is refused rather than filled at random.
function mapVariablesToTemplate(variables, templateVariables) {
  const byName = new Map();
  for (const tv of Array.isArray(templateVariables) ? templateVariables : []) {
    const name = String(tv?.name || '').trim();
    if (!name || !tv?.key) continue;
    if (byName.has(name)) throw new Error(`The Papersign template has two variables named "${name}".`);
    byName.set(name, String(tv.key));
  }
  if (!byName.size) throw new Error('The Papersign template has no named variables.');
  if (!byName.has('hire_name')) throw new Error('The Papersign template has no hire_name variable — is this the right template?');
  // buildVariables refuses a missing notice period; this is the last line of
  // defence: never send a contract with a blank in its notice clause.
  if (variables.some((v) => /^notice_period_/.test(v.key) && v.value === '' && byName.has(v.key))) {
    throw new Error('This agreement prints a notice period, but none is set for this hire. Set one in Offer terms.');
  }
  // The pre-November contractor templates print a fixed "30 days" with no
  // notice variable, so any other notice would be silently signed as 30
  // (30 Oct 2026). Leo's 02 Nov templates carry the variable, so this only
  // guards an old template put back in app_config.
  const notice = variables.find((v) => v.key === 'notice_period_days')?.value;
  if (notice && notice !== '30' && !byName.has('notice_period_days') && !byName.has('notice_period_words')) {
    throw new Error(`This agreement template prints a fixed 30-day notice period, not ${notice} days. Ask Leo to add the notice-period variable to the template in Papersign, or set 30 days in Offer terms.`);
  }
  return variables.filter(v => byName.has(v.key)).map(v => ({ key: byName.get(v.key), value: v.value }));
}

function signersFor(hire, template, agencySigner) {
  if (!template?.signer_hire_key || !template?.signer_agency_key) throw new Error('Template is missing its signer keys.');
  return [
    { key: template.signer_hire_key, name: hire.full_name, email: hire.personal_email },
    { key: template.signer_agency_key, name: agencySigner.name, email: agencySigner.email }
  ];
}

function draftName(hire) {
  // Named after the agreement it is: since Leo's 02 Nov 2026 templates a
  // fractional hire signs the Fractional Consultant Agreement.
  const kind = { 'full-time': 'Employment', consultant: 'Consultant', fractional: 'Fractional Consultant' }[hire.hire_type || 'full-time'] || 'Consultant';
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

module.exports = { VARIABLE_KEYS, MAX_BREAKUP_COMPONENTS, mapVariablesToTemplate, buildVariables, indianWords, breakupRows, breakupTotal, signersFor, draftName, readCompletion, prettyDate };
