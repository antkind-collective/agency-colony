// Quiet is not silent (28 Sep 2026): a quiet cron run writes one beacon per
// function per UTC day, so the audit can tell a quiet job from a dead one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { quietRunNeedsBeacon } = require('../netlify/functions/lib/notifications.js');

const NOW = '2026-09-28T04:00:00.000Z';

test('a quiet run with no heartbeat yet today writes a beacon', () => {
  assert.equal(quietRunNeedsBeacon({ quiet: true }, '2026-09-27T04:00:00Z', NOW), true);
  assert.equal(quietRunNeedsBeacon({ quiet: true }, null, NOW), true, 'never heartbeated');
});

test('only one beacon per UTC day', () => {
  assert.equal(quietRunNeedsBeacon({ quiet: true }, '2026-09-28T00:00:59Z', NOW), false);
});

test('dry runs and non-quiet runs never beacon (non-quiet runs log a full heartbeat anyway)', () => {
  assert.equal(quietRunNeedsBeacon({ quiet: true, dryRun: true }, null, NOW), false);
  assert.equal(quietRunNeedsBeacon({ quiet: false }, null, NOW), false);
  assert.equal(quietRunNeedsBeacon(null, null, NOW), false);
});
