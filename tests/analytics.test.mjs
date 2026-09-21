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
  assert.match(full.kpiPeriod, /^Week of /);

  const sparse = f({ metrics_data: [] }, { metrics_data: [day(1), day(2)] }, { visitor_metrics: [] });
  assert.equal(sparse.kpis[0].value, '0');
  assert.equal(sparse.kpis[2].value, '–');           // <7 days of follower data
  assert.equal(sparse.kpis[2].arrow, '');            // <14 days → no trend
  assert.equal(sparse.hasPrevWeek, false);
  assert.equal(sparse.kpiPeriod, 'Last week');
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
  assert.match(out.kpiPeriod, /12 Jul/);
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
