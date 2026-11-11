/* ── Your Agency config: constants only ──
   Classic script (not an ES module) — loaded before app.js in index.html,
   shares the global scope. No DOM, no state, no functions with behavior.
   First slice of the app.js modularization: keep this file pure config. */

const DEFAULT_EMPLOYEE = 'My Profile';
const WORK_HOURS_PER_WEEK = 45;
const HOURS_PER_DAY = 9;

const ENFORCED_ACCESS_BY_EMAIL = {
  'admin@youragency.com': 'admin',
  'strategy-lead@youragency.com': 'leadership',
  'creative-lead@youragency.com': 'leadership',
  'am-lead@youragency.com': 'leadership',
  'ops-lead@youragency.com': 'leadership'
};

const SUPERADMIN_EMAIL = 'admin@youragency.com';
// HARDCODED on purpose (23 Jul 2026) — deliberately NOT config-driven.
// Invoices are compensation data; a panel-editable list is one mistyped email
// away from exposing everyone's invoices. Changing this list = edit here AND
// app.is_invoice_viewer() in the DB (they must stay identical), then deploy.
const INVOICE_VIEWER_EMAILS = ['finance@youragency.com', 'am-lead@youragency.com', 'admin@youragency.com'];
const INVOICE_EXCLUDED_EMAILS = ['admin@youragency.com'];
const HIDDEN_EMPLOYEE_EMAILS = ['finance@youragency.com']; // have access but hidden from all team views
// Accounts that are not a person, so they never belong on all@youragency.com and
// the daily group sync should stop naming them (24 Sep 2026: studio is
// "a temp ID, soon to be disconnected").
const ALL_GROUP_EXEMPT_EMAILS = ['studio@youragency.com'];
// NOTE: there is no CAPACITY_EXCLUDED_EMAILS. "Not part of the agency capacity
// pool" is derived from client scope (app.employee_client_scope) — see
// isCapacityExcluded in js/access.js. A hand-maintained email list drifted from
// the fact it was standing in for.
// Deal Flow is PURE LEADERSHIP (23 Jul 2026). This fallback is empty on
// purpose so every failure mode — missing config key, unreachable DB — lands on
// leadership-only. Extras, if ever wanted again, are granted via the Deal-flow
// viewers panel (app_config.deal_flow_extra_emails), not here.
const DEAL_FLOW_EXTRA_EMAILS = [];
// Who approves a new joiner's setup (team, full-time/project-based, capacity,
// clients). Alex + Nadia only — deliberately NOT leadership-wide, because
// activation grants client access.
const SETUP_APPROVER_EMAILS = ['admin@youragency.com', 'am-lead@youragency.com'];
// Teams a new joiner can pick during onboarding. The delivery teams only —
// Leadership, Finance and Strategy are not self-selectable.
const ONBOARDING_DEPARTMENTS = ['AM', 'Copy', 'Art', 'Video'];

// Brief pipeline reviewers (the client Brief Tracking) — may lock/reopen/assign.
// Leadership always qualifies on top of this list.
const BRIEF_REVIEWER_EMAILS = ['rhea@youragency.com', 'mara@youragency.com'];

// Hiring pipeline crew beyond the setup approvers: legal + finance.
const HIRING_CREW_EMAILS = ['leo@youragency.com', 'finance@youragency.com'];
// @youragency.com accounts that get ONLY the hiring section — never an employee
// profile (mirrors app.is_hiring_only_email in the DB).
const HIRING_ONLY_EMAILS = ['leo@youragency.com'];

