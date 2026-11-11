// Tests for js/analytics.js pure helpers (the parsers need XLSX + File APIs —
// they're exercised in-browser; see slice-6 verification).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object, Array, JSON, Map, Set, Promise, isNaN, parseFloat, isFinite });
for (const file of ['js/utils.js', 'js/analytics.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
const u = (n) => vm.runInContext(n, ctx);

test('fmtAnalytics / pctAnalytics format compactly', () => {
  assert.equal(u('fmtAnalytics')(1500000), '1.5M');
  assert.equal(u('fmtAnalytics')(2300), '2.3K');
  assert.equal(u('fmtAnalytics')(42), '42');
  assert.equal(u('pctAnalytics')(0.034), '3.4%'); // input is a fraction
});

test('normalizeDateStr handles slash dates', () => {
  assert.equal(u('normalizeDateStr')('6/9/2026'), '2026-06-09');
  assert.equal(u('normalizeDateStr')('2026-06-09'), '2026-06-09');
});

test('mergeByKey: idempotent re-upload semantics (incoming wins, no dupes)', () => {
  const f = u('mergeByKey');
  const merged = f([{ k: 'a', v: 1 }, { k: 'b', v: 2 }], [{ k: 'b', v: 99 }, { k: 'c', v: 3 }], vm.runInContext('(r) => r.k', ctx));
  assert.equal(merged.length, 3);
  assert.equal(merged.find(r => r.k === 'b').v, 99);
});

test('aggregateWeeklyToMonthly groups weeks into months', () => {
  const monthly = u('aggregateWeeklyToMonthly')([
    { week: '2026-05-04', 'Impressions (total)': 10, 'Clicks (total)': 1, 'Reactions (total)': 0, 'Comments (total)': 0, 'Reposts (total)': 0, 'New followers (total)': 2, 'Engagement rate (total)': 1, 'Posts': 1 },
    { week: '2026-05-11', 'Impressions (total)': 20, 'Clicks (total)': 2, 'Reactions (total)': 0, 'Comments (total)': 0, 'Reposts (total)': 0, 'New followers (total)': 3, 'Engagement rate (total)': 2, 'Posts': 1 },
    { week: '2026-06-01', 'Impressions (total)': 5, 'Clicks (total)': 1, 'Reactions (total)': 0, 'Comments (total)': 0, 'Reposts (total)': 0, 'New followers (total)': 1, 'Engagement rate (total)': 3, 'Posts': 1 }
  ]);
  assert.equal(monthly.length, 2);
  const may = monthly.find(m => String(m.month || m.week || '').startsWith('2026-05'));
  assert.ok(may, JSON.stringify(monthly[0]));
  assert.equal(may['Impressions (total)'], 30);
});

test('trendArrow: carries % change, not just direction', () => {
  const f = u('trendArrow');
  // "up" alone reads the same for +0.4% and +140% — the arrow must say by how much
  assert.match(f(10, 5), /trend-up/);
  // magnitude only — the arrow already carries the direction, and "↑ +162%"
  // made the widest snapshot tiles wrap
  assert.match(f(10, 5), /↑ 100%/);
  assert.doesNotMatch(f(10, 5), /\+100%/);
  assert.match(f(5, 10), /trend-down/);
  assert.match(f(5, 10), /50%/);
  assert.equal(f(5, 5), '');
  assert.equal(f(0, 0), '');
  // no baseline → "new", not a bare arrow that looks broken next to siblings
  assert.match(f(10, 0), /new/);
  assert.doesNotMatch(f(10, 0), /%/);
  // past ~4x the baseline, % yells — show a multiplier at speaking volume
  assert.match(f(162, 6), /↑ 27×/);
  assert.doesNotMatch(f(162, 6), /%/);
});

test('pctDeltaLabel: signed, honest about missing baselines', () => {
  const f = u('pctDeltaLabel');
  assert.equal(f(150, 100), '+50%');
  assert.equal(f(150, 10), '+15\u00d7');  // capped to multiplier
  assert.equal(f(45, 10), '+4.5\u00d7');
  assert.equal(f(90, 100), '\u221210%');
  assert.equal(f(104, 100), '+4%');
  assert.equal(f(100, 100), null);
  assert.equal(f(10, 0), null); // no baseline, no invented infinity
});

test('weekLabelAnalytics normalizes slash dates and labels day-month', () => {
  const f = u('weekLabelAnalytics');
  assert.equal(f('2026-06-08'), f('6/8/2026'));
  assert.match(f('2026-06-08'), /08|8/);
  assert.equal(f('garbage'), 'garbage');
});

test('computeOverviewKpis: week-on-week + 7-day windows + sparse-data guards', () => {
  const f = u('computeOverviewKpis');
  const day = (total) => ({ total, overview_unique: total });
  const full = f(
    { metrics_data: [
        { week: '2026-06-01', 'Impressions (organic)': 100, 'Engagement rate (total)': 0.05 },
        { week: '2026-06-08', 'Impressions (organic)': 250, 'Engagement rate (total)': 0.04 }
      ] },
    { metrics_data: Array.from({ length: 14 }, (_, i) => day(i < 7 ? 1 : 3)) },   // prev 7×1, recent 7×3
    { visitor_metrics: Array.from({ length: 14 }, (_, i) => day(i < 7 ? 5 : 2)) } // prev 35, recent 14
  );
  assert.equal(full.kpis[0].value, '250');           // latest week impressions
  assert.match(full.kpis[0].arrow, /trend-up/);      // 250 > 100
  assert.match(full.kpis[1].arrow, /trend-down/);    // 0.04 < 0.05
  // Rate metric: delta in percentage POINTS, never relative % — 0.05→0.04 is
  // "↓ 1 pt", not "↓ 20%" (the 162%-vs-11.24-points confusion, 23 Jul 2026)
  assert.match(full.kpis[1].arrow, /1 pt/);
  assert.doesNotMatch(full.kpis[1].arrow, /%/);
  assert.equal(full.kpis[2].value, '+21');           // recent followers 7×3
  assert.match(full.kpis[2].arrow, /trend-up/);      // 21 > 7
  assert.match(full.kpis[3].arrow, /trend-down/);    // 14 < 35
  assert.equal(full.hasPrevWeek, true);
  assert.equal(full.kpiPeriod, '8–14 Jun');
  assert.equal(full.comparePeriod, '1–7 Jun');

  const sparse = f({ metrics_data: [] }, { metrics_data: [day(1), day(2)] }, { visitor_metrics: [] });
  assert.equal(sparse.kpis[0].value, '0');
  assert.equal(sparse.kpis[2].value, '–');           // <7 days of follower data
  assert.equal(sparse.kpis[2].arrow, '');            // <14 days → no trend
  assert.equal(sparse.hasPrevWeek, false);
  assert.equal(sparse.kpiPeriod, 'Last week');
});

test('computeOverviewKpis: followers and visitors cover the same dates as the KPI week', () => {
  const f = u('computeOverviewKpis');
  const days = (from, n, v) => Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), total: v(i), overview_unique: v(i) };
  });
  // Content weeks 20 Sep and 27 Sep (Sun–Sat); daily data runs on to 7 Oct.
  const out = f({ metrics_data: [{ week: '2026-09-20', 'Impressions (organic)': 1 }, { week: '2026-09-27', 'Impressions (organic)': 2 }] },
    { metrics_data: days('2026-09-20', 18, (i) => (i < 7 ? 1 : i < 14 ? 2 : 100)) },
    { visitor_metrics: days('2026-09-20', 18, () => 1) }, '2026-10-09');
  assert.equal(out.kpiPeriod, '27 Sept – 3 Oct');
  assert.equal(out.comparePeriod, '20–26 Sept');
  assert.equal(out.kpis[2].value, '+14');            // 27 Sep–3 Oct only, not the 4–7 Oct days
  assert.match(out.kpis[2].arrow, /trend-up/);       // 14 vs 7
  assert.equal(out.kpis[3].value, '7');
  // Daily data that stops before the week ends shows no number for it.
  const short = f({ metrics_data: [{ week: '2026-09-20' }, { week: '2026-09-27' }] }, { metrics_data: days('2026-09-20', 10, () => 1) }, { visitor_metrics: [] }, '2026-10-09');
  assert.equal(short.kpis[2].value, '–');
});

