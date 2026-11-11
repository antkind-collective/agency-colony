// Reminding Alex about open client feedback every 2 days
// (netlify/functions/lib/client-feedback-reminder.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isOpenClientPost, ageInDays, postsDueForReminder, reminderKey } =
  require('../netlify/functions/lib/client-feedback-reminder.js');

// Posted Mon 5 Oct, 23:00 IST (17:30 UTC): the IST day is the 5th.
const post = { id: 'f1', author_partner_id: 'p1', status: 'requested', created_at: '2026-10-05T17:30:00Z' };

test('only open client posts are chased', () => {
  assert.equal(isOpenClientPost(post), true);
  assert.equal(isOpenClientPost({ ...post, status: 'in_progress' }), true);
  assert.equal(isOpenClientPost({ ...post, status: 'done' }), false);
  assert.equal(isOpenClientPost({ ...post, status: 'archived' }), false);
  // Your Agency's own posts are not client feedback.
  assert.equal(isOpenClientPost({ ...post, author_partner_id: null }), false);
});

test('age is counted in IST calendar days', () => {
  // 17:30 UTC on the 5th is 23:00 IST on the 5th, not the 6th.
  assert.equal(ageInDays(post.created_at, '2026-10-05'), 0);
  assert.equal(ageInDays(post.created_at, '2026-10-06'), 1);
  // 19:00 UTC on the 5th is already the 6th in IST.
  assert.equal(ageInDays('2026-10-05T19:00:00Z', '2026-10-06'), 0);
});

test('reminds every 2 days until fixed, weekends included', () => {
  const due = (today, p = post) => postsDueForReminder([p], today).map((x) => x.id);
  assert.deepEqual(due('2026-10-05'), []);   // posted: the new-post email covers it
  assert.deepEqual(due('2026-10-06'), []);
  assert.deepEqual(due('2026-10-07'), ['f1']);
  assert.deepEqual(due('2026-10-08'), []);
  assert.deepEqual(due('2026-10-09'), ['f1']);
  assert.deepEqual(due('2026-10-11'), ['f1']); // Sunday
  assert.deepEqual(due('2026-10-11', { ...post, status: 'done' }), []);
});

test('the oldest open post comes first, and the key is per day', () => {
  const older = { ...post, id: 'f0', created_at: '2026-10-01T05:00:00Z' };
  assert.deepEqual(postsDueForReminder([post, older], '2026-10-09').map((p) => p.id), ['f0', 'f1']);
  assert.equal(reminderKey('2026-10-09'), 'client-feedback-reminder:2026-10-09');
});