// Rows in `clients` that aren't real clients: internal buckets people allocate
// time against. Excluded from the client-scope picker, since "dedicated to
// Pitches/BD" isn't a thing — and scoping someone to one would mark them
// client-scoped (gating their access, removing them from agency capacity)
// while granting no real client. These are genuine buckets Alex named (the
// synthetic 'Internal' client was removed on 27 Sep 2026).
// Compared lowercased; see the scope picker in renderPendingSetupAdmin.
const NON_CLIENT_BUCKETS = ['misc', 'misc/bizdev', 'pitches/bd'];
const ANT_DOMAIN = '@youragency.com';
const TEAM_AM = 'AM';
const TEAM_AM_LEGACY = 'Acc Management'; // DB renamed to 'AM' — kept for backward compat during transition
const TEAM_MANAGER_BY_TEAM = Object.freeze({
  [TEAM_AM]: 'am-lead@youragency.com',
  Art: 'creative-lead@youragency.com',
  Copy: 'creative-lead@youragency.com',
  Video: 'creative-lead@youragency.com',
  Strategy: 'strategy-lead@youragency.com'
});
const DIRECT_MANAGER_BY_EMAIL = Object.freeze({
  'creative-lead@youragency.com': SUPERADMIN_EMAIL,
  'am-lead@youragency.com': SUPERADMIN_EMAIL,
  'strategy-lead@youragency.com': SUPERADMIN_EMAIL,
  'ops-lead@youragency.com': SUPERADMIN_EMAIL
});

// Home cities, each carrying its own IANA zone. There is no browser API that
// maps a city to a timezone (Intl only reports the zone you are already in),
// and Colony has no build step to pull in a tz library — so the list IS the
// mapping. Picking a city picks a zone; nothing is looked up or inferred.
// `city` is what shows in the directory, `tz` is what the crons run on; they
// are stored as separate columns because "where I live" and "what clock I'm on"
// are different questions, and only the first is the employee's to keep current.
// Seeded from the real roster — Tura, Sikar, Benaulim and Ghaziabad are on it,
// and no off-the-shelf city list has those — plus the metros people plausibly
// move to.
//
// `aliases` carries the names people actually typed before this list existed,
// so a rename or a suffix resolves to the canonical entry instead of nagging
// someone who was never wrong (Gurgaon was renamed Gurugram in 2016; Calicut
// is Kozhikode). Matching is case- and whitespace-insensitive on top of this.
// A value that matches NOTHING is never guessed at and never silently kept —
// the picker asks the person to choose. See cityOptionsHtml in app.js.
const CITY_OPTIONS = [
  { group: 'India', city: 'Ahmedabad', tz: 'Asia/Kolkata' },
  { group: 'India', city: 'Benaulim', tz: 'Asia/Kolkata' },
  { group: 'India', city: 'Bengaluru', tz: 'Asia/Kolkata', aliases: ['Bangalore'] },
  { group: 'India', city: 'Chandigarh', tz: 'Asia/Kolkata' },
  { group: 'India', city: 'Chennai', tz: 'Asia/Kolkata', aliases: ['Madras'] },
  { group: 'India', city: 'Delhi', tz: 'Asia/Kolkata', aliases: ['New Delhi'] },
  { group: 'India', city: 'Ghaziabad', tz: 'Asia/Kolkata' },
  // Goa is a state, not a city — but it is how people here name where they are,
  // and both Goa-based folks entered exactly this. Kept as a first-class entry
  // rather than corrected at them; Benaulim and Panaji are also on the list.
  { group: 'India', city: 'Goa', tz: 'Asia/Kolkata' },
  { group: 'India', city: 'Gurugram', tz: 'Asia/Kolkata', aliases: ['Gurgaon'] },
  { group: 'India', city: 'Hyderabad', tz: 'Asia/Kolkata' },
  { group: 'India', city: 'Indore', tz: 'Asia/Kolkata' },
  { group: 'India', city: 'Jaipur', tz: 'Asia/Kolkata' },
  { group: 'India', city: 'Kochi', tz: 'Asia/Kolkata', aliases: ['Cochin', 'Ernakulam'] },
  { group: 'India', city: 'Kolkata', tz: 'Asia/Kolkata', aliases: ['Calcutta'] },
  { group: 'India', city: 'Kozhikode', tz: 'Asia/Kolkata', aliases: ['Calicut', 'Calicut, Kerala'] },
  { group: 'India', city: 'Lucknow', tz: 'Asia/Kolkata' },
  { group: 'India', city: 'Mumbai', tz: 'Asia/Kolkata', aliases: ['Bombay'] },
  { group: 'India', city: 'Noida', tz: 'Asia/Kolkata' },
  { group: 'India', city: 'Panaji', tz: 'Asia/Kolkata', aliases: ['Panjim'] },
  { group: 'India', city: 'Pune', tz: 'Asia/Kolkata', aliases: ['Poona'] },
  { group: 'India', city: 'Sikar', tz: 'Asia/Kolkata' },
  { group: 'India', city: 'Tura', tz: 'Asia/Kolkata' },
  { group: 'Asia Pacific', city: 'Bangkok', tz: 'Asia/Bangkok' },
  { group: 'Asia Pacific', city: 'Colombo', tz: 'Asia/Colombo' },
  { group: 'Asia Pacific', city: 'Dubai', tz: 'Asia/Dubai' },
  { group: 'Asia Pacific', city: 'Kathmandu', tz: 'Asia/Kathmandu' },
  { group: 'Asia Pacific', city: 'Melbourne', tz: 'Australia/Melbourne' },
  { group: 'Asia Pacific', city: 'Singapore', tz: 'Asia/Singapore' },
  { group: 'Asia Pacific', city: 'Sydney', tz: 'Australia/Sydney' },
  { group: 'Asia Pacific', city: 'Tokyo', tz: 'Asia/Tokyo' },
  { group: 'Europe', city: 'Amsterdam', tz: 'Europe/Amsterdam' },
  { group: 'Europe', city: 'Berlin', tz: 'Europe/Berlin' },
  { group: 'Europe', city: 'Lisbon', tz: 'Europe/Lisbon' },
  { group: 'Europe', city: 'London', tz: 'Europe/London' },
  { group: 'Europe', city: 'Madrid', tz: 'Europe/Madrid' },
  { group: 'Europe', city: 'Paris', tz: 'Europe/Paris' },
  { group: 'Americas', city: 'Chicago', tz: 'America/Chicago' },
  { group: 'Americas', city: 'Los Angeles', tz: 'America/Los_Angeles' },
  { group: 'Americas', city: 'New York', tz: 'America/New_York' },
  { group: 'Americas', city: 'Toronto', tz: 'America/Toronto' }
];

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

