// Out of Google licences: recognise the refusal, ask once, word the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isLicenceError, shouldAsk, licenceRequestEmail, ASK_AGAIN_AFTER_MS } = require('../netlify/functions/lib/workspace-licence.js');

test('isLicenceError: the refusal Google gave on 7 Oct 2026', () => {
  assert.equal(isLicenceError('Insufficient licenses for one or more products that are set to automatically assign licenses to new users'), true);
  assert.equal(isLicenceError('Entity already exists.'), false);
});

test('shouldAsk: once, then again only after the wait', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  assert.equal(shouldAsk(null, now), true);
  assert.equal(shouldAsk('2026-10-09T12:00:00Z', now), false);
  assert.equal(shouldAsk(new Date(now.getTime() - ASK_AGAIN_AFTER_MS).toISOString(), now), true);
});

test('licenceRequestEmail: names the joiner and the start day, signed Alex', () => {
  const m = licenceRequestEmail({ full_name: 'Modeera Fatima', start_date: '2026-10-12' });
  assert.match(m.text, /^Hi Kay,/);
  assert.match(m.text, /Modeera, who joins on Monday, 12 October/);
  assert.match(m.text, /Best,\nAlex$/);
});
