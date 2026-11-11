import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { withStandingCopies } = require('../netlify/functions/lib/email.js');

test('mail to Blake copies Ari, whether Blake is To or CC', () => {
  assert.deepEqual(withStandingCopies(['finance@youragency.com'], []), ['ari@youragency.com']);
  assert.deepEqual(withStandingCopies(['x@youragency.com'], ['admin@youragency.com', 'finance@youragency.com']),
    ['admin@youragency.com', 'finance@youragency.com', 'ari@youragency.com']);
});

test('Ari is never added twice, and mail without Blake is untouched', () => {
  assert.deepEqual(withStandingCopies(['finance@youragency.com'], ['ari@youragency.com']), ['ari@youragency.com']);
  assert.deepEqual(withStandingCopies(['ari@youragency.com', 'finance@youragency.com'], []), []);
  assert.deepEqual(withStandingCopies(['leo@youragency.com'], ['admin@youragency.com']), ['admin@youragency.com']);
});