test('excelSerialToIso: serials, serial-strings, ISO strings, junk', () => {
  const f = u('excelSerialToIso');
  assert.equal(f(45947), '2025-10-17');            // real send date from the the client workbook
  assert.equal(f('46164'), '2026-05-22');          // serial as string
  assert.equal(f('2026-06-03T01:38:33-04:00'), '2026-06-03'); // LeadConnector ISO
  assert.equal(f(''), '');
  assert.equal(f('Total clicks: 1219'), '');       // footnote rows must not parse
});

test('parseCommunityPulseRows: sends parsed, footnotes dropped, summary computed', () => {
  const f = u('parseCommunityPulseRows');
  const parsed = f(JSON.parse(JSON.stringify({
    sends: [
      { 'Date': 45947, 'Email Name': 'the client Newsletter', 'Type': 'Newsletter', 'Delivered (#)': 1000, 'Delivered (%)': 0.97, 'Opened (#)': 480, 'Open Rate (%)': 0.48, 'Clicked (#)': 30, 'Click Rate (%)': 0.03, 'Unsubscribed (#)': 5, 'Hard Bounce (#)': 10, 'Skipped (#)': 20 },
      { 'Date': 46147, 'Email Name': 'Dispatches', 'Type': 'Dispatches', 'Delivered (#)': 1000, 'Delivered (%)': 0.96, 'Opened (#)': 540, 'Open Rate (%)': 0.54, 'Clicked (#)': 200, 'Click Rate (%)': 0.20, 'Unsubscribed (#)': 1, 'Hard Bounce (#)': 8, 'Skipped (#)': 30 },
      { 'Date': 'Total clicks: 99 | Unique clicks: 50' } // hand-typed footnote row
    ],
    subscribers: [
      { 'Created': '2026-05-01T10:00:00-04:00', 'Region': 'Africa', 'Country': 'Kenya' },
      { 'Created': '2026-06-02T10:00:00-04:00', 'Region': 'Asia', 'Country': 'India' }
    ],
    forum: [
      { 'Created On': 46128, 'Region': 'Europe', 'Country': 'Iceland', 'Gender': '', 'Domain of Work': 'Art & Culture,Activism', 'Source': 'Artivism_Forum_Sign_Up' },
      { 'Created On': 45773, 'Region': 'Africa', 'Country': 'N/A​', 'Gender': 'Female', 'Domain of Work': 'Artist', 'Source': '' }
    ]
  })));
  assert.equal(parsed.metrics_data.length, 2);            // footnote dropped
  assert.equal(parsed.metrics_data[0].date, '2025-10-17');
  assert.equal(parsed.summary.total_sends, 2);
  assert.equal(parsed.summary.subscribers, 2);
  assert.equal(parsed.summary.forum_members, 2);
  // weighted rates: (480+540)/2000, (30+200)/2000
  assert.equal(parsed.summary.open_rate, 0.51);
  assert.equal(parsed.summary.click_rate, 0.115);
  assert.equal(parsed.summary.by_type.Dispatches.click_rate, 0.2);
  // demographics: domain splitting + N/A cleaning
  const domains = parsed.demographics_data.forum.by_domain.map(d => d.name);
  assert.ok(domains.includes('Activism') && domains.includes('Artist'));
  const countries = parsed.demographics_data.forum.by_country.map(c => c.name);
  assert.ok(!countries.some(c => /n\/?a/i.test(c)));      // N/A + zero-width space stripped
  assert.equal(parsed.demographics_data.subscribers.growth_by_month.length, 2);
});

