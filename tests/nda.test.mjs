import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nda = require('../netlify/functions/lib/nda.js');

const good = { party_name: 'Acme Studios Private Limited', party_type: 'pvt_ltd', party_address: '12 Hill Road,\nMumbai', signatory_name: 'Priya Rao', signatory_title: 'Founder', signatory_email: 'Priya@example.com ' };

test('details are cleaned to one line each and checked', () => {
  const { details } = nda.cleanDetails(good);
  assert.equal(details.party_address, '12 Hill Road, Mumbai');
  assert.equal(details.signatory_email, 'priya@example.com');
  assert.match(nda.cleanDetails({ ...good, party_type: 'x' }).error, /type/);
  assert.match(nda.cleanDetails({ ...good, signatory_email: 'nope' }).error, /email/);
  assert.equal(nda.cleanDetails({ ...good, party_type: 'individual', signatory_title: '' }).error, undefined);
});

test('the NDA variables: alias falls back to the legal name; the date reads as words', () => {
  const vars = Object.fromEntries(nda.ndaVariables({ ...nda.cleanDetails(good).details, with_name: '', purpose: 'Pitch', effective_date: '2026-10-22' }).map((v) => [v.key, v.value]));
  assert.equal(vars.alias, 'Acme Studios Private Limited');
  assert.equal(vars.effective_date, '22 October 2026');
  assert.equal(vars.party_description, 'a company incorporated under the Companies Act, 2013');
});

test('template variables map by name, and a missing or doubled name fails', () => {
  const names = ['effective_date', 'party_name', 'party_description', 'party_address', 'alias', 'purpose', 'party_signatory_name', 'party_signatory_title', 'party_email'];
  const tpl = names.map((n, i) => ({ name: n, key: `k${i}` }));
  const mapped = nda.mapNdaVariables([{ key: 'alias', value: 'Acme' }], tpl);
  assert.deepEqual(mapped, [{ key: 'k4', value: 'Acme' }]);
  assert.throws(() => nda.mapNdaVariables([], tpl.slice(1)), /missing: effective_date/);
  assert.throws(() => nda.mapNdaVariables([], [...tpl, { name: 'alias', key: 'zz' }]), /two variables/);
});

test('signers: Alex first; a TEST NDA goes only to Alex', () => {
  const tpl = [{ key: 'a', email: 'admin@youragency.com' }, { key: 'b', email: null }];
  const real = nda.ndaSigners(tpl, { with_name: 'Acme', signatory_name: 'Priya', signatory_email: 'priya@example.com' });
  assert.deepEqual(real.map((s) => s.email), ['admin@youragency.com', 'priya@example.com']);
  const t = nda.ndaSigners(tpl, { with_name: 'TEST Acme', signatory_name: 'Priya', signatory_email: 'priya@example.com' });
  assert.deepEqual(t.map((s) => s.email), ['admin@youragency.com', 'admin@youragency.com']);
});

test('the filed name follows the Legal folder convention', () => {
  assert.equal(nda.ndaFileBase({ party_name: 'Diya Sahgal', effective_date: '2026-10-01' }), 'Your Agency_NDA_Mutual_Diya_Sahgal_01Oct2026');
  assert.equal(nda.ndaFileBase({ with_name: 'TEST x', party_name: 'A & B Ltd.', effective_date: '2026-10-22' }), 'TEST_Your Agency_NDA_Mutual_A_B_Ltd_22Oct2026');
});

test('link tokens are long, random, and only their hash is kept', () => {
  const t = nda.newLinkToken();
  assert.ok(nda.looksLikeToken(t));
  assert.notEqual(t, nda.newLinkToken());
  assert.equal(nda.hashToken(t).length, 64);
  assert.equal(nda.looksLikeToken('short'), false);
});

test('the public door spends the link in the same update that saves, and says nothing about what exists', () => {
  const src = readFileSync(new URL('../netlify/functions/nda-intake.js', import.meta.url), 'utf8');
  assert.match(src, /intake_token_hash: null, intake_expires_at: null/);
  assert.match(src, /\.eq\('intake_token_hash', hash\)\.eq\('status', 'awaiting_details'\)\.gt\('intake_expires_at', now\)/);
  assert.match(src, /select\('purpose'\)/);
  const page = readFileSync(new URL('../nda.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /colony/i);
  assert.match(page, /history\.replaceState/);
});

test('sending: only the starter (or Alex), once, and real NDAs wait for nda_live', () => {
  const src = readFileSync(new URL('../netlify/functions/nda-action.js', import.meta.url), 'utf8');
  assert.match(src, /callerIs\(token, 'is_nda_crew'\)/);
  assert.match(src, /if \(!live && !isTestNda\(nda\)\)/);
  assert.match(src, /\.eq\('id', nda\.id\)\.eq\('status', 'ready'\)\.select\('id'\)\.maybeSingle\(\)/);
});

test('legal is copied on every signed NDA (22 Oct 2026)', () => {
  const src = readFileSync(new URL('../netlify/functions/papersign-webhook.js', import.meta.url), 'utf8');
  assert.match(src, /: \['leo@youragency\.com'\];/);
  assert.match(src, /cc: cc\.filter\(\(e\) => e !== to\)/);
});
