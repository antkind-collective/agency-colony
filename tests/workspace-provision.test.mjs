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