// Keep sorted by date. The holiday list is decided collaboratively with the
// team each year — append the next year's entries only after that exercise.
// Every consumer filters by date, so past entries are harmless to keep.
const PUBLIC_HOLIDAYS = [
  { date: '2026-01-26', name: 'Republic Day' },
  { date: '2026-02-15', name: 'Maha Shivratri' },
  { date: '2026-03-04', name: 'Holi' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-05-01', name: 'Labor Day' },
  { date: '2026-08-15', name: 'Independence Day' },
  { date: '2026-09-14', name: 'Ganesh Chaturthi' },
  { date: '2026-10-02', name: 'Gandhi Jayanti' },
  { date: '2026-10-19', name: 'Durga Ashtami' },
  { date: '2026-11-09', name: 'Diwali' },
  { date: '2026-11-24', name: 'Guru Nanak Jayanti' },
  { date: '2026-12-25', name: 'Christmas Break' },
  { date: '2026-12-26', name: 'Christmas Break' },
  { date: '2026-12-27', name: 'Christmas Break' },
  { date: '2026-12-28', name: 'Christmas Break' },
  { date: '2026-12-29', name: 'Christmas Break' },
  { date: '2026-12-30', name: 'Christmas Break' },
  { date: '2026-12-31', name: 'Christmas Break' },
  { date: '2027-01-01', name: 'Christmas Break' },
  { date: '2027-01-02', name: 'Christmas Break' },
  { date: '2027-01-03', name: 'Christmas Break' }
];

// Festivals that fall on a weekend, when the office day off is a different
// day (29 Oct 2026: Diwali is on a Sunday and should still show).
// Home's Coming up lists the festival itself on its own day; the holiday
// above still says the office is closed.
const FESTIVALS = [
  { date: '2026-11-08', name: 'Diwali' }
];


// ── Employment type ─────────────────────────────────────────────────────────
// Three values everywhere (31 Aug 2026): app.employees.employment_type
// and app.hires.hire_type now share this vocabulary. "Project-based" is retired
// as a second name for fractional — one idea, one word.
const EMPLOYMENT_TYPES = ['full-time', 'fractional', 'consultant'];
const EMPLOYMENT_TYPE_LABEL = {
  'full-time': 'Full-time',
  'fractional': 'Fractional',
  'consultant': 'Consultant'
};

// A consultant is an employee whose contract is structured differently: they
// raise an invoice, but they accrue leave, get nudged and see clients exactly
// like salaried staff. Only fractional people are client-scoped.
function employmentRaisesInvoice(type) {
  return type === 'fractional' || type === 'consultant';
}

function employmentIsScoped(type) {
  return type === 'fractional';
}

function employmentTypeLabel(type) {
  return EMPLOYMENT_TYPE_LABEL[type] || EMPLOYMENT_TYPE_LABEL['full-time'];
}

// ── Circle: the client-facing platform (7 Sep 2026) ────────────────
// One application, one database, two doors. Employees use Colony at
// app.youragency.com; clients use Circle at clients.youragency.com. The split is by
// HOSTNAME, not by session, so the name and the tab title are right from the
// first paint — before we know who is signing in.
//
// Candidates going through joining paperwork are NOT part of Circle: that is
// Your Agency's own hiring flow and stays on Colony.
const STAFF_HOST = 'app.youragency.com';
const CIRCLE_HOST = 'clients.youragency.com';

function isCircleHost(hostname) {
  return STAFF_HOST !== CIRCLE_HOST && String(hostname || '').toLowerCase().split(':')[0] === CIRCLE_HOST;
}

function productName(hostname) {
  return isCircleHost(hostname) ? 'Circle' : 'Colony';
}

// Where a signed-in session belongs. Partners belong on Circle, everyone else
// on Colony; returns null when they are already in the right place so the
// caller never redirects for no reason. Localhost and deploy previews are
// left alone — they are neither host and bouncing them would break testing.
function homeHostFor(sessionKind, hostname) {
  if (STAFF_HOST === CIRCLE_HOST) return null;
  const host = String(hostname || '').toLowerCase().split(':')[0];
  if (host !== STAFF_HOST && host !== CIRCLE_HOST) return null;
  const belongs = sessionKind === 'partner' ? CIRCLE_HOST : STAFF_HOST;
  return host === belongs ? null : belongs;
}

// ── Google Workspace reseller (Example Reseller) ──────────────────────────────────
// Who to ask for a new @youragency.com account. Contact moved from Sky to
// Kay on 8 Sep 2026 (Alex). Nadia stays copied — she is on every hiring
// email by standing instruction, separately from the vendor's own list.
const WORKSPACE_VENDOR_TO = 'reseller@example.com';
const WORKSPACE_VENDOR_CC = ['am-lead@youragency.com', 'reseller-2@example.com', 'reseller-support@example.com'];
// Greeting follows the To: address — "Hi Sky" going to Kay is the kind
// of small wrongness a vendor notices.
const WORKSPACE_VENDOR_GREETING = 'Kay';

// A task description doubles as its link: a URL in here makes the task title
// clickable (taskLinkParts / taskTitleHtml). ONE limit, used by the create
// form, the edit row and both validations — they carried separate numbers
// (create 200, edit 50) until 20 Sep 2026, so pasting a link into an edit
// silently refused to save (Dev). Never inline a number again.
const TASK_DESCRIPTION_MAX = 200;
