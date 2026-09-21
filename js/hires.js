// Hiring pipeline pure logic (New-hire process — approved by email 24 Jul 2026).
// Stage flow, per-stage owners, candidate detail validation. No DOM, no
// Supabase — unit-testable in the vm harness.

const HIRE_STAGES = ['invited', 'details_submitted', 'contract_uploaded', 'reviewed', 'signed', 'payroll_done'];

const HIRE_STAGE_LABEL = {
  invited: 'Waiting on candidate',
  details_submitted: 'Contract needed',
  contract_uploaded: 'Review needed',
  reviewed: 'Awaiting signature',
  signed: 'Payroll pending',
  payroll_done: 'Complete',
  cancelled: 'Cancelled'
};

// Same vocabulary as employees — see EMPLOYMENT_TYPE_LABEL in js/config.js.
const HIRE_TYPE_LABEL = EMPLOYMENT_TYPE_LABEL;

// Sanctioned transitions (cancel allowed from any live stage by approvers).
const HIRE_TRANSITIONS = {
  invited: ['details_submitted', 'cancelled'],
  details_submitted: ['contract_uploaded', 'cancelled'],
  contract_uploaded: ['reviewed', 'details_submitted', 'cancelled'],
  reviewed: ['signed', 'contract_uploaded', 'cancelled'],
  signed: ['payroll_done', 'cancelled'],
  payroll_done: [],
  cancelled: []
};

function isValidHireTransition(fromStage, toStage) {
  return Array.isArray(HIRE_TRANSITIONS[fromStage]) && HIRE_TRANSITIONS[fromStage].includes(toStage);
}

// Whose turn is it? Emails resolve via config lists at the call site; this
// returns a semantic owner key.
const HIRE_STAGE_OWNER = {
  invited: 'candidate',
  details_submitted: 'legal',      // Leo uploads the contract
  contract_uploaded: 'approver',   // Nadia reviews
  reviewed: 'signer',              // Alex signs
  signed: 'finance',               // Blake starts payroll
  payroll_done: null,
  cancelled: null
};

// Candidate detail form — required fields. Salary slips are files OR the
// explicit "I did not have salary slips" checkbox (11 Aug 2026 — some
// candidates never had slips); the note is optional context either way.
// The caller passes hasSlips (any file uploaded or already stored).
const HIRE_DETAIL_FIELDS = [
  { key: 'full_name', label: 'Full name' },
  { key: 'date_of_birth', label: 'Date of birth' },
  // Needed to request their @youragency.com account from the Workspace reseller,
  // who is sent Name / Email / Recovery email / Phone (8 Sep 2026).
  { key: 'phone', label: 'Mobile number' },
  { key: 'pan', label: 'PAN' },
  { key: 'address', label: 'Current address' },
  // Legal needs both addresses on the employment agreement (24 Aug 2026).
  { key: 'permanent_address', label: 'Permanent address' },
  { key: 'bank_account_name', label: 'Account holder name' },
  { key: 'bank_account_number', label: 'Account number' },
  { key: 'bank_ifsc', label: 'IFSC code' },
  // Asked of the candidate, not just the creator (24 Aug 2026): payroll
  // needs the month and the contract needs the date, and the person holding
  // the offer letter is the one who actually knows it.
  { key: 'start_date', label: 'Start date' }
];

function hireMissingDetails(details, hasSlips) {
  const missing = HIRE_DETAIL_FIELDS.filter(({ key }) => {
    const v = details?.[key];
    return v === null || v === undefined || String(v).trim() === '';
  });
  if (!hasSlips && details?.no_salary_slips !== true) {
    missing.push({ key: 'salary_slips', label: 'Salary slips (or tick "I did not have salary slips")' });
  }
  if (details?.full_name && String(details.full_name).trim().split(/\s+/).length < 2) {
    missing.push({ key: 'full_name_words', label: 'Full name — first and last' });
  }
  // Blake (5 Aug): regime is mandatory; Old regime needs HRA/80C/80D declarations.
  if (!['old', 'new'].includes(details?.tax_regime)) {
    missing.push({ key: 'tax_regime', label: 'Income tax regime (Old or New)' });
  } else if (details.tax_regime === 'old' && !String(details?.tax_declarations_note || '').trim()) {
    missing.push({ key: 'tax_declarations', label: 'HRA / 80C / 80D declarations (needed for the Old regime)' });
  }
  return missing;
}

