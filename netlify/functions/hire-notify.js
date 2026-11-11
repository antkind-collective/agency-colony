// Hiring pipeline emails — one per stage handoff, to exactly whoever's turn
// it is (per the approved email thread, 24 Jul 2026). Rule since 9 Oct 2026
// (Alex): an email goes out only when things move forward AND someone must
// act; nobody is copied just to keep them informed, except Alex and, on
// anything the new hire receives, their hiring manager. Fire-and-forget from
// the client; the durable state is hires.stage, so a lost email only delays
// a nudge, never the work.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification } = require('./lib/notifications');
const { getConfig } = require('./lib/config');
const { callerCanSee, callerIs } = require('./lib/caller');
const { financeRows } = require('./lib/hire-finance');
const { hireEmailCc } = require('./lib/hire-cc');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS = ['invited', 'details_submitted', 'contract_uploaded', 'reviewed', 'signed', 'payroll_done'];
const FALLBACK_CREW = ['leo@youragency.com', 'finance@youragency.com'];

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function configList(supabase, key, fallback) {
  const res = await supabase.from('app_config').select('value').eq('key', key).maybeSingle();
  return (!res.error && Array.isArray(res.data?.value) && res.data.value.length) ? res.data.value : fallback;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' });

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (authHeader.match(/^Bearer\s+(.+)$/i) || [])[1];
  if (!token) return jsonResponse(401, { error: 'Missing bearer token.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { error: 'Invalid JSON payload.' }); }
  const { event: hireEvent, hireId } = payload;
  if (!EVENTS.includes(hireEvent)) return jsonResponse(400, { error: 'Invalid event.' });
  if (typeof hireId !== 'string' || !UUID_RE.test(hireId)) return jsonResponse(400, { error: 'hireId must be a UUID.' });

  const { appBaseUrl } = getConfig();
  const supabase = getSupabaseAdmin();

  const userResponse = await supabase.auth.getUser(token);
  if (userResponse.error || !userResponse.data?.user) return jsonResponse(401, { error: 'Invalid auth token.' });
  const actorEmail = String(userResponse.data.user.email || '').toLowerCase();

  // Who may fire this (audit 16 Sep 2026). Until now any signed-in token —
  // a partner, another candidate — could send any stage email for any hire,
  // including "Signed — start payroll" to Finance. RLS on hires is crew or the
  // candidate themselves; beyond seeing the row, a candidate may only announce
  // their own submission. Everything else is a crew action.
  if (!await callerCanSee(token, 'hires', hireId)) return jsonResponse(404, { error: 'Hire not found.' });
  if (hireEvent !== 'details_submitted' && !await callerIs(token, 'is_hiring_crew')) {
    return jsonResponse(403, { error: 'Only the hiring crew can send this.' });
  }

  const hireRes = await supabase.from('hires')
    .select('id, full_name, personal_email, work_email, phone, hire_type, start_date, stage, pan, address, permanent_address, bank_account_name, bank_account_number, bank_ifsc, tax_regime')
    .eq('id', hireId).single();
  if (hireRes.error || !hireRes.data) return jsonResponse(404, { error: 'Hire not found.' });
  const hire = hireRes.data;

  // Offer terms (crew-only table) — everything Legal needs to draft, in the
  // email itself so nobody has to go asking (Leo's checklist, 24 Aug 2026).
  const termsRes = await supabase.from('hire_offer_terms').select('*').eq('hire_id', hireId).maybeSingle();
  const terms = termsRes.data || {};

  const crew = await configList(supabase, 'hiring_crew_emails', FALLBACK_CREW);
  const legal = crew.filter(e => e.includes('leo')).concat([]);
  const finance = crew.filter(e => e.includes('finance'));
  const superadmin = 'admin@youragency.com';
  // The person who opened the hire is the thread: they approve the details, and
  // they are told at every handoff after it. Nadia sat on five of these emails
  // only because she is in setup_approver_emails, which is a permissions list,
  // not a mailing list (7 Oct 2026). Her access is untouched.
  const hiringManager = String(terms.hiring_manager_email || '').trim();
  const manager = hiringManager ? [hiringManager] : [];

  const first = String(hire.full_name || 'the candidate').split(' ')[0];
  const salaried = (hire.hire_type || 'full-time') === 'full-time';
  const fixedTerm = !salaried && Boolean(terms.contract_end_date);

  // ONE email per event: the people who must act are in To, everyone keeping a
  // copy is in CC. Previously each recipient got their own private send, so
  // nobody could see who else knew or reply to the group (24 Aug 2026).
  // Deep link: land on the Hiring screen with this hire scrolled into view,
  // not the homepage.
  // Straight to this hire's card, expanded (Hiring is its own screen since 11 Sep 2026).
  let hiringLink = `${appBaseUrl}?open=hire:${hireId}#hiring`;
  let subject;
  let line;
  let toList = [];
  let ccList = [];
  let steps = null;            // numbered action points, in order
  let contractTable = null;    // the agreement checklist
  let missingForContract = []; // fields nobody has filled in yet
  let tableTitle = 'For the employment agreement';

  switch (hireEvent) {
    case 'invited':
      subject = 'Welcome to Your Agency — complete your joining details';
      // Payroll's questions (tax regime, salary slips) are for employees only;
      // fractional and consultant hires invoice and never see them (30 Oct 2026).
      line = `Welcome aboard! Your Agency uses Colony for joining paperwork. Go to ${appBaseUrl}, click "Invited sign in", and sign in with THIS Google account (${hire.personal_email}). You'll see one short form — ${(hire.hire_type || 'full-time') === 'full-time'
        ? `your details, bank information, your income tax regime choice, and salary slips from 1 April this fiscal year to now (or a note if you don't have them). Takes about ten minutes.`
        : `your details, PAN, address and bank information for your invoices. Takes about five minutes.`}`;
      toList = [hire.personal_email];
      // Their hiring manager is copied (with Alex, added below). The old
      // separate "📨 invited" notice to the setup approvers is gone: it said
      // "nothing to do yet", and an email goes out only when someone must act
      // (9 Oct 2026).
      ccList = manager;
      break;
    case 'details_submitted': {
      subject = `🧑‍💼 ${hire.full_name} — joining details in, agreement next`;
      // Sequenced on purpose (24 Aug 2026): Blake's breakup is an input
      // to the agreement, so the mail states step 1 and step 2 rather than
      // asking two people for something at once.
      const rows = [
        ['Full name', hire.full_name],
        ['Current address', hire.address],
        ['Permanent address', hire.permanent_address],
        ['PAN', hire.pan],
        ['Designation', terms.designation],
        ['Department', terms.department],
        ['Start date', hire.start_date],
        // The pay that applies to this hire: a fractional or consultant has a
        // monthly fee, not a CTC (30 Oct 2026: Manisha's ₹35,000 a month read
        // "CTC (annual): (still needed)"). A fixed term shows its end date, and
        // still has a notice period for ending it early (3 Nov 2026).
        ...(salaried
          ? [['CTC (annual)', terms.ctc_annual != null ? `${terms.ctc_currency || 'INR'} ${Number(terms.ctc_annual).toLocaleString('en-IN')}` : null]]
          : [['Monthly fee', terms.monthly_fee != null ? `INR ${Number(terms.monthly_fee).toLocaleString('en-IN')}` : null]]),
        ...(fixedTerm ? [['Contract', `Fixed term, ends ${terms.contract_end_date}`]] : []),
        ['Notice period', terms.notice_period_days ? `${terms.notice_period_days} days` : null],
        ['Scope of work', terms.scope_of_work]
      ];
      if (!salaried) tableTitle = 'For the consulting agreement';
      const missing = rows.filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
      contractTable = rows;
      missingForContract = missing;
      line = `${first} has submitted their joining details (${hire.hire_type}).`;
      // A CTC breakup is a SALARIED thing. A fractional or consultant hire is
      // paid against invoices, so asking Blake to break down a CTC for them is
      // asking for something that does not exist — and it went to him for Asha
      // (fractional) anyway (8 Sep 2026).
      //
      // One name on the To: line either way. The person who must act first is
      // the recipient; everyone else is copied.
      // Submitting is no longer the signal to draft (7 Oct 2026). Legal
      // checks the details first and approves in Colony; the drafting ask goes
      // out on 'details_approved' below. Before this, a draft could be built on
      // details nobody had looked at.
      // No approval step (7 Oct 2026): the draft itself is reviewed
      // before it is sent, and that is where these details are checked.
      if (hire.hire_type === 'full-time') {
        steps = [
          `Draft the agreement from the hire in Colony. These are the details it is built from.`,
          // The breakup does not wait on the check: it comes from the offer
          // terms we set, not from anything the candidate typed.
          `<strong>Blake</strong> — the CTC breakup${terms.ctc_annual != null ? ` for ${terms.ctc_currency || 'INR'} ${Number(terms.ctc_annual).toLocaleString('en-IN')}` : ''} is yours, in Colony. It prints as Annexure B.`
        ];
        // Checking the details is Alex's or Leo's, either one — nobody else
        // is on this mail (7 Oct 2026). Blake is copied only because the
        // CTC breakup is his, and it does not wait on the check.
        // The agreement stays between Legal and Alex (9 Oct 2026); Blake is
        // on it only because the CTC breakup is his to do.
        toList = [...legal, ...finance];
        ccList = [superadmin];
        hiringLink = `${appBaseUrl}?open=hireterms:${hireId}#hiring`;
      } else {
        steps = [
          `Draft the agreement from the hire in Colony. These are the details it is built from.`
        ];
        toList = legal;
        ccList = [superadmin];
      }
      break;
    }
    case 'contract_uploaded':
      // The only mail between drafting and signing. 'reviewed' used to send a
      // second one seconds later to the same people (7 Oct 2026).
      subject = `📄 Draft ready — review and send for signing: ${hire.full_name}`;
      line = `The agreement draft for ${first} is ready. Open it from the hire in Colony (Review draft), check it in Papersign, then click Approve & send for signing.`;
      // Nadia approves drafts too (30 Oct 2026): every setup approver
      // can Approve & send, so every one of them gets the to-do.
      toList = [superadmin, ...legal, ...(await configList(supabase, 'setup_approver_emails', [superadmin, 'am-lead@youragency.com']))];
      ccList = [];
      break;
    case 'reviewed':
      // Covered by the draft-ready mail; a second one added nothing.
      return json(200, { skipped: 'reviewed is not mailed' });
    case 'signed':
      // Everything Finance needs, in the mail itself, so nobody opens Colony to
      // copy a bank account across (7 Oct 2026).
      tableTitle = 'For the finance sheet';
      contractTable = financeRows(hire, terms);
      // Payroll is a job; adding an invoicing consultant to the finance sheet is
      // a note. Finance was asked to "set up" both the same way, so a consultant
      // sat waiting on a task nobody actually owed (7 Oct 2026).
      if (hire.hire_type === 'full-time') {
        subject = `✅ Signed — start payroll for ${hire.full_name}`;
        line = `${first}'s contract is signed. Their details are below and the salary slips are in Colony — please start payroll and update the finance sheet.`;
        toList = finance;
        ccList = [superadmin];
      } else {
        subject = `FYI — ${hire.full_name} signed, for the finance sheet`;
        line = `${first}'s contract is signed. They are ${hire.hire_type} and invoice rather than going on payroll, so there is nothing to set up — just add them to the finance sheet when convenient. Their details are below.`;
        toList = finance;
        ccList = [superadmin];
      }
      break;
    case 'payroll_done':
      // Not mailed. Signing in is announced by setup-approval-notify ("switch
      // their access on"), the one email where the manager has to act.
      return json(200, { skipped: 'payroll_done is not mailed' });
  }

  const norm = (list) => [...new Set((list || []).filter(Boolean).map((e) => String(e).toLowerCase()))];
  const isCandidateEmail = (e) => e === String(hire.personal_email).toLowerCase();
  let to = norm(toList);
  let cc = norm(ccList).filter((e) => !to.includes(e));
  // Alex sees every email a new hire receives (8 Oct 2026), even one she
  // triggered herself, so it is added after the "don't email the clicker" rule.
  const hireFacing = to.some(isCandidateEmail);
  // Never email the person who just clicked the button — but if they were the
  // only recipient in To, the copy list has to step up or the mail goes nowhere.
  // Except the draft-ready mail: reviewing is a to-do for both Alex and
  // Leo whoever drafted it, and the drafter was left without the link
  // (30 Oct 2026, on Manisha's draft).
  if (hireEvent !== 'contract_uploaded') {
    to = to.filter((e) => e !== actorEmail);
    cc = cc.filter((e) => e !== actorEmail);
  }
  if (!to.length && cc.length) { to = cc; cc = []; }
  if (hireFacing) cc = norm([...cc, ...(await hireEmailCc(supabase))]).filter((e) => !to.includes(e));

  const results = [];

  // Steps and the checklist are passed in, never read from scope: the separate
  // internal notice must not inherit another message's action points.
  const sendOne = async (targets, copies, mailSubject, bodyLine, opts = {}) => {
    const { steps: mailSteps = null, table: mailTable = null, missing: mailMissing = [] } = opts;
    if (!targets.length) return;
    const candidateOnly = targets.every(isCandidateEmail);
    const link = candidateOnly ? appBaseUrl : hiringLink;
    const stepsHtml = mailSteps && mailSteps.length
      ? `<ol style="padding-left:18px;margin:12px 0">${mailSteps.map((st) => `<li style="margin-bottom:6px">${st}</li>`).join('')}</ol>`
      : '';
    const tableHtml = mailTable
      ? `<p style="margin:14px 0 4px"><strong>${escapeHtml(tableTitle)}</strong></p>
         <table style="border-collapse:collapse;font-size:14px">${mailTable.map(([k, v]) => `
           <tr>
             <td style="padding:3px 14px 3px 0;color:#666;vertical-align:top">${escapeHtml(k)}</td>
             <td style="padding:3px 0">${v && String(v).trim() ? escapeHtml(String(v)) : '<em style="color:#b23">still needed</em>'}</td>
           </tr>`).join('')}</table>
         ${mailMissing.length ? `<p style="font-size:13px;color:#b23;margin:8px 0 0">Missing: ${escapeHtml(mailMissing.join(', '))} — Alex/Nadia can add these under Team Directory → New hire → Details.</p>` : ''}`
      : '';
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <p>Hello,</p>
        <p>${escapeHtml(bodyLine)}</p>
        ${stepsHtml}
        ${tableHtml}
        ${candidateOnly ? '' : `<p><a href="${link}">Open this hire in Colony</a></p>`}
      </div>`;
    const textSteps = mailSteps && mailSteps.length
      ? '\n\n' + mailSteps.map((st) => st.replace(/<[^>]+>/g, '')).join('\n')
      : '';
    const textTable = mailTable
      ? `\n\n${tableTitle}:\n` + mailTable
          .map(([k, v]) => `${k}: ${v && String(v).trim() ? v : '(still needed)'}`).join('\n')
      : '';
    const text = `${bodyLine}${textSteps}${textTable}\n\n${link}`;
    try {
      const emailResult = await sendEmail({ to: targets, cc: copies, subject: mailSubject, html, text });
      // One row per person so the audit trail still answers "who was told?",
      // with their role on the message.
      for (const email of [...targets, ...copies]) {
        await logNotification({
          kind: 'hire_notify',
          recipientEmail: email,
          subject: mailSubject,
          payload: {
            hire_id: hireId,
            event: hireEvent,
            actor_email: actorEmail,
            role: targets.includes(email) ? 'to' : 'cc'
          },
          status: emailResult.skipped ? 'skipped' : 'sent'
        });
        results.push({ email, role: targets.includes(email) ? 'to' : 'cc', status: emailResult.skipped ? 'skipped' : 'sent' });
      }
    } catch (error) {
      results.push({ to: targets, cc: copies, status: 'failed', error: error.message });
    }
  };

  await sendOne(to, cc, subject, line, { steps, table: contractTable, missing: missingForContract });

  // Counts only: the caller may be the candidate, who must not learn the
  // crew's addresses (and nobody needs them back — the app fires and forgets).
  const failed = results.filter((r) => r.status === 'failed').length;
  return jsonResponse(200, { ok: true, sent: results.length - failed, failed });
};
