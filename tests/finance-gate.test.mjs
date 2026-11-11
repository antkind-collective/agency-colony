// Finance's second lock and Pay (28 Oct 2026). The code replaces the
// Invoice Center PIN; slips are emailed to their own person only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gate = require('../netlify/functions/lib/finance-gate.js');
const { slipEmail } = require('../netlify/functions/payslip-notify.js');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fnGate = readFileSync(new URL('../netlify/functions/finance-gate.js', import.meta.url), 'utf8');
const fnSlip = readFileSync(new URL('../netlify/functions/payslip-notify.js', import.meta.url), 'utf8');

test('a code is 6 digits; its hash is tied to the person and the session', () => {
  const c = gate.newCode();
  assert.match(c, /^\d{6}$/);
  const h = gate.hashCode(c, 'emp-1', 'sess-1');
  assert.notEqual(h, gate.hashCode(c, 'emp-2', 'sess-1'));
  assert.notEqual(h, gate.hashCode(c, 'emp-1', 'sess-2'));
});

test('checkCode: right, wrong, expired, too many tries', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  const row = { code_hash: gate.hashCode('123456', 'e', 's'), code_expires_at: '2026-10-28T10:05:00Z', attempts: 0 };
  assert.equal(gate.checkCode(row, '123456', 'e', 's', now), 'ok');
  assert.equal(gate.checkCode(row, '654321', 'e', 's', now), 'wrong');
  assert.equal(gate.checkCode(row, '123456', 'e', 'other-session', now), 'wrong');
  assert.equal(gate.checkCode({ ...row, code_expires_at: '2026-10-28T09:59:00Z' }, '123456', 'e', 's', now), 'expired');
  assert.equal(gate.checkCode({ ...row, attempts: gate.MAX_TRIES }, '123456', 'e', 's', now), 'locked');
  assert.equal(gate.checkCode({}, '123456', 'e', 's', now), 'none');
});

test('at most 5 codes an hour per session', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  assert.equal(gate.sendAllowed(null, now).ok, true);
  assert.equal(gate.sendAllowed({ sends: 5, window_started_at: '2026-10-28T09:30:00Z' }, now).ok, false);
  assert.equal(gate.sendAllowed({ sends: 5, window_started_at: '2026-10-28T08:30:00Z' }, now).ok, true, 'a new hour resets');
});

test('the session id comes from the verified token', () => {
  const body = Buffer.from(JSON.stringify({ session_id: '7f0c2c6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f' })).toString('base64url');
  assert.equal(gate.sessionIdOf(`x.${body}.y`), '7f0c2c6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f');
  assert.equal(gate.sessionIdOf('nonsense'), null);
});

test('codes and slips go to their own person only, never the standing finance copy', () => {
  assert.match(fnGate, /to: emp\.email,\s*\n\s*private: true/);
  assert.match(fnSlip, /private: true/);
  assert.match(fnSlip, /callerIs\(token, 'finance_unlocked'\)/);
  const e = slipEmail('Carmen', '2026-10', 'https://app.youragency.com/#employee-profile');
  assert.equal(e.subject, 'Your October 2026 salary slip is in Colony');
  assert.doesNotMatch(e.html, /\.pdf/);
});

test('no PIN left in the page; files open through 60-second links', () => {
  assert.doesNotMatch(app, /INVOICE_PIN_HASH|checkInvoiceAccess|invoiceUnlocked/);
  assert.match(app, /createSignedUrl\(path, 60\)/);
});
