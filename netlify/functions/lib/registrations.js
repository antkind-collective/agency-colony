// Registrations (5 Nov 2026): how many artists have registered, as a
// health-of-the-movement metric on the client's analytics. Read, read-only,
// from Rishi's (The Sixth Sen) "Live Media Dashboard & Report" sheet for
// Example Collective Month: its Campaign Results tab carries a running total of
// form fills (all registrations, his own Jotform connection), one column per
// snapshot, every three days. Colony reads it as its own service account,
// which Rishi added as a Viewer; nothing is ever written to his sheet.
//
// Configured in app_config.registrations:
//   { "<client id>": { "sheet_id": "…", "tab": "Campaign Results" } }
// The rows are found by their labels in column A ("Metric" for the dates,
// "Total number of form fills" for the counts), so moved rows still work.
const { googleAccessToken } = require('./google-auth');

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const DATE_ROW = /^metric$/i;
const COUNT_ROW = /^total number of form fills$/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// "As of 04 Nov 2026" → "2026-11-04"; anything else → ''.
function snapshotDate(cell) {
  const m = String(cell || '').match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m || !MONTHS[m[2].toLowerCase()]) return '';
  return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const count = (cell) => {
  const n = Number(String(cell ?? '').replace(/[,\s]/g, ''));
  return String(cell ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
};

const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

// The tab's values (rows of cells) → the client's 'registrations' row:
// one snapshot per dated column that has a count, oldest first.
function buildRegistrationsReport(values, { sheetTitle = '', now = new Date() } = {}) {
  const rows = Array.isArray(values) ? values : [];
  const label = (r) => String(r?.[0] || '').trim();
  const dates = rows.find((r) => DATE_ROW.test(label(r)));
  const counts = rows.find((r) => COUNT_ROW.test(label(r)));
  if (!dates) throw new Error('Rishi\'s sheet no longer has the "Metric" row with the snapshot dates.');
  if (!counts) throw new Error('Rishi\'s sheet no longer has the "Total number of form fills" row.');
  const snapshots = [];
  for (let c = 1; c < dates.length; c += 1) {
    const date = snapshotDate(dates[c]);
    const total = count(counts[c]);
    if (date && total !== null) snapshots.push({ date, total });
  }
  if (!snapshots.length) throw new Error('Rishi\'s sheet has no form-fill counts yet.');
  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  snapshots.forEach((s, i) => { s.new = i ? s.total - snapshots[i - 1].total : null; });
  const latest = snapshots[snapshots.length - 1];
  const prev = snapshots[snapshots.length - 2] || null;
  // The latest snapshot at least 7 days before the newest one, for "last 7 days".
  const weekAgo = [...snapshots].reverse().find((s) => dayMs(latest.date) - dayMs(s.date) >= 7 * 86400000) || null;
  return {
    report_type: 'registrations',
    report_label: 'Registrations',
    file_name: "Rishi's media dashboard (Google Sheet)",
    file_path: 'sheet:registrations',
    data_through: latest.date,
    metrics_data: snapshots,
    summary: {
      total: latest.total,
      as_of: latest.date,
      since_previous: prev ? latest.total - prev.total : null,
      previous_date: prev?.date || null,
      last_7_days: weekAgo ? latest.total - weekAgo.total : null,
      week_ago_date: weekAgo?.date || null,
      source: sheetTitle || null,
      pulled_on: new Date(now).toISOString().slice(0, 10)
    },
    uploaded_at: new Date(now).toISOString()
  };
}

async function readSheetTab(sheetId, tab) {
  const token = await googleAccessToken(SHEETS_SCOPE, { asSelf: true });
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`;
  const get = async (url) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      if (res.status === 403 && /has not been used|is disabled/i.test(msg)) throw new Error(`Google Sheets API is off for Colony's Google project. Turn it on: ${(msg.match(/https:\/\/\S+/) || [''])[0]}`);
      if (res.status === 403 || res.status === 404) throw new Error('Colony can\'t open Rishi\'s sheet. It needs colony-provisioning@your-project.iam.gserviceaccount.com added as a Viewer.');
      throw new Error(`Google Sheets said: ${msg}`);
    }
    return body;
  };
  const meta = await get(`${base}?fields=properties.title`);
  const data = await get(`${base}/values/${encodeURIComponent(`'${tab}'!A1:Z60`)}?valueRenderOption=FORMATTED_VALUE`);
  return { title: meta?.properties?.title || '', values: data.values || [] };
}

async function syncRegistrations(admin, now = new Date()) {
  const summary = { clients: 0, synced: [], errors: [] };
  const { data } = await admin.from('app_config').select('value').eq('key', 'registrations').maybeSingle();
  const map = data?.value && typeof data.value === 'object' ? data.value : {};
  for (const [clientId, cfg] of Object.entries(map)) {
    summary.clients += 1;
    try {
      const sheetId = String(cfg?.sheet_id || '');
      if (!/^[A-Za-z0-9_-]{20,}$/.test(sheetId)) throw new Error('no sheet id');
      const { title, values } = await readSheetTab(sheetId, String(cfg?.tab || 'Campaign Results'));
      const row = buildRegistrationsReport(values, { sheetTitle: title, now });
      const { error } = await admin.from('client_analytics')
        .upsert({ client_id: clientId, ...row }, { onConflict: 'client_id,report_type' });
      if (error) throw new Error(error.message);
      summary.synced.push({ clientId, total: row.summary.total, asOf: row.summary.as_of });
    } catch (e) {
      summary.errors.push(`${clientId}: ${e.message}`);
    }
  }
  return summary;
}

module.exports = { SHEETS_SCOPE, snapshotDate, buildRegistrationsReport, readSheetTab, syncRegistrations };