test('parseInstagramMetricsRows: real Meta Insights CSV shape (title, Date/Primary, serial dates)', () => {
  const f = u('parseInstagramMetricsRows');
  const parsed = f(JSON.parse(JSON.stringify([
    ['Instagram follows', ''],
    ['Date', 'Primary'],
    [46143, 3],
    [46144, 4],
    [46148, 248],
    ['', '']            // trailing empty row from the export
  ])));
  assert.equal(parsed.metric, 'follows');
  assert.equal(parsed.metricLabel, 'follows');
  assert.equal(parsed.daily.length, 3);
  assert.equal(parsed.daily[0].date, '2026-05-01');   // serial 46143
  assert.equal(parsed.daily[2].value, 248);
  // multi-word metric names normalize to safe keys
  const visits = f(JSON.parse(JSON.stringify([['Instagram profile visits', ''], ['Date', 'Primary'], [46143, 10]])));
  assert.equal(visits.metric, 'profile_visits');
  // real-export title variants WITHOUT the "Instagram" prefix (Reach.csv,
  // Views.csv, Interactions.csv all ship bare titles)
  assert.equal(f(JSON.parse(JSON.stringify([['Reach', ''], ['Date', 'Primary'], [46143, 113]]))).metric, 'reach');
  assert.equal(f(JSON.parse(JSON.stringify([['Views', ''], ['Date', 'Primary'], [46143, 444]]))).metric, 'views');
  assert.equal(f(JSON.parse(JSON.stringify([['Content interactions', ''], ['Date', 'Primary'], [46143, 25]]))).metric, 'content_interactions');
  assert.equal(f(JSON.parse(JSON.stringify([['Instagram link clicks', ''], ['Date', 'Primary'], [46143, 0]]))).metric, 'link_clicks');
  // structure is the gate: no Date/Primary header, or no/absurd title → null
  assert.equal(f(JSON.parse(JSON.stringify([['Reach', ''], ['Day', 'Value'], [46143, 1]]))), null);
  assert.equal(f(JSON.parse(JSON.stringify([['', ''], ['Date', 'Primary'], [46143, 1]]))), null);
  assert.equal(f(JSON.parse(JSON.stringify([['x'.repeat(80), ''], ['Date', 'Primary'], [46143, 1]]))), null);
});

test('computeDataThrough: coverage end per report type, both date formats', () => {
  const f = u('computeDataThrough');
  // content: weekly rows cover through week END (+6 days)
  assert.equal(f('content', { metricsData: [{ week: '2026-06-28' }, { week: '2026-07-05' }] }), '2026-07-11');
  // followers/visitors: last daily date, incl. legacy MM/DD/YYYY rows
  assert.equal(f('followers', { metricsData: [{ date: '03/01/2026' }, { date: '02/15/2026' }] }), '2026-03-01');
  assert.equal(f('visitors', { visitorMetrics: [{ date: '2026-07-06' }] }), '2026-07-06');
  // instagram: max of post dates and daily-metric dates
  assert.equal(f('instagram', {
    postsData: [{ publish_time: '2026-06-25T10:00:00' }, { date: '2026-06-29' }],
    metricsData: [{ date: '2026-06-30' }]
  }), '2026-06-30');
  // community: last send
  assert.equal(f('community_pulse', { summary: { date_to: '2026-05-28' } }), '2026-05-28');
  // empties → null
  assert.equal(f('content', { metricsData: [] }), null);
  assert.equal(f('instagram', {}), null);
});

// ── Instagram comparison windows — the semantics behind "vs what?" ──
// Build 6 Monday-aligned weeks of synthetic daily data ending Sun 2026-07-19,
// plus 3 in-progress days (Mon 20 – Wed 22) that must be EXCLUDED.
function makeDaily() {
  const rows = [];
  const start = new Date('2026-06-08T00:00:00Z'); // a Monday
  for (let i = 0; i < 45; i++) { // through Wed 22 Jul
    const d = new Date(start); d.setUTCDate(d.getUTCDate() + i);
    rows.push({ date: d.toISOString().slice(0, 10), views: 100 + i, follows: i % 7 });
  }
  return rows;
}

test('igComparisonWindows wow: last FULL week vs previous, in-progress days excluded', () => {
  const win = u('igComparisonWindows')(makeDaily(), 'wow');
  assert.equal(win.a.startIso, '2026-07-13'); // Mon of last COMPLETE week
  assert.equal(win.a.endIso, '2026-07-19');
  assert.equal(win.b.startIso, '2026-07-06');
  assert.equal(win.a.rows.length, 7);
  assert.equal(win.b.rows.length, 7);
  // the partial week (20-22 Jul) must be excluded AND said out loud
  assert.match(win.note, /in progress/i);
  // totals: views are 100+i, week A covers i=35..41 → 135+...+141 = 966
  assert.equal(win.a.totals.views, 966);
  assert.equal(win.b.totals.views, 917);
});

test('igComparisonWindows wo4: average baseline, no fake daily shape', () => {
  const win = u('igComparisonWindows')(makeDaily(), 'wo4');
  assert.equal(win.a.startIso, '2026-07-13');
  assert.equal(win.b.rows, null); // an average has no single week to draw
  assert.match(win.b.label, /average/);
  // avg of weeks starting 15 Jun, 22 Jun, 29 Jun, 6 Jul → views avgs
  assert.ok(Math.abs(win.b.totals.views - (770 + 819 + 868 + 917) / 4) < 0.01);
});

test('igComparisonWindows mom: last full month vs previous', () => {
  // data spans 8 Jun – 22 Jul: June is the last full month ONLY if fully
  // covered — it isn't (starts the 8th), but the rule is calendar-based:
  // July is in progress, so A = June (whatever rows exist), B = May → no May
  // rows → null (not enough history), which is the honest answer.
  assert.equal(u('igComparisonWindows')(makeDaily(), 'mom'), null);
});

test('igComparisonWindows: empty and unknown modes fail closed', () => {
  assert.equal(u('igComparisonWindows')([], 'wow'), null);
  assert.equal(u('igComparisonWindows')(makeDaily(), 'all'), null);
  assert.equal(u('igComparisonWindows')(makeDaily(), 'nonsense'), null);
});

test('igCustomWeekWindows: any date snaps to its Monday week', () => {
  const win = u('igCustomWeekWindows')(makeDaily(), '2026-07-15', '2026-06-11');
  assert.equal(win.a.startIso, '2026-07-13'); // Wed 15 Jul → its Monday
  assert.equal(win.b.startIso, '2026-06-08'); // Thu 11 Jun → its Monday
  assert.equal(win.a.rows.length, 7);
  // missing picks → null, caller shows a prompt instead
  assert.equal(u('igCustomWeekWindows')(makeDaily(), '', '2026-06-11'), null);
});

test('sumMetricRows: missing metrics stay missing, not zero', () => {
  const t = u('sumMetricRows')([{ date: 'x', a: 1 }, { date: 'y', a: 2, b: 5 }]);
  assert.equal(t.a, 3);
  assert.equal(t.b, 5);
  assert.ok(!('date' in t));
});

