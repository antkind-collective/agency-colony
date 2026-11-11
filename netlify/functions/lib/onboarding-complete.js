// "Onboarding complete" (9 Oct 2026) — pure logic, no Supabase, no mail.
//
// The last step of a hire is the joiner showing up in Slack. When joiner-slack
// sees that, it sends ONE email to the hiring manager (Alex copied) listing
// every step of the hire and the day it happened, and says onboarding is
// complete. Rows mirror the hire screen (js/hires.js hireChecklist).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// IST calendar day of a timestamp (or a plain date), as "9 Oct".
function istDay(value) {
  if (!value) return null;
  const s = String(value);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(new Date(s).getTime() + 330 * 60000).toISOString().slice(0, 10);
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}
function escapeHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// hire: app.hires row; terms: hire_offer_terms row; stageAt: { stage: latest entered_at };
// signedInAt: employees.created_at for their @youragency.com profile.
function onboardingRows(hire, terms = {}, stageAt = {}, signedInAt = null) {
  const salaried = String(hire?.hire_type || 'full-time') === 'full-time';
  // What the hiring manager needs, not every back-office step (9 Oct
  // 2026): no Finance row; the account and the welcome email are one line;
  // signing in and access switched on are one line.
  const later = (...vals) => vals.filter(Boolean).sort().pop() || null;
  return [
    ['Hire opened', istDay(hire?.created_at)],
    ['Joining details in', istDay(hire?.details_submitted_at || stageAt.details_submitted)],
    [salaried ? 'Employment agreement signed' : 'Consulting agreement signed', istDay(terms.papersign_completed_at || stageAt.signed)],
    [hire?.work_email ? `${hire.work_email} created and welcome email sent` : 'Account created and welcome email sent', istDay(later(hire?.workspace_requested_at, hire?.welcome_sent_at))],
    ['Signed in to Colony, access switched on', istDay(later(signedInAt, hire?.activated_at))],
    ['Added to All Hands and Thirsty Thursday', istDay(hire?.calendar_added_at)],
    ['Joined Slack', istDay(hire?.slack_joined_at)]
  ];
}

function onboardingCompleteEmail(hire, rows, link) {
  const name = String(hire?.full_name || 'Your new joiner').trim();
  const first = name.split(/\s+/)[0];
  const start = hire?.start_date ? ` (starting ${istDay(hire.start_date)})` : '';
  const subject = `Onboarding complete: ${name}`;
  const intro = `${first}${start} has joined Slack, the last step of their hire. Everything is done:`;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;max-width:560px">
    <p>${escapeHtml(intro)}</p>
    <table style="border-collapse:collapse;font-size:14px">${rows.map(([label, day]) => `
      <tr><td style="padding:3px 10px 3px 0;color:#2a7">✓</td><td style="padding:3px 16px 3px 0">${escapeHtml(label)}</td><td style="padding:3px 0;color:#666">${escapeHtml(day || '')}</td></tr>`).join('')}
    </table>
    <p><strong>Onboarding complete.</strong></p>
    <p><a href="${escapeHtml(link)}">Open their hire in Colony →</a></p></div>`;
  const text = [intro, '', ...rows.map(([label, day]) => `✓ ${label}${day ? ` · ${day}` : ''}`), '', 'Onboarding complete.', '', link].join('\n');
  return { subject, html, text };
}

module.exports = { onboardingRows, onboardingCompleteEmail, istDay };
