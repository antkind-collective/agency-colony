// Website traffic from Google Analytics 4 (26 Oct 2026). Colony asks the GA4
// Data API directly, as its own service account (a Viewer on the property),
// once a week: the last complete Monday-Sunday in IST, the 11 weeks before
// it, and the last three complete months, so the tab can compare any of them. Stored as the client's 'website' analytics row.
//
// The week is the client's ISO week (Monday start), so users are counted once per
// week by Google, not summed from days (a person on two days is one visitor).
const { googleAccessToken } = require('./google-auth');
const { fetchSearchBlock } = require('./search-console');
const { zonedParts, IST_TIME_ZONE } = require('./config');

const GA_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const WEEKS = 12;
const TOP_PAGES = 10;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// The last complete Monday-Sunday before `now` (IST), the WEEKS-week span
// that ends with it, and the last three complete calendar months (for
// month-vs-month; a month still running is never compared).
function weekWindow(now = new Date()) {
  const p = zonedParts(now, IST_TIME_ZONE);
  const [y, m, d] = p.iso.split('-').map(Number);
  const thisMonday = Date.UTC(y, m - 1, d - ((p.day + 6) % 7));
  const lastMonday = thisMonday - 7 * 86400000;
  const weekEnd = isoDay(thisMonday - 86400000);
  const [ey, em] = weekEnd.split('-').map(Number);
  // A month is complete once the last full week reaches its last day.
  const endMonthDone = isoDay(Date.UTC(ey, em, 0)) === weekEnd;
  const lastMonthEnd = endMonthDone ? Date.UTC(ey, em, 0) : Date.UTC(ey, em - 1, 0);
  const lm = new Date(lastMonthEnd);
  return {
    weekStart: isoDay(lastMonday),
    weekEnd,
    spanStart: isoDay(lastMonday - (WEEKS - 1) * 7 * 86400000),
    monthStart: isoDay(Date.UTC(lm.getUTCFullYear(), lm.getUTCMonth() - 2, 1)),
    monthEnd: isoDay(lastMonthEnd)
  };
}

// ISO year + week of a Monday, as the client's isoYearIsoWeek prints it ("202643").
function isoYearWeek(mondayIso) {
  const t = Date.parse(`${mondayIso}T00:00:00Z`);
  const thursday = new Date(t + 3 * 86400000);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86400000)) + 1;
  return `${year}${String(week).padStart(2, '0')}`;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const rowsOf = (res) => (res?.rows || []).map((r) => ({
  dims: (r.dimensionValues || []).map((v) => v.value),
  mets: (r.metricValues || []).map((v) => num(v.value))
}));
const ym = (v) => `${String(v).slice(0, 4)}-${String(v).slice(4, 6)}`; // the client "202609" -> "2026-09"

function kpis([users, newUsers, sessions, views, engagement, events]) {
  return { users, new_users: newUsers, sessions, views, events, engagement_seconds: engagement,
    avg_engagement_seconds: users ? Math.round(engagement / users) : 0 };
}

// Rows of [bucket, path, title, views, users] -> { bucket: top pages }. One
// path can come back under two titles (a renamed page): merged by path.
function pagesByBucket(res, bucketOf) {
  const out = {};
  for (const r of rowsOf(res)) {
    const b = bucketOf(r.dims[0]);
    const list = (out[b] = out[b] || []);
    const hit = list.find((x) => x.path === r.dims[1]);
    if (hit) { hit.views += r.mets[0]; hit.users += r.mets[1]; } else list.push({ path: r.dims[1], title: r.dims[2], views: r.mets[0], users: r.mets[1] });
  }
  for (const b of Object.keys(out)) out[b] = out[b].sort((x, y) => y.views - x.views).slice(0, TOP_PAGES);
  return out;
}

function sourcesByBucket(res, bucketOf) {
  const out = {};
  for (const r of rowsOf(res)) {
    const b = bucketOf(r.dims[0]);
    (out[b] = out[b] || []).push({ channel: r.dims[1], users: r.mets[0], sessions: r.mets[1] });
  }
  for (const b of Object.keys(out)) out[b].sort((x, y) => y.users - x.users);
  return out;
}

