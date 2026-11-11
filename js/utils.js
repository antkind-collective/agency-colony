/* ── Your Agency utils: pure helpers only ──
   Classic script (not an ES module) — loaded before app.js in index.html,
   shares the global scope. Everything here must stay pure: no DOM access,
   no `state`, no Supabase. That keeps this file testable in Node
   (see tests/utils.test.mjs). */

function formatTimestamp(dateValue = new Date()) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleString('en-US', { month: 'short' });
  const year = date.getFullYear();
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours === 0 ? 12 : hours;
  return `${day} ${month} ${year}, ${String(hours).padStart(2, '0')}:${minutes} ${suffix}`;
}

function parseTimestamp(timestampText) {
  if (!timestampText) return null;
  const match = timestampText.match(/^(\d{2})\s([A-Za-z]{3})\s(\d{4}),\s(\d{2}):(\d{2})\s(AM|PM)$/);
  if (!match) return null;

  const [, dd, mon, yyyy, hh, mm, meridiem] = match;
  const monthMap = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11
  };
  const month = monthMap[mon];
  if (month === undefined) return null;

  let hour = Number(hh);
  if (meridiem === 'PM' && hour !== 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  return new Date(Number(yyyy), month, Number(dd), hour, Number(mm), 0, 0);
}

// The CITY_OPTIONS entry for a name, or null if nothing matches. Resolves
// aliases (Gurgaon -> Gurugram, Calicut -> Kozhikode) so a rename doesn't nag
// someone who was never wrong, and is case/whitespace-insensitive on top.
// Returning null rather than a guess is the point: an unrecognised city must
// be ASKED about, never silently assigned a zone that could be wrong.
function cityEntryFor(city) {
  const needle = String(city || '').trim().toLowerCase();
  if (!needle) return null;
  return CITY_OPTIONS.find((o) => o.city.toLowerCase() === needle
    || (o.aliases || []).some((a) => a.toLowerCase() === needle)) || null;
}

// The IANA zone for a city name. Falls back to DEFAULT_TIMEZONE for anything
// unmatched — deliberately, because an unrecognised city must never be able to
// stop a profile from saving or crash a cron. The UI does not rely on this
// fallback to be CORRECT: it prompts for an explicit choice instead (see
// cityOptionsHtml). This is the floor, not the answer.
function timezoneForCity(city) {
  const entry = cityEntryFor(city);
  return entry ? entry.tz : DEFAULT_TIMEZONE;
}

function toISODateLocal(dateValue = new Date()) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateForLabel(dateValue) {
  if (!dateValue) return '--';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(new Date(dateValue));
}

function parseIsoDateLocal(dateValue) {
  const text = String(dateValue || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, yyyy, mm, dd] = match;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
}

function isoWeekMetaFromDate(dateValue) {
  const local = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(local.getTime())) return { year: new Date().getFullYear(), week: 0 };
  const utcDate = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const isoYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((utcDate - yearStart) / 86400000 + 1) / 7);
  return { year: isoYear, week: isoWeek };
}

function weekIdentifierFromIsoDate(dateIso) {
  const parsed = parseIsoDateLocal(dateIso);
  if (!parsed) return '';
  const meta = isoWeekMetaFromDate(parsed);
  return `${meta.year}-W${String(meta.week).padStart(2, '0')}`;
}

function formatWeekRangeLabel(weekStartIso) {
  const start = parseIsoDateLocal(weekStartIso) || new Date(weekStartIso);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

function formatWeekIdentifierLabel(weekStartIso) {
  return formatWeekRangeLabel(weekStartIso);
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0%';
  const bounded = Math.max(0, Math.min(100, numeric));
  const rounded = Math.round(bounded * 100) / 100;
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/\.?0+$/, '');
  return `${text}%`;
}

function formatPercentRaw(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0%';
  const rounded = Math.round(numeric * 100) / 100;
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/\.?0+$/, '');
  return `${text}%`;
}

