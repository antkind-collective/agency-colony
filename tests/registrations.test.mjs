// Registrations from Rishi's media dashboard sheet (5 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { snapshotDate, buildRegistrationsReport, SHEETS_SCOPE } = require('../netlify/functions/lib/registrations.js');
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// Rishi's Campaign Results tab as read on 5 Nov 2026 (top rows).
const SHEET = [
  ['CAMPAIGN RESULTS', 'EXAMPLE COLLECTIVE MONTH 2026'],
  ['Reporting basis', 'Cumulative snapshots…'],
  [],
  ['Metric', 'As of 23 Oct 2026', 'As of 26 Oct 2026', 'As of 29 Oct 2026', 'As of 01 Nov 2026', 'As of 04 Nov 2026', 'As of 07 Nov 2026', 'As of 10 Nov 2026'],
  ['Impressions', '100,921', '359,932', '638,572', '901,791', '1,720,282'],
  ['Total number of form fills', '209', '243', '287', '306', '322']
];

test('snapshot dates read from "As of" headers', () => {
  assert.equal(snapshotDate('As of 04 Nov 2026'), '2026-11-04');
  assert.equal(snapshotDate('As of 1 Dec 2026'), '2026-12-01');
  assert.equal(snapshotDate('Campaign name'), '');
});

test('running total, new since last update, last 7 days; empty future columns ignored', () => {
  const r = buildRegistrationsReport(SHEET, { sheetTitle: 'GAM 2026 dashboard', now: new Date('2026-11-05T06:00:00Z') });
  assert.equal(r.report_type, 'registrations');
  assert.equal(r.metrics_data.length, 5);
  assert.deepEqual(r.metrics_data.map((x) => x.total), [209, 243, 287, 306, 322]);
  assert.deepEqual(r.metrics_data.map((x) => x.new), [null, 34, 44, 19, 16]);
  assert.equal(r.summary.total, 322);
  assert.equal(r.summary.as_of, '2026-11-04');
  assert.equal(r.summary.since_previous, 16);
  assert.equal(r.summary.previous_date, '2026-11-01');
  assert.equal(r.summary.last_7_days, 322 - 243, 'vs 26 Oct, the latest snapshot at least 7 days back');
  assert.equal(r.data_through, '2026-11-04');
  assert.ok(r.file_name && r.file_path, 'required columns set');
});

test('rows are found by label, so a moved row still works; a missing row says so', () => {
  const moved = [SHEET[5], ['x'], SHEET[3]];
  assert.equal(buildRegistrationsReport(moved).summary.total, 322);
  assert.throws(() => buildRegistrationsReport(SHEET.slice(0, 5)), /Total number of form fills/);
});

test('read-only: the sheets scope is readonly and nothing writes to the sheet', () => {
  assert.equal(SHEETS_SCOPE, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  const src = read('netlify/functions/lib/registrations.js');
  assert.doesNotMatch(src, /method: '(PUT|POST)'|:batchUpdate|values:append/);
});

test('refresh is superadmin-only; the Jotform pieces are gone', () => {
  assert.match(read('netlify/functions/registrations-refresh.js'), /callerIs\(token, 'is_superadmin'\)/);
  assert.ok(!existsSync(new URL('../netlify/functions/registrations-connect.js', import.meta.url)));
  assert.match(read('supabase/migrations/202611050003_drop_registration_sources.sql'), /drop table if exists app\.registration_sources/);
});

test('Colony: tab in test for the superadmin only, read daily', () => {
  const app = read('app.js');
  assert.match(app, /if \(grouped\.registrations && !registrationsVisible\(\)\) delete grouped\.registrations;/);
  assert.match(app, /isSuperadminUser\(\) \|\| \(state\.appConfig \|\| \{\}\)\.registrations_team === true/);
  assert.match(read('index.html'), /data-analytics-tab="registrations"/);
  assert.match(read('netlify.toml'), /\[functions\."registrations-sync"\]\n  schedule = "40 4 \* \* \*"/);
});
