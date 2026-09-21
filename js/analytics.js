/* ── Your Agency analytics parsing: LinkedIn + Instagram report ingestion ──
   Classic script — loads after utils.js, before app.js. Relocated VERBATIM
   from app.js (modularization slice 6) — the full parser toolkit:
   - format helpers (fmtAnalytics, pctAnalytics, trendArrow, week/month labels)
   - normalizeDateStr, getReportCompareLabel, aggregateWeeklyToMonthly
   - parseLinkedInAnalytics / FollowersReport / VisitorsReport (content,
     followers, visitors exports; description-row vs header-row detection)
   - parseInstagramAnalytics (Meta Business Suite post export)
   - detectReportType — SHEET-NAME based by design: vendor xlsx.js sometimes
     can't read cells of real Meta .xls files, so never rely on cell content
     (CLAUDE.md → Analytics report types)
   - mergeByKey (idempotent re-upload merge by stable key)
   Uses the global XLSX (vendor/xlsx.js) and browser File APIs — not pure;
   pure format helpers are unit-tested in tests/analytics.test.mjs. */

// Format large numbers
function fmtAnalytics(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return Number(n).toLocaleString();
}

function pctAnalytics(n) {
  if (n == null || isNaN(n)) return '0%';
  return (n * 100).toFixed(1) + '%';
}

// Signed % change, formatted, or null when it can't be computed honestly
// (no baseline). Whole % at ≥10, one decimal below.
function pctDeltaLabel(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0) return null; // "+∞%" helps nobody; trendArrow says "new"
  // Past ~4x the baseline, relative % stops informing and starts yelling —
  // "↑ 2700%" against a 6-reaction week reads like a bug, not a win. Show a
  // multiplier instead: "27×" is the same fact at speaking volume.
  if (cur / prev >= 4) {
    const ratio = cur / prev;
    return `+${ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10}×`;
  }
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const mag = Math.abs(pct);
  const rounded = mag >= 10 ? Math.round(mag) : Math.round(mag * 10) / 10;
  if (rounded === 0) return null;
  return `${pct > 0 ? '+' : '−'}${rounded}%`;
}

// Delta for a metric that IS a percentage (engagement rate): percentage
// POINTS, not relative %. A rate moving 6.96% → 18.2% is "↑ 162%" relatively —
// arithmetically true and humanly misleading (it reads like the rate hit 162%,
// and it contradicted the AI brief saying "+11.24 points" about the same move
// — Alex, 23 Jul 2026). Inputs are FRACTIONS (0.182), matching pctAnalytics.
function trendArrowPoints(currentFrac, previousFrac) {
  const cur = Number(currentFrac) || 0;
  const prev = Number(previousFrac) || 0;
  if (cur === prev) return '';
  const pts = Math.round((cur - prev) * 1000) / 10; // fraction → points, 1dp
  if (pts === 0) return '';
  const mag = `${Math.abs(pts)} pt${Math.abs(pts) === 1 ? '' : 's'}`;
  return pts > 0
    ? ` <span class="trend-up">↑ ${mag}</span>`
    : ` <span class="trend-down">↓ ${mag}</span>`;
}

// A bare arrow says "up" without saying by how much — which reads the same for
// +0.4% and +140% (23 Jul 2026). Arrows carry the % whenever a baseline
// exists — MAGNITUDE only ("↑ 162%", not "↑ +162%"): the arrow already gives
// the direction, and the redundant sign made the widest tiles wrap.
function trendArrow(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0 && cur === 0) return '';
  // Zero baseline: a bare arrow next to siblings with percentages reads
  // broken. "new" is the honest word for it.
  if (prev === 0 && cur > 0) return ' <span class="trend-up">new</span>';
  const pct = pctDeltaLabel(cur, prev);
  const mag = pct ? pct.slice(1) : '';
  if (cur > prev) return ` <span class="trend-up">↑${mag ? ' ' + mag : ''}</span>`;
  if (cur < prev) return ` <span class="trend-down">↓${mag ? ' ' + mag : ''}</span>`;
  return '';
}

