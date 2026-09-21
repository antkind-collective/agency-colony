// Creating a hire's @youragency.com account ourselves, instead of emailing the
// reseller and forwarding the password they send back (11 Sep 2026).
//
// The old loop: Colony opens a prefilled mail to Example Reseller → a human sends it →
// Example Reseller replies with a plaintext password → a human forwards it → the hire
// signs in. Three humans, two inboxes, one password in the clear, and days of
// latency. Asha's took 40 minutes for the account and three days for nobody to
// tell her what to do with it.
//
// The new loop: an approver clicks once. Colony calls Google's Directory API
// with a service account, creates the user with a random password that must be
// changed at first sign-in, sets the hire's Gmail as recovery email, and mails
// the hire their sign-in instructions — once, directly, from the function.
//
// The rule "Colony never stores or relays Workspace credentials" is kept in
// the way that matters: the password is generated in memory, sent to the hire
// in a single transactional email, and never written to the database, the
// notification log, or a Netlify log line. Nothing about it is retrievable
// afterwards — if the hire loses it, "Forgot password" goes to their Gmail.
//
// This file is the PURE part: payload shape, password rules, email copy.
// Tested without Google.

const { randomBytes } = require('node:crypto');

// 16 chars from a set with no look-alikes (no 0/O, 1/l/I), so a hire typing it
// from an email gets it right first time. Google requires 8+; this is well
// past that and is discarded at first sign-in anyway.
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generateTempPassword(length = 16) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { givenName: '', familyName: '' };
  if (parts.length === 1) return { givenName: parts[0], familyName: '' };
  return { givenName: parts[0], familyName: parts.slice(1).join(' ') };
}

// Directory API users.insert body. changePasswordAtNextLogin is the whole
// point: the temporary password is one-time by construction, not by promise.
function buildDirectoryUser(hire, workEmail, password) {
  const { givenName, familyName } = splitName(hire?.full_name);
  if (!givenName) throw new Error('Hire has no name');
  if (!/^[a-z0-9._-]+@youragency\.com$/i.test(String(workEmail || ''))) throw new Error(`Not a youragency.com address: ${workEmail}`);
  if (!password || password.length < 8) throw new Error('Password too short');
  const user = {
    primaryEmail: String(workEmail).toLowerCase(),
    name: { givenName, familyName: familyName || givenName },
    password,
    changePasswordAtNextLogin: true
  };
  // Their personal Gmail is the recovery channel — it is where the invite went,
  // so it is already proven to reach them.
  if (hire?.personal_email) user.recoveryEmail = String(hire.personal_email).toLowerCase();
  if (hire?.phone) user.recoveryPhone = String(hire.phone).replace(/\s+/g, '');
  return user;
}

// The one email that carries the password. Plain, short, and honest about the
// fact it will not be shown again.
function provisionEmail({ hire, workEmail, password, startDate, colonyUrl }) {
  const first = splitName(hire?.full_name).givenName || 'there';
  const startLine = startDate ? ` Your first day is ${startDate}.` : '';
  const subject = `Your account: ${workEmail}`;
  const text = [
    `Hi ${first},`,
    '',
    `Your Google account is ready.${startLine}`,
    '',
    `Email: ${workEmail}`,
    `Temporary password: ${password}`,
    '',
    'Sign in at https://accounts.google.com — Google will ask you to set your own password straight away. This temporary one stops working after that, and we do not keep a copy.',
    '',
    `Then sign in to Colony at ${colonyUrl} with ${workEmail} (not your Gmail). That creates your profile and opens the onboarding form.`,
    '',
    'If you lose the temporary password before using it, choose "Forgot password" and the reset goes to this Gmail.',
    '',
    'Your Agency'
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6">${text.split('\n').map((l) => l ? `<p style="margin:0 0 8px">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>` : '').join('')}</div>`;
  return { subject, text, html };
}

module.exports = { generateTempPassword, buildDirectoryUser, provisionEmail, splitName, PASSWORD_ALPHABET };
