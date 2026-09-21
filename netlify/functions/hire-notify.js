// Hiring pipeline emails — one per stage handoff, to exactly whoever's turn
// it is (per the approved email thread, 24 Jul 2026). Fire-and-forget from
// the client; the durable state is hires.stage, so a lost email only delays
// a nudge, never the work.
const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { sendEmail } = require('./lib/email');
const { logNotification } = require('./lib/notifications');
const { getConfig } = require('./lib/config');
const { callerCanSee, callerIs } = require('./lib/caller');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS = ['invited', 'details_submitted', 'contract_uploaded', 'reviewed', 'signed', 'payroll_done'];
const FALLBACK_APPROVERS = ['admin@youragency.com', 'am-lead@youragency.com'];
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
    .select('id, full_name, personal_email, hire_type, start_date, stage, pan, address, permanent_address')
    .eq('id', hireId).single();
  if (hireRes.error || !hireRes.data) return jsonResponse(404, { error: 'Hire not found.' });
  const hire = hireRes.data;

  // Offer terms (crew-only table) — everything Legal needs to draft, in the
  // email itself so nobody has to go asking (Leo's checklist, 24 Aug 2026).
  const termsRes = await supabase.from('hire_offer_terms').select('*').eq('hire_id', hireId).maybeSingle();
  const terms = termsRes.data || {};

  const approvers = await configList(supabase, 'setup_approver_emails', FALLBACK_APPROVERS);
  const crew = await configList(supabase, 'hiring_crew_emails', FALLBACK_CREW);
  const legal = crew.filter(e => e.includes('leo')).concat([]);
  const finance = crew.filter(e => e.includes('finance'));
  const superadmin = 'admin@youragency.com';

  const first = String(hire.full_name || 'the candidate').split(' ')[0];

  // ONE email per event: the people who must act are in To, everyone keeping a
  // copy is in CC. Previously each recipient got their own private send, so
  // nobody could see who else knew or reply to the group (24 Aug 2026).
  // Deep link: land on Team Directory with the Hiring panel scrolled into view,
  // not the homepage.
  // Straight to this hire's card, expanded (Hiring is its own screen since 11 Sep 2026).
  const hiringLink = `${appBaseUrl}?open=hire:${hireId}#hiring`;
  let subject;
  let line;
  let toList = [];
  let ccList = [];
  let internalNotice = null;
  let steps = null;            // numbered action points, in order
  let contractTable = null;    // the agreement checklist
  let missingForContract = []; // fields nobody has filled in yet

  switch (hireEvent) {
    case 'invited':
      subject = 'Welcome to Your Agency — complete your joining details';
      line = `Welcome aboard! Your Agency uses Colony for joining paperwork. Go to ${appBaseUrl}, click "Invited sign in", and sign in with THIS Google account (${hire.personal_email}). You'll see one short form — your details, bank information, your income tax regime choice, and salary slips from 1 April this fiscal year to now (or a note if you don't have them). Takes about ten minutes.`;
      toList = [hire.personal_email];
      // The candidate must not see internal addresses, so the team's copy is a
      // separate message rather than a CC on theirs.
      internalNotice = {
        subject: `📨 ${hire.full_name} invited to Colony`,
        line: `${first} has been invited to fill in their joining details. Nothing to do yet — you'll be emailed when they submit.`,
        to: approvers
      };
      break;
    case 'details_submitted': {
      subject = `🧑‍💼 ${hire.full_name} — CTC breakup needed, then contract`;
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
        ['CTC (annual)', terms.ctc_annual != null ? `${terms.ctc_currency || 'INR'} ${Number(terms.ctc_annual).toLocaleString('en-IN')}` : null],
        ['Notice period', terms.notice_period_days ? `${terms.notice_period_days} days` : null],
        ['Scope of work', terms.scope_of_work]
      ];
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
      if (hire.hire_type === 'full-time') {
        steps = [
          `<strong>1. Blake</strong> — please reply-all with the CTC breakup${terms.ctc_annual != null ? ` for ${terms.ctc_currency || 'INR'} ${Number(terms.ctc_annual).toLocaleString('en-IN')}` : ''}.`,
          `<strong>2. Leo</strong> — once Blake's breakup lands, draft the employment agreement. Everything else you need is below.`
        ];
        toList = finance;
        ccList = [...(legal.length ? legal : crew), ...approvers];
      } else {
        steps = [
          `<strong>Leo</strong> — please draft the engagement agreement. Everything you need is below.`,
          `No CTC breakup needed: ${first} is <strong>${hire.hire_type}</strong> and raises invoices rather than going on payroll.`
        ];
        toList = legal.length ? legal : crew;
        ccList = approvers;   // finance deliberately left out — nothing to do yet
      }
      break;
    }
    case 'contract_uploaded':
      subject = `📄 Contract ready for review — ${hire.full_name}`;
      line = `The contract draft for ${first} is uploaded and waiting for review in Colony (Team Directory → New hire).`;
      toList = approvers;
      break;
    case 'reviewed':
      subject = `✍️ Ready for signature — ${hire.full_name}`;
      line = `${first}'s contract has been reviewed and approved — it's waiting for signature. Download the draft, sign, and upload the signed copy in Colony.`;
      toList = [superadmin];
      ccList = approvers;
      break;
    case 'signed':
      // Same split: only a salaried hire goes on payroll. The others invoice.
      if (hire.hire_type === 'full-time') {
        subject = `✅ Signed — start payroll for ${hire.full_name}`;
        line = `${first}'s contract is signed. Their bank details and salary slips are in Colony — please start payroll and update the finance sheet.`;
      } else {
        subject = `✅ Signed — set up invoicing for ${hire.full_name}`;
        line = `${first}'s contract is signed. They are ${hire.hire_type}, so they invoice rather than going on payroll — their bank details are in Colony. Please add them to the finance sheet.`;
      }
      toList = finance;
      ccList = [...approvers, ...legal];
      break;
    case 'payroll_done':
      subject = `🎉 Hiring complete — ${hire.full_name}`;
      line = `Payroll is set up for ${first}. Next: create their @youragency.com account — Colony's onboarding takes over from there.`;
      toList = approvers;
      break;
  }

  const norm = (list) => [...new Set((list || []).filter(Boolean).map((e) => String(e).toLowerCase()))];
  const isCandidateEmail = (e) => e === String(hire.personal_email).toLowerCase();
  let to = norm(toList);
  let cc = norm(ccList).filter((e) => !to.includes(e));
  // Never email the person who just clicked the button — but if they were the
  // only recipient in To, the copy list has to step up or the mail goes nowhere.
  to = to.filter((e) => e !== actorEmail);
  cc = cc.filter((e) => e !== actorEmail);
  if (!to.length && cc.length) { to = cc; cc = []; }

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
      ? `<p style="margin:14px 0 4px"><strong>For the employment agreement</strong></p>
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
      ? '\n\nFor the employment agreement:\n' + mailTable
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
  if (internalNotice) {
    const notifyTo = norm(internalNotice.to).filter((e) => e !== actorEmail);
    await sendOne(notifyTo, [], internalNotice.subject, internalNotice.line);
  }

  // Counts only: the caller may be the candidate, who must not learn the
  // crew's addresses (and nobody needs them back — the app fires and forgets).
  const failed = results.filter((r) => r.status === 'failed').length;
  return jsonResponse(200, { ok: true, sent: results.length - failed, failed });
};