test('trendArrowPoints: rate deltas are percentage points, not relative %', () => {
  const f = u('trendArrowPoints');
  // The real the client numbers that caused the confusion: 6.96% → 18.2% showed
  // "↑ 162%" while the AI brief said "+11.24 points" about the same move.
  assert.match(f(0.18200161, 0.06958022), /trend-up/);
  assert.match(f(0.18200161, 0.06958022), /↑ 11.2 pts/);
  assert.doesNotMatch(f(0.18200161, 0.06958022), /%/);
  assert.match(f(0.04, 0.05), /↓ 1 pt<\/span>/); // singular
  assert.equal(f(0.05, 0.05), '');
  assert.equal(f(0, 0), '');
  // from zero: points still work where relative % couldn't (no baseline trap)
  assert.match(f(0.03, 0), /↑ 3 pts/);
});

test('precomputeRowDeltas: counts get %, rates get points, model gets no math to do', () => {
  const f = u('precomputeRowDeltas');
  const d = f(
    { 'Impressions (organic)': 13092, 'Engagement rate (total)': 0.0696, 'Clicks (total)': 0, week: '2026-07-12' },
    { 'Impressions (organic)': 4528, 'Engagement rate (total)': 0.182, 'Clicks (total)': 0, week: '2026-07-19' }
  );
  assert.equal(d['Impressions (organic)'], '-8,564 (−65%)'); // the exact number haiku kept botching
  assert.equal(d['Engagement rate (total)'], '+11.24 percentage points');
  assert.ok(!('Clicks (total)' in d)); // no change → no line
  assert.ok(!('week' in d));           // non-numeric keys skipped
});

// ── LinkedIn weekly comparison — complete weeks only ──
function makeWeekly() {
  // Sunday-keyed 7-day buckets ending 2026-07-19..25 (in progress on the 24th)
  return ['2026-06-14','2026-06-21','2026-06-28','2026-07-05','2026-07-12','2026-07-19']
    .map((week, i) => ({ week, 'Impressions (organic)': 1000 * (i + 1), 'Engagement rate (total)': 0.05 + i * 0.01, 'Posts': i + 1 }));
}
const TODAY = '2026-07-24';

test('trimInProgressWeek drops the bucket that spans past today', () => {
  const t = u('trimInProgressWeek')(makeWeekly(), TODAY);
  assert.equal(t.length, 5);
  assert.equal(t[t.length - 1].week, '2026-07-12'); // ends 18 Jul < today
  // nothing dropped when all weeks are complete
  assert.equal(u('trimInProgressWeek')(makeWeekly(), '2026-08-01').length, 6);
});

test('liComparisonWindows wow: last COMPLETE week vs previous, with the note', () => {
  const w = u('liComparisonWindows')(makeWeekly(), 'wow', TODAY);
  assert.equal(w.a.startIso, '2026-07-12'); // NOT the in-progress 07-19
  assert.equal(w.b.startIso, '2026-07-05');
  assert.match(w.note, /19–25 Jul.*in progress/); // human dates, not DB keys
  assert.equal(w.a.totals['Impressions (organic)'], 5000);
});

test('liComparisonWindows wo4: average of the four prior complete weeks', () => {
  const w = u('liComparisonWindows')(makeWeekly(), 'wo4', TODAY);
  assert.equal(w.a.startIso, '2026-07-12');
  // prior four complete weeks: 1000+2000+3000+4000 / 4
  assert.equal(w.b.totals['Impressions (organic)'], 2500);
});

test('liComparisonWindows mom: current month excluded; needs two complete months', () => {
  // weeks span Jun+Jul, today is in Jul → only June is complete → null
  assert.equal(u('liComparisonWindows')(makeWeekly(), 'mom', TODAY), null);
});

test('liComparisonWindows custom: any two weeks incl. in-progress, flagged', () => {
  const w = u('liComparisonWindows')(makeWeekly(), 'custom', TODAY, '2026-07-19', '2026-06-14');
  assert.equal(w.a.totals['Posts'], 6);
  assert.match(w.note, /in progress/);
});

test('computeOverviewKpis ignores the in-progress bucket', () => {
  const f = u('computeOverviewKpis');
  const out = f({ metrics_data: makeWeekly() }, { metrics_data: [] }, { visitor_metrics: [] }, TODAY);
  assert.equal(out.kpis[0].value, '5.0K');            // wk of 07-12, not 6000
  assert.equal(out.weekInProgress, '2026-07-19');     // surfaced for the note
  assert.equal(out.kpiPeriod, '12–18 Jul');
});

// ── Comms DOCX ingest — heading dates and section/image pairing ──
test('parseCommsHeading: both date orders, Dispatch and Newsletter', () => {
  const f = u('parseCommsHeading');
  // field-wise: vm-realm objects fail strict deepEqual on prototype
  const h = f('May 5 2026 Dispatch');
  assert.equal(h.dateIso, '2026-05-05');
  assert.equal(h.sendType, 'Dispatch');
  assert.equal(f('7 July 2026 Newsletter').dateIso, '2026-07-07');
  assert.equal(f('8 July 2026 Dispatch').sendType, 'Dispatch');
  // non-headings must not match
  assert.equal(f('Link: https://x'), null);
  assert.equal(f('Engagement Summary in percentage:'), null);
  assert.equal(f(''), null);
});

test('parseCommsDocxStructure: headings partition; images follow their heading', () => {
  const doc = `
    <w:p><w:t>May 5 2026 Dispatch</w:t></w:p>
    <w:p><w:t>Link: x</w:t></w:p>
    <w:p><w:drawing r:embed="rId4"/></w:p>
    <w:p><w:drawing r:embed="rId5"/></w:p>
    <w:p><w:t>7 July 2026 Newsletter</w:t></w:p>
    <w:p><w:drawing r:embed="rId6"/></w:p>
    <w:p><w:t>May 22 2026 Newsletter</w:t></w:p>`;
  const rels = `<Relationship Id="rId4" Type="t" Target="media/image1.png"/>
    <Relationship Id="rId5" Type="t" Target="media/image2.png"/>
    <Relationship Id="rId6" Type="t" Target="media/image3.png"/>`;
  const sends = u('parseCommsDocxStructure')(doc, rels);
  assert.equal(sends.length, 2); // May 22 has no images → dropped
  assert.equal(sends[0].imagePaths.join(','), 'word/media/image1.png,word/media/image2.png');
  assert.equal(sends[1].imagePaths.join(','), 'word/media/image3.png');
  assert.equal(sends[1].dateIso, '2026-07-07');
});

