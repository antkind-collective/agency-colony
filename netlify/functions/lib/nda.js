// NDAs (22 Oct 2026, _youragency_ops/Agreements/Colony-NDA-brief.md). Pure:
// no Supabase, no Papersign, no mail. Tested in tests/nda.test.mjs.
const { createHash, randomBytes } = require('node:crypto');

// "Type" on the form -> the words the NDA prints after the name.
const PARTY_TYPES = {
  pvt_ltd: { label: 'Private Limited company', description: 'a company incorporated under the Companies Act, 2013' },
  public_ltd: { label: 'Public Limited company', description: 'a company incorporated under the Companies Act, 2013' },
  llp: { label: 'LLP', description: 'a limited liability partnership incorporated under the Limited Liability Partnership Act, 2008' },
  partnership: { label: 'Partnership firm', description: 'a partnership firm' },
  proprietorship: { label: 'Sole proprietorship', description: 'a sole proprietorship' },
  individual: { label: 'Individual', description: 'an individual' },
  foreign: { label: 'Company outside India', description: 'a company incorporated outside India' }
};

const LIMITS = { party_name: 160, party_address: 300, signatory_name: 120, signatory_title: 120, signatory_email: 200 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Papersign drops line breaks inside a value, so every field is one line.
function oneLine(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }

// Their side of the NDA, from the link or typed by us. Returns
// { details } or { error } naming the first problem in plain words.
function cleanDetails(input = {}) {
  const d = {
    party_name: oneLine(input.party_name),
    party_type: String(input.party_type || ''),
    party_address: oneLine(input.party_address),
    signatory_name: oneLine(input.signatory_name),
    signatory_title: oneLine(input.signatory_title),
    signatory_email: oneLine(input.signatory_email).toLowerCase()
  };
  if (!d.party_name) return { error: 'Add the company or full name.' };
  if (!PARTY_TYPES[d.party_type]) return { error: 'Choose a type.' };
  if (!d.party_address) return { error: 'Add the registered address.' };
  if (!d.signatory_name) return { error: 'Add who signs.' };
  if (!d.signatory_title && d.party_type !== 'individual') return { error: 'Add their title.' };
  if (!EMAIL_RE.test(d.signatory_email)) return { error: 'Add a valid email.' };
  for (const [k, max] of Object.entries(LIMITS)) {
    if (d[k].length > max) return { error: `That is too long (${k.replace(/_/g, ' ')}).` };
  }
  return { details: d };
}

function prettyLongDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// The template's variables, by name (mapped to keys at draft time).
function ndaVariables(nda) {
  const t = PARTY_TYPES[nda.party_type];
  return [
    { key: 'effective_date', value: prettyLongDate(nda.effective_date) },
    { key: 'party_name', value: nda.party_name },
    { key: 'party_description', value: t ? t.description : '' },
    { key: 'party_address', value: nda.party_address },
    // The short name in quotes: who we said it's with, else the legal name
    // (a blank prints empty quotes).
    { key: 'alias', value: oneLine(nda.with_name) || nda.party_name },
    { key: 'purpose', value: oneLine(nda.purpose) },
    { key: 'party_signatory_name', value: nda.signatory_name },
    { key: 'party_signatory_title', value: nda.signatory_title || (nda.party_type === 'individual' ? 'Individual' : '') },
    { key: 'party_email', value: nda.signatory_email }
  ];
}

const NDA_VARIABLE_NAMES = ['effective_date', 'party_name', 'party_description', 'party_address', 'alias', 'purpose', 'party_signatory_name', 'party_signatory_title', 'party_email'];

// Name -> generated key; every expected name must exist exactly once.
function mapNdaVariables(variables, templateVariables) {
  const byName = new Map();
  for (const tv of Array.isArray(templateVariables) ? templateVariables : []) {
    const name = String(tv?.name || '').trim();
    if (!name || !tv?.key) continue;
    if (byName.has(name)) throw new Error(`The NDA template has two variables named "${name}".`);
    byName.set(name, String(tv.key));
  }
  const missing = NDA_VARIABLE_NAMES.filter((n) => !byName.has(n));
  if (missing.length) throw new Error(`The NDA template is missing: ${missing.join(', ')}.`);
  return variables.map((v) => ({ key: byName.get(v.key), value: v.value }));
}

// Signer 1 is Your Agency (Alex, signs first); signer 2 is blank in the template.
// A TEST NDA sends both to Alex so nothing reaches a stranger.
function ndaSigners(templateSigners, nda, youragency = { name: 'Alex Morgan', email: 'admin@youragency.com' }) {
  const list = Array.isArray(templateSigners) ? templateSigners : [];
  const ours = list.find((s) => String(s.email || '').toLowerCase() === youragency.email);
  const theirs = list.find((s) => s !== ours);
  if (!ours?.key || !theirs?.key) throw new Error('The NDA template signers are not as expected.');
  const test = isTestNda(nda);
  return [
    { key: ours.key, name: youragency.name, email: youragency.email },
    { key: theirs.key, name: test ? `TEST ${nda.signatory_name}` : nda.signatory_name, email: test ? youragency.email : nda.signatory_email }
  ];
}

function isTestNda(nda) { return /^TEST\b/i.test(oneLine(nda?.with_name)); }

// Your Agency_NDA_Mutual_<Party_Name>_<DDMonYYYY>, as filed since 2024.
function ndaFileBase(nda, when = nda.effective_date) {
  const d = new Date(`${String(when).slice(0, 10)}T00:00:00Z`);
  const stamp = `${String(d.getUTCDate()).padStart(2, '0')}${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}${d.getUTCFullYear()}`;
  const party = oneLine(nda.party_name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${isTestNda(nda) ? 'TEST_' : ''}Your Agency_NDA_Mutual_${party}_${stamp}`;
}

// The link: 32 random bytes; only the hash is stored.
const LINK_DAYS = 7;
function newLinkToken() { return randomBytes(32).toString('base64url'); }
function hashToken(token) { return createHash('sha256').update(String(token)).digest('hex'); }
function looksLikeToken(t) { return typeof t === 'string' && /^[A-Za-z0-9_-]{40,60}$/.test(t); }

module.exports = {
  PARTY_TYPES, cleanDetails, ndaVariables, mapNdaVariables, ndaSigners, isTestNda,
  ndaFileBase, prettyLongDate, newLinkToken, hashToken, looksLikeToken, LINK_DAYS, oneLine
};