// Indian fiscal year starts 1 April. Salary slips must cover FY start → now.
function fiscalYearStartLabel(todayIso) {
  const d = todayIso ? new Date(todayIso + 'T00:00:00') : new Date();
  const year = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `1 April ${year}`;
}

function isValidPan(pan) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(pan || '').trim().toUpperCase());
}

function isValidIfsc(ifsc) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(ifsc || '').trim().toUpperCase());
}

// ── Skipping a stage that happened outside Colony (8 Sep 2026) ──────
// Real case: a contract signed offline means "upload draft" and "review" are
// never going to happen in the app, and without a way past them the record
// sits at the wrong stage forever.
//
// One stage at a time, always forwards, and only along a transition that was
// already legal — skipping must not become a way to reach a state the normal
// flow forbids.
function nextHireStage(stage) {
  const i = HIRE_STAGES.indexOf(stage);
  if (i === -1 || i >= HIRE_STAGES.length - 1) return null;
  const next = HIRE_STAGES[i + 1];
  return isValidHireTransition(stage, next) ? next : null;
}

function canSkipHireStage(stage) {
  return Boolean(nextHireStage(stage));
}

// A skipped stage was never completed here. Read alongside the current stage,
// which on its own would imply everything before it was done in Colony.
function hireStageWasSkipped(hire, stage) {
  return Array.isArray(hire?.skipped_stages) && hire.skipped_stages.includes(stage);
}

function skippedHireStageLabels(hire) {
  return (hire?.skipped_stages || []).map((s) => HIRE_STAGE_LABEL[s] || s);
}

// ── The @youragency.com account (8 Sep 2026) ───────────────────────────
// Payroll being done is NOT the end of a hire. Nothing turns a hire into an
// employee: the employee row appears only when the person first signs in with
// their work address, which cannot happen until the Workspace reseller creates
// it. That request used to live in one inbox, so a hire read "complete" while
// the real next step had not been taken.

// firstname@youragency.com, the convention every account so far has followed
// (ruth@, ana@). Only a suggestion — the sender can change it.
function suggestWorkEmail(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0] || '';
  const slug = first.toLowerCase().replace(/[^a-z0-9]/g, '');
  return slug ? `${slug}@youragency.com` : '';
}

// Three states, so the panel can say which one a hire is actually in.
// `hasEmployeeRow` is the proof they signed in — the hire is only finished then.
function hireWorkspaceState(hire, hasEmployeeRow) {
  if (!hire || hire.stage !== 'payroll_done') return null;
  if (hasEmployeeRow) return 'joined';
  return hire.workspace_requested_at ? 'requested' : 'needed';
}

// The reseller is sent Name / Email to create / Recovery email / Phone —
// nothing secret. The password they send back is forwarded by a human and
// never touches Colony.
function workspaceRequestEmail(hire, workEmail) {
  const address = workEmail || suggestWorkEmail(hire?.full_name);
  const startLine = hire?.start_date ? `\n\nThey start on ${hire.start_date}.` : '';
  return {
    subject: `New Google Workspace user setup — ${address}`,
    body: `Hi ${typeof WORKSPACE_VENDOR_GREETING === 'string' ? WORKSPACE_VENDOR_GREETING : 'there'},\n\n`
      + `Could you please set up a new Google Workspace user for us on youragency.com? Details below:\n\n`
      + `Name: ${hire?.full_name || ''}\n`
      + `Email to create: ${address}\n`
      + `Recovery email: ${hire?.personal_email || ''}\n`
      + `Phone: ${hire?.phone || ''}`
      + `${startLine}\n\nThanks,\nAlex`
  };
}

// Skipping suppresses the stage email, because those emails describe work that
// did not happen ("the contract draft is uploaded and waiting for review").
//
// But TWO of them announce a state you have arrived at, not work you did, and
// they are addressed to someone who must now act. Dev reached "signed" by
// Skip on 8 Sep and finance was never told to set him up — he sat at "Hiring
// complete" with payroll never requested (Alex). Arriving is arriving,
// however you got there.
const SKIP_STILL_NOTIFIES = ['signed', 'payroll_done'];

function skipShouldNotify(toStage) {
  return SKIP_STILL_NOTIFIES.includes(toStage);
}