test('parseCommsDocxSections: a tabbed Google Doc export, one send per section (27 Oct 2026)', () => {
  const doc = `
    <w:p><w:r><w:t>Link</w:t></w:r><w:r><w:t>: </w:t></w:r><w:r><w:t>https://link.msgsndr.com/email-preview/LOC1/JKwE1L8jMCZ2A0GgOHpv?time_stamp=1777980137607</w:t></w:r></w:p>
    <w:p><w:t>Time: 16.50 IST</w:t></w:p>
    <w:p><w:drawing r:embed="rId4"/></w:p>
    <w:p><w:drawing r:embed="rId5"/><w:pPr><w:sectPr/></w:pPr></w:p>
    <w:p><w:t>Link: </w:t><w:hyperlink r:id="rId9"><w:r><w:t>Example Collective Matters</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:t>Time: 11 PM</w:t></w:p>
    <w:p><w:drawing r:embed="rId6"/><w:pPr><w:sectPr/></w:pPr></w:p>
    <w:p><w:t>Link:</w:t></w:p>
    <w:p><w:t>Time: 8 PM</w:t></w:p>
    <w:p><w:drawing r:embed="rId7"/></w:p>
    <w:p><w:t>Time:</w:t></w:p>`;
  const rels = `<Relationship Id="rId4" Type="t" Target="media/image1.png"/>
    <Relationship Id="rId5" Type="t" Target="media/image2.png"/>
    <Relationship Id="rId6" Type="t" Target="media/image3.png"/>
    <Relationship Id="rId7" Type="t" Target="media/image4.png"/>
    <Relationship Id="rId9" Type="h" Target="https://link.msgsndr.com/email-preview/LOC1/HKc6yr7shhLKjnyzOmOI?time_stamp=1779470000000&amp;x=1" TargetMode="External"/>`;
  const sends = JSON.parse(JSON.stringify(u('parseCommsDocxSections')(doc, rels)));
  assert.equal(sends.length, 3); // the last "Time:" has no screenshots → not a send
  assert.equal(sends[0].imagePaths.join(','), 'word/media/image1.png,word/media/image2.png');
  assert.equal(sends[0].linkId, 'JKwE1L8jMCZ2A0GgOHpv');
  assert.equal(sends[0].dateIso, '2026-05-05');
  assert.equal(sends[0].time, '16.50 IST');
  assert.equal(sends[1].linkId, 'HKc6yr7shhLKjnyzOmOI', 'a hyperlinked Link: resolves through the rels');
  assert.equal(sends[2].linkId, '');
  assert.equal(sends[2].dateIso, '', 'no link, no date: the uploader fills it in');
  assert.equal(sends[2].imagePaths.join(','), 'word/media/image4.png');
});

test('commsLinkDate is the IST date; commsSendName matches the names the client already has', () => {
  assert.equal(u('commsLinkDate')('https://x/email-preview/a/b?time_stamp=1777980137607'), '2026-05-05');
  assert.equal(u('commsLinkDate')('https://x/email-preview/a/b?time_stamp=1784917800000'), '2026-07-25'); // 00:00 IST, 24 Jul 18:30 UTC
  assert.equal(u('commsLinkDate')(''), '');
  assert.equal(u('commsSendName')('2026-07-23', 'Dispatches'), '23 July 2026 Dispatch');
  assert.equal(u('commsSendName')('2026-05-05', 'Newsletter'), '5 May 2026 Newsletter');
});

test('parseStoredUploadName: timestamp prefix → date, rest is the name', () => {
  const f = u('parseStoredUploadName');
  const r = f('1753357294307_Comms_ Ongoing report.docx');
  assert.equal(r.displayName, 'Comms_ Ongoing report.docx');
  assert.equal(r.dateIso, '2025-07-24'); // 1753357294307 ms
  // names without the prefix (hand-placed files) pass through un-mangled
  assert.equal(f('plain.xlsx').displayName, 'plain.xlsx');
  assert.equal(f('plain.xlsx').dateIso, null);
});

// ── excelSerialToIso: a reporting date carries no timezone ────────────────
// Meta's per-metric CSVs hand SheetJS "2026-04-01T00:00:00" as a plain string.
// new Date() reads a zoneless datetime as LOCAL, and toISOString() then
// converts to UTC — so east of UTC every daily figure was filed one day early.
// Found 10 Sep 2026 against a real Example Collective export: the file opened on
// 1 Apr and Colony stored 31 Mar. These run under TZ=Asia/Kolkata in CI-less
// local runs, which is where it actually bit.
test('excelSerialToIso keeps the date the file says, in any timezone', () => {
  const f = u('excelSerialToIso');
  assert.equal(f('2026-04-01T00:00:00'), '2026-04-01');
  assert.equal(f('2026-08-31T00:00:00'), '2026-08-31');
  // Space separator instead of T — same file, different Meta export vintage.
  assert.equal(f('2026-04-01 00:00:00'), '2026-04-01');
  // A bare date was already safe; keep it that way.
  assert.equal(f('2026-04-01'), '2026-04-01');
  // An explicit zone must still be respected, not overwritten with Z.
  assert.equal(f('2026-04-01T23:00:00-05:00'), '2026-04-02');
  // Excel serials are unaffected.
  assert.equal(f(46113), '2026-04-01');
});

test('excelSerialToIso still rejects junk that V8 would happily parse', () => {
  const f = u('excelSerialToIso');
  assert.equal(f('Total clicks: 1219'), '');
  assert.equal(f(''), '');
  assert.equal(f(null), '');
});

// ── parseInstagramMetricsRows on the real Meta per-metric shape ───────────
test('parseInstagramMetricsRows reads a Meta per-metric export end to end', () => {
  const rows = [
    ['Facebook follows'],
    ['Date', 'Primary'],
    ['2026-04-01T00:00:00', '0'],
    ['2026-04-02T00:00:00', '3'],
    ['2026-04-03T00:00:00', '']
  ];
  const out = u('parseInstagramMetricsRows')(rows);
  // The brand is stripped from the KEY: "Facebook follows" and "Instagram
  // follows" are the same metric on different platforms, and the platform is
  // carried on the report, not baked into the column name.
  assert.equal(out.metric, 'follows');
  assert.equal(out.metricLabel, 'follows');
  assert.equal(out.platform, 'facebook');
  assert.equal(out.daily.map(d => d.date).join('|'), '2026-04-01|2026-04-02|2026-04-03');
  assert.equal(out.daily.map(d => d.value).join('|'), '0|3|0');
});

