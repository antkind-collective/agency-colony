const { getConfig } = require('./config');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FETCH_TIMEOUT_MS = 15000;

async function sendEmail({ to, cc, subject, html, text, audience = 'team' }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  // Copies belong in CC, not in separate sends: three people who each received
  // their own private copy of the same handoff cannot see each other, cannot
  // reply-all, and cannot tell whether anyone else knows (24 Aug 2026).
  const ccRecipients = (Array.isArray(cc) ? cc : [cc])
    .filter(Boolean)
    .filter((e) => !recipients.some((r) => String(r).toLowerCase() === String(e).toLowerCase()));

  if (!recipients.length) {
    throw new Error('At least one recipient email is required.');
  }

  const invalidEmails = [...recipients, ...ccRecipients].filter((e) => !EMAIL_RE.test(e));
  if (invalidEmails.length) {
    throw new Error(`Invalid recipient email format: ${invalidEmails.join(', ')}`);
  }

  if (!subject) {
    throw new Error('Email subject is required.');
  }

  const { resendApiKey, emailSender } = getConfig();

  if (!resendApiKey) {
    return {
      skipped: true,
      reason: 'RESEND_API_KEY is not configured.',
      recipients,
      ccRecipients
    };
  }

  if (!emailSender || !EMAIL_RE.test(emailSender)) {
    throw new Error('EMAIL_SENDER is missing or invalid.');
  }

  // Who the mail appears to come from follows the RECIPIENT, not the codebase.
  // A client has no idea Colony exists and cannot sign into it; every message
  // they get must read as Circle (10 Sep 2026 — Mira was sent
  // "View it on Colony" with a link she is locked out of).
  //
  // 'team' is the default because most mail is internal, and a staff member
  // seeing Circle branding is confusing but harmless, while the reverse leaks
  // a platform the client should never learn about. Call sites that mail
  // partners pass audience: 'partner'.
  const brand = audience === 'partner' ? 'Client Circle' : 'Agency Colony';
  const fromHeader = `${brand} <${emailSender}>`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromHeader,
        to: recipients,
        ...(ccRecipients.length ? { cc: ccRecipients } : {}),
        subject,
        html,
        text
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Resend API returned non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`Resend API error (${response.status}): ${JSON.stringify(data)}`);
  }

  return {
    skipped: false,
    recipients,
    ccRecipients,
    data
  };
}

module.exports = {
  sendEmail
};