function percentNumberFromText(value) {
  const match = String(value || '').match(/-?\d+(\.\d+)?/);
  if (!match) return 0;
  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? numeric : 0;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// A partner's org decides everything they can read, so it is never guessed
// (S3, 24 Sep 2026). The add bar used to arrive pre-filled with "Global
// Artivism" and fell back to it when cleared: inviting a second client without
// retyping the box made them a the client partner with all of the client's briefs. Now it must
// be typed. A case/space variant of a known org resolves to that org's exact
// spelling (a stray "example collective" would otherwise be a separate, empty
// org); anything else is reported as new so the caller can confirm it.
function resolvePartnerOrg(input, knownOrgs = []) {
  const typed = String(input || '').trim().replace(/\s+/g, ' ');
  if (!typed) return { error: 'Enter the client organisation.' };
  const key = typed.toLowerCase();
  const match = (knownOrgs || []).find((o) => String(o || '').trim().replace(/\s+/g, ' ').toLowerCase() === key);
  return match ? { org: String(match).trim(), isNew: false } : { org: typed, isNew: true };
}

// Matches the DB's lower(task_title) unique index — never compare task titles
// with plain ===; always go through this.
function taskTitleKey(title) {
  return (title || '').toLowerCase().trim();
}


// Classify a scheduled job's health from its last heartbeat age. Pure, so the
// thresholds are unit-testable. cadence: 'daily' | 'weekly' | 'monthly'.
// 'late' = one missed window; 'dead' = more than twice the window.
function cronHealthStatus(lastRunIso, cadence, now = new Date()) {
  if (!lastRunIso) return 'unknown';
  const last = new Date(lastRunIso);
  if (Number.isNaN(last.getTime())) return 'unknown';
  const ageHours = (now - last) / 3600000;
  const windowHours = { daily: 26, weekly: 8 * 24, monthly: 32 * 24 }[cadence] || 26;
  if (ageHours <= windowHours) return 'ok';
  return ageHours <= windowHours * 2 ? 'late' : 'dead';
}

// Freshness predicate for the screen-switch cache (state.loadedAt stamps).
function isFreshStamp(stampMs, nowMs, ttlMs) {
  return Boolean(stampMs) && (nowMs - stampMs) < ttlMs;
}

// Task link rule (per Alex): a URL in the DESCRIPTION makes the task TITLE
// clickable; the description displays as plain text with the raw URL removed.
// Returns { url, displayDesc } — url null when there's no link.
// A link in a task description is never shown raw: it is lifted out and the
// TASK TITLE becomes the link (taskTitleHtml). Pasting a bare URL into the
// description used to leave it sitting in the cell whenever it lacked a
// scheme — "drive.google.com/…" is how people actually paste (20 Sep
// 2026).
//
// Three shapes, in order: a full URL; anything starting www.; and host/path
// where the host ends in a real letters-only TLD. That last clause is what
// keeps ordinary text out — "scored 3.5/10" has no letter TLD, so it stays
// text instead of silently turning into a link.
const URL_IN_TEXT_RE = /(?:https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/[^\s]*)/i;
// NOT the June 2026 `linkifyText`, which is gone on purpose and guarded by a
// test: that one linkified TASK DESCRIPTIONS inline, and Alex replaced it
// with "the task TITLE is the link" (taskTitleHtml). Tasks still work that
// way and must keep working that way.
//
// This is for PROSE, where there is no title to hang a link on: brief fields
// (Circle's form has a field FOR links that rendered them flat), comments,
// and feedback posts. Human-written text — often carries a URL. Show it as a link rather than as characters someone has to
// select and copy (20 Sep 2026: the same complaint as task links, and
// Circle's brief form has a field FOR links that rendered them flat).
//
// XSS-safe by construction: every chunk, and the href itself, goes through
// escapeHtml — nothing from the user reaches the page unescaped.
function linkifyProse(text) {
  let rest = String(text ?? '');
  let out = '';
  for (;;) {
    const m = rest.match(URL_IN_TEXT_RE);
    if (!m) return out + escapeHtml(rest);
    // A URL at the end of a sentence must not swallow the full stop.
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (!url) return out + escapeHtml(rest);
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    out += escapeHtml(rest.slice(0, m.index));
    out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    rest = rest.slice(m.index + url.length);
  }
}

function taskLinkParts(description) {
  const text = String(description || '');
  const m = text.match(URL_IN_TEXT_RE);
  if (!m) return { url: null, displayDesc: text };
  const raw = m[0];
  // href always carries a scheme, or the browser reads it as a relative path.
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return { url, displayDesc: text.replace(raw, '').replace(/\s{2,}/g, ' ').trim() };
}

// Render a task title cell: clickable (new tab) when its description holds a
// URL; always XSS-safe.
function taskTitleHtml(task) {
  const title = escapeHtml(task.task_title);
  const { url } = taskLinkParts(task.description);
  if (!url) return title;
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="task-link" onclick="event.stopPropagation()">${title} ↗</a>`;
}


// ── Working days ────────────────────────────────────────────────────────────
// Any date Colony PROPOSES or JUDGES has to skip weekends and Your Agency public
// holidays — a calendar-day count promises dates nobody works on (Alex,
// 24 Aug 2026). `holidays` is an array of 'YYYY-MM-DD'.
//
// UTC throughout, deliberately: parsing 'YYYY-MM-DD' as LOCAL midnight and then
// serialising with toISOString() drops a day everywhere east of UTC — in IST it
// turned 10 Sep into 09 Sep. A date with no time attached has no timezone.
function isWorkingDay(iso, holidays = []) {
  const day = new Date(iso + 'T00:00:00Z').getUTCDay();
  if (day === 0 || day === 6) return false;
  return !holidays.includes(iso);
}

function shiftIsoDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Inclusive: day 1 is the start day itself, so `days` working days means
// advancing (days - 1) further working days.
function addWorkingDays(startIso, days, holidays = []) {
  if (!Number.isFinite(days) || days <= 0) return startIso;
  let cursor = startIso;
  let remaining = days - 1;
  while (remaining > 0) {
    cursor = shiftIsoDays(cursor, 1);
    if (isWorkingDay(cursor, holidays)) remaining -= 1;
  }
  return cursor;
}

// How many working days from a to b (exclusive of a, inclusive of b). Negative
// when b is in the past. Used for "due soon" windows so a weekend never eats
// the warning.
function workingDaysBetween(fromIso, toIso, holidays = []) {
  if (!fromIso || !toIso) return null;
  if (toIso < fromIso) return -workingDaysBetween(toIso, fromIso, holidays);
  let count = 0;
  let cursor = fromIso;
  while (cursor < toIso) {
    cursor = shiftIsoDays(cursor, 1);
    if (isWorkingDay(cursor, holidays)) count += 1;
  }
  return count;
}


// Today on the AGENCY clock, not the viewer's. Streak rows are pinned to IST by
// their RLS policy, so a teammate in Tokyo (UTC+9) writing their own local date
// would be refused between midnight and 03:30 their time, and silently lose the
// day (Alex asked for an audit, 26 Aug 2026 — we have one employee in Tokyo).
function istToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}


// 1st, 2nd, 3rd, 4th … (11th/12th/13th are the exceptions that catch people out)
function ordinal(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  const mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
  return `${num}${['th', 'st', 'nd', 'rd'][num % 10] || 'th'}`;
}


// People pickers list everyone alphabetically by first name (25 Sep
// 2026, P3). Replaces a surname test that pushed every "Morgan" to one end.
// full_name starts with the first name; case and accents are ignored.
function compareByFirstName(a, b) {
  return String(a?.full_name || '').trim().localeCompare(String(b?.full_name || '').trim(), 'en', { sensitivity: 'base' });
}
