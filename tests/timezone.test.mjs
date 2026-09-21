// Per-person clock helpers used by the crons (netlify/functions/lib/config.js).
// These decide WHO gets emailed WHEN, so the interesting cases are the ones the
// old hand-rolled `+5.5h` arithmetic got wrong: non-IST zones and DST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { zonedParts, zonedMidnightUtc, DEFAULT_TIME_ZONE } = require('../netlify/functions/lib/config.js');

// 05:30 UTC — the instant the nudge used to fire, once, for everyone.
const OLD_NUDGE_INSTANT = '2026-07-17T05:30:00Z'; // a Friday

test('zonedParts: the bug the timezone work exists to fix', () => {
  // 11:00 for Delhi...
  assert.equal(zonedParts(OLD_NUDGE_INSTANT, 'Asia/Kolkata').hour, 11);
  // ...but 14:30 for Anya in Tokyo, who was told "it's past 11 and your
  // tasklist hasn't heard from you" about a window that shut mid-morning.
  const tokyo = zonedParts(OLD_NUDGE_INSTANT, 'Asia/Tokyo');
  assert.equal(tokyo.hour, 14);
  assert.equal(tokyo.minute, 30);
});

test('zonedParts: reports the local calendar date, not the UTC one', () => {
  // 22:00 UTC Thursday is already Friday in Tokyo.
  const t = '2026-07-16T22:00:00Z';
  assert.equal(zonedParts(t, 'Asia/Tokyo').iso, '2026-07-17');
  assert.equal(zonedParts(t, 'Asia/Kolkata').iso, '2026-07-17');
  assert.equal(zonedParts(t, 'America/New_York').iso, '2026-07-16');
});

test('zonedParts: weekend is per-person — a Monday in Tokyo is Sunday in LA', () => {
  const t = '2026-07-20T02:00:00Z'; // Mon 11:00 Tokyo / Sun 19:00 Los Angeles
  const tokyo = zonedParts(t, 'Asia/Tokyo');
  const la = zonedParts(t, 'America/Los_Angeles');
  assert.equal(tokyo.day, 1);
  assert.equal(tokyo.isWeekend, false);
  assert.equal(la.day, 0);
  assert.equal(la.isWeekend, true);
});

test('zonedParts: midnight reports hour 0, never 24', () => {
  // hour12:false yields '24' for midnight in some ICU versions; hour === 24
  // would silently never match a nudge-hour test.
  assert.equal(zonedParts('2026-07-16T18:30:00Z', 'Asia/Kolkata').hour, 0);
});

test('zonedParts: an unknown zone falls back instead of throwing', () => {
  // Intl throws RangeError on a bad zone. Inside the nudge loop that would take
  // out everyone's nudge, not just the one bad row.
  const parts = zonedParts(OLD_NUDGE_INSTANT, 'Mars/Olympus');
  assert.equal(parts.zone, DEFAULT_TIME_ZONE);
  assert.equal(parts.hour, 11);
  assert.equal(zonedParts(OLD_NUDGE_INSTANT, null).zone, DEFAULT_TIME_ZONE);
  assert.equal(zonedParts(OLD_NUDGE_INSTANT, '').zone, DEFAULT_TIME_ZONE);
});

test('zonedMidnightUtc: the UTC instant each local day begins', () => {
  assert.equal(zonedMidnightUtc('2026-07-17', 'Asia/Kolkata'), '2026-07-16T18:30:00.000Z');
  assert.equal(zonedMidnightUtc('2026-07-17', 'Asia/Tokyo'), '2026-07-16T15:00:00.000Z');
  assert.equal(zonedMidnightUtc('2026-07-17', 'America/New_York'), '2026-07-17T04:00:00.000Z');
});

test('zonedMidnightUtc: follows DST rather than assuming a fixed offset', () => {
  // Lisbon is UTC+0 in January and UTC+1 in July. Offset arithmetic — the trick
  // the crons used — cannot express this; only the tz database can.
  assert.equal(zonedMidnightUtc('2026-01-15', 'Europe/Lisbon'), '2026-01-15T00:00:00.000Z');
  assert.equal(zonedMidnightUtc('2026-07-15', 'Europe/Lisbon'), '2026-07-14T23:00:00.000Z');
});

test('zonedMidnightUtc: unknown zone falls back to IST, matching zonedParts', () => {
  assert.equal(zonedMidnightUtc('2026-07-17', 'Mars/Olympus'), '2026-07-16T18:30:00.000Z');
});

// The cohort rule task-nudge applies, exercised end-to-end against the real
// half-hourly cron slots.
test('nudge cohort: every zone is reached exactly once per local day', () => {
  const zones = ['Asia/Kolkata', 'Asia/Tokyo', 'Europe/Lisbon', 'America/New_York', 'Australia/Sydney'];
  // Every :00 and :30 slot across one UTC day — the real cron.
  const slots = [];
  for (let h = 0; h < 24; h++) for (const m of [0, 30]) {
    slots.push(new Date(Date.UTC(2026, 6, 17, h, m)));
  }
  for (const zone of zones) {
    const hits = slots
      .map((t) => zonedParts(t, zone))
      .filter((p) => p.hour === 11);
    // Two hits per zone (11:00 and 11:30 local) — which is precisely why
    // task-nudge needs the already-sent-today guard to stay once-a-day.
    assert.equal(hits.length, 2, `${zone} matched ${hits.length} slots`);
    assert.equal(new Set(hits.map((h) => h.iso)).size, 1, `${zone} spans local days`);
  }
});

test('nudge cohort: an on-the-hour cron would never fire for India', () => {
  // Why the schedule is "0,30 * * * *" and not "0 * * * *": India is UTC+5:30,
  // so on-the-hour runs land at :30 past every IST hour, never at 11:00 sharp.
  const onTheHour = [];
  for (let h = 0; h < 24; h++) onTheHour.push(new Date(Date.UTC(2026, 6, 17, h, 0)));
  const exact = onTheHour
    .map((t) => zonedParts(t, 'Asia/Kolkata'))
    .filter((p) => p.hour === 11 && p.minute === 0);
  assert.equal(exact.length, 0);
});
