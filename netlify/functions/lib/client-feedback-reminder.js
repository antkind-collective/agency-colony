// Which client feedback posts to chase Alex about, and when
// (6 Oct 2026).
//
// A client's bug or idea on Circle's wall is Alex's to fix. She gets one
// email when it is posted (feature-request-notify), then a reminder every 2
// days until she marks it fixed. Calendar days, weekends included: she asked
// for "every 2 days", and a client's bug does not pause for Saturday.
//
// Pure: no Supabase, no mail. Tested without either.

const { zonedParts, IST_TIME_ZONE } = require('./config');

const REMIND_EVERY_DAYS = 2;
const CLOSED = new Set(['done', 'archived']);

function isOpenClientPost(post) {
  return Boolean(post) && Boolean(post.author_partner_id) && !CLOSED.has(post.status);
}

function istDate(iso) {
  return zonedParts(iso, IST_TIME_ZONE).iso;
}

// Whole calendar days from the IST day it was posted to today (0 on the day).
function ageInDays(createdAt, todayIso) {
  const from = Date.parse(`${istDate(createdAt)}T00:00:00Z`);
  const to = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 0;
  return Math.round((to - from) / 86400000);
}

// Due on day 2, 4, 6 … after it was posted, while it is still open.
function postsDueForReminder(posts, todayIso) {
  return (posts || [])
    .filter(isOpenClientPost)
    .map((p) => ({ ...p, age: ageInDays(p.created_at, todayIso) }))
    .filter((p) => p.age >= REMIND_EVERY_DAYS && p.age % REMIND_EVERY_DAYS === 0)
    .sort((a, b) => b.age - a.age);
}

// One email a day at most, whatever re-runs the cron.
function reminderKey(todayIso) {
  return `client-feedback-reminder:${todayIso}`;
}

module.exports = { REMIND_EVERY_DAYS, isOpenClientPost, ageInDays, postsDueForReminder, reminderKey };