function weekLabelAnalytics(w) {
  let ds = String(w || '').trim();
  // Normalize MM/DD/YYYY → YYYY-MM-DD
  const m = ds.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) ds = m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  const d = new Date(ds + 'T00:00:00');
  if (isNaN(d.getTime())) return ds;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function monthLabelAnalytics(key) {
  const [y, m] = key.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

function normalizeDateStr(ds) {
  ds = String(ds || '').trim();
  const m = ds.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  return ds;
}

function getReportCompareLabel(report) {
  const weekly = report.metrics_data || [];
  if (weekly.length < 1) return report.report_label || 'No data';
  if (weekly.length < 2) return `Week of ${weekLabelAnalytics(weekly[0].week)}`;
  const latest = weekly[weekly.length - 1];
  const prev = weekly[weekly.length - 2];
  const now = new Date();
  const latestDate = new Date(normalizeDateStr(latest.week) + 'T00:00:00');
  const diffDays = Math.floor((now - latestDate) / (1000 * 60 * 60 * 24));
  if (diffDays >= 0 && diffDays < 7) return 'This week vs last week';
  return `Week of ${weekLabelAnalytics(latest.week)} vs ${weekLabelAnalytics(prev.week)}`;
}

function aggregateWeeklyToMonthly(weekly) {
  const map = new Map();
  weekly.forEach(w => {
    const monthKey = w.week.substring(0, 7);
    if (!map.has(monthKey)) {
      map.set(monthKey, {
        month: monthKey,
        'Impressions (organic)': 0, 'Impressions (sponsored)': 0, 'Impressions (total)': 0,
        'Clicks (total)': 0, 'Reactions (total)': 0, 'Comments (total)': 0, 'Reposts (total)': 0,
        'New followers (organic)': 0, 'New followers (sponsored)': 0, 'New followers (total)': 0,
        'Engagement rate (total)': 0, _engCount: 0, 'Posts': 0
      });
    }
    const m = map.get(monthKey);
    m['Posts'] += w['Posts'] || 0;
    m['Impressions (organic)'] += w['Impressions (organic)'] || 0;
    m['Impressions (sponsored)'] += w['Impressions (sponsored)'] || 0;
    m['Impressions (total)'] += w['Impressions (total)'] || 0;
    m['Clicks (total)'] += w['Clicks (total)'] || 0;
    m['Reactions (total)'] += w['Reactions (total)'] || 0;
    m['Comments (total)'] += w['Comments (total)'] || 0;
    m['Reposts (total)'] += w['Reposts (total)'] || 0;
    m['New followers (organic)'] += w['New followers (organic)'] || 0;
    m['New followers (sponsored)'] += w['New followers (sponsored)'] || 0;
    m['New followers (total)'] += w['New followers (total)'] || 0;
    const eng = w['Engagement rate (total)'] || 0;
    if (eng > 0) { m['Engagement rate (total)'] += eng; m._engCount++; }
  });
  const months = [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
  months.forEach(m => {
    if (m._engCount > 0) m['Engagement rate (total)'] /= m._engCount;
    delete m._engCount;
  });
  return months;
}

// --- XLS/CSV Parsing ---
function parseLinkedInAnalytics(file, existingWb) {
  return new Promise((resolve, reject) => {
    function doParse(wb) {
      try {
        // Find sheets — LinkedIn exports have "Metrics" and "All posts" (or similar names)
        const metricsSheetName = wb.SheetNames.find(s => /metric/i.test(s)) || wb.SheetNames[0];
        const postsSheetName = wb.SheetNames.find(s => /post/i.test(s)) || wb.SheetNames[1];

        // LinkedIn XLS has a description row 0, actual headers in row 1, data from row 2
        // Use header:1 to get raw arrays, then manually map using row 1 as keys
        function parseLinkedInSheet(ws) {
          if (!ws) return [];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          if (raw.length < 3) return [];
          // Row 0 = description, Row 1 = column headers, Row 2+ = data
          // But if row 0 looks like a short header (not a description), use it directly
          let headerIdx = 1;
          const r0First = String(raw[0][0] || '').trim();
          // If row 0 first cell is short (< 50 chars) and looks like a column name, use it as header
          if (r0First.length < 50 && (r0First === 'Date' || r0First === 'Post title')) {
            headerIdx = 0;
          }
          const headers = raw[headerIdx];
          const rows = [];
          for (let i = headerIdx + 1; i < raw.length; i++) {
            const obj = {};
            headers.forEach((h, idx) => { obj[String(h).trim()] = raw[i][idx] !== undefined ? raw[i][idx] : ''; });
            rows.push(obj);
          }
          return rows;
        }
        const metricsRaw = metricsSheetName ? parseLinkedInSheet(wb.Sheets[metricsSheetName]) : [];
        const postsRaw = postsSheetName ? parseLinkedInSheet(wb.Sheets[postsSheetName]) : [];

        // Aggregate metrics into weekly rollups
        const weeklyMap = new Map();
        metricsRaw.forEach(row => {
          // LinkedIn date column is usually "Date"
          let dateVal = row['Date'] || row['date'] || '';
          if (typeof dateVal === 'number') {
            // Excel serial date
            const d = new Date((dateVal - 25569) * 86400 * 1000);
            dateVal = d.toISOString().split('T')[0];
          } else if (dateVal instanceof Date) {
            dateVal = dateVal.toISOString().split('T')[0];
          } else {
            dateVal = String(dateVal).trim();
            // Convert MM/DD/YYYY to YYYY-MM-DD
            const slashParts = dateVal.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (slashParts) dateVal = slashParts[3] + '-' + slashParts[1].padStart(2, '0') + '-' + slashParts[2].padStart(2, '0');
          }
          if (!dateVal || dateVal.length < 8) return;

          // Compute week start (Monday)
          const dt = new Date(dateVal + 'T00:00:00');
          if (isNaN(dt.getTime())) return;
          const day = dt.getDay();
          const diff = day === 0 ? 6 : day - 1;
          const weekStart = new Date(dt);
          weekStart.setDate(dt.getDate() - diff);
          const weekKey = weekStart.toISOString().split('T')[0];

          if (!weeklyMap.has(weekKey)) {
            weeklyMap.set(weekKey, {
              week: weekKey,
              'Impressions (organic)': 0, 'Impressions (sponsored)': 0, 'Impressions (total)': 0,
              'Clicks (total)': 0, 'Reactions (total)': 0, 'Comments (total)': 0, 'Reposts (total)': 0,
              'New followers (organic)': 0, 'New followers (sponsored)': 0, 'New followers (total)': 0,
              'Engagement rate (total)': 0, _engCount: 0, 'Posts': 0
            });
          }
          const w = weeklyMap.get(weekKey);
          w['Impressions (organic)'] += Number(row['Impressions (organic)']) || 0;
          w['Impressions (sponsored)'] += Number(row['Impressions (sponsored)']) || 0;
          w['Impressions (total)'] += Number(row['Impressions (total)']) || Number(row['Impressions (organic)']) || 0;
          w['Clicks (total)'] += Number(row['Clicks (total)']) || 0;
          w['Reactions (total)'] += Number(row['Reactions (total)']) || 0;
          w['Comments (total)'] += Number(row['Comments (total)']) || 0;
          w['Reposts (total)'] += Number(row['Reposts (total)']) || 0;
          w['New followers (organic)'] += Number(row['New followers (organic)']) || 0;
          w['New followers (sponsored)'] += Number(row['New followers (sponsored)']) || 0;
          w['New followers (total)'] += Number(row['New followers (total)']) || Number(row['New followers (organic)']) || 0;
          const eng = Number(row['Engagement rate (total)']) || Number(row['Engagement rate (organic)']) || 0;
          if (eng > 0) { w['Engagement rate (total)'] += eng; w._engCount++; }
        });

        // Average out engagement rates
        const weekly = [...weeklyMap.values()].sort((a, b) => a.week.localeCompare(b.week));
        weekly.forEach(w => {
          if (w._engCount > 0) w['Engagement rate (total)'] /= w._engCount;
          delete w._engCount;
        });

        // Parse posts
        const posts = postsRaw.map(row => {
          const impressions = Number(row['Impressions']) || 0;
          const clicks = Number(row['Clicks']) || 0;
          const likes = Number(row['Likes']) || 0;
          const comments = Number(row['Comments']) || 0;
          const reposts = Number(row['Reposts']) || 0;
          const engRate = Number(row['Engagement rate']) || 0;
          const engScore = likes + comments * 2 + reposts * 3;

          let createdDate = row['Created date'] || '';
          let postWeekKey = '';
          if (typeof createdDate === 'number') {
            const d = new Date((createdDate - 25569) * 86400 * 1000);
            createdDate = d.toLocaleDateString('en-IN', { month: '2-digit', day: '2-digit', year: 'numeric' });
            const day = d.getDay(); const diff = day === 0 ? 6 : day - 1;
            const ws = new Date(d); ws.setDate(d.getDate() - diff);
            postWeekKey = ws.toISOString().split('T')[0];
          } else if (createdDate) {
            const str = String(createdDate).trim();
            const slashParts = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            const isoStr = slashParts ? slashParts[3] + '-' + slashParts[1].padStart(2, '0') + '-' + slashParts[2].padStart(2, '0') : str;
            const d = new Date(isoStr + 'T00:00:00');
            if (!isNaN(d.getTime())) {
              const day = d.getDay(); const diff = day === 0 ? 6 : day - 1;
              const ws = new Date(d); ws.setDate(d.getDate() - diff);
              postWeekKey = ws.toISOString().split('T')[0];
            }
          }

          // Count post in its weekly bucket
          if (postWeekKey && weeklyMap.has(postWeekKey)) {
            weeklyMap.get(postWeekKey)['Posts']++;
          }

          return {
            'Post title': row['Post title'] || '',
            'Post link': row['Post link'] || '',
            'Post type': row['Post type'] || (row['Campaign name'] ? 'Sponsored' : 'Organic'),
            'Created date': createdDate,
            'Posted by': row['Posted by'] || '',
            'Impressions': impressions,
            'Clicks': clicks,
            'Likes': likes,
            'Comments': comments,
            'Reposts': reposts,
            'Engagement rate': engRate,
            'Content Type': row['Content Type'] || '',
            engagement_score: engScore
          };
        }).sort((a, b) => b.engagement_score - a.engagement_score);

        // Compute summary totals
        const impressions_organic = weekly.reduce((s, w) => s + w['Impressions (organic)'], 0);
        const impressions_sponsored = weekly.reduce((s, w) => s + w['Impressions (sponsored)'], 0);
        const impressions_total = weekly.reduce((s, w) => s + w['Impressions (total)'], 0);
        const clicks = weekly.reduce((s, w) => s + w['Clicks (total)'], 0);
        const reactions = weekly.reduce((s, w) => s + w['Reactions (total)'], 0);
        const comments = weekly.reduce((s, w) => s + w['Comments (total)'], 0);
        const reposts = weekly.reduce((s, w) => s + w['Reposts (total)'], 0);
        const new_followers = weekly.reduce((s, w) => s + (w['New followers (total)'] || 0), 0);
        const new_followers_organic = weekly.reduce((s, w) => s + (w['New followers (organic)'] || 0), 0);
        const new_followers_sponsored = weekly.reduce((s, w) => s + (w['New followers (sponsored)'] || 0), 0);
        const avgEng = weekly.length ? weekly.reduce((s, w) => s + w['Engagement rate (total)'], 0) / weekly.length : 0;

        let dateFrom = '', dateTo = '';
        if (weekly.length) {
          dateFrom = weekLabelAnalytics(weekly[0].week);
          dateTo = weekLabelAnalytics(weekly[weekly.length - 1].week);
        }

        const summary = {
          impressions_total, impressions_organic, impressions_sponsored,
          clicks, reactions, comments, reposts,
          new_followers, new_followers_organic, new_followers_sponsored,
          avg_engagement: (avgEng * 100).toFixed(1),
          total_posts: posts.length,
          date_from: dateFrom, date_to: dateTo
        };

        const reportLabel = dateFrom && dateTo ? `${dateFrom} \u2013 ${dateTo}` : 'Analytics Report';

        resolve({
          metrics_data: weekly,
          posts_data: posts,
          summary,
          report_label: reportLabel
        });
      } catch (err) {
        reject(err);
      }
    }
    if (existingWb) { doParse(existingWb); }
    else {
      const reader = new FileReader();
      reader.onload = function(e) {
        if (typeof XLSX === 'undefined') { reject(new Error('SheetJS library not loaded')); return; }
        const data = new Uint8Array(e.target.result);
        doParse(XLSX.read(data, { type: 'array' }));
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    }
  });
}

// --- Followers Report Parser ---
function parseLinkedInFollowersReport(file, existingWb) {
  return new Promise((resolve, reject) => {
    function doParse(wb) {
      try {
        function parseSheet(ws) {
          if (!ws) return [];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          if (raw.length < 2) return [];
          const headers = raw[0];
          const rows = [];
          for (let i = 1; i < raw.length; i++) {
            const obj = {};
            headers.forEach((h, idx) => { obj[String(h).trim()] = raw[i][idx] !== undefined ? raw[i][idx] : ''; });
            rows.push(obj);
          }
          return rows;
        }

        function parseDateVal(dateVal) {
          if (typeof dateVal === 'number') {
            return new Date((dateVal - 25569) * 86400 * 1000).toISOString().split('T')[0];
          } else if (dateVal instanceof Date) {
            return dateVal.toISOString().split('T')[0];
          }
          const s = String(dateVal).trim();
          const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          return m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : s;
        }

        // Parse "New followers" sheet → daily rows
        const followersSheet = wb.Sheets[wb.SheetNames.find(s => /new follower/i.test(s)) || wb.SheetNames[0]];
        const followersRaw = parseSheet(followersSheet);
        const dailyFollowers = followersRaw.map(row => ({
          date: parseDateVal(row['Date'] || ''),
          organic: Number(row['Organic followers']) || 0,
          sponsored: Number(row['Sponsored followers']) || 0,
          total: Number(row['Total followers']) || 0
        })).filter(r => r.date && r.date.length >= 8);

        // Parse demographic sheets
        function parseDemoSheet(sheetName, nameCol, countCol) {
          const ws = wb.Sheets[wb.SheetNames.find(s => s.toLowerCase() === sheetName.toLowerCase())];
          if (!ws) return [];
          const rows = parseSheet(ws);
          return rows.map(r => ({
            name: String(r[nameCol] || '').trim(),
            count: Number(r[countCol]) || 0
          })).filter(r => r.name && r.count > 0).sort((a, b) => b.count - a.count);
        }

        const demographics_data = {
          job_function: parseDemoSheet('Job function', 'Job function', 'Total followers'),
          seniority: parseDemoSheet('Seniority', 'Seniority', 'Total followers'),
          industry: parseDemoSheet('Industry', 'Industry', 'Total followers'),
          company_size: parseDemoSheet('Company size', 'Company size', 'Total followers'),
          location: parseDemoSheet('Location', 'Location', 'Total followers')
        };

        // Date range for label
        let dateFrom = '', dateTo = '';
        if (dailyFollowers.length) {
          dateFrom = weekLabelAnalytics(dailyFollowers[0].date);
          dateTo = weekLabelAnalytics(dailyFollowers[dailyFollowers.length - 1].date);
        }
        const reportLabel = dateFrom && dateTo ? `${dateFrom} – ${dateTo}` : 'Followers Report';

        resolve({
          metrics_data: dailyFollowers,
          demographics_data,
          report_label: reportLabel
        });
      } catch (err) { reject(err); }
    }
    if (existingWb) { doParse(existingWb); }
    else {
      const reader = new FileReader();
      reader.onload = function(e) {
        if (typeof XLSX === 'undefined') { reject(new Error('SheetJS library not loaded')); return; }
        const data = new Uint8Array(e.target.result);
        doParse(XLSX.read(data, { type: 'array' }));
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    }
  });
}

// --- Visitors Report Parser ---
function parseLinkedInVisitorsReport(file, existingWb) {
  return new Promise((resolve, reject) => {
    function doParse(wb) {
      try {

        function parseSheet(ws) {
          if (!ws) return [];
          const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          if (raw.length < 2) return [];
          const headers = raw[0];
          const rows = [];
          for (let i = 1; i < raw.length; i++) {
            const obj = {};
            headers.forEach((h, idx) => { obj[String(h).trim()] = raw[i][idx] !== undefined ? raw[i][idx] : ''; });
            rows.push(obj);
          }
          return rows;
        }

        function parseDateVal(dateVal) {
          if (typeof dateVal === 'number') {
            return new Date((dateVal - 25569) * 86400 * 1000).toISOString().split('T')[0];
          } else if (dateVal instanceof Date) {
            return dateVal.toISOString().split('T')[0];
          }
          const s = String(dateVal).trim();
          const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          return m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : s;
        }

        // Parse "Visitor metrics" sheet
        const visitorSheet = wb.Sheets[wb.SheetNames.find(s => /visitor metric/i.test(s)) || wb.SheetNames[0]];
        const visitorRaw = parseSheet(visitorSheet);
        const dailyVisitors = visitorRaw.map(row => ({
          date: parseDateVal(row['Date'] || ''),
          overview_views: Number(row['Overview page views (total)']) || 0,
          overview_unique: Number(row['Overview unique visitors (total)']) || 0,
          total_views: Number(row['Total page views (total)']) || 0,
          total_unique: Number(row['Total unique visitors (total)']) || 0
        })).filter(r => r.date && r.date.length >= 8);

        // Parse demographic sheets (same as followers but count column = "Total views")
        function parseDemoSheet(sheetName, nameCol, countCol) {
          const ws = wb.Sheets[wb.SheetNames.find(s => s.toLowerCase() === sheetName.toLowerCase())];
          if (!ws) return [];
          const rows = parseSheet(ws);
          return rows.map(r => ({
            name: String(r[nameCol] || '').trim(),
            count: Number(r[countCol]) || 0
          })).filter(r => r.name && r.count > 0).sort((a, b) => b.count - a.count);
        }

        const demographics_data = {
          job_function: parseDemoSheet('Job function', 'Job function', 'Total views'),
          seniority: parseDemoSheet('Seniority', 'Seniority', 'Total views'),
          industry: parseDemoSheet('Industry', 'Industry', 'Total views'),
          company_size: parseDemoSheet('Company size', 'Company size', 'Total views'),
          location: parseDemoSheet('Location', 'Location', 'Total views')
        };

        let dateFrom = '', dateTo = '';
        if (dailyVisitors.length) {
          dateFrom = weekLabelAnalytics(dailyVisitors[0].date);
          dateTo = weekLabelAnalytics(dailyVisitors[dailyVisitors.length - 1].date);
        }
        const reportLabel = dateFrom && dateTo ? `${dateFrom} – ${dateTo}` : 'Visitors Report';

        resolve({
          visitor_metrics: dailyVisitors,
          demographics_data,
          report_label: reportLabel
        });
      } catch (err) { reject(err); }
    }
    if (existingWb) { doParse(existingWb); }
    else {
      const reader = new FileReader();
      reader.onload = function(e) {
        if (typeof XLSX === 'undefined') { reject(new Error('SheetJS library not loaded')); return; }
        const data = new Uint8Array(e.target.result);
        doParse(XLSX.read(data, { type: 'array' }));
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    }
  });
}

// --- Instagram (Meta Insights) post export parser ---
// Single-sheet export from Meta Business Suite — Account info + post-level rows.
// Distinguished from LinkedIn by header signature, not sheet name (IG sheet
// names are <dateRange>_<numericId> and unstable).
function parseInstagramAnalytics(file, existingWb) {
  return new Promise((resolve, reject) => {
    function doParse(wb) {
      try {
        // Find the sheet containing IG post columns. Prefer header match, but
        // fall back to first non-empty sheet (detection has already classified
        // this workbook as Instagram, so any sheet with rows is the post sheet).
        let postSheetName = null;
        for (const name of wb.SheetNames) {
          const ws = wb.Sheets[name];
          if (!ws) continue;
          const firstRow = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })[0] || [];
          const headers = firstRow.map(h => String(h || '').trim().toLowerCase());
          if (headers.includes('account username') && headers.includes('permalink')) {
            postSheetName = name;
            break;
          }
        }
        if (!postSheetName) {
          // Fallback: first sheet with any data
          postSheetName = wb.SheetNames.find(n => {
            const ws = wb.Sheets[n];
            return ws && (ws['!ref'] || Object.keys(ws).some(k => /^[A-Z]+\d+$/.test(k)));
          }) || wb.SheetNames[0];
        }
        if (!postSheetName) { reject(new Error('Instagram workbook has no sheets')); return; }

        const rows = XLSX.utils.sheet_to_json(wb.Sheets[postSheetName], { defval: '' });
        if (!rows.length) { reject(new Error('Instagram export has no rows')); return; }

        const toIsoDate = (v) => {
          if (v === '' || v === null || v === undefined) return '';
          if (typeof v === 'number') {
            const d = new Date((v - 25569) * 86400 * 1000);
            return isNaN(d) ? '' : d.toISOString().split('T')[0];
          }
          if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().split('T')[0];
          const s = String(v).trim();
          // MM/DD/YYYY or MM/DD/YYYY HH:MM
          const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
          // YYYY-MM-DD passes through
          if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
          return '';
        };

        const posts = rows.map(r => {
          const date = toIsoDate(r['Date'] || '');
          const publishDate = toIsoDate(r['Publish time'] || '');
          return {
            post_id: String(r['Post ID'] || ''),
            account_id: String(r['Account ID'] || ''),
            account_username: String(r['Account username'] || ''),
            account_name: String(r['Account name'] || ''),
            description: String(r['Description'] || '').slice(0, 500),
            duration_sec: Number(r['Duration (sec)']) || 0,
            publish_time: publishDate || String(r['Publish time'] || ''),
            permalink: String(r['Permalink'] || ''),
            post_type: String(r['Post type'] || ''),
            data_comment: String(r['Data comment'] || ''),
            date: date,
            views: Number(r['Views']) || 0,
            reach: Number(r['Reach']) || 0,
            likes: Number(r['Likes']) || 0,
            shares: Number(r['Shares']) || 0,
            follows: Number(r['Follows']) || 0,
            comments: Number(r['Comments']) || 0,
            saves: Number(r['Saves']) || 0
          };
        }).filter(p => p.post_id);

        if (!posts.length) { reject(new Error('No valid Instagram posts found (rows missing Post ID)')); return; }

        const sum = (k) => posts.reduce((s, p) => s + (p[k] || 0), 0);
        const totalReach = sum('reach');
        const totalEngagements = sum('likes') + sum('comments') + sum('saves') + sum('shares');
        const engagementRate = totalReach > 0 ? (totalEngagements / totalReach) : 0;

        const dates = posts.map(p => p.date || (p.publish_time || '').slice(0, 10)).filter(Boolean).sort();
        const dateFrom = dates[0] || '';
        const dateTo = dates[dates.length - 1] || '';

        const summary = {
          total_posts: posts.length,
          total_views: sum('views'),
          total_reach: totalReach,
          total_likes: sum('likes'),
          total_comments: sum('comments'),
          total_saves: sum('saves'),
          total_shares: sum('shares'),
          total_follows: sum('follows'),
          engagement_rate: engagementRate,
          avg_engagement: (engagementRate * 100).toFixed(2),
          date_from: dateFrom,
          date_to: dateTo,
          account_name: posts[0]?.account_name || '',
          account_username: posts[0]?.account_username || ''
        };

        const reportLabel = (dateFrom && dateTo)
          ? `${dateFrom} – ${dateTo}`
          : (summary.account_name || 'Instagram report');

        resolve({ posts_data: posts, summary, report_label: reportLabel });
      } catch (err) { reject(err); }
    }

    if (existingWb) { doParse(existingWb); return; }
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        if (typeof XLSX === 'undefined') { reject(new Error('SheetJS library not loaded')); return; }
        const data = new Uint8Array(e.target.result);
        doParse(XLSX.read(data, { type: 'array' }));
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

// --- Smart client-mismatch guard for Instagram uploads ---
// Returns a client object IF the IG account name/username matches a DIFFERENT
// client in state.clients than the current page's client. Returns null when
// there's no signal of mistake (account doesn't match any client, or matches
// the current one).
function findIgClientSuggestion(accountName, accountUsername, currentClientId) {
  if (!Array.isArray(state.clients)) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/official$/, '');
  const accountNorm = norm(accountName);
  const usernameNorm = norm(accountUsername);
  if (!accountNorm && !usernameNorm) return null;

  for (const c of state.clients) {
    if (!c || c.id === currentClientId) continue;
    const clientNorm = norm(c.name);
    if (!clientNorm || clientNorm.length < 3) continue;
    if (clientNorm === accountNorm || clientNorm === usernameNorm) return c;
    if (accountNorm.length >= 4 && (clientNorm.includes(accountNorm) || accountNorm.includes(clientNorm))) return c;
    if (usernameNorm.length >= 4 && (clientNorm.includes(usernameNorm) || usernameNorm.includes(clientNorm))) return c;
  }
  return null;
}

// --- Auto-detect report type ---
// Instagram detection tries TWO signals in order. Sheet-name pattern is primary
// because Meta Business Suite exports use <DateRange>_<longNumericId> (the
// trailing numeric ID is the page/account ID — always 12+ digits). Distinctive
// and doesn't require parsing cells. Header-based is the backup for future
// export shapes. LinkedIn detection (existing) uses sheet names too.
function detectReportType(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        if (typeof XLSX === 'undefined') { reject(new Error('SheetJS library not loaded')); return; }
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const names = wb.SheetNames || [];
        let type = null;

        // Instagram (Meta) — primary: sheet name ends with `_<long numeric ID>`
        if (names.some(s => /_\d{12,}$/.test(s))) type = 'instagram';

        // Instagram (Meta) — secondary: header-based fallback
        if (!type) {
          for (const name of names) {
            const ws = wb.Sheets[name];
            if (!ws) continue;
            const firstRow = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })[0] || [];
            const headers = firstRow.map(h => String(h || '').trim().toLowerCase());
            if (headers.includes('account username') && headers.includes('permalink') &&
                headers.some(h => ['likes', 'saves', 'reach'].includes(h))) {
              type = 'instagram';
              break;
            }
          }
        }

        // Instagram account-metrics CSV — Meta Insights export, ONE metric per
        // file: UTF-16, a sep= line, a title row, then Date/Primary daily
        // rows. The title is NOT always "Instagram <metric>" — real exports
        // say "Reach", "Views", "Content interactions" — so the signature is
        // the STRUCTURE: a short title row followed by a Date/Primary header.
        if (!type && names.length === 1) {
          const firstRows = XLSX.utils.sheet_to_json(wb.Sheets[names[0]], { header: 1, defval: '' }).slice(0, 5);
          const title = String((firstRows[0] || [])[0] || '').trim();
          const hasDatePrimary = firstRows.some(r =>
            String(r[0] || '').trim().toLowerCase() === 'date' &&
            String(r[1] || '').trim().toLowerCase() === 'primary');
          if (hasDatePrimary && title && title.length <= 60) type = 'instagram_metrics';
        }

        // Community Pulse — the LeadConnector comms workbook (per-send stats
        // sheet name starts "NewslettersAll…"; header fallback for renames)
        if (!type) {
          if (names.some(s => /^newslettersall/i.test(s.trim()))) type = 'community_pulse';
          else {
            for (const name of names) {
              const ws = wb.Sheets[name];
              if (!ws) continue;
              const firstRow = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })[0] || [];
              const headers = firstRow.map(h => String(h || '').trim().toLowerCase());
              if (headers.includes('email name') && headers.includes('open rate (%)')) { type = 'community_pulse'; break; }
            }
          }
        }

        // LinkedIn — sheet-name based
        if (!type) {
          if (names.some(s => /new follower/i.test(s))) type = 'followers';
          else if (names.some(s => /visitor metric/i.test(s))) type = 'visitors';
          else if (names.some(s => /metric/i.test(s)) || names.some(s => /post/i.test(s))) type = 'content';
        }

        if (!type) {
          // Single-sheet "Sheet1" = almost certainly a CSV. Meta post exports
          // and Instagram insights-metric CSVs are caught above; an
          // unrecognized CSV is most likely a LinkedIn report someone
          // converted — those need the original Excel export (multi-sheet,
          // detected by sheet names).
          if (names.length === 1 && /^sheet1$/i.test(names[0])) {
            reject(new Error('This CSV isn\'t a recognized Meta (Instagram) export. LinkedIn reports need the original Excel (.xls/.xlsx) download from LinkedIn — CSV versions aren\'t supported yet.'));
            return;
          }
          const sheetSummary = names.length ? ` Sheets found: ${names.join(', ')}.` : '';
          reject(new Error(`Could not detect report type.${sheetSummary} Expected a LinkedIn Content/Followers/Visitors export, an Instagram (Meta) post export, or the community comms workbook.`));
          return;
        }
        resolve({ type, workbook: wb });
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

// ═══════════════ Community Pulse (LeadConnector comms workbook) ═══════════════
// Parses the Comms_Report workbook the Example Collective team maintains:
//  - a per-send stats sheet (name starts "NewslettersAll…"): one row per
//    newsletter/dispatch/survey send with delivered/opened/clicked/unsub counts
//  - "Newsletter subscriptions": the subscriber list (region/country/created)
//  - "Forum_<date>": the forum member roster (region/country/domain of work)
// Dates arrive as Excel serials (days since 1899-12-30) or ISO-ish strings.

function excelSerialToIso(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && isFinite(value)) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (/^\d{4,5}(\.\d+)?$/.test(s)) return excelSerialToIso(parseFloat(s));
  // A datetime with no zone is parsed as LOCAL time, and toISOString() below
  // then converts to UTC — which moves the date back a day everywhere east of
  // UTC. Meta's per-metric CSVs hand us "2026-04-01T00:00:00", so in IST every
  // daily figure was being filed one day early (found 10 Sep 2026 against a
  // real export). Pin these to UTC: a calendar date carries no timezone, and
  // the reporting day is whatever the file says it is.
  const zoneless = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const direct = new Date(
    s.length > 10 ? (zoneless ? s.replace(' ', 'T') + 'Z' : s) : s + 'T00:00:00Z'
  );
  if (isNaN(direct)) return '';
  // V8 date parsing is lenient (e.g. "Total clicks: 1219" parses as year
  // 1219) — reject anything outside a plausible reporting window.
  const y = direct.getUTCFullYear();
  return (y >= 1990 && y <= 2100) ? direct.toISOString().slice(0, 10) : '';
}

// Strip the "N/A" + zero-width-space junk LeadConnector exports carry.
function cleanCommunityValue(v) {
  const s = String(v === null || v === undefined ? '' : v).replace(/[​‌﻿]/g, '').trim();
  return /^n\/?a$/i.test(s) ? '' : s;
}

function communityTopSegments(rows, field, limit, splitCommas) {
  const counts = new Map();
  (rows || []).forEach((r) => {
    const raw = cleanCommunityValue(r[field]);
    if (!raw) return;
    const parts = splitCommas ? raw.split(',').map(p => p.trim()).filter(Boolean) : [raw];
    parts.forEach(p => counts.set(p, (counts.get(p) || 0) + 1));
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit || 10)
    .map(([name, count]) => ({ name, count }));
}

// Summary is recomputed after merges too, so keep it a standalone pure fn.
function communityPulseSummary(sends, demographics) {
  const rows = (sends || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const totDelivered = rows.reduce((s, r) => s + (r.delivered || 0), 0);
  const totOpened = rows.reduce((s, r) => s + (r.opened || 0), 0);
  const totClicked = rows.reduce((s, r) => s + (r.clicked || 0), 0);
  const byType = {};
  rows.forEach((r) => {
    const t = r.send_type || 'Other';
    if (!byType[t]) byType[t] = { sends: 0, delivered: 0, opened: 0, clicked: 0 };
    byType[t].sends += 1;
    byType[t].delivered += r.delivered || 0;
    byType[t].opened += r.opened || 0;
    byType[t].clicked += r.clicked || 0;
  });
  Object.values(byType).forEach((t) => {
    t.open_rate = t.delivered > 0 ? t.opened / t.delivered : 0;
    t.click_rate = t.delivered > 0 ? t.clicked / t.delivered : 0;
  });
  return {
    total_sends: rows.length,
    date_from: rows.length ? rows[0].date : '',
    date_to: rows.length ? rows[rows.length - 1].date : '',
    open_rate: totDelivered > 0 ? totOpened / totDelivered : 0,
    click_rate: totDelivered > 0 ? totClicked / totDelivered : 0,
    total_unsubscribed: rows.reduce((s, r) => s + (r.unsubscribed || 0), 0),
    subscribers: demographics?.subscribers?.total || 0,
    forum_members: demographics?.forum?.total || 0,
    by_type: byType
  };
}

// Pure core (Node-testable): takes already-jsonified sheet rows.
function parseCommunityPulseRows(sheets) {
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const sends = (sheets.sends || [])
    .map((r) => ({
      date: excelSerialToIso(r['Date']),
      name: cleanCommunityValue(r['Email Name']),
      send_type: cleanCommunityValue(r['Type']) || 'Newsletter',
      delivered: Math.round(num(r['Delivered (#)'])),
      delivered_rate: num(r['Delivered (%)']),
      opened: Math.round(num(r['Opened (#)'])),
      open_rate: num(r['Open Rate (%)']),
      clicked: Math.round(num(r['Clicked (#)'])),
      click_rate: num(r['Click Rate (%)']),
      unsubscribed: Math.round(num(r['Unsubscribed (#)'])),
      hard_bounce: Math.round(num(r['Hard Bounce (#)'])),
      skipped: Math.round(num(r['Skipped (#)']))
    }))
    .filter((r) => r.date && r.delivered > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const subs = sheets.subscribers || [];
  const growth = new Map();
  subs.forEach((r) => {
    const iso = excelSerialToIso(r['Created']);
    if (!iso) return;
    const month = iso.slice(0, 7);
    growth.set(month, (growth.get(month) || 0) + 1);
  });
  const subscribers = subs.length ? {
    total: subs.length,
    by_region: communityTopSegments(subs, 'Region', 8),
    by_country: communityTopSegments(subs, 'Country', 12),
    growth_by_month: [...growth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, count]) => ({ month, count }))
  } : null;

  const forumRows = sheets.forum || [];
  const forum = forumRows.length ? {
    total: forumRows.length,
    by_region: communityTopSegments(forumRows, 'Region', 8),
    by_country: communityTopSegments(forumRows, 'Country', 12),
    by_domain: communityTopSegments(forumRows, 'Domain of Work', 12, true),
    by_gender: communityTopSegments(forumRows, 'Gender', 5),
    by_source: communityTopSegments(forumRows, 'Source', 8)
  } : null;

  const demographics = { subscribers, forum };
  return {
    metrics_data: sends,
    demographics_data: demographics,
    summary: communityPulseSummary(sends, demographics),
    report_label: sends.length ? `${sends[0].date} – ${sends[sends.length - 1].date}` : 'Community pulse'
  };
}

// ═══════════ Instagram account-metrics CSV (Meta Insights export) ═══════════
// One metric per file: row 0 = title ("Instagram follows"), then a
// Date/Primary header row, then daily rows (dates arrive as Excel serials
// after SheetJS parses the ISO datetimes). Pure core is Node-testable.
// Meta exports Instagram and Facebook per-metric CSVs in the SAME shape, from
// the same screen. Some titles name the platform ("Facebook follows",
// "Instagram follows"); the shared ones do not ("Viewers", "Content
// interactions", "Reach", "Views"). Verified against Example Collective's real
// Facebook export on 10 Sep 2026: all five files were being read as Instagram,
// and the two untitled ones landed on the exact metric keys Instagram already
// uses — so the client's Facebook figures would have merged into their Instagram
// numbers with nothing on screen to show it.
//
// null means genuinely undecidable from the file. There is no other signal in
// it, so the caller must ASK rather than guess: a wrong guess silently corrupts
// a client's reporting, which is worse than one extra click.
function metricsPlatformFromTitle(title) {
  const t = String(title || '').trim().toLowerCase();
  if (/^instagram\b/.test(t)) return 'instagram';
  if (/^facebook\b/.test(t)) return 'facebook';
  return null;
}

function parseInstagramMetricsRows(rows) {
  const all = rows || [];
  const title = cleanCommunityValue((all[0] || [])[0]);
  // Real export titles: "Instagram follows", "Instagram link clicks" — but
  // also just "Reach", "Views", "Content interactions". The "Instagram"
  // prefix is optional branding; strip it for the metric key.
  if (!title || title.length > 60) return null;
  const metricLabel = title.replace(/^(instagram|facebook)\s+/i, '').trim();
  const metric = metricLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  const headerIdx = all.findIndex(r =>
    String((r || [])[0] || '').trim().toLowerCase() === 'date' &&
    String((r || [])[1] || '').trim().toLowerCase() === 'primary');
  if (headerIdx < 0 || !metric) return null;
  const daily = [];
  for (let i = headerIdx + 1; i < all.length; i++) {
    const date = excelSerialToIso((all[i] || [])[0]);
    if (!date) continue;
    const v = parseFloat((all[i] || [])[1]);
    daily.push({ date, value: isFinite(v) ? v : 0 });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));
  return daily.length
    ? { metric, metricLabel, daily, platform: metricsPlatformFromTitle(title), title }
    : null;
}

function parseInstagramMetricsCsv(file, existingWb) {
  return new Promise((resolve, reject) => {
    try {
      const wb = existingWb;
      if (!wb) { reject(new Error('Workbook not loaded')); return; }
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      const parsed = parseInstagramMetricsRows(rows);
      if (!parsed) { reject(new Error('Could not read this Instagram metrics CSV — expected a metric title row then Date/Primary daily rows.')); return; }
      resolve(parsed);
    } catch (err) { reject(err); }
  });
}

// SheetJS wrapper (browser): locates the sheets by name pattern.
function parseCommunityPulse(file, existingWb) {
  return new Promise((resolve, reject) => {
    try {
      const wb = existingWb;
      if (!wb) { reject(new Error('Workbook not loaded')); return; }
      const names = wb.SheetNames || [];
      const rowsOf = (name) => name ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' }) : [];
      const sendsName = names.find(s => /^newslettersall/i.test(s.trim()));
      if (!sendsName) { reject(new Error('No "NewslettersAll…" per-send stats sheet found in this workbook.')); return; }
      const parsed = parseCommunityPulseRows({
        sends: rowsOf(sendsName),
        subscribers: rowsOf(names.find(s => /^newsletter subscriptions/i.test(s.trim()))),
        forum: rowsOf(names.find(s => /^forum_/i.test(s.trim())))
      });
      if (!parsed.metrics_data.length) { reject(new Error('The per-send stats sheet has no usable rows.')); return; }
      resolve(parsed);
    } catch (err) { reject(err); }
  });
}

// --- Merge helper: appends new rows to existing, keyed by unique identifier ---
function mergeByKey(existing, incoming, keyFn) {
  const map = new Map();
  (existing || []).forEach(r => map.set(keyFn(r), r));
  (incoming || []).forEach(r => map.set(keyFn(r), r));
  return [...map.values()];
}

// Overview KPI math (pure — extracted from renderAnalyticsOverview, slice 8).
// Impressions/engagement compare last week vs previous week; followers and
// visitors compare last 7 days vs the previous 7 (needing >=7/>=14 data days).
function computeOverviewKpis(contentReport, followersReport, visitorsReport, todayIso) {
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const allWeekly = contentReport?.metrics_data || [];
  // Complete weeks only: the last bucket usually spans past today (the export
  // runs mid-week), and a 5-day "week" vs a 7-day one manufactures a collapse
  // — the "↓65%" impressions tile was exactly this.
  const weekly = trimInProgressWeek(allWeekly, today);
  const weekInProgress = allWeekly.length > weekly.length ? allWeekly[allWeekly.length - 1].week : null;
  const followerDaily = followersReport?.metrics_data || [];
  const visitorDaily = visitorsReport?.visitor_metrics || [];

  const latestWeek = weekly.length ? weekly[weekly.length - 1] : null;
  const prevWeek = weekly.length > 1 ? weekly[weekly.length - 2] : null;

  const lastWeekImpressions = latestWeek ? Math.round(latestWeek['Impressions (organic)'] || 0) : 0;
  const lastWeekEngRate = latestWeek ? (latestWeek['Engagement rate (total)'] || 0) : 0;

  const fLen = followerDaily.length;
  const fRecent = fLen >= 7 ? followerDaily.slice(-7).reduce((s, d) => s + (d.total || 0), 0) : 0;
  const fPrev = fLen >= 14 ? followerDaily.slice(-14, -7).reduce((s, d) => s + (d.total || 0), 0) : 0;

  const vLen = visitorDaily.length;
  const vRecent = vLen >= 7 ? visitorDaily.slice(-7).reduce((s, d) => s + (d.overview_unique || 0), 0) : 0;
  const vPrev = vLen >= 14 ? visitorDaily.slice(-14, -7).reduce((s, d) => s + (d.overview_unique || 0), 0) : 0;

  const kpis = [
    { label: 'Impressions', value: fmtAnalytics(lastWeekImpressions), arrow: prevWeek ? trendArrow(lastWeekImpressions, prevWeek['Impressions (organic)'] || 0) : '' },
    // Rate metric → delta in percentage POINTS (trendArrowPoints), matching how
    // the AI brief talks about the same move. Relative % on a rate reads wrong.
    { label: 'Engagement Rate', value: pctAnalytics(lastWeekEngRate), arrow: prevWeek ? trendArrowPoints(lastWeekEngRate, prevWeek['Engagement rate (total)'] || 0) : '' },
    { label: 'New Followers', value: fRecent > 0 ? `+${fmtAnalytics(fRecent)}` : '–', arrow: fLen >= 14 ? trendArrow(fRecent, fPrev) : '' },
    { label: 'Page Visits', value: vRecent > 0 ? fmtAnalytics(vRecent) : '–', arrow: vLen >= 14 ? trendArrow(vRecent, vPrev) : '' },
  ];

  return {
    kpis,
    kpiPeriod: latestWeek?.week ? `Week of ${weekLabelAnalytics(latestWeek.week)}` : 'Last week',
    hasPrevWeek: Boolean(prevWeek),
    weekInProgress
  };
}

// The last date a report's CONTENTS cover — staleness must come from this,
// never from uploaded_at: a frozen upload timestamp under fresh data cried
// wolf (Example Materials, Jul 2026), and a fresh upload click on an OLD file is not
// fresh data. Mirrors the SQL backfill in migration 202607140001.
function computeDataThrough(reportType, data) {
  const iso = (v) => {
    const s = normalizeDateStr(String(v || '').slice(0, 10));
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  };
  const maxOf = (rows, pick) => (rows || []).reduce((m, r) => {
    const d = iso(pick(r || {}));
    return d && d > m ? d : m;
  }, '');
  if (reportType === 'content') {
    const lastWeek = maxOf(data.metricsData, r => r.week);
    if (!lastWeek) return null;
    const d = new Date(lastWeek + 'T00:00:00');
    d.setDate(d.getDate() + 6); // a weekly row covers through its week END
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (reportType === 'followers') return maxOf(data.metricsData, r => r.date) || null;
  if (reportType === 'visitors') return maxOf(data.visitorMetrics, r => r.date) || null;
  // Facebook rides the same shape: daily metric rows, and posts if a post
  // export ever lands. Without this a Facebook report has no data_through and
  // reads as permanently stale.
  if (reportType === 'instagram' || reportType === 'facebook') {
    const posts = maxOf(data.postsData, p => p.date || p.publish_time);
    const daily = maxOf(data.metricsData, r => r.date);
    return (posts > daily ? posts : daily) || null;
  }
  if (reportType === 'community_pulse') return iso(data.summary && data.summary.date_to) || null;
  return null;
}

// ── Comparison windows for daily-metric reports (Instagram) ──
// Data is put in perspective, never shown raw (23 Jul 2026): every
// number answers "compared to WHAT?". Windows are MONDAY-WEEK ALIGNED — the
// agency's operating rhythm (weekly uploads, Monday weeks per Business Rules)
// — even though Meta's export carries daily rows; the daily rows only give the
// charts their shape inside those weeks.
//
// All helpers are PURE (tested in tests/analytics.test.mjs). Dates are ISO
// strings throughout, compared lexically — no Date-object timezone traps.

function isoAddDays(iso, n) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday of the ISO week containing `iso` (Sunday belongs to the PREVIOUS
// week, matching mondayWeekStartDate in js/alloc.js).
function isoMondayOf(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  const day = d.getUTCDay();
  return isoAddDays(iso, day === 0 ? -6 : 1 - day);
}

// Sum every numeric metric across rows → { metricKey: total }. Missing values
// are missing, not zero — a metric absent from every row stays absent.
function sumMetricRows(rows) {
  const totals = {};
  (rows || []).forEach((r) => {
    Object.keys(r || {}).forEach((k) => {
      if (k === 'date') return;
      const v = Number(r[k]);
      if (!isNaN(v)) totals[k] = (totals[k] || 0) + v;
    });
  });
  return totals;
}

// Build the A-vs-B windows for a comparison mode over daily rows.
// Returns { a, b, note } where a/b = { startIso, endIso, label, rows, totals },
// or null when the data can't support the mode. b.rows is null for average
// baselines (there's no single week to draw); b.totals is always present.
//
// The partial-week rule: "this week vs last week" on a Wednesday compares 3
// days against 7 and reports a collapse. So A is the last FULL Monday–Sunday
// week the data covers, and in-progress days are EXCLUDED, with `note` saying
// so. Honest beats current.
function igComparisonWindows(daily, mode) {
  const rows = (daily || []).filter((r) => r && r.date).slice()
    .sort((x, y) => String(x.date).localeCompare(String(y.date)));
  if (!rows.length) return null;
  const maxIso = rows[rows.length - 1].date;
  const inRange = (s, e) => rows.filter((r) => r.date >= s && r.date <= e);
  const fmt = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  const weekWin = (monIso, label) => {
    const endIso = isoAddDays(monIso, 6);
    const r = inRange(monIso, endIso);
    return { startIso: monIso, endIso, label: `${label} (${fmt(monIso)} – ${fmt(endIso)})`, rows: r, totals: sumMetricRows(r) };
  };

  // Last COMPLETE week: its Sunday must be within the data.
  const thisMon = isoMondayOf(maxIso);
  const lastFullMon = isoAddDays(thisMon, 6) <= maxIso ? thisMon : isoAddDays(thisMon, -7);
  const partialNote = maxIso >= isoAddDays(lastFullMon, 7)
    ? `Week in progress (from ${fmt(isoAddDays(lastFullMon, 7))}) excluded — it would compare a part-week against a full one.`
    : '';

  if (mode === 'wow') {
    const a = weekWin(lastFullMon, 'Last week');
    const b = weekWin(isoAddDays(lastFullMon, -7), 'Week before');
    if (!a.rows.length || !b.rows.length) return null;
    return { a, b, note: partialNote };
  }

  if (mode === 'wo4') {
    const a = weekWin(lastFullMon, 'Last week');
    if (!a.rows.length) return null;
    const avgTotals = {};
    let weeksCounted = 0;
    for (let i = 1; i <= 4; i++) {
      const w = inRange(isoAddDays(lastFullMon, -7 * i), isoAddDays(lastFullMon, -7 * i + 6));
      if (!w.length) continue;
      weeksCounted += 1;
      const t = sumMetricRows(w);
      Object.keys(t).forEach((k) => { avgTotals[k] = (avgTotals[k] || 0) + t[k]; });
    }
    if (!weeksCounted) return null;
    Object.keys(avgTotals).forEach((k) => { avgTotals[k] = avgTotals[k] / weeksCounted; });
    return {
      a,
      b: { startIso: null, endIso: null, label: `${weeksCounted}-week average`, rows: null, totals: avgTotals },
      note: partialNote + (weeksCounted < 4 ? ` Average uses the ${weeksCounted} prior week${weeksCounted > 1 ? 's' : ''} on record.` : '')
    };
  }

  if (mode === 'mom') {
    // Last FULL calendar month vs the one before it.
    const monthStart = (iso) => iso.slice(0, 7) + '-01';
    const monthEnd = (iso) => {
      const d = new Date(iso.slice(0, 7) + '-01T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
      return d.toISOString().slice(0, 10);
    };
    const prevMonthStart = (iso) => {
      const d = new Date(iso.slice(0, 7) + '-01T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() - 1);
      return d.toISOString().slice(0, 10);
    };
    const monthLabel = (iso) => new Date(iso + 'T00:00:00Z')
      .toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    let aStart = monthStart(maxIso);
    if (monthEnd(maxIso) > maxIso) aStart = prevMonthStart(aStart); // current month incomplete
    const bStart = prevMonthStart(aStart);
    const aRows = inRange(aStart, monthEnd(aStart));
    const bRows = inRange(bStart, monthEnd(bStart));
    if (!aRows.length || !bRows.length) return null;
    const inProgress = monthEnd(maxIso) > maxIso
      ? `${monthLabel(monthStart(maxIso))} is in progress and excluded.` : '';
    return {
      a: { startIso: aStart, endIso: monthEnd(aStart), label: monthLabel(aStart), rows: aRows, totals: sumMetricRows(aRows) },
      b: { startIso: bStart, endIso: monthEnd(bStart), label: monthLabel(bStart), rows: bRows, totals: sumMetricRows(bRows) },
      note: inProgress
    };
  }

  if (mode === 'custom') return null; // caller builds windows from picked weeks
  return null; // 'all' and unknown modes: no comparison framing
}

// Custom comparison: any two weeks, each picked by any date inside it. Snapped
// to Monday weeks — matching the presets and the upload rhythm.
function igCustomWeekWindows(daily, aDateIso, bDateIso) {
  const rows = (daily || []).filter((r) => r && r.date).slice()
    .sort((x, y) => String(x.date).localeCompare(String(y.date)));
  if (!rows.length || !aDateIso || !bDateIso) return null;
  const fmt = (iso) => new Date(iso + 'T00:00:00Z')
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const win = (dateIso, name) => {
    const mon = isoMondayOf(dateIso);
    const end = isoAddDays(mon, 6);
    const r = rows.filter((x) => x.date >= mon && x.date <= end);
    return { startIso: mon, endIso: end, label: `${name} (${fmt(mon)} – ${fmt(end)})`, rows: r, totals: sumMetricRows(r) };
  };
  const a = win(aDateIso, 'Week A');
  const b = win(bDateIso, 'Week B');
  if (!a.rows.length || !b.rows.length) return null;
  return { a, b, note: '' };
}

// Precomputed latest-vs-previous deltas for a pair of metric rows — the AI
// QUOTES these, it never does division (it picked wrong denominators and
// invented baselines when asked to). Rate-ish keys get points; counts get
// absolute + relative % from pctDeltaLabel. Pure; tested.
function precomputeRowDeltas(prevRow, curRow) {
  const out = {};
  Object.keys(curRow || {}).forEach((k) => {
    const cur = Number(curRow[k]); const prev = Number((prevRow || {})[k]);
    if (isNaN(cur) || isNaN(prev)) return;
    if (/rate/i.test(k)) {
      const pts = (cur - prev) * 100;
      if (Math.abs(pts) >= 0.005) out[k] = `${pts > 0 ? '+' : '−'}${Math.abs(pts).toFixed(2)} percentage points`;
    } else {
      const pct = pctDeltaLabel(cur, prev);
      if (pct) out[k] = `${cur - prev > 0 ? '+' : ''}${(cur - prev).toLocaleString()} (${pct})`;
    }
  });
  return out;
}


// "2026-07-12" bucket → "12–18 Jul" (or "28 Jun – 4 Jul" across months).
// Weekly buckets are database keys; humans read date ranges.
function weekRangeLabel(weekStartIso) {
  const start = new Date(String(weekStartIso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(start)) return String(weekStartIso);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
  const d = (x) => x.getUTCDate();
  const m = (x) => x.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${d(start)}–${d(end)} ${m(end)}`
    : `${d(start)} ${m(start)} – ${d(end)} ${m(end)}`;
}

// ── Comparison windows for WEEKLY-bucketed reports (LinkedIn) ──
// Buckets are 7-day spans keyed by start date. The last bucket is usually IN
// PROGRESS (the export runs to mid-week), and comparing it to a full week
// manufactures a collapse — found live: "↓65%" was 5 days vs 7. Completeness
// rule: a bucket is complete only when today is PAST its end date.

function liWeekIsComplete(weekStartIso, todayIso) {
  return isoAddDays(String(weekStartIso).slice(0, 10), 6) < todayIso;
}

// Trailing in-progress bucket removed — for KPI tiles AND AI payloads, so
// every consumer reasons over complete weeks only.
function trimInProgressWeek(weekly, todayIso) {
  const rows = Array.isArray(weekly) ? weekly.slice() : [];
  while (rows.length && !liWeekIsComplete(rows[rows.length - 1].week, todayIso)) rows.pop();
  return rows;
}

// A-vs-B windows over weekly rows. Modes: wow, wo4, mom, custom (aKey/bKey =
// week keys). Returns { a, b, note } with totals per metric, or null.
function liComparisonWindows(weekly, mode, todayIso, aKey, bKey) {
  const all = Array.isArray(weekly) ? weekly.slice().sort((x, y) => String(x.week).localeCompare(String(y.week))) : [];
  if (!all.length) return null;
  const rows = trimInProgressWeek(all, todayIso);
  if (!rows.length) return null;
  const trimmedNote = rows.length < all.length
    ? `Current week (${weekRangeLabel(all[all.length - 1].week)}) is in progress and excluded.` : '';
  const win = (row, name) => row ? ({ startIso: row.week, label: `${name} (${weekRangeLabel(row.week)})`, totals: row }) : null;

  if (mode === 'wow') {
    if (rows.length < 2) return null;
    return { a: win(rows[rows.length - 1], 'Last full week'), b: win(rows[rows.length - 2], 'Week before'), note: trimmedNote };
  }
  if (mode === 'wo4') {
    if (rows.length < 2) return null;
    const a = rows[rows.length - 1];
    const base = rows.slice(-5, -1);
    const avg = {};
    base.forEach(r => Object.keys(r).forEach(k => {
      const v = Number(r[k]);
      if (!isNaN(v) && k !== 'week') avg[k] = (avg[k] || 0) + v / base.length;
    }));
    return { a: win(a, 'Last full week'),
      b: { startIso: null, label: `${base.length}-week average`, totals: avg },
      note: trimmedNote + (base.length < 4 ? ` Average uses ${base.length} prior week${base.length > 1 ? 's' : ''}.` : '') };
  }
  if (mode === 'mom') {
    const months = aggregateWeeklyToMonthly(rows);
    // Exclude the current calendar month — it is in progress by definition.
    const complete = months.filter(m => m.month < String(todayIso).slice(0, 7));
    if (complete.length < 2) return null;
    const a = complete[complete.length - 1], b = complete[complete.length - 2];
    return { a: { startIso: a.month, label: a.month, totals: a },
             b: { startIso: b.month, label: b.month, totals: b },
             note: months.length > complete.length ? `${String(todayIso).slice(0, 7)} is in progress and excluded.` : '' };
  }
  if (mode === 'custom') {
    const a = all.find(r => r.week === aKey), b = all.find(r => r.week === bKey);
    if (!a || !b) return null;
    const partial = [a, b].filter(r => !liWeekIsComplete(r.week, todayIso));
    return { a: win(a, 'Week A'), b: win(b, 'Week B'),
      note: partial.length ? `Week of ${partial.map(r => weekRangeLabel(r.week)).join(' & ')} is in progress — partial data.` : '' };
  }
  return null;
}

// ── Comms DOCX ingest (Rhea's report format, 28 Jul 2026) ──
// The "report" is a Word file where every send's stats are pasted DASHBOARD
// SCREENSHOTS under a date heading ("May 5 2026 Dispatch") — zero tables,
// zero text numbers. So ingestion is: unzip the .docx, pair each image with
// its send section in document order, have Claude read the screenshots into
// structured rows, then a human review step before anything is saved.

// Minimal ZIP reader — enough for .docx (which is just a zip). Uses the
// browser-native DecompressionStream, so no vendored zip library. Parses the
// central directory; supports stored (0) and deflate (8) entries.
async function extractZipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  // End-of-central-directory: scan back for PK\x05\x06
  let eocd = -1;
  for (let i = arrayBuffer.byteLength - 22; i >= 0 && i > arrayBuffer.byteLength - 65558; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file (no central directory).');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    // Local header repeats name/extra lengths — data starts after them.
    const lhNameLen = view.getUint16(localOffset + 26, true);
    const lhExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    entries[name] = { method, raw };
    offset += 46 + nameLen + extraLen + commentLen;
  }
  const out = {};
  for (const [name, e] of Object.entries(entries)) {
    if (e.method === 0) { out[name] = e.raw; continue; }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([e.raw]).stream().pipeThrough(ds);
    out[name] = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return out;
}

// "May 5 2026 Dispatch" / "7 July 2026 Newsletter" → { dateIso, sendType }.
// Both date orders appear in the real file. Null when the line isn't a send
// heading (Link:/Time:/section labels).
function parseCommsHeading(text) {
  const t = String(text || '').trim();
  const m = t.match(/^(.*?)\s*(Dispatch|Newsletter)\s*$/i);
  if (!m) return null;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const d = m[1].trim();
  let day, mon, year;
  let dm = d.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);      // May 5 2026
  if (dm) { mon = MONTHS[dm[1].slice(0, 3).toLowerCase()]; day = +dm[2]; year = +dm[3]; }
  else {
    dm = d.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/);        // 7 July 2026
    if (dm) { day = +dm[1]; mon = MONTHS[dm[2].slice(0, 3).toLowerCase()]; year = +dm[3]; }
  }
  if (!day || !mon || !year) return null;
  return {
    dateIso: `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    sendType: m[2][0].toUpperCase() + m[2].slice(1).toLowerCase(),
    heading: t
  };
}

// Walk document.xml in order: send headings partition the doc; every image
// reference (r:embed id) after a heading belongs to that send. Rels map the
// embed ids to media file paths. Regex-based (no DOMParser) so it's testable.
function parseCommsDocxStructure(documentXml, relsXml) {
  const rels = {};
  String(relsXml || '').replace(/<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g,
    (_, id, target) => { rels[id] = target.replace(/^\.?\//, ''); return ''; });
  const sends = [];
  let current = null;
  const paras = String(documentXml || '').match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  paras.forEach((p) => {
    const text = (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [])
      .map((t) => t.replace(/<[^>]+>/g, '')).join('');
    const heading = parseCommsHeading(text);
    if (heading) { current = { ...heading, imagePaths: [] }; sends.push(current); return; }
    (p.match(/r:embed="([^"]+)"/g) || []).forEach((e) => {
      const id = e.slice(9, -1);
      if (current && rels[id]) current.imagePaths.push('word/' + rels[id]);
    });
  });
  return sends.filter((s) => s.imagePaths.length);
}

// Storage object name → display parts. Uploads are stored as
// `${Date.now()}_${original name}` (see the upload handlers), so the date the
// file landed is IN the name — the bucket API's own timestamps reflect
// list-time metadata, not what we want shown.
function parseStoredUploadName(objectName) {
  const m = String(objectName || '').match(/^(\d{13})_(.+)$/);
  if (!m) return { displayName: String(objectName || ''), dateIso: null };
  return {
    displayName: m[2],
    dateIso: new Date(Number(m[1])).toISOString().slice(0, 10)
  };
}
