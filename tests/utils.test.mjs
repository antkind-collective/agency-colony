// First tests in the project. js/utils.js and js/config.js are classic
// browser scripts (no exports), so we load them into a Node vm context and
// test the globals they define. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object });
for (const file of ['js/config.js', 'js/utils.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
const u = (name) => vm.runInContext(name, ctx);

// ── taskTitleKey — must mirror the DB's lower(task_title) unique index ──
test('taskTitleKey lowercases and trims', () => {
  assert.equal(u('taskTitleKey')('  Fix The Deck  '), 'fix the deck');
  assert.equal(u('taskTitleKey')('ALL CAPS'), 'all caps');
});

test('taskTitleKey handles null/undefined/empty', () => {
  assert.equal(u('taskTitleKey')(null), '');
  assert.equal(u('taskTitleKey')(undefined), '');
  assert.equal(u('taskTitleKey')(''), '');
});

// ── date round-trips ──
test('toISODateLocal/parseIsoDateLocal round-trip', () => {
  const iso = '2026-06-10';
  const d = u('parseIsoDateLocal')(iso);
  assert.equal(u('toISODateLocal')(d), iso);
});

test('parseIsoDateLocal rejects junk', () => {
  assert.equal(u('parseIsoDateLocal')('not a date'), null);
  assert.equal(u('parseIsoDateLocal')(''), null);
  assert.equal(u('parseIsoDateLocal')('2026-6-1'), null); // unpadded not accepted
});

test('formatTimestamp/parseTimestamp round-trip', () => {
  const d = new Date(2026, 5, 10, 14, 30, 0, 0); // 10 Jun 2026 2:30 PM
  const text = u('formatTimestamp')(d);
  assert.equal(text, '10 Jun 2026, 02:30 PM');
  assert.equal(u('parseTimestamp')(text).getTime(), d.getTime());
});

test('parseTimestamp midnight/noon meridiem edges', () => {
  assert.equal(u('parseTimestamp')('01 Jan 2026, 12:00 AM').getHours(), 0);
  assert.equal(u('parseTimestamp')('01 Jan 2026, 12:00 PM').getHours(), 12);
});

// ── ISO weeks ──
test('isoWeekMetaFromDate handles year boundaries', () => {
  // (field-wise asserts: vm-realm objects fail strict deepEqual on prototype)
  // 2026-01-01 is a Thursday → ISO week 1 of 2026
  const a = u('isoWeekMetaFromDate')(new Date(2026, 0, 1));
  assert.equal(a.year, 2026);
  assert.equal(a.week, 1);
  // 2027-01-01 is a Friday → ISO week 53 of 2026
  const b = u('isoWeekMetaFromDate')(new Date(2027, 0, 1));
  assert.equal(b.year, 2026);
  assert.equal(b.week, 53);
});

test('weekIdentifierFromIsoDate formats year-week', () => {
  assert.equal(u('weekIdentifierFromIsoDate')('2026-06-10'), '2026-W24');
  assert.equal(u('weekIdentifierFromIsoDate')('garbage'), '');
});

// ── percent formatting ──
test('formatPercent clamps to 0..100', () => {
  assert.equal(u('formatPercent')(150), '100%');
  assert.equal(u('formatPercent')(-5), '0%');
  assert.equal(u('formatPercent')(33.333), '33.33%');
  assert.equal(u('formatPercent')('nonsense'), '0%');
});

test('formatPercentRaw does not clamp', () => {
  assert.equal(u('formatPercentRaw')(150), '150%');
});

// ── escapeHtml — the XSS line of defense ──
test('escapeHtml escapes all five dangerous chars', () => {
  assert.equal(
    u('escapeHtml')(`<img src=x onerror="alert('&')">`),
    '&lt;img src=x onerror=&quot;alert(&#39;&amp;&#39;)&quot;&gt;'
  );
  assert.equal(u('escapeHtml')(null), '');
});

// ── normalizeEmail ──
test('normalizeEmail trims and lowercases', () => {
  assert.equal(u('normalizeEmail')('  admin@youragency.com '), 'admin@youragency.com');
});

// ── config sanity ──
test('PUBLIC_HOLIDAYS entries are well-formed and sorted', () => {
  const holidays = u('PUBLIC_HOLIDAYS');
  assert.ok(Array.isArray(holidays) && holidays.length > 0);
  for (const h of holidays) {
    assert.match(h.date, /^\d{4}-\d{2}-\d{2}$/, `bad date: ${h.date}`);
    assert.ok(h.name && typeof h.name === 'string');
  }
  const dates = Array.from(holidays, h => h.date);
  assert.deepEqual(dates, [...dates].sort(), 'holidays must stay sorted by date');
});

test('every enforced-access email is on the youragency domain', () => {
  const map = u('ENFORCED_ACCESS_BY_EMAIL');
  for (const [email, role] of Object.entries(map)) {
    assert.ok(email.endsWith('@youragency.com'), email);
    assert.ok(['admin', 'leadership', 'employee'].includes(role), role);
  }
});

// ── cronHealthStatus — scheduled-job health thresholds ──
test('cronHealthStatus: ok / late / dead boundaries per cadence', () => {
  const now = new Date('2026-06-10T12:00:00Z');
  const hoursAgo = (h) => new Date(now - h * 3600000).toISOString();
  const f = u('cronHealthStatus');
  // daily: 26h window
  assert.equal(f(hoursAgo(2), 'daily', now), 'ok');
  assert.equal(f(hoursAgo(25), 'daily', now), 'ok');
  assert.equal(f(hoursAgo(27), 'daily', now), 'late');
  assert.equal(f(hoursAgo(53), 'daily', now), 'dead');
  // weekly: 8d window
  assert.equal(f(hoursAgo(7 * 24), 'weekly', now), 'ok');
  assert.equal(f(hoursAgo(9 * 24), 'weekly', now), 'late');
  assert.equal(f(hoursAgo(17 * 24), 'weekly', now), 'dead');
  // monthly: 32d window
  assert.equal(f(hoursAgo(30 * 24), 'monthly', now), 'ok');
  assert.equal(f(hoursAgo(33 * 24), 'monthly', now), 'late');
  // no heartbeat at all
  assert.equal(f(null, 'daily', now), 'unknown');
  assert.equal(f('garbage', 'daily', now), 'unknown');
});

test('isFreshStamp: TTL boundaries and missing stamps', () => {
  const f = u('isFreshStamp');
  assert.equal(f(1000, 1500, 600), true);    // 500ms old, 600ms TTL
  assert.equal(f(1000, 1601, 600), false);   // 601ms old
  assert.equal(f(0, 1000, 600), false);      // no stamp
  assert.equal(f(undefined, 1000, 600), false);
});

test('taskLinkParts + taskTitleHtml: URL in description makes the TITLE clickable', () => {
  const p = u('taskLinkParts');
  assert.equal(p('plain text').url, null);
  const r = p('brief doc https://docs.google.com/d/abc here');
  assert.equal(r.url, 'https://docs.google.com/d/abc');
  assert.equal(r.displayDesc, 'brief doc here');
  const h = u('taskTitleHtml');
  assert.equal(h({ task_title: 'Edit deck', description: 'no link' }), 'Edit deck');
  const linked = h({ task_title: 'Edit <b>deck</b>', description: 'https://x.co/1' });
  assert.match(linked, /^<a href="https:\/\/x\.co\/1" target="_blank" rel="noopener"/);
  assert.match(linked, /Edit &lt;b&gt;deck&lt;\/b&gt; ↗/);  // title still escaped
});

// June 2026: inline-linkified task descriptions were replaced by "a URL in
// the description makes the task TITLE the link" (taskTitleHtml), and Alex
// restated that preference on 20 Sep. This keeps the old approach from
// creeping back. `linkifyProse` (brief fields, comments, feedback posts) is a
// DIFFERENT, sanctioned helper — prose has no title to carry the link.
test('OLD linkify removed', () => {
  assert.equal(vm.runInContext('typeof linkifyText', ctx), 'undefined');
  assert.equal(vm.runInContext('typeof linkifyProse', ctx), 'function');
});

// ── timezoneForCity — the city picker IS the city→timezone mapping ──
test('timezoneForCity maps canonical cities to their IANA zone', () => {
  const f = u('timezoneForCity');
  assert.equal(f('Mumbai'), 'Asia/Kolkata');
  assert.equal(f('Tokyo'), 'Asia/Tokyo');
  assert.equal(f('Lisbon'), 'Europe/Lisbon');
  assert.equal(f('New York'), 'America/New_York');
});

test('timezoneForCity matches case- and whitespace-insensitively', () => {
  const f = u('timezoneForCity');
  // Genuine matches against CITY_OPTIONS, just sloppily cased/padded — these
  // must resolve via the list, not via the fallback. Asserted against a
  // non-default zone so a silent fall-through to Asia/Kolkata cannot pass.
  assert.equal(f('tokyo'), 'Asia/Tokyo');
  assert.equal(f('  TOKYO  '), 'Asia/Tokyo');
  assert.equal(f('lIsBoN'), 'Europe/Lisbon');
});

test('cityEntryFor resolves aliases to the canonical city', () => {
  const f = u('cityEntryFor');
  // Renames must not nag someone who was never wrong.
  assert.equal(f('Gurgaon').city, 'Gurugram');
  assert.equal(f('gurgaon').city, 'Gurugram');
  assert.equal(f('Calicut, Kerala').city, 'Kozhikode');
  assert.equal(f('Bombay').city, 'Mumbai');
  assert.equal(f('Bangalore').city, 'Bengaluru');
  assert.equal(f('New Delhi').city, 'Delhi');
});

test('cityEntryFor returns null for a city it cannot place — it must ask, not guess', () => {
  const f = u('cityEntryFor');
  assert.equal(f('Atlantis'), null);
  assert.equal(f(''), null);
  assert.equal(f(null), null);
  assert.equal(f(undefined), null);
});

test('timezoneForCity floors to the default but never throws', () => {
  const f = u('timezoneForCity');
  // The UI prompts instead of trusting this; it exists so an unplaceable city
  // can never stop a profile saving or crash a cron.
  assert.equal(f('Atlantis'), 'Asia/Kolkata');
  assert.equal(f(''), 'Asia/Kolkata');
  assert.equal(f(null), 'Asia/Kolkata');
});

test('every city on the live roster resolves — nobody gets prompted needlessly', () => {
  // The actual current_city values in prod as of 17 Jul 2026. If a future edit
  // to CITY_OPTIONS drops one of these, a real person gets asked to re-pick a
  // city they already answered correctly.
  const roster = ['Benaulim', 'Calicut, Kerala', 'Delhi', 'Ghaziabad', 'Goa',
    'gurgaon', 'Kochi', 'Kolkata', 'Lucknow', 'Mumbai', 'Sikar', 'Tokyo', 'Tura'];
  const f = u('cityEntryFor');
  for (const city of roster) {
    assert.ok(f(city), `roster city no longer resolves: ${city}`);
  }
  // ...and each lands on the zone that person is actually in.
  assert.equal(u('timezoneForCity')('Tokyo'), 'Asia/Tokyo');
  for (const city of roster.filter((c) => c !== 'Tokyo')) {
    assert.equal(u('timezoneForCity')(city), 'Asia/Kolkata', city);
  }
});

test('every CITY_OPTIONS entry carries a zone the runtime accepts', () => {
  const cities = vm.runInContext('CITY_OPTIONS', ctx);
  assert.ok(cities.length > 20);
  for (const { city, tz, group } of cities) {
    assert.ok(city && tz && group, `incomplete entry: ${JSON.stringify({ city, tz, group })}`);
    // Would throw RangeError on a typo'd zone — which is exactly what would
    // crash the nudge loop in production.
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-CA', { timeZone: tz }), `bad zone: ${tz}`);
  }
});

test('CITY_OPTIONS has no duplicate cities', () => {
  const cities = vm.runInContext('CITY_OPTIONS', ctx).map((o) => o.city.toLowerCase());
  assert.equal(new Set(cities).size, cities.length);
});

// ── resolvePartnerOrg — the org decides what a partner reads (S3, 24 Sep 2026) ──
test('resolvePartnerOrg never defaults an org', () => {
  const r = u('resolvePartnerOrg');
  assert.ok(r('', ['Example Collective']).error);
  assert.ok(r('   ', ['Example Collective']).error);
  assert.ok(r(null).error);
});
test('resolvePartnerOrg snaps case/space variants to the known spelling', () => {
  const r = u('resolvePartnerOrg');
  assert.deepEqual({ ...r(' example  collective ', ['Example Collective', 'RM']) }, { org: 'Example Collective', isNew: false });
});
test('resolvePartnerOrg reports an unknown org as new', () => {
  const r = u('resolvePartnerOrg');
  assert.deepEqual({ ...r('Acme Foundation', ['Example Collective']) }, { org: 'Acme Foundation', isNew: true });
});

// ── compareByFirstName — people pickers are alphabetical by first name (P3) ──
test('no people picker sorts by surname any more', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
});
