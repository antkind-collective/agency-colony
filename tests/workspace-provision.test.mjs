import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { generateTempPassword, buildDirectoryUser, provisionEmail, PASSWORD_ALPHABET } = require('../netlify/functions/lib/workspace-provision.js');

test('temp password: long, random, and free of look-alike characters', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const p = generateTempPassword();
    assert.equal(p.length, 16);
    assert.ok(![...p].some((c) => !PASSWORD_ALPHABET.includes(c)));
    assert.ok(!/[0O1lI]/.test(p), `look-alike in ${p}`);
    seen.add(p);
  }
  assert.equal(seen.size, 50);
});

test('directory user: must change password at first sign-in, recovery is their Gmail', () => {
  const u = buildDirectoryUser(
    { full_name: 'Asha Rao', personal_email: 'new.hire@example.com', phone: '+91 90295 51357' },
    'asha@youragency.com', 'Abcdefgh23456789');
  assert.equal(u.primaryEmail, 'asha@youragency.com');
  assert.equal(u.name.givenName, 'Asha');
  assert.equal(u.name.familyName, 'Rao');
  assert.equal(u.changePasswordAtNextLogin, true);
  assert.equal(u.recoveryEmail, 'new.hire@example.com');
  assert.equal(u.recoveryPhone, '+919029551357');
});

test('directory user: refuses anything that is not a youragency.com address', () => {
  assert.throws(() => buildDirectoryUser({ full_name: 'X Y' }, 'x@example.com', 'Abcdefgh23456789'), /youragency\.com/);
  assert.throws(() => buildDirectoryUser({ full_name: '' }, 'x@youragency.com', 'Abcdefgh23456789'), /no name/);
  assert.throws(() => buildDirectoryUser({ full_name: 'X Y' }, 'x@youragency.com', 'short'), /short/);
});

test('single-name hire still gets a valid Google name object', () => {
  const u = buildDirectoryUser({ full_name: 'Mara' }, 'mara@youragency.com', 'Abcdefgh23456789');
  assert.equal(u.name.givenName, 'Mara');
  assert.equal(u.name.familyName, 'Mara');
});

test('the email carries the password once and says it will not be kept', () => {
  const m = provisionEmail({ hire: { full_name: 'Asha Rao' }, workEmail: 'asha@youragency.com', password: 'Abcdefgh23456789', startDate: 'Tuesday 15 September', colonyUrl: 'https://app.youragency.com' });
  assert.match(m.subject, /asha@youragency\.com/);
  assert.match(m.text, /Temporary password: Abcdefgh23456789/);
  assert.match(m.text, /do not keep a copy/);
  assert.match(m.text, /not your Gmail/);
  assert.match(m.text, /Tuesday 15 September/);
  assert.match(m.html, /Abcdefgh23456789/);
});

// S18 (audit 14 Oct 2026): the internal bearer is derived from the
// service-role key, never the Papersign webhook key (which sits in a URL).
test('internal caller: the derived key only, never the Papersign webhook key', () => {
  const { isInternalCaller, internalFunctionKey } = require('../netlify/functions/lib/workspace-provision.js');
  const env = { PAPERSIGN_WEBHOOK_KEY: 'webhook-key-123', SUPABASE_SERVICE_ROLE_KEY: 'service-role-xyz' };
  const k = internalFunctionKey(env);
  assert.equal(k.length, 64);
  assert.notEqual(k, env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(isInternalCaller('webhook-key-123', env), false);
  assert.equal(isInternalCaller(k, env), true);
  assert.equal(isInternalCaller('webhook-key-123', { PAPERSIGN_WEBHOOK_KEY: 'webhook-key-123' }), false, 'no fallback when there is no service key');
  assert.equal(isInternalCaller('', env), false);
});

test('no function sends or accepts the webhook key as an internal bearer', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (f) => readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), 'utf8');
  assert.doesNotMatch(read('workspace-provision.js'), /PAPERSIGN_WEBHOOK_KEY/);
  assert.doesNotMatch(read('workspace-retry.js'), /PAPERSIGN_WEBHOOK_KEY/);
  assert.doesNotMatch(read('papersign-webhook.js'), /Bearer \$\{process\.env\.PAPERSIGN_WEBHOOK_KEY/);
});

// Netlify functions share AWS Lambda's 4KB environment budget, and a new env
// var broke every deploy on 14 Oct 2026. Nothing here reads an env var that
// is not already set in Netlify.
test('functions read no INTERNAL_FUNCTION_KEY env var', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../netlify/functions/', import.meta.url);
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => new URL(f, dir)),
    ...readdirSync(new URL('lib/', dir)).filter((f) => f.endsWith('.js')).map((f) => new URL(`lib/${f}`, dir))];
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /process\.env\.INTERNAL_FUNCTION_KEY/, String(f));
});

// Google refuses a bare 10-digit number and the account with it (30 Oct 2026).
test('recoveryPhone: E.164 or nothing', () => {
  const { recoveryPhone } = require('../netlify/functions/lib/workspace-provision.js');
  assert.equal(recoveryPhone('9876543210'), '+919876543210');
  assert.equal(recoveryPhone('98765 43210'), '+919876543210');
  assert.equal(recoveryPhone('09876543210'), '+919876543210');
  assert.equal(recoveryPhone('91 98765 43210'), '+919876543210');
  assert.equal(recoveryPhone('+91 98765-43210'), '+919876543210');
  assert.equal(recoveryPhone('+44 7700 900123'), '+447700900123');
  assert.equal(recoveryPhone('12345'), '');
  assert.equal(recoveryPhone(''), '');
});

// Payal got a seat nobody wanted (2 Nov 2026): Colony emailed Example Reseller by
// itself and the retry made the account. Now a person says yes in Colony
// first, and nothing creates an account for a hire marked "not needed".
test('Example Reseller is emailed only on a person\'s yes; "not needed" hires get no account', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (f) => readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), 'utf8');
  const provision = read('workspace-provision.js');
  assert.match(provision, /if \(hire\.workspace_not_needed\) return json\(409/);
  assert.match(provision, /if \(internal \|\| !requestLicence\) \{[\s\S]*?needsApproval: true/);
  assert.equal((provision.match(/await askForLicence\(admin, hire\)/g) || []).length, 1, 'one call site, behind the yes');
  const retry = read('workspace-retry.js');
  assert.match(retry, /\.eq\('workspace_not_needed', false\)/);
  assert.doesNotMatch(retry, /sendEmail|askForLicence/);
});

test('new hire form: no @youragency.com account unless the manager asked', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /class="opt is-on"[^>]*data-opt="not-needed"/);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /setOptGroup\(document\.querySelector\('\[data-opt-group="nhAccount"\]'\), 'not-needed'\)/);
});