// ── Which platform did this file come from? ───────────────────────────────
test('metricsPlatformFromTitle names the platform only when the file does', () => {
  const f = u('metricsPlatformFromTitle');
  assert.equal(f('Facebook follows'), 'facebook');
  assert.equal(f('Facebook visits'), 'facebook');
  assert.equal(f('Facebook link clicks'), 'facebook');
  assert.equal(f('Instagram follows'), 'instagram');
  // The shared metric names carry no platform at all. Guessing these is what
  // would have merged the client's Facebook numbers into their Instagram ones.
  assert.equal(f('Viewers'), null);
  assert.equal(f('Content interactions'), null);
  assert.equal(f('Reach'), null);
  assert.equal(f('Views'), null);
  assert.equal(f(''), null);
  assert.equal(f(null), null);
  // Substring matches must not count — only the leading word.
  assert.equal(f('Clicks to Facebook'), null);
});

test('computeDataThrough covers Facebook the same way as Instagram', () => {
  const f = u('computeDataThrough');
  const data = { metricsData: [{ date: '2026-08-30' }, { date: '2026-08-31' }], postsData: [] };
  assert.equal(f('facebook', data), '2026-08-31');
  assert.equal(f('instagram', data), '2026-08-31');
  // An unknown type still returns null rather than guessing.
  assert.equal(f('mystery', data), null);
});

// ── Meta upload: the platform question (18 Sep 2026) ──────────────
// A batch of per-metric CSVs asked which account it was once per FILE, worded
// like a failure — she reported it as "colony is unable to read the platform".
// These pin the rules that removed it.
test('a file that names its platform is never asked about', () => {
  assert.equal(u('metricsPlatformFromTitle')('Facebook follows'), 'facebook');
  assert.equal(u('metricsPlatformFromTitle')('Instagram link clicks'), 'instagram');
  // The shared ones carry no signal, so these are the files that must ask.
  assert.equal(u('metricsPlatformFromTitle')('Viewers'), null);
  assert.equal(u('metricsPlatformFromTitle')('Content interactions'), null);
});

test('the upload asks once per batch, and the archive labels both platforms', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  // The answer is remembered on the batch and reused, rather than re-asked.
  assert.match(app, /if \(!platform && batch\.platform\)/, 'batch answer is not reused');
  assert.match(app, /batch\.platform = platform/, 'answer is never remembered');
  assert.match(app, /processAnalyticsSpreadsheet\(sheets\[i\]\.file, batch\)/, 'batch not threaded through');
  // Worded as a question, not a failure.
  assert.doesNotMatch(app, /doesn't say which platform it's from — Meta names/, 'old error-style wording still present');
  // Facebook files must be identifiable in the uploaded-files archive.
  assert.match(app, /facebook: \['Facebook'/, 'archive has no Facebook label');
});

test('websiteComparison: the four LinkedIn modes over website weeks and months', () => {
  const wk = (start, users, views, eng) => ({ week_start: start, users, new_users: users - 5, sessions: users, views, events: 0, engagement_seconds: eng });
  const weeks = [wk('2026-09-21', 40, 80, 2400), wk('2026-09-28', 40, 80, 2400), wk('2026-10-05', 40, 80, 2400), wk('2026-10-12', 80, 160, 4800), wk('2026-10-19', 60, 120, 3840)];
  const report = { metrics_data: weeks, demographics_data: {
    months: [{ month: '2026-08', users: 150, views: 300, engagement_seconds: 9000 }, { month: '2026-09', users: 200, views: 400, engagement_seconds: 10000 }],
    pages: { weeks: { '2026-10-19': [{ path: '/', views: 100, users: 50 }], '2026-10-12': [{ path: '/', views: 60, users: 30 }], '2026-10-05': [{ path: '/', views: 20, users: 10 }, { path: '/work', views: 8, users: 4 }] }, months: { '2026-09': [{ path: '/', views: 300, users: 150 }] } },
    sources: { weeks: {}, months: {} } } };
  const f = u('websiteComparison');
  const wow = JSON.parse(JSON.stringify(f(report, 'wow')));
  assert.equal(wow.a.totals.users, 60);
  assert.equal(wow.a.totals.avg_engagement_seconds, 64);
  assert.equal(wow.b.totals.users, 80);
  assert.equal(wow.a.pages[0].views, 100);
  const wo4 = JSON.parse(JSON.stringify(f(report, 'wo4')));
  assert.equal(wo4.b.totals.users, 50, 'average of 40,40,40,80, never a sum');
  assert.equal(wo4.b.label, '4-week average');
  assert.deepEqual(wo4.b.pages.map((p) => [p.path, p.views]), [['/', 20], ['/work', 2]]);
  const mom = JSON.parse(JSON.stringify(f(report, 'mom')));
  assert.equal(mom.a.label, 'September 2026');
  assert.equal(mom.a.totals.avg_engagement_seconds, 50);
  assert.equal(mom.a.pages[0].views, 300);
  const custom = JSON.parse(JSON.stringify(f(report, 'custom', '2026-09-21', '2026-10-12')));
  assert.equal(custom.a.totals.users, 40);
  assert.equal(custom.b.totals.users, 80);
  assert.equal(f(report, 'custom', '2026-01-05', '2026-10-12'), null);
  assert.equal(f({ metrics_data: weeks.slice(0, 1), demographics_data: { months: [] } }, 'mom'), null);
});

test('AI summaries: reused while the data is the same, never once it has moved on (27 Oct 2026)', () => {
  const stamp = u('insightDataStamp'), usable = u('usableInsight');
  const reports = { content: { report_type: 'content', uploaded_at: '2026-10-19T04:30:00Z', data_through: '2026-10-18' },
    followers: { report_type: 'followers', uploaded_at: '2026-10-19T04:31:00Z', data_through: '2026-10-18' }, website: null };
  const s1 = stamp(reports);
  assert.equal(s1, stamp({ followers: reports.followers, content: reports.content }), 'order does not matter');
  const entry = { text: 'Impressions up 12%', stamp: s1, at: '2026-10-20T06:00:00Z' };
  assert.equal(usable(entry, s1).text, 'Impressions up 12%', 'same week: no new call');
  const nextWeek = stamp({ ...reports, followers: { ...reports.followers, uploaded_at: '2026-10-26T04:31:00Z', data_through: '2026-10-25' } });
  assert.notEqual(nextWeek, s1);
  assert.equal(usable(entry, nextWeek), null, 'any report moved on: the old summary is not shown');
  assert.equal(usable('Impressions up 12%', s1), null, 'pre-stamp plain-text summaries count as stale');
  assert.equal(usable({ text: '', stamp: s1 }, s1), null);
});