// The the client answers -> the row Colony stores.
//   metrics_data       12 weeks, oldest first; a week nobody visited is zeros
//   demographics_data  { months: [3 complete months], pages: {weeks, months},
//                        sources: {weeks, months} }, keyed by week start /
//                        "YYYY-MM", so any period can be compared
//   posts_data         last week's top pages (what older readers expect)
// Users are the client's own count per week or month (a person on two days is one
// visitor); they are never summed across buckets here.
function buildWebsiteReport(res, win, propertyId, nowIso = new Date().toISOString()) {
  const weekStarts = [];
  for (let i = WEEKS - 1; i >= 0; i -= 1) weekStarts.push(isoDay(Date.parse(`${win.weekStart}T00:00:00Z`) - i * 7 * 86400000));
  const startOfIsoWeek = new Map(weekStarts.map((w) => [isoYearWeek(w), w]));
  const weekOf = (k) => startOfIsoWeek.get(k) || k;
  const byWeek = new Map(rowsOf(res.weekly).map((r) => [r.dims[0], r.mets]));
  const weeks = weekStarts.map((start) => ({
    week_start: start,
    week_end: isoDay(Date.parse(`${start}T00:00:00Z`) + 6 * 86400000),
    ...kpis(byWeek.get(isoYearWeek(start)) || [0, 0, 0, 0, 0, 0])
  }));
  const months = rowsOf(res.monthly).map((r) => ({ month: ym(r.dims[0]), ...kpis(r.mets) }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const pages = { weeks: pagesByBucket(res.weekPages, weekOf), months: pagesByBucket(res.monthPages, ym) };
  const sources = { weeks: sourcesByBucket(res.weekSources, weekOf), months: sourcesByBucket(res.monthSources, ym) };
  return {
    report_type: 'website',
    report_label: 'Website (Google Analytics)',
    file_name: 'Google Analytics, weekly',
    file_path: `ga4:properties/${propertyId}`,
    metrics_data: weeks,
    posts_data: pages.weeks[win.weekStart] || [],
    demographics_data: { months, pages, sources },
    summary: { property_id: String(propertyId), week_start: win.weekStart, week_end: win.weekEnd, synced_at: nowIso },
    data_through: win.weekEnd,
    uploaded_by: null,
    uploaded_at: nowIso
  };
}

async function runReport(token, propertyId, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Analytics: ${json.error?.message || res.status}`);
  return json;
}

const KPI_METRICS = ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'userEngagementDuration', 'eventCount'].map((name) => ({ name }));

async function fetchWebsiteReport(propertyId, now = new Date()) {
  const token = await googleAccessToken(GA_SCOPE, { asSelf: true });
  const win = weekWindow(now);
  const span = [{ startDate: win.spanStart, endDate: win.weekEnd }];
  const monthSpan = [{ startDate: win.monthStart, endDate: win.monthEnd }];
  const pagesBy = (dim, dateRanges) => runReport(token, propertyId, {
    dateRanges,
    dimensions: [{ name: dim }, { name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 5000
  });
  const sourcesBy = (dim, dateRanges) => runReport(token, propertyId, {
    dateRanges,
    dimensions: [{ name: dim }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
    limit: 1000
  });
  const [weekly, monthly, weekPages, monthPages, weekSources, monthSources] = await Promise.all([
    runReport(token, propertyId, { dateRanges: span, dimensions: [{ name: 'isoYearIsoWeek' }], metrics: KPI_METRICS, limit: 100 }),
    runReport(token, propertyId, { dateRanges: monthSpan, dimensions: [{ name: 'yearMonth' }], metrics: KPI_METRICS, limit: 100 }),
    pagesBy('isoYearIsoWeek', span), pagesBy('yearMonth', monthSpan),
    sourcesBy('isoYearIsoWeek', span), sourcesBy('yearMonth', monthSpan)
  ]);
  return buildWebsiteReport({ weekly, monthly, weekPages, monthPages, weekSources, monthSources }, win, propertyId);
}

// Every configured client, one upsert each. Returns a summary for the
// heartbeat; one client failing never stops the others.
async function syncWebsiteAnalytics(admin, now = new Date()) {
  const summary = { clients: 0, synced: [], errors: [] };
  const { data } = await admin.from('app_config').select('value').eq('key', 'website_analytics').maybeSingle();
  const map = data?.value && typeof data.value === 'object' ? data.value : {};
  for (const [clientId, cfg] of Object.entries(map)) {
    summary.clients += 1;
    const propertyId = String(cfg?.property_id || '');
    if (!/^\d+$/.test(propertyId)) { summary.errors.push(`${clientId}: no property id`); continue; }
    try {
      const row = await fetchWebsiteReport(propertyId, now);
      // Google Search (Search Console), when the client has a site set
      // (cfg.search_site, e.g. "sc-domain:youragency.com"). If it fails, last
      // week's Search block stays and the error is noted; the client still saves.
      if (cfg?.search_site) {
        try {
          row.demographics_data.search = await fetchSearchBlock(String(cfg.search_site), weekWindow(now), row.metrics_data.map((w) => w.week_start));
        } catch (e) {
          const { data: prev } = await admin.from('client_analytics').select('demographics_data')
            .eq('client_id', clientId).eq('report_type', 'website').maybeSingle();
          row.demographics_data.search = { ...(prev?.demographics_data?.search || { site: String(cfg.search_site) }), error: e.message };
          summary.errors.push(`${clientId} search: ${e.message}`);
        }
      }
      const { error } = await admin.from('client_analytics')
        .upsert({ client_id: clientId, ...row }, { onConflict: 'client_id,report_type' });
      if (error) throw new Error(error.message);
      summary.synced.push({ clientId, week: `${row.summary.week_start}..${row.summary.week_end}`, users: row.metrics_data[WEEKS - 1].users,
        ...(row.demographics_data.search?.weeks ? { search_clicks: row.demographics_data.search.weeks[WEEKS - 1].clicks } : {}) });
    } catch (e) {
      summary.errors.push(`${clientId}: ${e.message}`);
    }
  }
  return summary;
}

module.exports = { GA_SCOPE, WEEKS, weekWindow, isoYearWeek, buildWebsiteReport, fetchWebsiteReport, syncWebsiteAnalytics };
