// Website traffic from Google Analytics (26 Oct 2026): the week window, the client's
// ISO week keys, and the row Colony stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { weekWindow, isoYearWeek, buildWebsiteReport, WEEKS } = require('../netlify/functions/lib/website-analytics.js');

test('the window: last complete Monday-Sunday in IST, and the last three complete months', () => {
  // Monday 26 Oct 2026, 10:00 IST
  assert.deepEqual(weekWindow(new Date('2026-10-26T04:30:00Z')),
    { weekStart: '2026-10-19', weekEnd: '2026-10-25', spanStart: '2026-08-03', monthStart: '2026-07-01', monthEnd: '2026-09-30' });
  // Sunday night 23:30 IST is still the week before
  assert.equal(weekWindow(new Date('2026-10-25T18:00:00Z')).weekEnd, '2026-10-18');
  // 00:30 IST Monday (Sunday 19:00 UTC) already counts as Monday
  assert.equal(weekWindow(new Date('2026-10-25T19:00:00Z')).weekEnd, '2026-10-25');
  // A month counts once the last full week reaches its final day
  assert.equal(weekWindow(new Date('2026-11-02T04:30:00Z')).monthEnd, '2026-10-31');
  assert.equal(weekWindow(new Date('2026-08-31T04:30:00Z')).monthEnd, '2026-07-31');
});

test('ISO week keys match the client isoYearIsoWeek, across a year end', () => {
  assert.equal(isoYearWeek('2026-10-19'), '202643');
  assert.equal(isoYearWeek('2026-12-28'), '202653');
  assert.equal(isoYearWeek('2027-01-04'), '202701');
  assert.equal(isoYearWeek('2024-12-30'), '202501');
});

const r = (dims, mets) => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: mets.map((value) => ({ value: String(value) })) });

test('the stored row: weeks oldest first with zeros for empty weeks; pages and sources per week and month', () => {
  const win = weekWindow(new Date('2026-10-26T04:30:00Z'));
  const row = buildWebsiteReport({
    weekly: { rows: [r(['202643'], [60, 50, 80, 120, 3840, 500]), r(['202642'], [40, 35, 50, 90, 2000, 300])] },
    monthly: { rows: [r(['202609'], [200, 180, 260, 480, 12000, 2000]), r(['202608'], [150, 140, 190, 330, 9000, 1500])] },
    weekPages: { rows: [r(['202643', '/', 'Your Agency'], [100, 55]), r(['202643', '/work', 'Work'], [20, 15]), r(['202643', '/', 'Your Agency | Home'], [5, 3]), r(['202642', '/', 'Your Agency'], [70, 35])] },
    monthPages: { rows: [r(['202609', '/', 'Your Agency'], [300, 150])] },
    weekSources: { rows: [r(['202643', 'Direct'], [30, 35]), r(['202643', 'Organic Social'], [20, 22])] },
    monthSources: { rows: [r(['202609', 'Direct'], [90, 100])] }
  }, win, '514000078', '2026-10-26T04:30:00.000Z');
  assert.equal(row.report_type, 'website');
  assert.equal(row.metrics_data.length, WEEKS);
  assert.deepEqual(row.metrics_data[WEEKS - 1], { week_start: '2026-10-19', week_end: '2026-10-25', users: 60, new_users: 50, sessions: 80, views: 120, events: 500, engagement_seconds: 3840, avg_engagement_seconds: 64 });
  assert.equal(row.metrics_data[0].users, 0);
  assert.deepEqual(row.demographics_data.months.map((m) => m.month), ['2026-08', '2026-09']);
  // a renamed page is one row, by path
  assert.deepEqual(row.demographics_data.pages.weeks['2026-10-19'][0], { path: '/', title: 'Your Agency', views: 105, users: 58 });
  assert.equal(row.demographics_data.pages.weeks['2026-10-12'][0].views, 70);
  assert.equal(row.demographics_data.pages.months['2026-09'][0].views, 300);
  assert.equal(row.demographics_data.sources.weeks['2026-10-19'][0].channel, 'Direct');
  assert.equal(row.posts_data, row.demographics_data.pages.weeks['2026-10-19']);
  assert.equal(row.data_through, '2026-10-25');
  assert.equal(row.uploaded_by, null);
});

test('the sync runs weekly, never daily', () => {
  const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const m = toml.match(/\[functions\."website-analytics-sync"\]\s*\n\s*schedule\s*=\s*"([^"]+)"/);
  assert.ok(m, 'no schedule');
  assert.match(m[1], /^\d+ \d+ \* \* [0-6]$/, 'must name one weekday');
});

test('Colony signs in to Google Analytics as itself, impersonating no one', () => {
  const src = readFileSync(new URL('../netlify/functions/lib/website-analytics.js', import.meta.url), 'utf8');
  assert.match(src, /googleAccessToken\(GA_SCOPE, \{ asSelf: true \}\)/);
  assert.match(src, /analytics\.readonly/);
});

// ── Google Search from Search Console (3 Nov 2026) ──
const { buildSearchBlock } = require('../netlify/functions/lib/search-console.js');

test('Search block: weeks and months summed from days; CTR and position from the sums', () => {
  const win = weekWindow(new Date('2026-11-02T04:30:00Z')); // week 26 Oct - 1 Nov; months Aug-Oct
  const weekStarts = ['2026-10-19', '2026-10-26'];
  const day = (date, clicks, impressions, position) => ({ keys: [date], clicks, impressions, position });
  const s = buildSearchBlock({
    daily: { rows: [day('2026-10-26', 3, 100, 2), day('2026-10-31', 1, 300, 10), day('2026-11-01', 0, 0, 0), day('2026-10-20', 2, 50, 4), day('2026-09-30', 5, 50, 1)] },
    queries: { rows: [{ keys: ['2026-10-26', 'youragency'], clicks: 2, impressions: 20, position: 1 }, { keys: ['2026-10-31', 'youragency'], clicks: 1, impressions: 30, position: 3 }, { keys: ['2026-10-31', 'pyse'], clicks: 0, impressions: 40, position: 9 }] },
    pages: { rows: [{ keys: ['2026-10-26', 'https://www.youragency.com/'], clicks: 3, impressions: 60, position: 2 }] }
  }, win, weekStarts, 'sc-domain:youragency.com', '2026-11-02T04:30:00.000Z');
  const last = s.weeks[1];
  assert.equal(last.week_start, '2026-10-26');
  assert.equal(last.clicks, 4);
  assert.equal(last.impressions, 400);
  assert.equal(last.ctr, 0.01);
  assert.equal(last.position, 8);              // (2*100 + 10*300) / 400, not (2+10)/2
  assert.equal(s.weeks[0].clicks, 2);
  assert.deepEqual(s.months.map(m => m.month), ['2026-08', '2026-09', '2026-10']);
  assert.equal(s.months[1].clicks, 5);
  assert.equal(s.months[2].clicks, 6);
  assert.equal(s.data_through, '2026-10-31');  // 1 Nov had no impressions
  const top = s.queries.weeks['2026-10-26'];
  assert.equal(top[0].key, 'youragency');
  assert.equal(top[0].clicks, 3);
  assert.equal(top[0].position, 2.2);          // (1*20 + 3*30) / 50
  assert.equal(s.pages.months['2026-10'][0].key, 'https://www.youragency.com/');
});
