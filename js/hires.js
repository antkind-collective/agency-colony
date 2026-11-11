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

// salaried defaults true so older callers behave as before. Salary slips and a
// tax regime are payroll things: someone who invoices has neither, and asking
// them produced a "salary slips" row on a consultant's details (Modeera,
// 7 Oct 2026).
// Anything the candidate types lands verbatim in the agreement, and the agreement
// is a paragraph, not a form. Modeera entered her address over three lines and
// those line breaks printed inside the parties clause (7 Oct 2026). Lines become
// one line: joined with a comma unless the line already ends in punctuation, and
// runs of whitespace collapse.
function normalizeAgreementText(value) {
  const lines = String(value == null ? '' : value)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return '';
  return lines.reduce((out, line) => {
    if (!out) return line;
    return /[,;:.\-]$/.test(out) ? `${out} ${line}` : `${out}, ${line}`;
  }, '').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').trim();
}

function hireMissingDetails(details, hasSlips, salaried = true) {
  const missing = HIRE_DETAIL_FIELDS.filter(({ key }) => {
    const v = details?.[key];
    return v === null || v === undefined || String(v).trim() === '';
  });
  if (salaried && !hasSlips && details?.no_salary_slips !== true) {
    missing.push({ key: 'salary_slips', label: 'Salary slips (or tick "I did not have salary slips")' });
  }
  if (details?.full_name && String(details.full_name).trim().split(/\s+/).length < 2) {
    missing.push({ key: 'full_name_words', label: 'Full name — first and last' });
  }
  // Blake (5 Aug): regime is mandatory; Old regime needs HRA/80C/80D declarations.
  if (salaried && !['old', 'new'].includes(details?.tax_regime)) {
    missing.push({ key: 'tax_regime', label: 'Income tax regime (Old or New)' });
  } else if (salaried && details.tax_regime === 'old' && !String(details?.tax_declarations_note || '').trim()) {
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

// First name alone is only right while it is unused. To create accounts without
// a human choosing, the options have to be ordered and then checked against the
// directory — two Sivas would otherwise collide or fail (7 Oct 2026).
// Returns addresses in the order we would like them, most preferred first.
function workEmailCandidates(fullName) {
  const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean).map(slug).filter(Boolean);
  if (!parts.length) return [];
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const out = [first];
  if (last) {
    out.push(`${first}.${last}`);
    out.push(`${first}${last[0]}`);
  }
  for (let n = 2; n <= 4; n += 1) out.push(`${first}${n}`);
  return [...new Set(out)].map((local) => `${local}@youragency.com`);
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
// But "signed" announces a state you have arrived at, not work you did, and it
// is addressed to someone who must now act. Dev reached "signed" by Skip
// on 8 Sep and finance was never told to set him up — he sat at "Hiring
// complete" with payroll never requested (Alex). Arriving is arriving,
// however you got there. "payroll_done" is not mailed at all since 7 Oct, so
// the skip dialog must not promise it (S24).
const SKIP_STILL_NOTIFIES = ['signed'];

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
  lead: 'Hiring lead', candidate: 'The hire', finance: 'Finance', legal: 'Legal', team: 'Colony', approver: 'Setup approver',
  // Reviewing and signing an agreement is Alex's, Nadia's or Leo's (Nadia
  // added 30 Oct 2026) — any one of them, on
  // every agreement, not only consulting (7 Oct 2026). It read "Hiring
  // lead", which let anyone holding setup-approver move a contract along.
  counsel: 'Reviewers', signer: 'Signatories'
};

// The day the welcome email goes out: two working days (no weekends, no
// public holidays) before the start date. Mirrors welcomeSendDate in
// netlify/functions/lib/hire-welcome.js, which is what actually sends it.
function welcomeDayIso(startIso, holidays = []) {
  const hol = new Set((holidays || []).map((d) => String(d).slice(0, 10)));
  const d = new Date(`${String(startIso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  let counted = 0;
  while (counted < 2) {
    d.setUTCDate(d.getUTCDate() - 1);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !hol.has(iso)) counted += 1;
  }
  return d.toISOString().slice(0, 10);
}

// When the welcome email will actually go. hire-welcome runs once a day at
// 9 am IST and sends from the send day until the start day, so a hire signed
// after their send day goes at the next 9 am, not on a day already gone
// (Manisha read 'goes out Thu 29 Oct' on 30 Oct, 2026).
function welcomeWhen(startIso, ctx = {}) {
  const due = welcomeDayIso(startIso, ctx.holidays);
  const today = ctx.today;
  if (!today || due > today) return shortHireDate(due);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const next = (Number(ctx.istHour) || 0) < 9 ? today : tomorrow;
  if (next > String(startIso).slice(0, 10)) return 'too late: past the start date';
  return next === today ? 'today' : 'tomorrow';
}

// A start date on a weekend or an office holiday is almost always a slip:
// Manisha's was Sun 1 Nov 2026 and her welcome email said "You start on
// Sunday". Warn and name the next working day; don't refuse, since a hire may
// really start then. holidays: [{ date, name }] or ISO strings.
function startDateWarning(startIso, holidays = []) {
  const iso = String(startIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const hol = new Map((holidays || []).map((h) => [String(h?.date ?? h).slice(0, 10), h?.name || '']));
  const off = (d) => { const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); return dow === 0 || dow === 6 || hol.has(d); };
  if (!off(iso)) return '';
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  const what = dow === 0 ? 'a Sunday' : dow === 6 ? 'a Saturday' : `an office holiday${hol.get(iso) ? ` (${hol.get(iso)})` : ''}`;
  let next = iso;
  for (let i = 0; i < 30 && off(next); i++) next = new Date(Date.parse(`${next}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return `${shortHireDate(iso).replace(/^\w+ /, '')} is ${what}. The next working day is ${shortHireDate(next)}.`;
}

// "Mon 12 Oct" from an ISO date or timestamp; '' when missing.
function shortHireDate(value) {
  if (!value) return '';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function isSalariedHire(hire) { return (hire?.hire_type || 'full-time') === 'full-time'; }

// Which compensation a type carries, and what to call it on a form.
function hireCompensationSpec(hireType) {
  return hireType === 'full-time'
    ? { key: 'ctc_annual', label: 'CTC (annual, ₹)', placeholder: 'e.g. 1200000' }
    : { key: 'monthly_fee', label: 'Monthly fee (₹, GST extra)', placeholder: 'e.g. 60000' };
}

// What the collapsed row says: the step it is actually on, not the pipeline
// stage. "Complete" at payroll_done was wrong while the welcome email and the
// first sign-in were still to come (7 Oct 2026).
const HIRE_STEP_STATUS = {
  open: 'Opening', details: 'Waiting on their details', breakup: 'CTC breakup',
  contract: 'Agreement being drafted', review: 'Draft to review', sign: 'Awaiting signature',
  pay: 'With Finance', account: 'Account to create', welcome: 'Welcome email next',
  signin: 'Waiting for first sign-in', activate: 'Ready to activate', meetings: 'Adding to meetings',
  slack: 'Sending Slack invite'
};
function hireStepStatus(rows, stage) {
  if (stage === 'cancelled') return 'Cancelled';
  const current = (rows || []).find((r) => r.state === 'current');
  if (current?.key === 'account' && /^waiting for a Google licence/.test(current.detail || '')) return 'Waiting for a licence';
  return current ? (current.status || HIRE_STEP_STATUS[current.key] || current.label) : 'Complete';
}

function hireChecklist(hire, terms = {}, ctx = {}) {
  const salaried = isSalariedHire(hire);
  const idx = HIRE_STAGES.indexOf(hire?.stage);
  const at = (stage) => HIRE_STAGES.indexOf(stage);
  // done when the pipeline has moved PAST the stage that completes the row
  const past = (stage) => idx > at(stage);
  const comp = salaried ? terms.ctc_annual : terms.monthly_fee;
  // Every finished step carries the day it happened, the same way on every
  // row (7 Oct 2026). ctx.stageAt is the latest entry into each stage,
  // from hire_stage_history.
  const stageAt = ctx.stageAt || {};
  const on = (iso) => shortHireDate(iso) || null;
  const legacyJoiner = Boolean(ctx.activated && !hire?.welcome_sent_at);
  const rows = [
    { key: 'open', owner: 'lead', label: 'Open the hire',
      detail: [comp ? (salaried ? `CTC ₹${Number(comp).toLocaleString('en-IN')} a year` : `₹${Number(comp).toLocaleString('en-IN')} a month`) : 'compensation not set', on(hire?.created_at)].filter(Boolean).join(' · '),
      // Hires opened before compensation lived in Colony (Sep 2026) have no
      // terms on file; once the candidate has moved past 'invited' the row
      // plainly happened, so it stays a hint ("compensation not set"), not a block.
      done: Boolean(hire?.start_date && ((comp && terms.scope_of_work) || past('invited'))) },
    // No approval of what they submitted (7 Oct 2026): the draft is
    // reviewed before it is sent, and that is where these details get checked.
    { key: 'details', owner: 'candidate', label: salaried ? 'Details, tax regime, salary slips' : 'Details and bank',
      // Until they submit, say that the invite went and to whom, so nobody
      // reads the empty row as a step to do themselves (30 Oct 2026).
      detail: past('invited')
        ? on(stageAt.details_submitted || hire?.details_submitted_at)
        : [`invite emailed${hire?.personal_email ? ` to ${hire.personal_email}` : ''}`, on(stageAt.invited || hire?.created_at)].filter(Boolean).join(' · '),
      done: past('invited') },
  ];
  // Done once Finance has entered it in the offer terms (it prints as
  // Annexure B), or once the hire is past the step — hires from before the
  // breakup lived in Colony had it by email.
  const hasBreakup = Array.isArray(terms.ctc_breakup) && terms.ctc_breakup.some(r => r && r.component && Number(r.annual) > 0);
  if (salaried) rows.push({ key: 'breakup', owner: 'finance', label: 'CTC breakup', done: hasBreakup || past('details_submitted') });
  rows.push(
    { key: 'contract', owner: 'legal', label: salaried ? 'Employment agreement' : 'Consulting agreement',
      detail: past('details_submitted') ? on(stageAt.contract_uploaded) : null, done: past('details_submitted') },
    // Sent is its own fact: it can be true while signing is still pending.
    // While the draft waits, say it is ready and that both reviewers were
    // emailed, so nobody wonders how they would know (30 Oct 2026).
    // Who sent it, when known, so a late reviewer sees it was handled and by
    // whom (30 Oct 2026). ctx.sentBy is a first name.
    { key: 'review', owner: 'counsel', label: terms.papersign_sent_at ? 'Sent for signature' : 'Review the draft',
      detail: (terms.papersign_sent_at ? [ctx.sentBy ? `by ${ctx.sentBy}` : '', on(terms.papersign_sent_at)].filter(Boolean).join(' · ') : null) || (past('contract_uploaded') ? on(stageAt.reviewed)
        : (hire?.stage === 'contract_uploaded' ? ['draft ready, emailed to Alex, Leo and Nadia', on(stageAt.contract_uploaded)].filter(Boolean).join(' · ') : null)),
      done: past('contract_uploaded') },
    // Leo and Nadia review and send; Alex and the hire sign (30 Oct 2026).
    { key: 'sign', owner: 'signer', label: past('reviewed') ? 'Signed by both' : 'Signing',
      detail: past('reviewed') ? on(terms.papersign_completed_at || stageAt.signed) : null, done: past('reviewed') },
    // An employee row can only exist if the youragency account did, so it counts
    // even when the account was made outside Colony and never recorded.
    // Out of Google licences: Colony has asked the reseller and retries by
    // itself, so the step is automatic until the account exists.
    hire?.workspace_not_needed && !hire?.work_email
      ? { key: 'account', owner: 'approver', label: 'No youragency.com account', detail: 'not needed', done: true }
      : { key: 'account', owner: hire?.workspace_licence_requested_at && !hire?.work_email ? 'team' : 'approver', label: 'youragency.com account',
      detail: hire?.workspace_licence_requested_at && !hire?.work_email
        ? `waiting for a Google licence · asked ${on(hire.workspace_licence_requested_at)}`
        : on(hire?.workspace_requested_at), done: Boolean(hire?.work_email || hire?.workspace_requested_at || ctx.hasEmployeeRow) },
    // After the account: the signed webhook creates it first, so Finance's
    // email carries the work email (30 Oct 2026).
    // Only payroll is a task Finance has to do. Someone who invoices needs
    // nothing set up — Finance is told so they can add them to the sheet, and
    // the row says that rather than implying work owed (7 Oct 2026).
    // For someone who invoices, telling Finance IS the step — it happens when
    // the agreement is signed, with no button to close (7 Oct 2026).
    salaried
      ? { key: 'pay', owner: 'finance', label: 'On payroll from the start date',
          detail: past('signed') ? on(stageAt.payroll_done) : null, done: past('signed') }
      : { key: 'pay', owner: 'finance', label: 'Finance notified',
          detail: past('reviewed') ? on(stageAt.signed || terms.papersign_completed_at) : null, done: past('reviewed') },
    // The end of a hire, in the order it happens (8 Oct 2026). Each row
    // says plainly what happened and when, so it reads cold:
    //   welcome email (Colony sign-in) → they sign in → the hiring manager
    //   switches their access on → Colony adds them to the meetings and
    //   emails the Slack invite → they join Slack.
    // Two working days before the start date (netlify/functions/hire-welcome.js).
    { key: 'welcome', owner: 'team', label: hire?.welcome_sent_at ? 'Welcome email sent' : 'Welcome email',
      detail: hire?.welcome_sent_at
        ? shortHireDate(hire.welcome_sent_at)
        : (ctx.activated ? null : (hire?.start_date
          ? `goes out ${welcomeWhen(hire.start_date, ctx)}, 9 am`
          : 'goes out 2 working days before the start date')),
      done: Boolean(hire?.welcome_sent_at || ctx.activated),
      // Once they have signed in, the welcome email no longer holds the hire
      // up: it still goes out (first-day details), but the hire moves on to
      // activation (8 Oct 2026: Modeera read "Welcome email next" after she
      // had already signed in).
      nonBlocking: Boolean(ctx.hasEmployeeRow) },
    // Their first sign-in creates their Colony profile; only then can their
    // access be switched on.
    { key: 'signin', owner: 'candidate', label: ctx.hasEmployeeRow ? 'Signed in to Colony' : 'Signs in to Colony',
      detail: [ctx.hasEmployeeRow ? on(ctx.signedInAt) : null, hire?.work_email ? `as ${hire.work_email}` : null].filter(Boolean).join(' · ') || null,
      done: Boolean(ctx.hasEmployeeRow) },
    // The hiring manager's step (or Alex's): Activate now, or Schedule.
    { key: 'activate', owner: 'lead', label: ctx.activated ? 'Colony access switched on' : 'Colony access',
      detail: ctx.activated
        ? on(hire?.activated_at)
        : (hire?.activation_scheduled_on
          ? `switches on ${shortHireDate(hire.activation_scheduled_on)}, 9:30 am`
          : (ctx.hasEmployeeRow ? null : 'after they sign in')),
      status: ctx.activated ? null : (hire?.activation_scheduled_on
        ? `Activates ${shortHireDate(hire.activation_scheduled_on)}`
        : (ctx.hasEmployeeRow ? 'Ready to activate' : null)),
      done: Boolean(ctx.activated) },
    // Both follow activation by themselves (joiner-calendar, joiner-slack).
    // Hires active before the joiner steps existed (no welcome email on
    // record) count as done, or every old hire would reopen.
    { key: 'meetings', owner: 'team', label: 'Added to All Hands, Thirsty Thursday',
      detail: hire?.calendar_added_at ? on(hire.calendar_added_at) : 'on activation',
      done: Boolean(hire?.calendar_added_at || legacyJoiner) },
    // Slack is one row (8 Oct 2026): Colony emails the invite on
    // activation, then the same row waits for them and ticks when they join.
    { key: 'slack', owner: hire?.slack_invited_at && !hire?.slack_joined_at ? 'candidate' : 'team',
      label: hire?.slack_joined_at ? 'Joined Slack' : (hire?.slack_invited_at ? 'Slack invite sent' : 'Slack invite'),
      detail: hire?.slack_joined_at
        ? on(hire.slack_joined_at)
        : (hire?.slack_invited_at
          ? `${on(hire.slack_invited_at)} · waiting for ${String(hire.full_name || 'them').split(' ')[0]} to join`
          : (legacyJoiner ? null : 'on activation')),
      status: hire?.slack_invited_at && !hire?.slack_joined_at ? `Waiting for ${String(hire.full_name || 'them').split(' ')[0]} to join Slack` : null,
      done: Boolean(hire?.slack_joined_at || legacyJoiner) }
  );
  // With no account there is no welcome, sign-in, access, meetings or Slack:
  // the hire is finished once Finance is told (30 Oct 2026).
  if (hire?.workspace_not_needed && !hire?.work_email) {
    const after = new Set(['welcome', 'signin', 'activate', 'meetings', 'slack']);
    for (let i = rows.length - 1; i >= 0; i -= 1) if (after.has(rows[i].key)) rows.splice(i, 1);
  }
  if (hire?.stage === 'cancelled') return rows.map((r) => ({ ...r, state: r.done ? 'done' : 'cancelled' }));
  // The current row is the first one not done; everything after waits. A
  // non-blocking row (see welcome) never becomes current and stays "to do".
  let currentSeen = false;
  return rows.map((r) => {
    if (r.done) return { ...r, state: 'done' };
    if (r.nonBlocking) return { ...r, state: 'todo' };
    if (!currentSeen) { currentSeen = true; return { ...r, state: 'current' }; }
    return { ...r, state: 'todo' };
  });
}
