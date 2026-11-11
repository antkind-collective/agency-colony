// Delivered briefs the client does not answer close after 7 days (30 Sep 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { autoCompleteDue, AUTO_COMPLETE_DAYS } = require('../netlify/functions/lib/brief-auto-complete.js');

const NOW = '2026-10-10T05:00:00Z';
const at = (days) => new Date(Date.parse(NOW) - days * 86400000).toISOString();

test('seven days, not six, of silence closes a delivery', () => {
  assert.equal(AUTO_COMPLETE_DAYS, 7);
  const briefs = [{ id: 'a', status: 'delivered' }, { id: 'b', status: 'delivered' }];
  const due = autoCompleteDue(briefs, new Map([['a', at(7)], ['b', at(6.9)]]), NOW);
  assert.deepEqual(due.map((b) => b.id), ['a']);
});

test('paused, not delivered, or no delivery record: left alone', () => {
  const briefs = [
    { id: 'p', status: 'delivered', paused_at: '2026-10-01T00:00:00Z' },
    { id: 'r', status: 'under_revision' },
    { id: 'n', status: 'delivered' }
  ];
  assert.deepEqual(autoCompleteDue(briefs, new Map([['p', at(30)], ['r', at(30)]]), NOW), []);
});

test('a re-delivery after revision restarts the clock (latest entry wins)', () => {
  const due = autoCompleteDue([{ id: 'a', status: 'delivered' }], new Map([['a', at(2)]]), NOW);
  assert.deepEqual(due, []);
});
