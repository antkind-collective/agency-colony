// Google Search from Search Console (3 Nov 2026). The same Monday pull as
// Google Analytics: Colony's service account, added as a user on the Search
// Console property, asks the Search Analytics API for clicks, impressions and
// position. Stored inside the client's 'website' row (demographics_data.search)
// so the Website tab shows both, and a Search failure never costs the the client data.
//
// Search Console's own per-query numbers leave out rare (anonymised) queries,
// so the queries table adds up to less than the totals. Daily totals come from
// the date-only query, which includes them.
//
// Rates follow Colony's rule (2 Nov 2026): sum the counts, then divide.
// CTR = clicks / impressions; position = impression-weighted average.
const { googleAccessToken } = require('./google-auth');

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOP_ROWS = 10;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Weighted sums so any set of days can be combined exactly.
function addRow(t, r) {
  const impressions = num(r.impressions);
  t.clicks += num(r.clicks);
  t.impressions += impressions;
  t.position_sum += num(r.position) * impressions;
  return t;
}
const blank = () => ({ clicks: 0, impressions: 0, position_sum: 0 });
function finish(t) {
  return { clicks: t.clicks, impressions: t.impressions, position_sum: t.position_sum,
    ctr: t.impressions ? t.clicks / t.impressions : 0,
    position: t.impressions ? t.position_sum / t.impressions : 0 };
}

// Top queries or pages per bucket from [date, key] rows.
function topByBucket(rows, bucketsOf) {
  const out = {};
  for (const r of rows || []) {
    const [date, key] = r.keys || [];
    for (const b of bucketsOf(date)) {
      const m = (out[b] = out[b] || new Map());
      addRow(m.get(key) || m.set(key, blank()).get(key), r);
    }
  }
  const res = {};
  for (const [b, m] of Object.entries(out)) {
    res[b] = [...m.entries()].map(([key, t]) => ({ key, ...finish(t) }))
      .sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions).slice(0, TOP_ROWS);
  }
  return res;
}

// The Search Console answers -> the block stored as demographics_data.search.
//   weeks   the same Monday weeks as the client's metrics_data, oldest first (zeros if none)
//   months  the same complete months as the client's
//   queries / pages  { weeks: {week_start: top}, months: {"YYYY-MM": top} }
function buildSearchBlock(res, win, weekStarts, site, nowIso = new Date().toISOString()) {
  const weekOf = (d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    const day = new Date(t).getUTCDay();
    return isoDay(t - ((day + 6) % 7) * 86400000);
  };
  const wanted = new Set(weekStarts);
  const months = [];
  for (let t = Date.parse(`${win.monthStart}T00:00:00Z`); isoDay(t) <= win.monthEnd;) {
    const d = new Date(t);
    months.push(isoDay(t).slice(0, 7));
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  const monthSet = new Set(months);
  const bucketsOf = (date) => {
    const out = [];
    const w = weekOf(date);
    if (wanted.has(w) && date <= win.weekEnd) out.push(w);
    const m = String(date).slice(0, 7);
    if (monthSet.has(m) && date <= win.monthEnd) out.push(m);
    return out;
  };
  const totals = {};
  let dataThrough = '';
  for (const r of res.daily?.rows || []) {
    const date = (r.keys || [])[0];
    if (!date) continue;
    if (num(r.impressions) > 0 && date > dataThrough) dataThrough = date;
    for (const b of bucketsOf(date)) addRow(totals[b] || (totals[b] = blank()), r);
  }
  return {
    site,
    weeks: weekStarts.map((w) => ({ week_start: w, ...finish(totals[w] || blank()) })),
    months: months.map((m) => ({ month: m, ...finish(totals[m] || blank()) })),
    queries: splitBuckets(topByBucket(res.queries?.rows, bucketsOf)),
    pages: splitBuckets(topByBucket(res.pages?.rows, bucketsOf)),
    data_through: dataThrough || null,
    synced_at: nowIso
  };
}
const splitBuckets = (all) => {
  const weeks = {}, months = {};
  for (const [k, v] of Object.entries(all)) (k.length === 7 ? months : weeks)[k] = v;
  return { weeks, months };
};

async function searchQuery(token, site, body) {
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Search Console: ${json.error?.message || res.status}`);
  return json;
}

// dataState 'all' includes the last day or two, which Search Console still
// marks fresh on a Monday morning; next Monday's pull replaces them.
async function fetchSearchBlock(site, win, weekStarts) {
  const token = await googleAccessToken(GSC_SCOPE, { asSelf: true });
  const startDate = [weekStarts[0], win.monthStart].sort()[0];
  const endDate = [win.weekEnd, win.monthEnd].sort()[1];
  const q = (dimensions) => searchQuery(token, site, { startDate, endDate, dimensions, dataState: 'all', rowLimit: 25000 });
  const [daily, queries, pages] = await Promise.all([q(['date']), q(['date', 'query']), q(['date', 'page'])]);
  return buildSearchBlock({ daily, queries, pages }, win, weekStarts, site);
}

module.exports = { GSC_SCOPE, buildSearchBlock, fetchSearchBlock };