// ── LinkedIn engagement rate: sum the counts, then divide (2 Nov 2026) ──
test('liEngagementRate: (clicks + reactions + comments + reposts) ÷ impressions, summed first', () => {
  const f = u('liEngagementRate');
  const day = (impr, clicks) => ({ 'Impressions (total)': impr, 'Clicks (total)': clicks, 'Reactions (total)': 0, 'Comments (total)': 0, 'Reposts (total)': 0 });
  // LinkedIn's own row: 27 Oct 2025 in UIV's export, 77 ÷ 1601
  assert.equal(f({ 'Impressions (total)': 1601, 'Clicks (total)': 42, 'Reactions (total)': 34, 'Comments (total)': 1, 'Reposts (total)': 0 }).toFixed(6), '0.048095');
  // 50 impressions at 40% + 5,000 at 2%: averaging says 21%, summed is 2.4%
  assert.equal(f([day(50, 20), day(5000, 100)]).toFixed(4), '0.0238');
  // 0% and 0-impression days stay in the totals
  assert.equal(f([day(100, 10), day(100, 0), day(0, 0)]), 0.05);
  assert.equal(f([]), 0);
});

test('liWithRates recomputes stored averaged rates; rows without counts untouched', () => {
  const [a, b] = u('liWithRates')([
    { week: '2026-06-01', 'Impressions (total)': 200, 'Clicks (total)': 10, 'Reactions (total)': 10, 'Comments (total)': 0, 'Reposts (total)': 0, 'Engagement rate (total)': 0.5 },
    { week: '2026-06-08', 'Engagement rate (total)': 0.04 }
  ]);
  assert.equal(a['Engagement rate (total)'], 0.1);
  assert.equal(b['Engagement rate (total)'], 0.04);
});

test('aggregateWeeklyToMonthly splits a week across months by its days', () => {
  const d = (date, impr, clicks) => ({ date, 'Impressions (total)': impr, 'Clicks (total)': clicks, 'Reactions (total)': 0, 'Comments (total)': 0, 'Reposts (total)': 0, 'Posts': 0 });
  const months = u('aggregateWeeklyToMonthly')([{ week: '2026-08-30', 'Impressions (total)': 1100, 'Clicks (total)': 110,
    daily_counts: [d('2026-08-31', 100, 50), d('2026-09-01', 1000, 60)] }]);
  const aug = months.find(m => m.month === '2026-08'), sep = months.find(m => m.month === '2026-09');
  assert.equal(aug['Impressions (total)'], 100);
  assert.equal(aug['Engagement rate (total)'], 0.5);
  assert.equal(sep['Engagement rate (total)'], 0.06);
});

test('liComparisonWindows wo4: rate from the four weeks summed, totals carry no day rows', () => {
  const wk = (week, impr, clicks) => ({ week, 'Impressions (total)': impr, 'Clicks (total)': clicks, 'Reactions (total)': 0, 'Comments (total)': 0, 'Reposts (total)': 0, daily_counts: [] });
  const w = u('liComparisonWindows')([wk('2026-06-14', 100, 50), wk('2026-06-21', 900, 9), wk('2026-06-28', 1000, 10), wk('2026-07-05', 1000, 10), wk('2026-07-12', 1000, 30)], 'wo4', TODAY);
  // (50 + 9 + 10 + 10) ÷ 3,000 = 2.63%, not the 13.25% mean of the four rates
  assert.equal(w.b.totals['Engagement rate (total)'].toFixed(4), '0.0263');
  assert.ok(!('daily_counts' in w.a.totals));
});

test('liPostsEngagementRate: a group of posts sums its counts, not its post rates', () => {
  const post = (impr, clicks) => ({ 'Impressions': impr, 'Clicks': clicks, 'Likes': 0, 'Comments': 0, 'Reposts': 0, 'Engagement rate': clicks / impr });
  // 1 post at 50% on 20 impressions + 1 at 1% on 2,000: mean 25.5%, summed 1.5%
  assert.equal(u('liPostsEngagementRate')([post(20, 10), post(2000, 20)]).toFixed(4), '0.0149');
  assert.equal(u('liPostsEngagementRate')([]), 0);
});

test('liMergeWeeks: a partial first week adds its days instead of replacing the full week', () => {
  const d = (date, impr, clicks) => ({ date, 'Impressions (total)': impr, 'Clicks (total)': clicks, 'Reactions (total)': 0, 'Comments (total)': 0, 'Reposts (total)': 0, 'Posts': 0 });
  const wk = (days) => ({ week: '2026-09-20', daily_counts: days, ...Object.fromEntries(['Impressions (total)', 'Clicks (total)', 'Reactions (total)', 'Comments (total)', 'Reposts (total)', 'Posts'].map(k => [k, days.reduce((s, x) => s + x[k], 0)])) });
  const full = wk(['21', '22', '23', '24', '25', '26', '27'].map(n => d(`2026-09-${n}`, 100, 10)));
  const partial = wk([d('2026-09-26', 100, 30), d('2026-09-27', 100, 10)]); // a new export starting on the 26th
  const [m] = u('liMergeWeeks')([full], [partial]);
  assert.equal(m.daily_counts.length, 7);
  assert.equal(m['Impressions (total)'], 700);
  assert.equal(m['Clicks (total)'], 90);         // the 26th's revised 30 wins over 10
  assert.equal(m['Engagement rate (total)'].toFixed(4), '0.1286');
  // a stored week without days keeps its totals against a partial week…
  const legacy = { week: '2026-09-20', 'Impressions (total)': 700, 'Clicks (total)': 70 };
  assert.equal(u('liMergeWeeks')([legacy], [partial])[0]['Impressions (total)'], 700);
  // …and gives way to a complete one
  assert.equal(u('liMergeWeeks')([legacy], [full])[0].daily_counts.length, 7);
});