// ── Which door next ───────────────────────────────────────────────────────
// A hire signs in with a personal Gmail for their paperwork. Once their
// @youragency.com account exists, that Gmail door is the WRONG one, and the
// checklist used to say "All done!" and let them stop there (10 Sep
// 2026). This decides what the done-panel must say instead.
//   'joined'    — the youragency account has already been used: only tell them
//                 to switch, nothing else on the screen.
//   'ready'     — requested, not yet used: say it exists and how to sign in.
//   null        — not requested yet: the old "you'll hear from us" copy stands.
function hireSignInPrompt(hire, status) {
  if (!hire || hire.stage !== 'payroll_done' || !status) return null;
  const workEmail = status.work_email || suggestWorkEmail(hire.full_name);
  if (status.joined) return { kind: 'joined', workEmail };
  if (status.requested_at) return { kind: 'ready', workEmail };
  return null;
}

// ── The checklist ─────────────────────────────────────────────────────────
// One row per thing that has to happen, with who owns it, derived from the
// hire's stage and type (11 Sep 2026). Rows a type does not have are
// simply absent: consultants and fractionals never see a Finance breakup or
// a payroll row, because their fee was fixed at open and they invoice.
//
// Pure. `ctx` carries the two facts the row cannot read off the hire itself:
// whether an employee row exists (the youragency account has been used) and
// whether activation has happened.
const HIRE_OWNER_LABEL = {
  lead: 'Hiring lead', candidate: 'The hire', finance: 'Finance', legal: 'Legal', team: 'Colony'
};

function isSalariedHire(hire) { return (hire?.hire_type || 'full-time') === 'full-time'; }

// Which compensation a type carries, and what to call it on a form.
function hireCompensationSpec(hireType) {
  return hireType === 'full-time'
    ? { key: 'ctc_annual', label: 'CTC (annual, ₹)', placeholder: 'e.g. 1200000' }
    : { key: 'monthly_fee', label: 'Monthly fee (₹)', placeholder: 'e.g. 60000' };
}

function hireChecklist(hire, terms = {}, ctx = {}) {
  const salaried = isSalariedHire(hire);
  const idx = HIRE_STAGES.indexOf(hire?.stage);
  const at = (stage) => HIRE_STAGES.indexOf(stage);
  // done when the pipeline has moved PAST the stage that completes the row
  const past = (stage) => idx > at(stage);
  const comp = salaried ? terms.ctc_annual : terms.monthly_fee;
  const rows = [
    { key: 'open', owner: 'lead', label: 'Open the hire',
      detail: comp ? (salaried ? `CTC ₹${Number(comp).toLocaleString('en-IN')} a year` : `₹${Number(comp).toLocaleString('en-IN')} a month`) : 'compensation not set',
      // Hires opened before compensation lived in Colony (Sep 2026) have no
      // terms on file; once the candidate has moved past 'invited' the row
      // plainly happened, so it stays a hint ("compensation not set"), not a block.
      done: Boolean(hire?.start_date && ((comp && terms.scope_of_work) || past('invited'))) },
    { key: 'details', owner: 'candidate', label: salaried ? 'Details, tax regime, salary slips' : 'Details and bank',
      done: past('invited') },
  ];
  if (salaried) rows.push({ key: 'breakup', owner: 'finance', label: 'CTC breakup', done: past('details_submitted') });
  rows.push(
    { key: 'contract', owner: 'legal', label: salaried ? 'Employment agreement' : 'Consulting agreement', done: past('details_submitted') },
    { key: 'review', owner: 'lead', label: 'Review the draft', done: past('contract_uploaded') },
    { key: 'sign', owner: 'lead', label: 'Signed by both', done: past('reviewed') },
    { key: 'pay', owner: 'finance', label: salaried ? 'On payroll from the start date' : 'Set up as a vendor from the start date', done: past('signed') },
    // An employee row can only exist if the youragency account did, so it counts
    // even when the account was made outside Colony and never recorded.
    { key: 'account', owner: 'team', label: 'youragency.com account', done: Boolean(hire?.work_email || hire?.workspace_requested_at || ctx.hasEmployeeRow) },
    { key: 'signin', owner: 'candidate', label: 'First sign-in and onboarding', done: Boolean(ctx.hasEmployeeRow) },
    { key: 'activate', owner: 'team', label: `Active from ${hire?.start_date || 'start date'}`, done: Boolean(ctx.activated) }
  );
  if (hire?.stage === 'cancelled') return rows.map((r) => ({ ...r, state: r.done ? 'done' : 'cancelled' }));
  // The current row is the first one not done; everything after waits.
  let currentSeen = false;
  return rows.map((r) => {
    if (r.done) return { ...r, state: 'done' };
    if (!currentSeen) { currentSeen = true; return { ...r, state: 'current' }; }
    return { ...r, state: 'todo' };
  });
}