test('searchComparison: the 4-week baseline sums first, so CTR and position are the four weeks together', () => {
  const wk = (week_start, clicks, impressions, position) => ({ week_start, clicks, impressions, position_sum: position * impressions });
  const report = { demographics_data: { search: {
    weeks: [wk('2026-09-28', 10, 100, 5), wk('2026-10-05', 0, 900, 20), wk('2026-10-12', 10, 100, 5), wk('2026-10-19', 0, 900, 20), wk('2026-10-26', 5, 50, 3)],
    months: [], queries: { weeks: {} }, pages: { weeks: {} } } } };
  const w = u('searchComparison')(report, 'wo4');
  assert.equal(w.b.totals.clicks, 5);              // 20 / 4
  assert.equal(w.b.totals.ctr, 0.01);              // 20 / 2,000, not the 5% mean of four rates
  assert.equal(w.b.totals.position.toFixed(1), '18.5'); // impression-weighted
  assert.equal(w.a.totals.ctr, 0.1);
  assert.equal(u('searchComparison')({ demographics_data: {} }, 'wow'), null);
});

// Newsletter: Beehiiv subscriber export (3 Nov 2026).
const BH_HEADER = ['subscriber_id', 'api_subscription_id', 'email', 'tags', 'status', 'created_at', 'updated_at', 'unsubscribed_at', 'stripe_customer_id', 'referred_by', 'campaign', 'channel', 'acquisition_source', 'referring_url', 'acquisition_term', 'acquisition_content', 'device_type', 'total_revenue_cents', 'referral_count', 'total_sent', 'total_delivered', 'total_unique_opened', 'total_clicked', 'total_unique_clicked', 'open_rate', 'click_rate', 'last_opened_at', 'last_clicked_at', 'Free Tier', 'First Name', 'Last Name'];
const bh = (o) => BH_HEADER.map((h) => o[h] ?? '');
const BH_ROWS = [BH_HEADER,
  bh({ email: 'a@example.com', status: 'active', created_at: '2026-10-30 11:29:13 UTC', channel: 'website', acquisition_source: 'website: direct / ', total_delivered: '0', total_unique_opened: '0' }),
  bh({ email: 'b@example.com', status: 'active', created_at: '2026-10-30 15:52:03 UTC', channel: 'website', acquisition_source: 'website: linktr.ee / referral', referring_url: 'https://linktr.ee/', total_delivered: '1', total_unique_opened: '1' }),
  bh({ email: 'c@example.com', status: 'inactive', created_at: '2026-10-21 04:00:00 UTC', unsubscribed_at: '2026-11-02 05:00:00 UTC', acquisition_source: 'website: lnkd.in / referral', total_delivered: '3', total_unique_opened: '1', total_unique_clicked: '1' }),
  bh({ email: 'd@example.com', status: 'active', created_at: '2026-11-01 19:00:00 UTC', acquisition_source: 'website: l.instagram.com / referral', total_delivered: '0' })];

test('Beehiiv export: detected by its columns; personal columns stripped', () => {
  assert.equal(u('isBeehiivSubscriberHeader')(BH_HEADER), true);
  assert.equal(u('isBeehiivSubscriberHeader')(['Date', 'Impressions']), false);
  const stripped = u('stripBeehiivPersonalColumns')(BH_ROWS);
  assert.ok(!stripped[0].map((h) => h.toLowerCase()).some((h) => ['email', 'first name', 'last name'].includes(h)));
  assert.ok(!JSON.stringify(stripped).includes('@example.com'));
});

test('Beehiiv export: weeks, months, sources and rates (sum, then divide)', () => {
  const r = u('parseBeehiivSubscribers')(BH_ROWS, '2026-11-03');
  // Finished weeks only: exported Tue 3 Nov, so the week of 2 Nov is left
  // out. 1 Nov 19:00 UTC is 2 Nov 00:30 IST, so that sign-up falls in it.
  assert.deepEqual(JSON.parse(JSON.stringify(r.weeks)), [
    { week_start: '2026-10-19', new: 1, left: 0, subscribers: 1 },
    { week_start: '2026-10-26', new: 2, left: 0, subscribers: 3 }]);
  const later = u('parseBeehiivSubscribers')(BH_ROWS, '2026-11-09');
  assert.deepEqual(JSON.parse(JSON.stringify(later.weeks[2])), { week_start: '2026-11-02', new: 1, left: 1, subscribers: 3 });
  assert.equal(r.summary.subscribers, 3);
  assert.equal(r.summary.ever, 4);
  assert.equal(r.summary.left, 1);
  assert.equal(r.summary.open_rate, 2 / 4);
  assert.equal(r.summary.click_rate, 1 / 4);
  assert.deepEqual(JSON.parse(JSON.stringify(r.sources.all)), { Direct: 1, Linktree: 1, LinkedIn: 1, Instagram: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(r.months)), [{ month: '2026-10', new: 3, left: 0, subscribers: 3 }]);
  assert.equal(u('parseBeehiivSubscribers')(BH_ROWS, '2026-12-01').months.length, 2);
});

test('newsletterComparison: last week vs previous, month vs month', () => {
  const p = u('parseBeehiivSubscribers')(BH_ROWS, '2026-12-01');
  const report = { metrics_data: p.weeks, demographics_data: { months: p.months, sources: p.sources } };
  const wow = u('newsletterComparison')(report, 'wow');
  assert.equal(wow.a.key, '2026-11-23');
  const wo4 = u('newsletterComparison')(report, 'wo4');
  assert.equal(wo4.b.label, '4-week average');
  const mom = u('newsletterComparison')(report, 'mom');
  assert.equal(mom.a.key, '2026-11');
  assert.equal(mom.a.totals.new, 1);
  assert.equal(mom.a.totals.left, 1);
  assert.equal(mom.b.totals.subscribers, 3);
  assert.equal(u('newsletterComparison')({ metrics_data: [p.weeks[0]] }, 'wow'), null);
});

test('parseCsvText keeps text as text and handles quotes; toCsvText round-trips', () => {
  const rows = u('parseCsvText')('﻿a,b,c\r\n"x, y","say ""hi""",2026-10-30 11:29:13 UTC\n');
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [['a', 'b', 'c'], ['x, y', 'say "hi"', '2026-10-30 11:29:13 UTC']]);
  assert.deepEqual(JSON.parse(JSON.stringify(u('parseCsvText')(u('toCsvText')(rows)))), JSON.parse(JSON.stringify(rows)));
});
