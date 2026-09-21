/* ── Splash screen ── */
function dismissSplash() {
  const el = document.getElementById('splashScreen');
  if (!el || el.classList.contains('splash-hidden')) return;
  el.classList.add('splash-hidden');
  el.addEventListener('transitionend', () => el.remove(), { once: true });
}

// Constants live in js/config.js (loaded before this file).
const employeeStore = {};

let APP_UPDATES = [];

const state = {
  role: 'employee',
  currentEmployee: DEFAULT_EMPLOYEE,
  isAuthenticated: false,
  supabase: null,
  session: null,
  employeeProfile: null,
  runtimeConfig: null,
  leaveRowsById: new Map(),
  employeeDirectory: [],
  dailyTasks: [],
  featureRequests: [],
  clients: [],
  weeklyAllocations: [],
  taskViewEmployeeId: null,
  allocationViewEmployeeId: null,
  allocationClientFilter: 'all',
  profileAllocationRows: [],
  profileWeekOptions: [],
  profileWeekKey: '',
  currentEmployeeId: null,
  authIntent: 'signin',
  pendingAuthStatus: null,
  _realRole: null,
  leaveCycleSummary: null,
  homeAllocations: [],
  // An Your Agency reviewer signed in on Circle to answer client feedback. Never
  // true on Colony, and cleared on sign-out with the rest of the session.
  staffOnCircle: false,
  deals: [],
  dealSection: 'hot',
  dealFilter: 'open',
  dealView: 'board',
  dealFilterPoc: '',
  dealSearch: '',
  dealCompany: 'Your Agency',
  inactiveEmployees: [],
  publicHolidays: null, // loaded from app.public_holidays; null = use PUBLIC_HOLIDAYS fallback
  accessOverrides: null, // loaded from app.access_overrides; null/empty = use ENFORCED_ACCESS_BY_EMAIL fallback
  appConfig: null, // loaded from app.app_config (key→value); per-key fallback to the config.js constants
  clientScopeByEmployee: null, // employee_id → Set(client_id) from app.employee_client_scope.
  // Scoped people are dedicated to specific clients: non-leadership among them
  // see only those clients (enforced in RLS), and ALL of them are excluded from
  // agency-level capacity maths — they're not reassignable bandwidth. Their
  // capacity still counts at client level. null = not loaded yet.
  homePulse: null, // home feed live signals: whosOut (RPC), doneTasks, dealMoves, myTasksDueToday
  loadedAt: {} // loader freshness stamps (screen-switch cache; mutations call raw loaders which re-stamp)
};

// Holiday list: prefer the DB-managed list (editable in Admin Settings), fall
// back to the in-code PUBLIC_HOLIDAYS constant if the table is empty/unreachable.
function getPublicHolidays() {
  return (state.publicHolidays && state.publicHolidays.length)
    ? state.publicHolidays
    : PUBLIC_HOLIDAYS;
}

async function loadPublicHolidaysFromSupabase() {
  if (!state.supabase) return;
  const { data, error } = await state.supabase
    .from('public_holidays')
    .select('holiday_date, name')
    .order('holiday_date', { ascending: true });
  if (error) { console.error('Public holidays load failed:', error); return; }
  // Normalize to the shape every consumer expects: { date, name }.
  state.publicHolidays = (data || []).map(r => ({ date: r.holiday_date, name: r.name }));
}

// Access overrides (the role failsafe, editable by superadmin in Admin Settings).
// Loaded into a { email: role } map for drop-in compatibility with the old
// hardcoded ENFORCED_ACCESS_BY_EMAIL constant; getEnforcedAccessMap() (access.js)
// falls back to that constant if this is empty/unreachable. MUST be awaited
// before getEnforcedAccessLevel() runs during login.
async function loadAccessOverrides() {
  if (!state.supabase) return;
  const { data, error } = await state.supabase
    .from('access_overrides')
    .select('email, role');
  if (error) { console.error('Access overrides load failed:', error); return; }
  const map = {};
  (data || []).forEach(r => { map[normalizeEmail(r.email)] = r.role; });
  state.accessOverrides = map;
}

// Generic operational config (app.app_config, superadmin-editable). Loaded into
// a { key: value } map; each get*() accessor falls back to the in-code constant
// for that key if the table/key is missing. Awaited in applyAuthState before
// visibility is computed.
async function loadAppConfig() {
  if (!state.supabase) return;
  const { data, error } = await state.supabase
    .from('app_config')
    .select('key, value');
  if (error) { console.error('App config load failed:', error); return; }
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  state.appConfig = map;
}

// Which people are dedicated to specific clients (app.employee_client_scope).
// Readable by everyone by design: the home "Hours Allocated" stat isn't
// leadership-gated, so every viewer must compute the same capacity exclusion.
// Rows carry client_id only — a scoped user can't resolve ids for clients the
// clients RLS hides from them. Awaited in applyAuthState alongside loadAppConfig.
async function loadClientScope() {
  if (!state.supabase) return;
  const { data, error } = await state.supabase
    .from('employee_client_scope')
    .select('employee_id, client_id');
  if (error) { console.error('Client scope load failed:', error); return; }
  const map = new Map();
  (data || []).forEach(r => {
    if (!map.has(r.employee_id)) map.set(r.employee_id, new Set());
    map.get(r.employee_id).add(r.client_id);
  });
  state.clientScopeByEmployee = map;
}

// Config accessors (getConfigList/getConfigMap + the per-key getters) live in
// js/access.js so they're testable and colocated with getEnforcedAccessMap.

function makeEmptyEmployeeRecord(overrides = {}) {
  return {
    team: TEAM_AM,
    accessLevel: 'employee',
    employmentType: 'full-time',
    email: '',
    capacityPercent: 100,
    lastAllocationEdit: '',
    utilization: { week: 0, month: 0 },
    projects: { week: [], month: [] },
    leaveTrackingEnabled: true,
    ...overrides
  };
}

function ensureEmployeeRecord(name) {
  const targetName = String(name || '').trim() || DEFAULT_EMPLOYEE;
  if (!employeeStore[targetName]) {
    employeeStore[targetName] = makeEmptyEmployeeRecord();
  }
  return employeeStore[targetName];
}

// Pure date/format/string helpers live in js/utils.js (loaded before this file).

function getStaleReferenceDate() {
  const dates = Object.values(employeeStore)
    .map((row) => parseTimestamp(row.lastAllocationEdit))
    .filter((d) => d instanceof Date && !Number.isNaN(d.getTime()));

  if (!dates.length) return new Date();
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

function staleMeta(timestampText) {
  const tsDate = parseTimestamp(timestampText);
  const reference = getStaleReferenceDate();
  if (!tsDate || Number.isNaN(tsDate.getTime())) {
    return { status: 'ts-watch', label: 'Unknown', ageDays: null };
  }

  const diffDays = Math.max(0, Math.floor((reference.getTime() - tsDate.getTime()) / (24 * 60 * 60 * 1000)));
  if (diffDays <= 3) return { status: 'ts-fresh', label: `${diffDays}d old`, ageDays: diffDays };
  if (diffDays <= 7) return { status: 'ts-watch', label: `${diffDays}d old`, ageDays: diffDays };
  return { status: 'ts-stale', label: `${diffDays}d old`, ageDays: diffDays };
}

function applyTimestampClass(el, timestampText) {
  if (!el) return;
  const meta = staleMeta(timestampText);
  el.classList.remove('ts-fresh', 'ts-watch', 'ts-stale');
  el.classList.add(meta.status);
}

function updateEmployeeLastEditLabels(employeeName) {
  const record = employeeStore[employeeName];
  if (!record) return;
  document.querySelectorAll('.employee-last-edit').forEach((label) => {
    if (label.dataset.employee === employeeName) {
      label.textContent = record.lastAllocationEdit || '--';
      applyTimestampClass(label, record.lastAllocationEdit);
    }
  });
  document.querySelectorAll('.stale-badge').forEach((badge) => {
    if (badge.dataset.employee === employeeName) {
      const meta = staleMeta(record.lastAllocationEdit);
      badge.textContent = meta.label;
      badge.classList.remove('ts-fresh', 'ts-watch', 'ts-stale');
      badge.classList.add(meta.status);
    }
  });
}

function updateAllLastEditLabels() {
  Object.keys(employeeStore).forEach((name) => updateEmployeeLastEditLabels(name));
}

const navButtons = [...document.querySelectorAll('.screen-link')];
const screens = [...document.querySelectorAll('.screen')];
const loginNavButton = document.getElementById('loginNavButton') || navButtons.find((btn) => btn.dataset.screen === 'login') || null;

// Access-control predicates (isSuperadmin*, canManageAccessRoles, canEditEmployee,
// isLeadership*, can*Clients, canManageTask*, etc.) live in js/access.js.

function displayPersonName(value, fallback = 'Employee') {
  const tokens = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return fallback;
  if (tokens.length === 1) return tokens[0];
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

function normalizeTeamName(value, fallback = TEAM_AM) {
  const normalized = String(value || '').trim();
  if (!normalized) return fallback;
  if (normalized.toLowerCase() === TEAM_AM_LEGACY.toLowerCase()) return TEAM_AM;
  if (normalized.toLowerCase() === 'leadership') return TEAM_AM;
  return normalized;
}

function teamLookupCandidates(value) {
  const normalized = normalizeTeamName(value);
  if (normalized === TEAM_AM) return [TEAM_AM, TEAM_AM_LEGACY];
  return [normalized];
}

function setAuthenticatedNavigation(enabled) {
  navButtons.forEach((btn) => {
    if (!STATEFUL_SCREENS.includes(btn.dataset.screen)) return;
    btn.classList.toggle('disabled', !enabled);
  });
}

function currentUserDepartmentName() {
  const fromProfile = normalizeTeamName(state.employeeProfile?.department?.name || '', '');
  if (fromProfile) return fromProfile;

  if (state.currentEmployeeId) {
    const ownDirectoryRow = lookupActiveEmployee(state.currentEmployeeId);
    const fromDirectory = normalizeTeamName(ownDirectoryRow?.department?.name || '', '');
    if (fromDirectory) return fromDirectory;
  }

  return normalizeTeamName(selectedEmployeeRecord()?.team || '', '');
}

// ─── Display name normalization ─────────────────────────────────────
// Strip middle names colony-wide. "Jo Middle Last" → "Jo Last".
// Single-token names ("Cher") and two-token names ("Tara Bell") are kept as-is.
function shortDisplayName(fullName) {
  if (!fullName || typeof fullName !== 'string') return fullName || '';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return parts.join(' ');
  return parts[0] + ' ' + parts[parts.length - 1];
}
function stripMiddleNameOnEmployee(employee) {
  if (!employee) return employee;
  const short = shortDisplayName(employee.full_name);
  if (short !== employee.full_name) {
    return { ...employee, full_name: short, _original_full_name: employee.full_name };
  }
  return employee;
}
if (typeof window !== 'undefined') {
  window.shortDisplayName = shortDisplayName;
}

// ─── Universal employee resolver ────────────────────────────────────
// Single source of truth for "look up an employee". Every place in the app
// that needs to find an employee by id / email / full name routes through
// these helpers. They search BOTH active and offboarded directories so
// historical references (old tasks, deals, audit logs, comments) always
// resolve to a real name with "(offboarded)" suffix when relevant.
//
// Use `lookupEmployee*` for display / historical lookups.
// Use `lookupActiveEmployee*` for permission / form-only contexts where
// offboarded people must NOT be returned.
function _allEmployees() {
  const active = state.employeeDirectory || [];
  const inactive = state.inactiveEmployees || [];
  return active.concat(inactive);
}
function lookupEmployee(employeeId) {
  if (!employeeId) return null;
  const active = (state.employeeDirectory || []).find((e) => e.id === employeeId);
  if (active) return { ...active, _offboarded: false };
  const inactive = (state.inactiveEmployees || []).find((e) => e.id === employeeId);
  if (inactive) return { ...inactive, _offboarded: true };
  return null;
}
function lookupEmployeeName(employeeId, fallback = 'Unknown') {
  const rec = lookupEmployee(employeeId);
  if (!rec) return fallback;
  const name = rec.full_name || fallback;
  return rec._offboarded ? `${name} (offboarded)` : name;
}
function lookupEmployeeByEmail(email) {
  if (!email) return null;
  const norm = (typeof normalizeEmail === 'function' ? normalizeEmail(email) : String(email).trim().toLowerCase());
  const active = (state.employeeDirectory || []).find((e) => (typeof normalizeEmail === 'function' ? normalizeEmail(e.email) : (e.email || '').toLowerCase()) === norm);
  if (active) return { ...active, _offboarded: false };
  const inactive = (state.inactiveEmployees || []).find((e) => (typeof normalizeEmail === 'function' ? normalizeEmail(e.email) : (e.email || '').toLowerCase()) === norm);
  if (inactive) return { ...inactive, _offboarded: true };
  return null;
}
function lookupEmployeeByFullName(fullName) {
  if (!fullName) return null;
  const target = String(fullName).trim();
  const active = (state.employeeDirectory || []).find((e) => e.full_name === target);
  if (active) return { ...active, _offboarded: false };
  const inactive = (state.inactiveEmployees || []).find((e) => e.full_name === target);
  if (inactive) return { ...inactive, _offboarded: true };
  return null;
}
function lookupActiveEmployee(employeeId) {
  if (!employeeId) return null;
  return (state.employeeDirectory || []).find((e) => e.id === employeeId) || null;
}
function lookupActiveEmployeeByEmail(email) {
  if (!email) return null;
  const norm = (typeof normalizeEmail === 'function' ? normalizeEmail(email) : String(email).trim().toLowerCase());
  return (state.employeeDirectory || []).find((e) => (typeof normalizeEmail === 'function' ? normalizeEmail(e.email) : (e.email || '').toLowerCase()) === norm) || null;
}
function lookupActiveEmployeeByFullName(fullName) {
  if (!fullName) return null;
  const target = String(fullName).trim();
  return (state.employeeDirectory || []).find((e) => e.full_name === target) || null;
}
function isEmployeeOffboarded(employeeId) {
  const rec = lookupEmployee(employeeId);
  return !!(rec && rec._offboarded);
}
window.lookupEmployee = lookupEmployee;
window.lookupEmployeeName = lookupEmployeeName;
window.lookupEmployeeByEmail = lookupEmployeeByEmail;
window.lookupEmployeeByFullName = lookupEmployeeByFullName;
window.lookupActiveEmployee = lookupActiveEmployee;
window.lookupActiveEmployeeByEmail = lookupActiveEmployeeByEmail;
window.lookupActiveEmployeeByFullName = lookupActiveEmployeeByFullName;
window.isEmployeeOffboarded = isEmployeeOffboarded;

function defaultHomeScreen() {
  if (state.partnerProfile || state.staffOnCircle) return 'partner-home';
  if (state.hireProfile) return 'hire-checklist';
  if (state.hiringOnlyMode) return 'hiring-only';
  return 'home-feed';
}

function employeeDirectoryByEmailMap() {
  const map = new Map();
  state.employeeDirectory.forEach((entry) => {
    const email = normalizeEmail(entry?.email);
    if (email) {
      map.set(email, entry);
    }
  });
  return map;
}

function employeeByEmail(email) {
  // Thin wrapper around the central helper. Active-only by intent — used in
  // contexts where offboarded users must NOT match (permissions, role checks).
  return lookupActiveEmployeeByEmail(email);
}

function managerEmailForEmployee(employee) {
  const email = normalizeEmail(employee?.email);
  if (!email || isSuperadminEmail(email)) return null;

  // DB-stored manager takes priority
  const dbManager = normalizeEmail(employee?.direct_manager_email || '');
  if (dbManager) return dbManager;

  const directManager = getDirectManagerMap()[email];
  if (directManager) return normalizeEmail(directManager);

  const normalizedTeam = normalizeTeamName(employee?.department?.name, '');
  const teamManager = getTeamManagerMap()[normalizedTeam];
  if (teamManager && normalizeEmail(teamManager) !== email) return normalizeEmail(teamManager);

  const accessLevel = normalizeAccessLevel(employee?.access_level || 'employee');
  if ((accessLevel === 'leadership' || accessLevel === 'admin') && !isSuperadminEmail(email)) {
    return SUPERADMIN_EMAIL;
  }

  return null;
}

function managerLabelForEmployee(employee) {
  const managerEmail = managerEmailForEmployee(employee);
  if (!managerEmail) return '--';
  const managerRow = employeeByEmail(managerEmail);
  return displayPersonName(managerRow?.full_name || displayNameFromEmail(managerEmail), '--');
}

function employeeReportsToManager(employee, managerEmail) {
  const targetManager = normalizeEmail(managerEmail);
  if (!targetManager) return false;

  const byEmail = employeeDirectoryByEmailMap();
  let current = employee || null;
  const visited = new Set();

  while (current) {
    const email = normalizeEmail(current.email);
    if (!email || visited.has(email)) return false;
    visited.add(email);

    const parentEmail = managerEmailForEmployee(current);
    if (!parentEmail) return false;
    if (normalizeEmail(parentEmail) === targetManager) return true;
    current = byEmail.get(normalizeEmail(parentEmail)) || null;
  }

  return false;
}

function reporteeEmployeesForManager(managerEmail) {
  const normalizedManager = normalizeEmail(managerEmail);
  if (!normalizedManager) return [];
  const list = state.employeeDirectory
    .filter((employee) => {
      const employeeEmail = normalizeEmail(employee.email);
      if (!employeeEmail || employeeEmail === normalizedManager) return false;
      return employeeReportsToManager(employee, normalizedManager);
    })
    .sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || '')));
  // Superadmin sees themselves in their own team view
  if (isSuperadminEmail(normalizedManager)) {
    const self = lookupActiveEmployeeByEmail(normalizedManager);
    if (self) list.unshift(self);
  }
  return list;
}

function activateScreen(screenId) {
  const targetScreen = document.getElementById(screenId);
  if (!targetScreen || targetScreen.classList.contains('hidden')) {
    return false;
  }

  if (getActiveScreenId() === screenId) {
    return false;
  }

  // Sub-screens keep their parent sidebar button highlighted
  const PARENT_SCREEN = {
    'employee-profile': 'people-directory',
    'client-analytics': 'client-projects',
  };
  const navTarget = PARENT_SCREEN[screenId] || screenId;
  navButtons.forEach((btn) => {
    const isActive = btn.dataset.screen === navTarget;
    btn.classList.toggle('active', isActive);
  });

  screens.forEach((screen) => {
    screen.classList.toggle('active', screen.id === screenId);
  });

  const isLogin = screenId === 'login';
  document.querySelector('.body').classList.toggle('no-sidebar', isLogin);
  document.querySelector('.global-header').classList.toggle('hidden', isLogin);

  updateScreenArrows();
  scrollCanvasToTop();
  refreshScreenData(screenId);
  syncMobileNav();
  return true;
}

function scrollCanvasToTop() {
  const canvas = document.querySelector('.canvas');
  if (!canvas) return;
  canvas.scrollTop = 0;
  requestAnimationFrame(() => { canvas.scrollTop = 0; });
}

// ── Home Dashboard + Timeline ──────────────────────────────────────────

// Just the date — no greeting, no tagline (signals live in the feed itself:
// Your-day strip, On Leave Today card, Team Pulse).
function applyHomeGreeting() {
  const el = document.getElementById('homeGreeting');
  if (!el) return;
  const now = new Date();
  const weekday = now.toLocaleDateString('en-IN', { weekday: 'long' });
  const dayMonth = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
  el.textContent = `${weekday}, ${dayMonth}`;
}

// Live signals for the home feed: who's out (all roles, via SECURITY DEFINER
// RPC since leave_requests RLS is own-or-leadership), attributed task
// completions, deal stage moves, and the viewer's own tasks due today.
// Every query tolerates failure independently — a missing signal just leaves
// its section empty, never blanks the page.
async function loadHomePulse() {
  if (!state.supabase || !state.isAuthenticated) { state.homePulse = null; return; }

  const todayIso = toISODateLocal();
  const today = new Date();
  const from = new Date(today); from.setDate(today.getDate() - 7);
  const until = new Date(today); until.setDate(today.getDate() + 7);
  const fromIso = toISODateLocal(from);
  const untilIso = toISODateLocal(until);

  const [whosOutRes, doneRes, movesRes, dueRes] = await Promise.all([
    state.supabase.rpc('home_whos_out', { p_from: fromIso, p_until: untilIso }),
    state.supabase.from('daily_tasks')
      .select('task_title, updated_at, employee_id')
      .eq('status', 'done')
      .gte('updated_at', fromIso)
      .order('updated_at', { ascending: false })
      .limit(500),
    state.supabase.from('deal_stage_history')
      .select('stage, entered_at, deal:deals(deal_name)')
      .gte('entered_at', fromIso)
      .order('entered_at', { ascending: false })
      .limit(50),
    // Own tasks due today — always employee_id-filtered (critical pattern)
    state.currentEmployeeId
      ? state.supabase.from('daily_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('employee_id', state.currentEmployeeId)
          .eq('task_date', todayIso)
          .eq('status', 'in_progress')
      : Promise.resolve({ count: 0, error: null })
  ]);

  const hidden = getHiddenEmployeeEmails();
  if (whosOutRes.error) console.warn('home_whos_out failed:', whosOutRes.error.message);
  if (doneRes.error) console.warn('home pulse tasks failed:', doneRes.error.message);
  if (movesRes.error) console.warn('home pulse deals failed:', movesRes.error.message);

  // Done-cascade marks sibling copies done too — dedupe by employee + title key
  const seenDone = new Set();
  const doneTasks = (doneRes.data || []).filter(t => {
    const key = `${t.employee_id}|${taskTitleKey(t.task_title)}`;
    if (seenDone.has(key)) return false;
    seenDone.add(key);
    return true;
  });

  state.homePulse = {
    whosOut: (whosOutRes.data || []).filter(r => !hidden.includes(normalizeEmail(r.email))),
    doneTasks,
    dealMoves: movesRes.data || [],
    myTasksDueToday: dueRes.error ? 0 : (dueRes.count || 0)
  };
}

async function loadHomeStatsFromSupabase() {
  if (!state.supabase || !state.isAuthenticated) {
    state.homeAllocations = [];
    state.homeAllocTrend = [];
    state.homePulse = null;
    renderHomeFeed();
    return;
  }

  const weekStartIso = getCurrentWeekStartIso();
  // Trailing 4 weeks (incl. current) for the Hours card hover: last-week delta + 4-wk average.
  const trendStartIso = (() => { const t = new Date(weekStartIso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 21); return t.toISOString().slice(0, 10); })();
  const [response, , trendRes] = await Promise.all([
    state.supabase
      .from('allocations')
      .select(`
        employee_id,
        allocation_percent,
        project:projects!allocations_project_id_fkey (
          name,
          client:clients!projects_client_id_fkey ( id, name, is_active )
        )
      `)
      .eq('period_type', 'week')
      .eq('period_start', weekStartIso),
    loadHomePulse().catch(err => { console.warn('Home pulse load failed:', err); state.homePulse = null; }),
    state.supabase
      .from('allocations')
      .select('employee_id, allocation_percent, period_start')
      .eq('period_type', 'week')
      .gte('period_start', trendStartIso)
      .lte('period_start', weekStartIso)
  ]);

  if (response.error) {
    console.error('Home allocations load failed:', response.error);
    state.homeAllocations = [];
  } else {
    state.homeAllocations = response.data || [];
    state.loadedAt.homeStats = Date.now();
  }
  state.homeAllocTrend = (trendRes && !trendRes.error) ? (trendRes.data || []) : [];

  renderHomeFeed();
}

function renderHomeStatCards() {
  if (!homeStatCards) return;

  const todayIso = toISODateLocal();

  // 1. Hours allocated this week (cumulative)
  // Client-scoped people (dedicated to one client) don't roll into AGENCY
  // totals — they're not reassignable bandwidth. Their hours still count on
  // their client's own page. Excluded from BOTH the hours numerator and the
  // capacity denominator below; counting them on one side only inflated
  // "free capacity".
  const empCapacityMap = new Map();
  const capacityExcludedIds = new Set(
    state.employeeDirectory.filter(isCapacityExcluded).map(e => e.id)
  );
  state.employeeDirectory.forEach(e => empCapacityMap.set(e.id, (e.capacity_percent || 100) / 100));

  let totalWeeklyHours = 0;
  const employeeAllocTotals = new Map();
  state.homeAllocations.forEach(a => {
    if (capacityExcludedIds.has(a.employee_id)) return;
    const current = employeeAllocTotals.get(a.employee_id) || 0;
    employeeAllocTotals.set(a.employee_id, current + (a.allocation_percent || 0));
  });
  // allocation_percent is already a % of a FULL week (the planner does
  // free = capacity - allocated, same unit space) — multiplying by capacity
  // here double-counted it, so a 40%-capacity person allocated 40% showed
  // 7.2h instead of 18h. Invisible while everyone sat at capacity 100.
  employeeAllocTotals.forEach((totalPct) => {
    totalWeeklyHours += (totalPct / 100) * WORK_HOURS_PER_WEEK;
  });

  // 2. Top + Chill client by allocation share.
  //
  // By CLIENT, not project name (10 Sep 2026). This grouped on the
  // project's name, which meant the card said "client" while showing a project,
  // never consulted the client table, and so could not tell a live account from
  // an archived one — that is how Example Analytics, archived months earlier, came to be
  // the agency's "chill client". Grouping on client id also stops two projects
  // that share a name from being silently added together.
  const clientAlloc = new Map();   // clientId -> { name, pct }
  let totalAllocPct = 0;
  state.homeAllocations.forEach(a => {
    const client = a.project?.client;
    // An archived client is finished work; it belongs in neither headline.
    // Its hours still count in Hours Allocated, which measures what people are
    // booked on regardless of who it is for.
    if (!client || client.is_active === false) return;
    const name = client.name || a.project?.name || 'Unassigned';
    if (isGarbageProjectName(name)) return;
    const entry = clientAlloc.get(client.id) || { name, pct: 0 };
    entry.pct += (a.allocation_percent || 0);
    clientAlloc.set(client.id, entry);
    totalAllocPct += (a.allocation_percent || 0);
  });
  let topClient = '--';
  let topClientPct = 0;
  let chillClient = '--';
  let chillClientPct = Infinity;
  clientAlloc.forEach(({ name, pct }) => {
    if (pct > topClientPct) {
      topClientPct = pct;
      topClient = name;
    }
    // Ties are broken alphabetically rather than by whichever row the query
    // happened to return first — two clients sat at exactly 15% and the card
    // could show either one on any given load.
    if (pct < chillClientPct || (pct === chillClientPct && name < chillClient)) {
      chillClientPct = pct;
      chillClient = name;
    }
  });
  const topClientShare = totalAllocPct > 0 ? Math.round((topClientPct / totalAllocPct) * 100) : 0;
  const chillClientShare = totalAllocPct > 0 ? Math.round((chillClientPct / totalAllocPct) * 100) : 0;

  // 3. On leave today — prefer the all-roles who's-out pulse (employees'
  // leaveRowsById only holds their own rows under RLS); includes started
  // pending sick leave so someone out sick isn't counted as "in"
  const onLeaveToday = []; // { name, half } — a ½ day counts as ½ a person
  if (state.homePulse?.whosOut) {
    state.homePulse.whosOut.forEach(r => {
      if (r.start_date <= todayIso && r.end_date >= todayIso) {
        onLeaveToday.push({ name: displayPersonName(r.full_name, 'Someone'), half: Boolean(r.is_half_day) });
      }
    });
  } else {
    state.leaveRowsById.forEach(lr => {
      if (lr.status === 'approved' && lr.start_date <= todayIso && lr.end_date >= todayIso) {
        onLeaveToday.push({ name: displayPersonName(lr.employee?.full_name || '', 'Someone'), half: Boolean(lr.is_half_day) });
      }
    });
  }
  // The count is PEOPLE affected today, not leave-days consumed: someone on a
  // half day is still a person you can't fully reach. The ½ shows on the name.
  const leaveCountLabel = `${onLeaveToday.length}`;
  const leaveNameLabel = (p) => escapeHtml(p.name) + (p.half ? ' <span class="mini-meta">(½ day)</span>' : '');

  // ── Hover expansions (Hours Allocated + Top Client) ──
  const empDept = new Map();
  const empNameById = new Map();
  state.employeeDirectory.forEach(e => {
    empDept.set(e.id, e.department?.name || 'Unassigned');
    empNameById.set(e.id, e.full_name || 'Someone');
  });

  // Per-week capacity-weighted hours across the trailing window.
  const weekPctByEmp = new Map(); // period_start -> Map(empId -> pct)
  (state.homeAllocTrend || []).forEach(a => {
    if (!weekPctByEmp.has(a.period_start)) weekPctByEmp.set(a.period_start, new Map());
    const m = weekPctByEmp.get(a.period_start);
    m.set(a.employee_id, (m.get(a.employee_id) || 0) + (a.allocation_percent || 0));
  });
  const hoursForWeek = (m) => {
    let h = 0;
    // Same rule as the current-week total: allocation % is already % of a full
    // week, and client-scoped people are out of agency figures.
    if (m) m.forEach((pct, empId) => {
      if (capacityExcludedIds.has(empId)) return;
      h += (pct / 100) * WORK_HOURS_PER_WEEK;
    });
    return h;
  };
  const isoMinusDays = (iso, n) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - n); return t.toISOString().slice(0, 10); };
  const weekStartIso = getCurrentWeekStartIso();
  const last4Iso = [21, 14, 7, 0].map(n => isoMinusDays(weekStartIso, n)); // oldest -> newest
  const trendHours = last4Iso.map(iso => Math.round(hoursForWeek(weekPctByEmp.get(iso))));
  const allocatedNow = Math.round(totalWeeklyHours);
  const lastWeekHours = Math.round(hoursForWeek(weekPctByEmp.get(isoMinusDays(weekStartIso, 7))));
  const deltaHours = allocatedNow - lastWeekHours;
  const presentWeeks = last4Iso.map(iso => hoursForWeek(weekPctByEmp.get(iso))).filter(h => h > 0);
  const monthlyAvg = presentWeeks.length
    ? Math.round(presentWeeks.reduce((s, h) => s + h, 0) / presentWeeks.length)
    : allocatedNow;
  // Capacity baseline counts ONLY people who actually allocated >=1h this week.
  // Including non-updaters' capacity would inflate "free capacity" unfairly.
  let capacityHours = 0;
  // employeeAllocTotals already excludes client-scoped people, so the
  // denominator and the allocatedNow numerator cover the same set. (capacity ×
  // 45 is correct here — this is the person's own ceiling in hours, with no
  // allocation % involved, so there's nothing to double-count.)
  employeeAllocTotals.forEach((pct, empId) => {
    if (pct > 0) capacityHours += (empCapacityMap.get(empId) || 1) * WORK_HOURS_PER_WEEK;
  });
  capacityHours = Math.round(capacityHours);
  const freeHours = Math.max(0, capacityHours - allocatedNow);
  const usedPct = capacityHours > 0 ? Math.min(100, Math.round((allocatedNow / capacityHours) * 100)) : 0;
  const maxTrend = Math.max(1, ...trendHours);

  const hoursExpand = allocatedNow > 0 ? `
      <div class="home-stat-expand">
        <div class="hse-row"><span>vs last week</span><span class="hse-delta ${deltaHours >= 0 ? 'up' : 'down'}">${deltaHours >= 0 ? '+' : ''}${deltaHours}h${pctDeltaLabel(allocatedNow, lastWeekHours) ? ` (${pctDeltaLabel(allocatedNow, lastWeekHours)})` : ''} <em>(${lastWeekHours}h)</em></span></div>
        <div class="hse-row"><span>4-week average</span><span class="hse-strong">${monthlyAvg}h</span></div>
        <div class="hse-row"><span>Free capacity</span><span class="hse-strong">${freeHours}h <em>of ${capacityHours}h</em></span></div>
        <div class="hse-bar"><div style="width:${usedPct}%"></div></div>
        <div class="hse-sub" style="margin-top:10px;">Last 4 weeks</div>
        <div class="hse-spark">${trendHours.map((h, i) => `<div class="hse-spark-bar${i === trendHours.length - 1 ? ' now' : ''}" style="height:${Math.max(8, Math.round((h / maxTrend) * 100))}%" title="${h}h"></div>`).join('')}</div>
      </div>` : '';

  // Shared client breakdown (team split + biggest contributor) — used by both
  // Top Client and Chill Client cards.
  function buildClientBreakdown(clientName, clientTotalPct) {
    if (!(clientTotalPct > 0) || !isFinite(clientTotalPct) || clientName === '--') return '';
    const deptPct = new Map();
    const empPctOnClient = new Map();
    state.homeAllocations.forEach(a => {
      // Match the CLIENT, not the project name. These happened to be equal
      // while every project was named after its client, but a client with two
      // differently-named projects — the whole reason the hierarchy exists —
      // would have shown a breakdown that did not add up to its own headline.
      const client = a.project?.client;
      if (!client || client.is_active === false) return;
      if ((client.name || a.project?.name || 'Unassigned') !== clientName) return;
      const d = empDept.get(a.employee_id) || 'Unassigned';
      deptPct.set(d, (deptPct.get(d) || 0) + (a.allocation_percent || 0));
      empPctOnClient.set(a.employee_id, (empPctOnClient.get(a.employee_id) || 0) + (a.allocation_percent || 0));
    });
    const teamRows = [...deptPct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, pct]) => {
      const share = Math.round((pct / clientTotalPct) * 100);
      return `<div class="hse-team"><div class="hse-team-head"><span>${escapeHtml(d)}</span><span>${share}%</span></div><div class="hse-bar"><div style="width:${share}%"></div></div></div>`;
    }).join('');
    let topEmpId = null, topEmpPct = 0;
    empPctOnClient.forEach((pct, id) => { if (pct > topEmpPct) { topEmpPct = pct; topEmpId = id; } });
    // allocation % is already % of a full week — no capacity multiplier
    const contribHours = topEmpId ? Math.round((topEmpPct / 100) * WORK_HOURS_PER_WEEK) : 0;
    const contribName = topEmpId ? displayPersonName(empNameById.get(topEmpId), 'Someone') : '--';
    return `
      <div class="home-stat-expand">
        <div class="hse-sub">Allocation by team</div>
        ${teamRows}
        <div class="hse-row hse-divide"><span>Most time this week</span><span class="hse-strong">${escapeHtml(contribName)} · ${contribHours}h</span></div>
      </div>`;
  }
  const topClientExpand = buildClientBreakdown(topClient, topClientPct);
  const chillClientExpand = buildClientBreakdown(chillClient, chillClientPct);

  const cards = [
    {
      label: 'Hours Allocated',
      value: `${allocatedNow}h`,
      detail: 'this week',
      expand: hoursExpand
    },
    {
      label: 'Top Client',
      value: escapeHtml(topClient),
      detail: totalAllocPct > 0 ? `${topClientShare}% of allocation` : 'no allocations yet',
      expand: topClientExpand
    },
    {
      label: 'Chill Client',
      value: escapeHtml(chillClient),
      detail: totalAllocPct > 0 ? `${chillClientShare}% of allocation` : 'no allocations yet',
      expand: chillClientExpand
    },
    {
      label: 'On Leave Today',
      value: leaveCountLabel,
      // Names visible to all roles (team decision, matches Who's Around);
      // ½-day people count as ½ in the number and get a (½ day) tag
      detail: onLeaveToday.length
        ? (onLeaveToday.length <= 3
            ? onLeaveToday.map(leaveNameLabel).join(', ')
            : `${onLeaveToday.slice(0, 2).map(leaveNameLabel).join(', ')} +${onLeaveToday.length - 2}`)
        : 'everyone\'s in'
    }
  ];

  const caretSvg = '<svg class="home-stat-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  homeStatCards.innerHTML = cards.map(c => `
    <div class="home-stat-card${c.expand ? ' has-expand' : ''}"${c.expand ? ' tabindex="0"' : ''}>
      <span class="home-stat-label">${c.label}${c.expand ? caretSvg : ''}</span>
      <span class="home-stat-value">${c.value}</span>
      <span class="home-stat-detail">${c.detail}</span>
      ${c.expand || ''}
    </div>
  `).join('');
}

/* ── Sustainability Calendar ── */

const SUSTAINABILITY_CATEGORY_LABELS = {
  un_international_day: 'UN Day',
  awareness_campaign: 'Campaign',
  conference: 'Conference',
  climate_week: 'Climate Week',
  policy_regulatory: 'Policy'
};

function formatSusCalBadge(entry, todayIso, weekEndIso) {
  if (entry.start_date <= todayIso && entry.end_date >= todayIso) {
    if (entry.duration_type === 'day') return { text: 'today', cls: 'today' };
    if (entry.duration_type === 'month') return { text: 'all month', cls: '' };
    return { text: 'this week', cls: '' };
  }
  // Upcoming — show start date
  const d = parseIsoDateLocal(entry.start_date);
  if (!d) return { text: '', cls: '' };
  const mon = d.toLocaleString('en-IN', { month: 'short' });
  const day = d.getDate();
  if (entry.start_date === entry.end_date) return { text: `${mon} ${day}`, cls: '' };
  const ed = parseIsoDateLocal(entry.end_date);
  if (!ed) return { text: `${mon} ${day}`, cls: '' };
  const emon = ed.toLocaleString('en-IN', { month: 'short' });
  if (mon === emon) return { text: `${mon} ${day}–${ed.getDate()}`, cls: '' };
  return { text: `${mon} ${day} – ${emon} ${ed.getDate()}`, cls: '' };
}

function renderSusCalPill(entry, todayIso, weekEndIso) {
  const badge = formatSusCalBadge(entry, todayIso, weekEndIso);
  return `<span class="sus-pill ${badge.cls}" data-sus-id="${escapeHtml(entry.id)}">${entry.emoji || '📅'} ${escapeHtml(entry.name)} <span class="sus-pill-date">${badge.text}</span></span>`;
}

function renderSusCalDetail(entry) {
  return `<div class="sus-pill-detail" data-sus-detail="${escapeHtml(entry.id)}">
    <p>${escapeHtml(entry.description || '')}</p>
    ${entry.content_hook ? `<p class="sus-pill-hook">${escapeHtml(entry.content_hook)}</p>` : ''}
  </div>`;
}

async function renderSustainabilityCalendar() {
  const panel = document.getElementById('homeSustainabilityPanel');
  if (!panel) return;

  // Load calendar data once
  if (!state.sustainabilityCalendar) {
    try {
      const resp = await fetch('/data/sustainability-calendar-2026.json');
      if (!resp.ok) throw new Error(resp.statusText);
      state.sustainabilityCalendar = await resp.json();
    } catch (err) {
      console.warn('Sustainability calendar load failed:', err);
      panel.classList.add('hidden');
      return;
    }
  }

  const cal = state.sustainabilityCalendar;
  const todayIso = toISODateLocal();
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay()));
  const weekEndIso = toISODateLocal(weekEnd);

  // Active today: start <= today && end >= today
  const activeToday = cal.filter(e => e.start_date <= todayIso && e.end_date >= todayIso);
  // Coming this week: starts after today, starts <= weekEnd, not already active
  const comingThisWeek = cal.filter(e => e.start_date > todayIso && e.start_date <= weekEndIso);

  const allEvents = [...activeToday, ...comingThisWeek];
  if (!allEvents.length) {
    const future = cal.filter(e => e.start_date > todayIso).sort((a, b) => a.start_date.localeCompare(b.start_date));
    if (future.length) {
      const next = future[0];
      const d = parseIsoDateLocal(next.start_date);
      const dateStr = d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
      panel.classList.remove('hidden');
      panel.innerHTML = `<div class="sus-strip"><span class="sus-strip-label">Upcoming events</span><span class="sus-pill">${next.emoji || '📅'} ${escapeHtml(next.name)} <span class="sus-pill-date">${dateStr}</span></span></div>`;
    } else {
      panel.classList.add('hidden');
    }
    return;
  }

  panel.classList.remove('hidden');
  const todayPills = activeToday.map(e => renderSusCalPill(e, todayIso, weekEndIso)).join('');
  // Always lead with a label: the streak strip sits directly above, and without
  // a header the events run straight on from it (26 Aug 2026).
  const leadLabel = `<span class="sus-strip-label">${activeToday.length ? 'Events today' : 'Upcoming events'}</span>`;
  // Only separate the two groups when both are present.
  const weekLabel = activeToday.length && comingThisWeek.length ? '<span class="sus-strip-label">Upcoming</span>' : '';
  const weekPills = comingThisWeek.map(e => renderSusCalPill(e, todayIso, weekEndIso)).join('');
  const details = allEvents.map(e => renderSusCalDetail(e)).join('');
  panel.innerHTML = `<div class="sus-strip">${leadLabel}${todayPills}${weekLabel}${weekPills}</div>${details}`;

  panel.onclick = (e) => {
    const pill = e.target.closest('.sus-pill');
    if (!pill) return;
    const id = pill.dataset.susId;
    const detail = panel.querySelector(`[data-sus-detail="${id}"]`);
    if (detail) detail.classList.toggle('open');
  };
}

function buildTimelineEvents() {
  const todayIso = toISODateLocal();
  const today = new Date();
  const events = [];

  // Cutoff dates
  const daysAgo14 = new Date(today);
  daysAgo14.setDate(today.getDate() - 14);
  const daysAgo14Iso = toISODateLocal(daysAgo14);
  const daysAhead7 = new Date(today);
  daysAhead7.setDate(today.getDate() + 7);
  const daysAhead7Iso = toISODateLocal(daysAhead7);

  // Holidays (today + next 7 days)
  getPublicHolidays().forEach(h => {
    if (h.date >= todayIso && h.date <= daysAhead7Iso) {
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const daysUntil = Math.round((parseIsoDateLocal(h.date) - todayMidnight) / 86400000);
      const when = daysUntil === 0 ? 'today' : daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days`;
      events.push({
        type: 'holiday',
        icon: '\uD83C\uDF89',
        text: `${h.name} ${when}`,
        detail: formatDateForLabel(h.date),
        date: h.date,
        sortDate: h.date
      });
    }
  });

  // Leave events (all roles, via home_whos_out RPC) flow into the day-by-day
  // stream under their own date. Someone out TODAY lives on the "On Leave
  // Today" stat card instead — no duplicate feed card. Pending sick days are
  // shown (tagged "awaiting approval") rather than invisible.
  if (state.homePulse?.whosOut) {
    const seenLeave = new Set();
    state.homePulse.whosOut.forEach(r => {
      const key = `${r.email}|${r.start_date}|${r.end_date}`;
      if (seenLeave.has(key)) return;
      seenLeave.add(key);
      if (r.start_date <= todayIso && r.end_date >= todayIso) return; // on the stat card

      const name = displayPersonName(r.full_name, 'Someone').split(' ')[0];
      const sick = r.leave_type === 'SL';
      const typeLabel = LEAVE_TYPE_LABEL[r.leave_type] || 'leave';
      const oneDay = r.start_date === r.end_date;
      const range = oneDay
        ? formatDateForLabel(r.start_date)
        : `${formatDateForLabel(r.start_date)} - ${formatDateForLabel(r.end_date)}`;
      const halfTag = r.is_half_day ? ' · half day' : '';
      const pendingTag = r.status === 'pending' ? ' · awaiting approval' : '';
      const past = r.end_date < todayIso;
      const eventDate = past ? r.end_date : r.start_date;
      const text = past
        ? (sick ? `${name} was out sick` : `${name} was on ${typeLabel}`)
        : (sick ? `${name} will be out sick` : `${name} off on ${typeLabel}`);
      events.push({
        type: sick ? 'whos-out-sick' : 'whos-out',
        icon: sick ? '🤒' : '🏖️',
        text,
        detail: `${range}${halfTag}${pendingTag}`,
        date: eventDate,
        sortDate: eventDate
      });
    });
  }

  // New team members (last 14 days)
  state.employeeDirectory.forEach(emp => {
    if (emp.created_at) {
      const createdIso = toISODateLocal(new Date(emp.created_at));
      if (createdIso >= daysAgo14Iso && createdIso <= todayIso) {
        events.push({
          type: 'people',
          icon: '\uD83D\uDC4B',
          text: `${displayPersonName(emp.full_name, 'New member')} joined the team`,
          detail: formatDateForLabel(emp.created_at),
          date: createdIso,
          sortDate: createdIso
        });
      }
    }
  });

  // New clients (last 14 days)
  state.clients.forEach(client => {
    if (client.created_at) {
      const createdIso = toISODateLocal(new Date(client.created_at));
      if (createdIso >= daysAgo14Iso && createdIso <= todayIso) {
        events.push({
          type: 'client',
          icon: '\uD83C\uDD95',
          text: `New client: ${client.name}`,
          detail: formatDateForLabel(client.created_at),
          date: createdIso,
          sortDate: createdIso
        });
      }
    }
  });

  // Feature/bug requests — aggregate by day into daily digest
  const frByDate = {};
  state.featureRequests.forEach(fr => {
    let dateStr, category;
    if (fr.status === 'done') {
      dateStr = fr.updated_at || fr.created_at;
      category = 'shipped';
    } else if (fr.created_at) {
      dateStr = fr.created_at;
      category = 'new';
    }
    if (!dateStr) return;
    const dateIso = toISODateLocal(new Date(dateStr));
    if (dateIso < daysAgo14Iso || dateIso > todayIso) return;
    if (!frByDate[dateIso]) frByDate[dateIso] = [];
    const typeLabel = fr.request_type === 'bug' ? 'Bug fix' : 'Feature';
    const snippet = fr.request_text.length > 60 ? fr.request_text.slice(0, 60) + '…' : fr.request_text;
    frByDate[dateIso].push({ category, typeLabel, snippet, author: fr.author_name, requestType: fr.request_type });
  });
  Object.entries(frByDate).forEach(([dateIso, items]) => {
    const shipped = items.filter(i => i.category === 'shipped');
    const newItems = items.filter(i => i.category === 'new');
    const parts = [];
    if (shipped.length) parts.push(`${shipped.length} shipped`);
    if (newItems.length) parts.push(`${newItems.length} new`);
    const summary = parts.join(', ');
    // Build bullet list for expand
    const bullets = [];
    shipped.forEach(i => bullets.push(`<li><span class="feed-bullet-tag shipped">Shipped</span> ${escapeHtml(i.snippet)}</li>`));
    newItems.forEach(i => bullets.push(`<li><span class="feed-bullet-tag new">New ${i.typeLabel.toLowerCase()}</span> ${escapeHtml(i.snippet)}</li>`));
    events.push({
      type: shipped.length ? 'feature-done' : 'feature-new',
      icon: shipped.length ? '\u2728' : '\uD83D\uDCA1',
      text: `Bugs & Features — ${summary}`,
      detail: formatDateForLabel(dateIso),
      date: dateIso,
      sortDate: dateIso,
      expandable: `<ul class="feed-expand-list">${bullets.join('')}</ul><a class="feed-expand-viewall" data-link="feature-requests">View all →</a>`
    });
  });

  // Colony platform updates (last 30 days)
  const daysAgo30 = new Date(today);
  daysAgo30.setDate(today.getDate() - 30);
  const daysAgo30Iso = toISODateLocal(daysAgo30);
  APP_UPDATES.forEach(u => {
    if (u.date >= daysAgo30Iso && u.date <= todayIso) {
      events.push({
        type: 'platform',
        icon: '\uD83D\uDE80',
        text: u.text,
        detail: formatDateForLabel(u.date),
        date: u.date,
        sortDate: u.date
      });
    }
  });

  // Sort by date descending
  events.sort((a, b) => b.sortDate.localeCompare(a.sortDate));

  return events.slice(0, 30);
}

const LEAVE_TYPE_LABEL = { SL: 'sick leave', PL: 'planned leave', CL: 'casual leave' };
// (Who's-out events are built inline in buildTimelineEvents - they live in the
// day-by-day stream, not a pinned section. Ongoing-today leave is shown on the
// "On Leave Today" stat card instead.)

// "Team pulse" — attributed task completions (visible to everyone, per the
// team's call) and deal-flow movement (forward stages for everyone; contracted
// deals celebrated; stalled/closed-lost stay off the feed).
function buildTeamPulseEvents() {
  const pulse = state.homePulse;
  if (!pulse) return [];
  const todayIso = toISODateLocal();
  const events = [];
  const nameById = new Map();
  state.employeeDirectory.forEach(e => nameById.set(e.id, displayPersonName(e.full_name, 'Someone').split(' ')[0]));
  const hidden = getHiddenEmployeeEmails();
  const emailById = new Map();
  state.employeeDirectory.forEach(e => emailById.set(e.id, normalizeEmail(e.email)));

  const visibleDone = (pulse.doneTasks || []).filter(t => !hidden.includes(emailById.get(t.employee_id) || ''));

  // Today's completions — attributed, expandable to task titles
  const doneToday = visibleDone.filter(t => toISODateLocal(new Date(t.updated_at)) === todayIso);
  if (doneToday.length) {
    const byPerson = new Map();
    doneToday.forEach(t => {
      const n = nameById.get(t.employee_id) || 'Someone';
      if (!byPerson.has(n)) byPerson.set(n, []);
      byPerson.get(n).push(t.task_title);
    });
    const names = [...byPerson.keys()];
    const lead = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
    const bullets = [];
    byPerson.forEach((titles, n) => {
      titles.slice(0, 4).forEach(title => bullets.push(`<li><span class="feed-bullet-tag shipped">${escapeHtml(n)}</span> ${escapeHtml(title)}</li>`));
      if (titles.length > 4) bullets.push(`<li><span class="feed-bullet-tag shipped">${escapeHtml(n)}</span> +${titles.length - 4} more</li>`);
    });
    events.push({
      type: 'pulse-today', icon: '✅',
      text: `${doneToday.length} task${doneToday.length > 1 ? 's' : ''} shipped today — ${lead}`,
      detail: 'tap to see what got done', date: todayIso, sortDate: `9-${todayIso}`,
      expandable: `<ul class="feed-expand-list">${bullets.slice(0, 16).join('')}</ul>`
    });
  }

  // Week momentum — per-person counts
  if (visibleDone.length) {
    const counts = new Map();
    visibleDone.forEach(t => {
      const n = nameById.get(t.employee_id) || 'Someone';
      counts.set(n, (counts.get(n) || 0) + 1);
    });
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const bullets = ranked.map(([n, c]) => `<li><span class="feed-bullet-tag shipped">${c}</span> ${escapeHtml(n)}</li>`);
    events.push({
      type: 'pulse-week', icon: '🔥',
      text: `Team shipped ${visibleDone.length} tasks this week`,
      detail: `${ranked.length} people contributing`, date: todayIso, sortDate: `8-${todayIso}`,
      expandable: `<ul class="feed-expand-list">${bullets.join('')}</ul>`
    });
  }

  // Deal movement — forward stages only; contracted gets the confetti
  const FORWARD_STAGES = { qualified: 'Qualified', discovery: 'Discovery', proposal: 'Proposal', negotiated: 'Negotiation' };
  const seenDeal = new Set();
  (pulse.dealMoves || []).forEach(m => {
    const dealName = m.deal?.deal_name || '';
    if (!dealName) return;
    const moveIso = toISODateLocal(new Date(m.entered_at));
    const key = `${dealName}|${moveIso}`;
    if (seenDeal.has(key)) return; // latest stage per deal per day (rows arrive desc)
    seenDeal.add(key);
    if (m.stage === 'contracted') {
      events.push({
        type: 'deal-won', icon: '🎉',
        text: `${dealName} signed — new business!`,
        detail: formatDateForLabel(moveIso), date: moveIso, sortDate: `7-${moveIso}`
      });
    } else if (FORWARD_STAGES[m.stage]) {
      events.push({
        type: 'deal-move', icon: '🤝',
        text: `${dealName} moved to ${FORWARD_STAGES[m.stage]}`,
        detail: formatDateForLabel(moveIso), date: moveIso, sortDate: `6-${moveIso}`
      });
    }
  });

  events.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
  return events.slice(0, 8);
}

// Personal "Your day" strip — own tasks due + own allocation this week
function buildYourDayEvent() {
  const pulse = state.homePulse;
  if (!pulse) return null;
  const due = pulse.myTasksDueToday || 0;
  let myAllocPct = 0;
  (state.homeAllocations || []).forEach(a => {
    if (a.employee_id === state.currentEmployeeId) myAllocPct += (a.allocation_percent || 0);
  });
  const bits = [];
  if (due > 0) bits.push(`${due} task${due > 1 ? 's' : ''} due today`);
  else bits.push('no tasks due today');
  if (myAllocPct > 0) bits.push(`you're ${Math.round(myAllocPct)}% allocated this week`);
  return {
    type: 'your-day', icon: '👋',
    text: `Your day — ${bits.join(' · ')}`,
    detail: 'open My Work →', link: 'daily-tasklist',
    date: toISODateLocal(), sortDate: ''
  };
}

function renderBirthdayStrip() {
  const panel = document.getElementById('homeBirthdayPanel');
  if (!panel) return;

  const todayIso = toISODateLocal();
  const todayMD = todayIso.slice(5); // "MM-DD"
  const today = new Date();

  // Collect birthdays from employee directory
  const birthdays = state.employeeDirectory
    .filter((e) => e.date_of_birth && e.is_active)
    .map((e) => {
      const md = e.date_of_birth.slice(5); // "MM-DD"
      const thisYear = new Date(today.getFullYear(), parseInt(md.slice(0, 2)) - 1, parseInt(md.slice(3)));
      if (thisYear < today && md !== todayMD) {
        thisYear.setFullYear(thisYear.getFullYear() + 1);
      }
      const diffDays = Math.round((thisYear - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
      return { name: displayPersonName(e.full_name, 'Employee'), md, diffDays, date: thisYear };
    })
    .filter((b) => b.diffDays >= 0 && b.diffDays <= 7)
    .sort((a, b) => a.diffDays - b.diffDays);

  if (!birthdays.length) {
    panel.classList.add('hidden');
    return;
  }

  const hasToday = birthdays.some((b) => b.diffDays === 0);
  panel.classList.remove('hidden');
  const pills = birthdays.map((b) => {
    const firstName = b.name.split(' ')[0];
    const isToday = b.diffDays === 0;
    const dateStr = b.date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
    const label = isToday ? `🎂 Today is ${escapeHtml(firstName)}'s birthday!` : `🎂 ${escapeHtml(firstName)} <span class="bday-pill-date">${dateStr}</span>`;
    return `<span class="bday-pill${isToday ? ' bday-today' : ''}">${label}</span>`;
  }).join('');

  const stripLabel = hasToday ? 'Birthdays' : 'Upcoming birthdays';
  panel.innerHTML = `<div class="bday-strip"><span class="bday-strip-label">${stripLabel}</span>${pills}</div>`;
}

function renderHomeFeed() {
  applyHomeGreeting();
  renderHomeStatCards();
  renderBirthdayStrip();
  renderSustainabilityCalendar();

  if (!homeFeedList || !homeFeedEmpty) return;

  const events = buildTimelineEvents();
  const yourDay = buildYourDayEvent();
  const teamPulse = buildTeamPulseEvents();

  if (!events.length && !teamPulse.length && !yourDay) {
    homeFeedList.innerHTML = '';
    homeFeedEmpty.classList.remove('hidden');
    return;
  }

  homeFeedEmpty.classList.add('hidden');

  const todayIso = toISODateLocal();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayIso = toISODateLocal(yesterday);
  const daysAgo7 = new Date(today);
  daysAgo7.setDate(today.getDate() - 7);
  const daysAgo7Iso = toISODateLocal(daysAgo7);
  const daysAhead7 = new Date(today);
  daysAhead7.setDate(today.getDate() + 7);
  const daysAhead7Iso = toISODateLocal(daysAhead7);

  const sections = { today: [], yesterday: [], thisWeek: [], recent: [] };
  events.forEach(e => {
    if (e.date === todayIso || (e.date > todayIso && e.date <= daysAhead7Iso)) {
      if (e.date === todayIso) sections.today.push(e);
      else sections.thisWeek.push(e);
    } else if (e.date === yesterdayIso) {
      sections.yesterday.push(e);
    } else if (e.date >= daysAgo7Iso && e.date < todayIso) {
      sections.thisWeek.push(e);
    } else {
      sections.recent.push(e);
    }
  });

  let html = '';
  const renderSection = (label, items) => {
    if (!items.length) return;
    if (label) html += `<h4 class="feed-section-heading">${label}</h4>`;
    items.forEach(e => {
      const titleAttr = e.fullText ? ` title="${escapeHtml(e.fullText)}"` : '';
      const linkAttr = !e.expandable && e.link ? ` data-link="${escapeHtml(e.link)}" style="cursor:pointer"` : '';
      const expandAttr = e.expandable ? ' data-expandable style="cursor:pointer"' : '';
      html += `
        <div class="feed-card feed-type-${escapeHtml(e.type)}"${titleAttr}${linkAttr}${expandAttr}>
          <span class="feed-icon">${escapeHtml(e.icon)}</span>
          <div class="feed-body">
            <span class="feed-text">${escapeHtml(e.text)}${e.expandable ? ' <span class="feed-chevron">▾</span>' : ''}</span>
            ${e.detail ? `<span class="feed-detail">${escapeHtml(e.detail).replace(/\n/g, '<br>')}</span>` : ''}
            ${e.expandable ? `<div class="feed-expand hidden">${e.expandable}</div>` : ''}
          </div>
        </div>`;
    });
  };

  if (yourDay) renderSection('', [yourDay]);
  renderSection('Team Pulse', teamPulse);
  renderSection('Today', sections.today);
  renderSection('Yesterday', sections.yesterday);
  renderSection('This Week', sections.thisWeek);
  renderSection('Recent', sections.recent);

  homeFeedList.innerHTML = html;
  homeFeedList.querySelectorAll('.feed-card[data-link]').forEach(card => {
    card.addEventListener('click', () => navigateToScreen(card.dataset.link));
  });
  homeFeedList.querySelectorAll('.feed-card[data-expandable]').forEach(card => {
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-link]') && !ev.target.closest('.feed-card[data-expandable]').isSameNode(ev.target.closest('[data-link]'))) return;
      const expand = card.querySelector('.feed-expand');
      const chevron = card.querySelector('.feed-chevron');
      if (expand) {
        expand.classList.toggle('hidden');
        if (chevron) chevron.textContent = expand.classList.contains('hidden') ? '▾' : '▴';
      }
    });
  });
  homeFeedList.querySelectorAll('.feed-expand-viewall[data-link]').forEach(link => {
    link.addEventListener('click', (ev) => {
      ev.stopPropagation();
      navigateToScreen(link.dataset.link);
    });
  });
}

// Screen-switch cache: skip a loader if its data landed <60s ago. ONLY the
// screen-switch call sites below use this — every mutation path calls the raw
// loader directly, which refetches AND renews the stamp, so a stale-after-
// action state is impossible by construction. On tab focus, stamps older than
// 10 minutes are dropped (see the visibilitychange listener).
const SCREEN_CACHE_TTL_MS = 60 * 1000;
const FOCUS_STALE_MS = 10 * 60 * 1000;
function maybeLoad(key, loader) {
  if (isFreshStamp(state.loadedAt[key], Date.now(), SCREEN_CACHE_TTL_MS)) return Promise.resolve();
  return loader();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.isAuthenticated) return;
  const now = Date.now();
  let droppedStale = false;
  Object.keys(state.loadedAt).forEach((key) => {
    if (!isFreshStamp(state.loadedAt[key], now, FOCUS_STALE_MS)) {
      delete state.loadedAt[key];
      droppedStale = true;
    }
  });
  if (droppedStale && ['home-feed', 'people-directory', 'client-projects', 'daily-tasklist', 'leave-center'].includes(getActiveScreenId())) {
    refreshScreenData(getActiveScreenId());
  }
});

function refreshScreenData(screenId) {
  if (!state.isAuthenticated) return;
  switch (screenId) {
    case 'home-feed':
      maybeLoad('homeStats', loadHomeStatsFromSupabase).then(() => renderHomeFeed()).catch(console.error);
      maybeLoad('featureRequests', loadFeatureRequestsFromSupabase).then(() => renderHomeFeed()).catch(console.error);
      break;
    case 'employee-profile':
      loadProfileAllocationHistoryFromSupabase().catch(console.error);
      loadInvoices().catch(console.error);
      break;
    case 'daily-tasklist':
      // My Work: refetch tasks on screen entry so edits made elsewhere (or by
      // a manager) show without a hard refresh. Carry-forward is session-gated
      // inside the loader, so this won't re-run cleanup.
      if (!taskEditInProgress()) loadDailyTasksFromSupabase().catch(console.error);
      break;
    case 'leave-center':
      // My Leave: refresh both the request list and the balance summary.
      loadLeaveRequestsFromSupabase().catch(console.error);
      loadLeaveCycleSummaryFromSupabase().catch(console.error);
      break;
    case 'my-allocations':
      // Skip reload if allocation table already has rows (preserves unsaved edits)
      if (allocationTable && allocationTable.querySelector('tr')) break;
      loadWeeklyAllocationsFromSupabase().catch(console.error);
      break;
    case 'executive-dashboard':
      if (isLeadershipRole()) loadExecutiveDashboard().catch(console.error);
      break;
    case 'leadership-planner':
      if (isLeadershipRole()) loadTeamDashboardFromSupabase().catch(console.error);
      break;
    case 'people-directory':
      maybeLoad('homeStats', loadHomeStatsFromSupabase).then(() => renderPeopleDirectory()).catch(console.error);
      if (isLeadershipRole()) loadOnboardingBadge().catch(console.error);
      loadHiringPanel().catch(console.error);
      break;
    case 'hire-checklist':
      if (state.hireProfile) renderHireChecklist().catch(console.error);
      break;
    case 'hiring-only':
      if (state.hiringOnlyMode) loadHiringPanel().catch(console.error);
      break;
    case 'admin-settings':
      if (isSuperadminUser()) loadPolicyDocuments().catch(console.error);
      loadPublicHolidaysFromSupabase().then(renderHolidaysAdmin).catch(console.error);
      if (isSuperadminUser()) loadAccessOverrides().then(renderAccessOverridesAdmin).catch(console.error);
      if (isSuperadminUser()) loadAppConfig().then(renderAppConfigAdmin).catch(console.error);
      loadCronHealth().then(renderCronHealthAdmin).catch(console.error);
      renderPendingSetupAdmin().catch(console.error);
      break;
    case 'policy':
      loadPolicyPage().catch(console.error);
      break;
    case 'hiring':
      // The panel is born inside the directory markup; bring it here on the
      // way in, whichever screen loaded first.
      if (!state.hiringOnlyMode) placeHiringPanel('hiring');
      loadHiringPanel().catch(console.error);
      break;
    case 'partner-home':
      if (isPartnerRole() || state.staffOnCircle) loadPartnerData().catch(console.error);
      break;
    case 'partner-feedback':
      // Clients and the reviewers answering them read the same wall.
      if (isPartnerRole() || state.staffOnCircle) loadPartnerFeedback().catch(console.error);
      break;
    case 'partner-timeline':
      if (isPartnerRole() || state.staffOnCircle) loadPartnerTimeline().catch(console.error);
      break;
    case 'partner-team':
      if (isPartnerRole() || state.staffOnCircle) { placeOrgContactsPanel('partner'); loadOrgContacts().catch(console.error); }
      break;
    case 'briefs-pipeline':
      if (!isPartnerRole()) loadBriefsBoard().catch(console.error);
      break;
    case 'client-projects':
      hideClientDetail();
      maybeLoad('homeStats', loadHomeStatsFromSupabase).catch(console.error);
      break;
    case 'feature-requests':
      loadFeatureRequestsFromSupabase().catch(console.error);
      break;
    case 'bd-pipeline':
      if (isDealFlowViewer()) {
        loadDealsFromSupabase().catch(console.error);
      } else {
        navigateToScreen('home-feed', { replace: true });
      }
      break;
    case 'invoice-center':
      checkInvoiceAccess().then(allowed => {
        if (allowed) {
          loadInvoices().catch(console.error);
        } else {
          navigateToScreen('home-feed', { replace: true });
        }
      });
      break;
    case 'client-analytics':
      if (analyticsCurrentClientId) {
        renderClientAnalyticsTab(analyticsCurrentClientId);
      } else {
        // No client selected (e.g. direct hash navigation) — redirect to client list
        navigateToScreen('client-projects', { replace: true });
      }
      break;
    case 'client-scope-coverage':
      if (!isLeadershipRole()) {
        navigateToScreen('home-feed', { replace: true });
        break;
      }
      if (scopeCoverageCurrentClientId) {
        renderClientScopeCoverage(scopeCoverageCurrentClientId).catch(console.error);
      } else {
        navigateToScreen('client-projects', { replace: true });
      }
      break;
  }
}

function getActiveScreenId() {
  return document.querySelector('.screen.active')?.id || 'login';
}

function getVisibleScreenOrder() {
  return STATEFUL_SCREENS.filter(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
}

function navigateScreenByDelta(delta) {
  const order = getVisibleScreenOrder();
  const current = getActiveScreenId();
  const idx = order.indexOf(current);
  if (idx < 0) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= order.length) return;
  navigateToScreen(order[newIdx]);
}

function updateScreenArrows() {
  const order = getVisibleScreenOrder();
  const current = getActiveScreenId();
  const idx = order.indexOf(current);
  document.querySelectorAll('.screen-arrow.prev').forEach(btn => {
    btn.disabled = idx <= 0;
  });
  document.querySelectorAll('.screen-arrow.next').forEach(btn => {
    btn.disabled = idx >= order.length - 1;
  });
}

function readScreenFromHash() {
  const hash = String(window.location.hash || '').replace(/^#/, '').trim();
  if (!hash) return '';
  return hash;
}

function writeScreenToHistory(screenId, { replace = false } = {}) {
  if (!screenId || !window?.history?.pushState) return;
  const url = new URL(window.location.href);
  url.hash = screenId;
  const statePayload = { screenId };
  if (replace) {
    window.history.replaceState(statePayload, '', url.toString());
  } else {
    window.history.pushState(statePayload, '', url.toString());
  }
}

function navigateToScreen(screenId, { replace = false } = {}) {
  const changed = activateScreen(screenId);
  if (!changed) {
    // Already on it (updateSidebarIdentityLabels can activate home first): the
    // URL must still say so, or it keeps the boot #login and a reload or a
    // copied link lands on the sign-in screen's hash.
    if (getActiveScreenId() === screenId && readScreenFromHash() !== screenId) {
      writeScreenToHistory(screenId, { replace: true });
    }
    return;
  }
  writeScreenToHistory(screenId, { replace });
}

function hashContainsAuthTokens() {
  const hash = window.location.hash || '';
  const query = window.location.search || '';
  return hash.includes('access_token=') || hash.includes('error_description=') || hash.includes('code=') || hash.includes('refresh_token=') || hash.includes('type=recovery') || query.includes('code=');
}

// An emailed deep link (#people-directory, ?open=hiring) is an INTENT that has
// to survive the Google round trip: signing in returns to the origin with
// ?code= and no hash, so routeAfterSignIn used to drop everyone on the home
// screen — which is why hire emails "just went to the homepage" (Alex,
// 24 Aug 2026). Stash it on arrival, spend it once auth completes.
const INTENT_KEY = 'colony_link_intent';

function rememberLinkIntent() {
  if (hashContainsAuthTokens()) return;
  const screen = readScreenFromHash();
  const open = new URLSearchParams(window.location.search).get('open');
  if (!screen && !open) return;
  try { sessionStorage.setItem(INTENT_KEY, JSON.stringify({ screen, open })); } catch (e) { /* private mode */ }
}

function takeLinkIntent() {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(INTENT_KEY);
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// Panels inside a screen (Hiring lives in Team Directory) get scrolled to and
// flashed, reusing the notification-anchor treatment.
// Only ids that actually exist — a made-up anchor would retry ten times and
// then silently do nothing.
const LINK_OPEN_ANCHORS = {
  hiring: 'hiringPanel',
  partners: 'partnersAdminPanel',
  // Awaiting Setup sits well down a long Admin Settings page, so the approval
  // email used to land people at the top of it with nothing to tell them what
  // they had come for (7 Sep 2026 — first real hire through it).
  setup: 'pendingSetupPanel'
};

// ?open=<kind>:<id> — the specific thing an email is about, not just the
// screen it lives on (15 Sep 2026: "when I click the email link it
// should take me down to the section"). Each opener returns true once it has
// done its job; until the data it needs has loaded it returns false and is
// retried, like the panel anchors above.
const LINK_OPEN_ITEMS = {
  hire: (id) => revealBySelector(`[data-hire-row="${cssEscape(id)}"]`, (el) => {
    const toggle = el.querySelector('[data-hire-checklist-toggle]');
    const list = el.querySelector('[data-hire-checklist]');
    if (toggle && list && list.classList.contains('hidden')) toggle.click();
  }),
  brief: (id) => {
    if (!briefById(id)) return false;
    if (isPartnerRole() || state.staffOnCircle) openPartnerBriefDetail(id);
    else renderBriefDrawer(id).catch(console.error);
    return true;
  },
  request: (id) => revealBySelector(`.fr-card[data-fr-id="${cssEscape(id)}"], [data-pf-id="${cssEscape(id)}"]`),
  deal: (id) => {
    if (!(state.deals || []).some((d) => d.id === id)) return false;
    openDealDetail(id);
    return true;
  },
  leave: (id) => revealBySelector(`tr[data-request-id="${cssEscape(id)}"]`),
  client: (id) => {
    if (!(state.clients || []).some((c) => String(c.id) === String(id))) return false;
    showClientDetail(id).catch(console.error);
    return true;
  }
};
function cssEscape(v) { return (window.CSS && CSS.escape) ? CSS.escape(String(v)) : String(v).replace(/["\\]/g, '\\$&'); }
function revealBySelector(selector, then) {
  const el = document.querySelector(selector);
  if (!el || el.offsetHeight === 0) return false;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('notify-anchor-flash');
  setTimeout(() => el.classList.remove('notify-anchor-flash'), 2400);
  if (then) then(el);
  return true;
}
function applyLinkIntentAnchor(open, attempt = 0) {
  const raw = String(open || '');
  const m = raw.match(/^([a-z]+):(.+)$/i);
  if (m && LINK_OPEN_ITEMS[m[1].toLowerCase()]) {
    let done = false;
    try { done = LINK_OPEN_ITEMS[m[1].toLowerCase()](m[2]); } catch (e) { done = false; }
    if (!done && attempt < 50) setTimeout(() => applyLinkIntentAnchor(open, attempt + 1), 300);
    return;
  }
  const anchorId = LINK_OPEN_ANCHORS[raw.toLowerCase()];
  if (anchorId) scrollToNotifyAnchor(anchorId);
}

// ── Circle branding (7 Sep 2026) ──────────────────────────────────
// Runs as early as app.js does, before any auth: on clients.youragency.com the tab,
// the splash and the footer say Circle, and the Colony wordmark is removed.
// There is deliberately no Circle wordmark yet — Kira's asset replaces this
// empty space; a text stand-in would look like the real thing and quietly
// become permanent.
function applyProductBranding(hostname = location.hostname) {
  if (!isCircleHost(hostname)) return;
  const name = productName(hostname);
  document.title = name;
  const splashTitle = document.querySelector('.splash-title');
  if (splashTitle) splashTitle.textContent = name;
  // The ant is Your Agency's mark, not Colony's, so Circle keeps it — only the
  // COLONY wordmark goes (8 Sep 2026: "we don't need a new logo mark").
  // Cloned from the splash rather than added as a new asset so there is one
  // copy of the artwork; it uses fill="currentColor", so it inherits colour and
  // the sidebar's own opacity exactly as the wordmark did.
  // No mark at the bottom of the sidebar on Circle (16 Sep 2026: the
  // faint ant there "looks really shitty in dark mode"). The header ant stays.
  const brandLink = document.getElementById('sidebarBrand');
  if (brandLink) {
    document.querySelectorAll('[data-product-mark]').forEach((el) => el.remove());
    brandLink.classList.add('hidden');
  }
  // Both marks link home, and home is a different place now. The ant itself
  // stays — it is Your Agency's, not Colony's — but a client clicking it must not
  // land in the employee app, and it must not announce itself as "Agency Colony".
  [brandLink, document.getElementById('headerLogo')].forEach((el) => {
    if (!el) return;
    el.setAttribute('href', `https://${CIRCLE_HOST}`);
    el.setAttribute('aria-label', name);
  });
  document.querySelectorAll('[aria-label="Agency Colony"]').forEach((el) => el.setAttribute('aria-label', name));
  // Staff have no door here. The invited entrance is the ONLY way into Circle,
  // so it stops being the secondary option and speaks to clients directly.
  //
  // The mirror of this on Colony is deliberately NOT done: that same invited
  // door is how candidates reach their joining paperwork, which is Your Agency's
  // own process and stays on Colony. Removing it there would lock out every
  // new hire.
  document.getElementById('staffAuthActions')?.remove();
  document.getElementById('staffAuthHelp')?.remove();
  // No "Sign in to Circle" line: the mark and name sit directly above it, so it
  // only repeated what the screen already said (8 Sep 2026).
  document.getElementById('invitedEntranceTitle')?.remove();
  // "Partner sign in" rather than "Sign in with Google" — it names who the door
  // is for. Google is still the mechanism, and the hint below says which
  // account to use.
  const partnerBtnLabel = document.querySelector('#partnerSignInBtn span');
  if (partnerBtnLabel) partnerBtnLabel.textContent = 'Partner sign in';
  const entranceHint = document.getElementById('invitedEntranceHint');
  // One button, two kinds of people: clients with an invited Google account,
  // and the Your Agency account team who answer them here. Saying so beats a
  // reviewer assuming the door is not for them.
  if (entranceHint) {
    entranceHint.textContent = 'Use the Google account your invite was sent to. Your Agency team: your @youragency.com account.';
  }
  document.getElementById('invitedEntrance')?.classList.add('is-only-entrance');

  document.documentElement.setAttribute('data-product', 'circle');
}
applyProductBranding();

// The sign-in screen carried no mark at all, on either host — just buttons on
// an empty page (8 Sep 2026). The sidebar and header are both hidden
// while signed out, so nothing identified where you were.
//
// Cloned from the splash rather than a third copy of the artwork, and it has
// to run NOW: dismissSplash() removes that element from the DOM once it fades.
// The name is taken from the splash's own title so the sign-in screen always
// says exactly what the loading screen just said.
function decorateLoginScreen(hostname = location.hostname) {
  const content = document.querySelector('.login-content');
  const ant = document.querySelector('.splash-logo');
  if (!content || !ant || document.getElementById('loginBrand')) return;
  const wrap = document.createElement('div');
  wrap.id = 'loginBrand';
  wrap.className = 'login-brand';
  const mark = ant.cloneNode(true);
  mark.setAttribute('class', 'login-brand-mark');
  mark.setAttribute('aria-hidden', 'true');
  const name = document.createElement('p');
  name.className = 'login-brand-name';
  name.textContent = (document.querySelector('.splash-title')?.textContent || '').trim()
    || productName(hostname);
  wrap.append(mark, name);
  content.prepend(wrap);
}
decorateLoginScreen();

// Send a session to its own door. Partners belong on Circle, everyone else on
// Colony. Deliberately AFTER we know who they are — the two hosts are separate
// origins, so this costs a fresh sign-in; it is a one-time move, not a loop,
// because the destination is the place where homeHostFor() returns null.
function routeToHomeHost(sessionKind) {
  const target = homeHostFor(sessionKind, location.hostname);
  if (!target) return false;
  window.location.replace(`https://${target}${location.hash || ''}`);
  return true;
}

function initializeScreenHistory() {
  rememberLinkIntent();
  if (!hashContainsAuthTokens()) {
    const hashScreen = readScreenFromHash();
    if (hashScreen) {
      activateScreen(hashScreen);
    }
    writeScreenToHistory(getActiveScreenId(), { replace: true });
  }

  window.addEventListener('popstate', () => {
    const histState = window.history.state || {};

    // If popping back from a client detail view, just close the detail panel
    if (state.selectedClientId && !histState.clientDetailId) {
      state.selectedClientId = null;
      if (typeof hideClientDetail === 'function') hideClientDetail();
      return;
    }

    const hashTarget = readScreenFromHash();
    if (hashTarget) {
      activateScreen(hashTarget);
      return;
    }

    const stateTarget = histState.screenId;
    if (stateTarget) {
      activateScreen(stateTarget);
    }
  });
}

// Footer links are plain markup, not screens, so they are NOT covered by the
// default-deny screen routing and need their own gate. Rule, by session:
//   employee            → both (Bugs & Features, Remote Work Policy)
//   partner             → Bugs & Features only (routes to partner-feedback)
//   hire / hiring-only  → neither (both targets are blocked for them)
//   signed out          → neither
// The separator only earns its place when both links are showing, otherwise
// it is a dangling "|". Signed out was the case the first pass missed: the
// links sat on the login screen for anyone who opened the URL (Alex,
// 24 Aug 2026). No data was reachable through them — anon has no access to
// the app schema — but they should not have been there.
function applyFooterLinkAccess() {
  const signedIn = Boolean(state.isAuthenticated);
  const employee = signedIn && Boolean(state.currentEmployeeId);
  const partner = signedIn && isPartnerRole();
  const show = (id, on) => document.getElementById(id)?.classList.toggle('hidden', !on);
  show('featureRequestsFooterLink', employee || partner);
  // Same footer link on both products, different wall behind it.
  const frLink = document.getElementById('featureRequestsFooterLink');
  if (frLink) frLink.setAttribute('href', (partner || state.staffOnCircle) ? '#partner-feedback' : '#feature-requests');
  show('footerPolicyRemoteWork', employee);
  show('footerPolicySep', employee);
}

function applyRoleAccess() {
  // Outsider sessions (partner / new-hire candidate / hiring-only): default-
  // deny. Only their surface's sections (and partner nav, for partners) are
  // visible; activateScreen refuses hidden sections, so hiding here is a real
  // route block. Early return — everything below assumes an employee profile.
  // Staff on Circle are treated as an outsider session on purpose: the same
  // default-deny path, so they get exactly what is listed and nothing that is
  // added to Colony later. #partner-feedback carries the extra class.
  // A reviewer on Circle sees exactly what the client sees — that is the point
  // of them being here (10 Sep 2026). Same screens, same nav; the
  // difference is that they read rather than write. RLS is the real stop: an
  // employee has no partner id, so every partner INSERT/UPDATE policy fails
  // for them. Hiding the controls below is so nobody is invited to try.
  const outsiderScreenClass = state.staffOnCircle ? 'partner-screen'
    : (isPartnerRole() ? 'partner-screen'
    : (state.hireProfile ? 'hire-screen'
    : (state.hiringOnlyMode ? 'hiring-crew-screen' : null)));
  if (outsiderScreenClass) {
    // The Remote Work Policy footer link points at the employee-only #policy
    // screen, which is route-blocked below — an outsider (partner, hire
    // candidate, hiring-only) would see an internal HR link that goes nowhere.
    applyFooterLinkAccess();
    navButtons.forEach((btn) => {
      const forPartner = outsiderScreenClass === 'partner-screen' && btn.dataset.role === 'partner';
      btn.classList.toggle('hidden', !forPartner);
    });
    document.querySelectorAll('section.screen').forEach((section) => {
      if (section.id === 'login') return;
      if (section.classList.contains(outsiderScreenClass)) {
        section.classList.remove('hidden');
      } else if (!section.classList.contains('hidden')) {
        // Mark what WE hid so an employee session on the same page load can
        // restore it (sections like invoice-center manage their own .hidden).
        section.classList.add('hidden', 'partner-hidden');
      }
    });
    if (state.staffOnCircle) applyStaffOnCircleReadOnly();
    const activeOutsiderScreen = getActiveScreenId();
    const activeEl = document.getElementById(activeOutsiderScreen);
    if (activeEl && activeEl.classList.contains('hidden')) {
      activateScreen(defaultHomeScreen());
    }
    return;
  }
  // Employees never see partner nav/screens; partner sections stay hidden by
  // their default .hidden class, partner nav hidden via the data-role loop below.
  // Restore anything a partner session on this page load hid.
  document.querySelectorAll('section.screen.partner-hidden').forEach((section) => {
    section.classList.remove('hidden', 'partner-hidden');
  });
  applyFooterLinkAccess();

  const leadershipAccess = isLeadershipRole();
  const teamDashboardAccess = canAccessTeamDashboard();
  const peopleDirectoryAccess = state.isAuthenticated;
  const adminSettingsAccess = isSuperadminUser();

  // Hiring lives under Team for the people who work it: leadership and the
  // hiring crew. Everyone else never sees the entry (RLS is the real gate).
  document.getElementById('hiringNavButton')?.classList.toggle('hidden', !isHiringCrew());
  document.querySelectorAll('.leadership-only').forEach((node) => {
    node.classList.toggle('hidden', !leadershipAccess);
  });
  document.querySelectorAll('.scope-coverage-only').forEach((node) => {
    node.classList.toggle('hidden', !canEditScopeCoverage());
  });
  document.querySelectorAll('.superadmin-only').forEach((node) => {
    node.classList.toggle('hidden', !adminSettingsAccess);
  });

  navButtons.forEach((btn) => {
    const requiredRole = btn.dataset.role;
    let hide = false;
    if (requiredRole === 'leadership') hide = !leadershipAccess;
    if (requiredRole === 'admin') hide = !adminSettingsAccess;
    if (requiredRole === 'partner') hide = true;  // employees never see partner nav
    btn.classList.toggle('hidden', hide);
  });
  document.querySelectorAll('section.screen.partner-screen').forEach((section) => {
    section.classList.add('hidden');
  });

  const teamDashboardNav = navButtons.find((btn) => btn.dataset.screen === 'leadership-planner');
  const peopleDirectoryNav = navButtons.find((btn) => btn.dataset.screen === 'people-directory');
  const adminSettingsNav = navButtons.find((btn) => btn.dataset.screen === 'admin-settings');
  const teamDashboardScreen = document.getElementById('leadership-planner');
  const peopleDirectoryScreen = document.getElementById('people-directory');
  const adminSettingsScreen = document.getElementById('admin-settings');

  teamDashboardNav?.classList.toggle('hidden', !teamDashboardAccess);
  if (teamDashboardScreen) {
    teamDashboardScreen.classList.toggle('hidden', !teamDashboardAccess);
  }

  peopleDirectoryNav?.classList.toggle('hidden', !peopleDirectoryAccess);
  if (peopleDirectoryScreen) {
    peopleDirectoryScreen.classList.toggle('hidden', !peopleDirectoryAccess);
  }

  adminSettingsNav?.classList.toggle('hidden', !adminSettingsAccess);
  if (adminSettingsScreen) {
    adminSettingsScreen.classList.toggle('hidden', !adminSettingsAccess);
  }

  // Onboarding: policy docs editor visible to admin only
  const policyDocsPanel = document.getElementById('policyDocumentsPanel');
  if (policyDocsPanel) policyDocsPanel.style.display = adminSettingsAccess ? '' : 'none';
  const onbTemplatesPanel = document.getElementById('onboardingTemplatesPanel');
  if (onbTemplatesPanel) onbTemplatesPanel.style.display = adminSettingsAccess ? '' : 'none';

  if (!leadershipAccess) {
    const ownName = state.employeeProfile?.full_name || state.currentEmployee || DEFAULT_EMPLOYEE;
    setSelectedEmployee(ownName);
  }

  const active = getActiveScreenId();
  const blockedActiveScreen =
    (active === 'leadership-planner' && !teamDashboardAccess) ||
    (active === 'people-directory' && !peopleDirectoryAccess) ||
    (active === 'admin-settings' && !adminSettingsAccess);
  if (blockedActiveScreen) {
    activateScreen(defaultHomeScreen());
  }

  syncTaskManagerUi();
  syncAllocationManagerUi();
  applySuperadminOnlyControls();
  syncMobileNav();
}

function applySuperadminOnlyControls() {
  const canManage = canManageAccessRoles();
  const profileAccessLabel = profileAccessLevel?.closest('label');

  if (profileAccessLabel) {
    profileAccessLabel.classList.toggle('hidden', !canManage);
  }
  if (profileAccessLevel) {
    profileAccessLevel.disabled = !canManage;
  }
  if (saveAccessRolesBtn) {
    saveAccessRolesBtn.disabled = !canManage;
  }
  if (fullAccessTableBody) {
    fullAccessTableBody.querySelectorAll('.full-access-role').forEach((select) => {
      select.disabled = !canManage;
    });
  }
  if (!canManage) {
    setFullAccessNotice('');
  }
}

// --- Theme toggle ---
function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  applyTheme(newTheme);
  try { localStorage.setItem('colony-theme', newTheme); } catch (_) {}
}

(function initTheme() {
  try {
    const saved = localStorage.getItem('colony-theme');
    if (saved === 'dark') applyTheme('dark');
  } catch (_) {}
})();

navButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('hidden') || btn.classList.contains('disabled')) return;
    navigateToScreen(btn.dataset.screen);
  });
});

document.querySelectorAll('.header-logo, .sidebar-brand').forEach((el) => {
  el.addEventListener('click', (e) => {
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
  });
});

document.querySelector('.canvas').addEventListener('click', (e) => {
  const prev = e.target.closest('.screen-arrow.prev');
  const next = e.target.closest('.screen-arrow.next');
  if (prev) navigateScreenByDelta(-1);
  if (next) navigateScreenByDelta(1);
});

// ── Mobile Bottom Tab Bar + More Sheet ──────────────────────────────────

const MOBILE_TAB_ICONS = {
  'daily-tasklist': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  'my-allocations': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  'leave-center': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  'home-feed': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  'leadership-planner': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  'people-directory': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  'client-projects': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  'admin-settings': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  'feature-requests': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  'executive-dashboard': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>',
  'bd-pipeline': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  'invoice-center': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
  'more': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
};

const MOBILE_TAB_LABELS = {
  'daily-tasklist': 'My Work',
  'my-allocations': 'Allocation',
  'leave-center': 'My Leave',
  'home-feed': 'Home',
  'leadership-planner': 'Resources',
  'people-directory': 'Directory',
  'client-projects': 'Clients',
  'admin-settings': 'Admin',
  'feature-requests': 'Features',
  'executive-dashboard': 'Overview',
  'bd-pipeline': 'Deal Flow',
  'invoice-center': 'Invoices',
  'more': 'More',
};

const mobileTabBar = document.getElementById('mobileTabBar');
const moreSheet = document.getElementById('moreSheet');
const moreSheetBackdrop = document.getElementById('moreSheetBackdrop');
const moreSheetList = document.getElementById('moreSheetList');

function getMobileTabConfig() {
  const leadership = isLeadershipRole();
  const dealFlow = isDealFlowViewer();
  if (leadership) {
    return {
      tabs: ['home-feed', 'leadership-planner', 'daily-tasklist'],
      more: [
        ...(dealFlow ? ['bd-pipeline'] : []),
        'executive-dashboard',
        'my-allocations', 'leave-center', 'people-directory', 'client-projects', 'feature-requests',
        ...(isSuperadminUser() ? ['admin-settings'] : [])],
    };
  }
  return {
    tabs: ['home-feed', 'daily-tasklist', 'my-allocations'],
    more: [
      ...(dealFlow ? ['bd-pipeline'] : []),
      'leave-center', 'people-directory', 'client-projects', 'feature-requests'],
  };
}

function renderMobileTabBar() {
  if (!mobileTabBar) return;
  const config = getMobileTabConfig();
  const activeScreen = getActiveScreenId();
  const moreActive = config.more.includes(activeScreen);

  let html = '';
  config.tabs.forEach((screenId) => {
    const isActive = screenId === activeScreen;
    html += `<button class="tab-item${isActive ? ' active' : ''}" data-screen="${screenId}" type="button">
      ${MOBILE_TAB_ICONS[screenId] || ''}
      <span class="tab-label">${MOBILE_TAB_LABELS[screenId] || screenId}</span>
    </button>`;
  });

  // "More" button
  html += `<button class="tab-item${moreActive ? ' active' : ''}" data-action="more" type="button">
    ${MOBILE_TAB_ICONS.more}
    <span class="tab-label">More</span>
  </button>`;

  mobileTabBar.innerHTML = html;

  // Attach click handlers
  mobileTabBar.querySelectorAll('.tab-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'more') {
        toggleMoreSheet(true);
        return;
      }
      toggleMoreSheet(false);
      navigateToScreen(btn.dataset.screen);
    });
  });
}

function renderMoreSheet() {
  if (!moreSheetList) return;
  const config = getMobileTabConfig();
  const activeScreen = getActiveScreenId();

  let html = '';
  config.more.forEach((screenId) => {
    const isActive = screenId === activeScreen;
    html += `<button class="more-sheet-item${isActive ? ' active' : ''}" data-screen="${screenId}" type="button">
      ${MOBILE_TAB_ICONS[screenId] || ''}
      <span>${MOBILE_TAB_LABELS[screenId] || screenId}</span>
    </button>`;
  });

  moreSheetList.innerHTML = html;

  moreSheetList.querySelectorAll('.more-sheet-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggleMoreSheet(false);
      navigateToScreen(btn.dataset.screen);
    });
  });
}

function toggleMoreSheet(show) {
  if (!moreSheet || !moreSheetBackdrop) return;
  if (show) {
    renderMoreSheet();
    moreSheetBackdrop.hidden = false;
    moreSheet.hidden = false;
  } else {
    moreSheetBackdrop.hidden = true;
    moreSheet.hidden = true;
  }
}

if (moreSheetBackdrop) {
  moreSheetBackdrop.addEventListener('click', () => toggleMoreSheet(false));
}

function syncMobileNav() {
  if (!mobileTabBar) return;
  const isLoggedIn = state.isAuthenticated && getActiveScreenId() !== 'login';
  mobileTabBar.hidden = !isLoggedIn;
  if (isLoggedIn) {
    renderMobileTabBar();
  }
}

let _lastMobileState = window.matchMedia('(max-width: 768px)').matches;
// Re-run daily cleanup when tab regains focus (handles overnight idle).
// Guard with a lock to prevent concurrent loadDailyTasksFromSupabase calls.
let _taskLoadInFlight = false;
let _carryForwardDoneThisSession = false;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || _taskLoadInFlight) return;
  if (!state.isAuthenticated) return;
  // Copying a link means leaving the tab and coming back — exactly when this
  // fires, and exactly when an edit row is open.
  if (taskEditInProgress()) return;
  const today = toISODateLocal();
  if (localStorage.getItem('colony_task_cleanup_date') === today) return;
  _taskLoadInFlight = true;
  _carryForwardDoneThisSession = false; // new day — allow carry-forward to run again
  try {
    await loadDailyTasksFromSupabase();
  } catch (err) {
    console.error('Visibility-change task reload failed:', err);
  } finally {
    _taskLoadInFlight = false;
  }
});

// Midnight boundary: detect date change and re-run carry-forward for the new day.
// Fires every 60s — lightweight check, only reloads when date actually changes.
let _lastCheckedDate = toISODateLocal();
setInterval(() => {
  if (!state.isAuthenticated) return;
  const now = toISODateLocal();
  if (now !== _lastCheckedDate) {
    _lastCheckedDate = now;
    _carryForwardDoneThisSession = false;
    loadDailyTasksFromSupabase().catch((err) => console.error('Midnight reload failed:', err));
  }
}, 60000);

window.addEventListener('resize', () => {
  syncMobileNav();
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  if (isMobile !== _lastMobileState) {
    _lastMobileState = isMobile;
    // Re-render planner when crossing mobile/desktop breakpoint
    if (state._plannerByDept) {
      renderActivePlannerView();
    }
  }
});
syncMobileNav();

// ── End Mobile Nav ──────────────────────────────────────────────────────

const signInBtn = document.getElementById('signInBtn');
const registerBtn = document.getElementById('registerBtn');
const partnerSignInBtn = document.getElementById('partnerSignInBtn');
const loginMessage = document.getElementById('loginMessage');
const authSessionLine = document.getElementById('authSessionLine');
const logoutBtn = document.getElementById('logoutBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', toggleTheme);
}

function setLoginStatus(message, className = 'status') {
  if (!loginMessage) return;
  loginMessage.className = className;
  loginMessage.textContent = message;
}

function setAuthSessionLine(message = '') {
  if (!authSessionLine) return;
  authSessionLine.textContent = message;
}

function updateSidebarIdentityLabels() {
  if (loginNavButton) {
    if (!state.isAuthenticated) {
      loginNavButton.textContent = 'Login';
      loginNavButton.dataset.screen = 'login';
      loginNavButton.classList.remove('sidebar-identity');
    } else {
      loginNavButton.textContent = displayPersonName(state.employeeProfile?.full_name, 'My Profile');
      loginNavButton.dataset.screen = 'employee-profile';
      loginNavButton.classList.add('sidebar-identity');
    }
    loginNavButton.classList.remove('disabled');
  }
  // Circle: who is signed in and for which client. The blank block above the
  // nav read as broken (16 Sep 2026). Colony keeps this hidden.
  const identity = document.getElementById('circleIdentity');
  if (identity) {
    let html = '';
    if (state.isAuthenticated && state.partnerProfile) {
      html = `${escapeHtml(displayPersonName(state.partnerProfile.full_name, 'You'))}<span class="sidebar-identity-sub">${escapeHtml(state.partnerProfile.org || '')}</span>`;
    } else if (state.isAuthenticated && state.staffOnCircle) {
      html = `${escapeHtml(displayPersonName(state.employeeProfile?.full_name, 'Your Agency'))}<span class="sidebar-identity-sub">Your Agency team</span>`;
    }
    identity.innerHTML = html;
    identity.classList.toggle('hidden', !html);
  }
  if (state.isAuthenticated && getActiveScreenId() === 'login') {
    activateScreen(defaultHomeScreen());
  }
}

function upsertEmployeeInStore(employee) {
  const fullName = employee?.full_name || state.currentEmployee || DEFAULT_EMPLOYEE;
  const departmentName = normalizeTeamName(employee?.department?.name, TEAM_AM);
  const employmentType = employee?.employment_type || 'full-time';
  const email = normalizeEmail(employee?.email);
  const parsedCapacity = Number(employee?.capacity_percent);
  const capacityPercent = Number.isFinite(parsedCapacity) ? parsedCapacity : 100;
  const leaveTrackingEnabled = employee?.leave_tracking_enabled !== false;
  const accessLevel = normalizeAccessLevel(employee?.access_level || 'employee');
  const target = ensureEmployeeRecord(fullName);
  target.team = normalizeTeamName(departmentName, TEAM_AM);
  target.accessLevel = accessLevel;
  target.employmentType = employmentType;
  target.email = email || target.email || '';
  target.capacityPercent = capacityPercent;
  target.leaveTrackingEnabled = leaveTrackingEnabled;
  target.lastAllocationEdit = target.lastAllocationEdit || '';
  target.utilization = target.utilization || { week: 0, month: 0 };
  target.projects = target.projects || { week: [], month: [] };
}

async function fetchRuntimeConfig() {
  // ALWAYS go through /api/runtime-config — `netlify dev` serves it locally
  // from .env. The old localhost branch returned before this fetch with a
  // hardcoded project URL + anon key, which meant:
  //   1. .env was silently ignored on localhost, so the documented
  //      SUPABASE_URL=https://your-project.supabase.co swap (needed for the Google OAuth
  //      callback to work locally) never actually took effect; and
  //   2. a rotated anon key would break local dev with no obvious cause,
  //      while a plain static server pointed straight at production data.
  const response = await fetch('/api/runtime-config', { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    throw new Error(isLocal
      ? 'Runtime config unavailable — run `netlify dev` (it serves /api/runtime-config from .env). See CLAUDE.md → Testing.'
      : 'Unable to load runtime configuration from Netlify.');
  }
  return response.json();
}

// ensure_employee_profile is split out so the caller can await it FIRST: it
// creates a new joiner's row, and app_config / access_overrides /
// employee_client_scope are all RLS-gated on is_employee(), so they read
// nothing until that row exists.
async function ensureEmployeeProfileRow() {
  const ensureResult = await state.supabase.rpc('ensure_employee_profile');
  if (ensureResult.error) throw ensureResult.error;
  return ensureResult;
}

async function fetchCurrentEmployeeProfile(ensureResult) {
  const profileId = ensureResult.data?.id;
  if (!profileId) {
    throw new Error('Account bootstrap succeeded but profile id is missing.');
  }

  // Address and emergency contact are column-revoked from authenticated
  // (202609210001) and come from employee_private_details, own row only.
  const [employeeResult, privateDetails] = await Promise.all([state.supabase
    .from('employees')
    .select(`
      id,
      auth_user_id,
      full_name,
      email,
      capacity_percent,
      employment_type,
      access_level,
      leave_tracking_enabled,
      approver_emails,
      onboarding_completed,
      job_title,
      current_city,
      timezone,
      date_of_birth,
      direct_manager_email,
      department:departments!employees_department_id_fkey (
        id,
        name,
        leave_tracking_enabled
      )
    `)
    .eq('id', profileId)
    .single(), loadEmployeePrivateDetails(profileId)]);

  if (employeeResult.error) throw employeeResult.error;
  return { ...employeeResult.data, ...(privateDetails || {}) };
}

// A person's home address and emergency contact: their own, or anyone's for
// leadership/admin. Null when the caller may not see them or the read fails —
// callers must then leave those fields out of any save, never write blanks.
async function loadEmployeePrivateDetails(employeeId) {
  if (!state.supabase || !employeeId) return null;
  const { data, error } = await state.supabase.rpc('employee_private_details', { p_employee_id: employeeId });
  if (error) {
    console.warn('Private profile details unavailable:', error.message);
    return null;
  }
  return (Array.isArray(data) ? data[0] : data) || null;
}

// applyAuthState is split into focused phases (slice 7) — the orchestrator at
// the bottom preserves the exact original order, awaits and early-returns.

// Phase: full reset to the signed-out state (also runs on sign-out).
function resetToSignedOutState() {
    state.employeeProfile = null;
    state.partnerProfile = null;
    state.hireProfile = null;
    state.hiringOnlyMode = false;
    state.staffOnCircle = false;
    placeHiringPanel('directory');
    state.currentEmployeeId = null;
    state.employeeDirectory = [];
    state.inactiveEmployees = [];
    state.dailyTasks = [];
    state.featureRequests = [];
    state.frPendingFiles = [];
    state.frReplyPendingFiles = {};
    state.clients = [];
    state.weeklyAllocations = [];
    state.taskViewEmployeeId = null;
    state.allocationViewEmployeeId = null;
    state.role = 'employee';
    state.currentEmployee = DEFAULT_EMPLOYEE;
    invoiceUnlocked = false;
    setAuthenticatedNavigation(false);
    if (signInBtn) signInBtn.classList.remove('hidden');
    if (registerBtn) registerBtn.classList.remove('hidden');
    if (partnerSignInBtn) partnerSignInBtn.classList.remove('hidden');
    if (logoutBtn) {
      logoutBtn.classList.add('hidden');
      logoutBtn.disabled = true;
    }
    state._realRole = null;
    setAuthSessionLine('');
    updateSidebarIdentityLabels();
    if (state.pendingAuthStatus) {
      setLoginStatus(state.pendingAuthStatus.message, state.pendingAuthStatus.className);
      state.pendingAuthStatus = null;
    } else {
      setLoginStatus('Choose Sign in or Register with your @youragency.com Google account.', 'status');
    }
    setDailyTaskNotice('');
    renderPeopleDirectory();
    renderTaskEmployeeFilterOptions();
    renderAllocationEmployeeFilterOptions();
    renderClientRegistryTable();
    renderTaskClientOptions();
    renderFullAccessUsers();
    renderClientOwnerOptions();
    renderWeeklyAllocationViews();
    renderTeamDashboardEmpty('Sign in to load team allocation snapshots.');
    setTeamDashboardScopeNote('Sign in to load team allocation snapshots.');
    renderDailyTaskViews();
    applyLeaveCycleSummary(emptyLeaveSummary());
    setLeaveBalanceNotice('Sign in to load leave balances.');
    if (orgChartPanel) orgChartPanel.classList.add('hidden');
    if (toggleOrgChartBtn) toggleOrgChartBtn.textContent = 'Org Chart';
    // Runs after every field above is cleared, so applyFooterLinkAccess()
    // inside it sees a genuinely signed-out state.
    applyRoleAccess();
    activateScreen('login');
    dismissSplash();
}

// Phase: profile + role. Loads access overrides and app_config BEFORE the role
// is computed; self-heals DB access_level drift against the enforced pin.
async function establishIdentityAndRole(authEmail, wasAuthenticated) {
    // Access overrides and app_config must be in hand BEFORE the role is
    // computed below (falls back to the hardcoded ENFORCED_ACCESS_BY_EMAIL if
    // the table is empty/unreachable). Once the row exists none of the four
    // reads depends on another, so they run together: one after another they
    // were ~3s of every sign-in and page load (17 Sep 2026).
    const ensureResult = await ensureEmployeeProfileRow();
    const [rawProfile] = await Promise.all([
      fetchCurrentEmployeeProfile(ensureResult),
      loadAccessOverrides().catch(err => console.warn('Access overrides load failed, using fallback:', err)),
      loadAppConfig().catch(err => console.warn('App config load failed, using fallback:', err)),
      loadClientScope().catch(err => console.warn('Client scope load failed:', err))
    ]);
    const employeeProfile = stripMiddleNameOnEmployee(rawProfile);
    const enforcedAccess = getEnforcedAccessLevel(authEmail);
    state.employeeProfile = employeeProfile;
    state.currentEmployeeId = employeeProfile.id;
    // Only reset view employee IDs on fresh sign-in, not token refresh
    if (!wasAuthenticated) {
      state.taskViewEmployeeId = employeeProfile.id;
      state.allocationViewEmployeeId = employeeProfile.id;
    }
    state.role = enforcedAccess || employeeProfile.access_level || 'employee';
    // Sync enforced access level to DB if mismatched
    if (enforcedAccess && normalizeAccessLevel(employeeProfile.access_level) !== enforcedAccess) {
      state.supabase.from('employees').update({ access_level: enforcedAccess }).eq('id', employeeProfile.id).then(res => {
        if (!res.error) {
          employeeProfile.access_level = enforcedAccess;
          console.log(`Synced enforced access level '${enforcedAccess}' to DB for ${authEmail}`);
        }
      }).catch(err => console.warn('Access level sync failed:', err));
    }
    upsertEmployeeInStore(employeeProfile);
    return employeeProfile;
}

// Phase: signed-in UI chrome (buttons, identity labels, status, visibility).
function applySignedInChrome(employeeProfile, authEmail, wasAuthenticated) {
    if (signInBtn) signInBtn.classList.add('hidden');
    if (registerBtn) registerBtn.classList.add('hidden');
    if (logoutBtn) {
      logoutBtn.classList.remove('hidden');
      logoutBtn.disabled = false;
    }
    updateSidebarIdentityLabels();
    setAuthenticatedNavigation(true);
    setAuthSessionLine(`Signed in as ${displayPersonName(employeeProfile.full_name, 'Employee')} (${authEmail})`);
    if (!wasAuthenticated) {
      if (state.authIntent === 'register') {
        setLoginStatus('Registration complete. Role assigned from your company profile.', 'status');
      } else {
        setLoginStatus('Sign-in successful. Role assigned from your company profile.', 'status');
      }
    }
    state.authIntent = 'signin';

    if (!wasAuthenticated) {
      setSelectedEmployee(employeeProfile.full_name || DEFAULT_EMPLOYEE);
    }
    applyRoleAccess();
    applyInvoiceVisibility();
    applyDealFlowVisibility();
    applyBriefsVisibility();
    applyFractionalVisibility();
}

// Phase: initial data fan-out (each load fails independently).
// Dead-session recovery. Deliberately narrow: only the signatures that mean
// "this request had no usable identity" — an ordinary RLS refusal ("new row
// violates row-level security policy") must NOT land here, it is a real
// answer to a real request.
let authLossInFlight = false;
function isDeadSessionBody(body) {
  return /permission denied for schema|JWT expired|invalid claim|bad_jwt|token is expired/i.test(body || '');
}

async function handlePossibleAuthLoss(response) {
  if (authLossInFlight || !state.supabase) return;
  // ONLY for a session we already had. Without this guard the handler also ran
  // during the sign-in round trip — PKCE exchanges the code on page load, and
  // any query firing before the session settled hit 401/403, failed to
  // refresh, and called signOut(), which wiped the session just created AND
  // its PKCE verifier. Result: signed out, and every sign-in killed itself
  // (Alex, locked out 24 Aug 2026). A signed-out client has no session to
  // rescue, so there is nothing here for it to do.
  if (!state.isAuthenticated || !state.session) return;
  let body = '';
  try { body = await response.text(); } catch (e) { return; }
  if (!isDeadSessionBody(body)) return;
  authLossInFlight = true;
  try {
    // One honest attempt to refresh before giving up on the session.
    const { data, error } = await state.supabase.auth.refreshSession();
    if (!error && data?.session) {
      await loadInitialAppData().catch((e) => console.error('Reload after session refresh failed:', e));
      return;
    }
    // Never sign out blind: if the client no longer holds a session, calling
    // signOut() can only destroy state a concurrent sign-in is building.
    const current = await state.supabase.auth.getSession().catch(() => null);
    if (!current?.data?.session) return;
    const msg = 'Your session expired — please sign in again.';
    state.pendingAuthStatus = { message: msg, className: 'status error' };
    await state.supabase.auth.signOut().catch(() => {});
    setLoginStatus(msg, 'status error');
  } finally {
    authLossInFlight = false;
  }
}

async function loadInitialAppData() {
    await Promise.all([
      loadEmployeeDirectoryFromSupabase().catch((error) => {
        console.error('Employee directory load failed:', error);
      }),
      loadClientsFromSupabase().catch((error) => {
        console.error('Clients load failed:', error);
      }),
      loadDailyTasksFromSupabase().catch((error) => {
        console.error('Daily tasks load failed:', error);
      }),
      loadWeeklyAllocationsFromSupabase().catch((error) => {
        console.error('Weekly allocations load failed:', error);
      }),
      loadLeaveRequestsFromSupabase().catch((error) => {
        console.error('Leave requests load failed:', error);
      }),
      loadFeatureRequestsFromSupabase().catch((error) => {
        console.error('Feature requests load failed:', error);
      }),
      loadPublicHolidaysFromSupabase().catch((error) => {
        console.error('Public holidays load failed:', error);
      }),
      loadDepartmentOptions().catch((error) => {
        console.error('Department options load failed:', error);
      }),
      // Deal Flow, briefs and anything else that judges a date needs these —
      // without them "due soon" silently falls back to weekends-only.
      loadSlaAndHolidays().catch((error) => {
        console.error('SLA/holiday load failed:', error);
      }),
      loadNotifySignals().catch((error) => {
        console.error('Notify signals load failed:', error);
      }),
      loadRecurringTasks().catch((error) => {
        console.error('Recurring tasks load failed:', error);
      })
    ]);

    // AFTER the parallel block, not inside it: streaks need the holiday list
    // and the employee directory to already be in hand.
    loadStreakData().catch((error) => console.error('Streak load failed:', error));
}

// Phase: post-sign-in routing (hash screen vs default dashboard vs refresh).
function routeAfterSignIn(wasAuthenticated, activeScreenBeforeAuthUpdate) {
    // initializeScreenHistory() writes the boot screen into the URL, which is
    // #login before auth resolves. That is not somewhere a signed-in person
    // asked to go, so it counts as no hash. Without this they stayed on the
    // sign-in screen whenever nothing else happened to move them — staff on
    // Circle, once they stopped loading the employee app (17 Sep 2026).
    const rawHashScreen = readScreenFromHash();
    const hashScreen = rawHashScreen === 'login' ? '' : rawHashScreen;
    const hashIsAuthCallback = hashContainsAuthTokens();
    const shouldOpenDashboard = !wasAuthenticated && (!hashScreen || hashIsAuthCallback) && activeScreenBeforeAuthUpdate === 'login';

    // Where they were actually trying to go, before Google intervened.
    const intent = takeLinkIntent();
    if (intent && (intent.screen || intent.open)) {
      const target = intent.screen || getActiveScreenId();
      // activateScreen refuses screens this role cannot open, so a stale or
      // off-limits link falls back to home rather than showing a blank shell.
      const landed = target ? activateScreen(target) || getActiveScreenId() === target : false;
      if (landed) {
        writeScreenToHistory(target, { replace: true });
        refreshScreenData(target);
        if (intent.open) applyLinkIntentAnchor(intent.open);
        return;
      }
    }

    if (shouldOpenDashboard) {
      navigateToScreen(defaultHomeScreen(), { replace: true });
    } else if (hashIsAuthCallback) {
      // Auth tokens still in hash — clean up and go to default screen
      navigateToScreen(defaultHomeScreen(), { replace: true });
    } else {
      // Screen already active from initializeScreenHistory but data wasn't loaded
      // because auth hadn't completed yet — refresh it now.
      refreshScreenData(getActiveScreenId());
    }
}

async function applyAuthState(session) {
  const wasAuthenticated = state.isAuthenticated;
  const activeScreenBeforeAuthUpdate = getActiveScreenId();
  state.session = session || null;
  state.isAuthenticated = Boolean(session);

  if (!session) {
    resetToSignedOutState();
    return;
  }

  const authEmail = normalizeEmail(session.user?.email);
  // Reset splash copy in case an outsider attempt on this page load changed it.
  const splashTextEl = document.getElementById('splashText');
  if (splashTextEl) splashTextEl.textContent = 'Setting up your workspace...';
  // An Your Agency address on Circle used to be someone in the wrong place. Since
  // 10 Sep 2026 the people who service clients answer client feedback there,
  // so staff are let through and sorted out once we know who they are — a
  // brief reviewer stays on Circle with the feedback wall and nothing else;
  // anyone else is still sent to Colony. The check has to happen after the
  // profile loads, because reviewer status is not knowable from the address.
  //
  // Candidates are unaffected: they were never reviewers and still go home.
  const onCircle = isCircleHost(location.hostname);
  if (authEmail.endsWith(ANT_DOMAIN) && !onCircle && routeToHomeHost('employee')) return;
  if (!authEmail.endsWith(ANT_DOMAIN)) {
    // Non-youragency session: invited-outsider path (partner, else new hire).
    // Invite-only — no invite anywhere means sign-out.
    await applyOutsiderAuthState(authEmail, wasAuthenticated);
    return;
  }
  if (HIRING_ONLY_EMAILS.includes(authEmail)) {
    // Hiring-only accounts (Leo/legal): youragency email, but never an
    // employee profile — they get the hiring section and nothing else.
    await applyHiringOnlyAuthState(authEmail, wasAuthenticated);
    return;
  }

  try {
    const employeeProfile = await establishIdentityAndRole(authEmail, wasAuthenticated);

    // Now we know. Staff on Circle: only the people who service clients stay,
    // and they get the client feedback wall — briefs and everything else they
    // already have in Colony, and the Circle bundle does not even contain
    // those screens.
    if (onCircle) {
      if (!isBriefReviewer()) {
        state.staffOnCircle = false;
        // This runs on Circle only, so the staff product is named through
        // productName(STAFF_HOST) — the Circle build rewrites that one literal,
        // keeping the internal product's name out of what clients download.
        const staffProduct = productName(STAFF_HOST);
        const msg = `This is the client workspace. Your workspace is ${staffProduct}.`;
        state.pendingAuthStatus = { message: msg, className: 'status error' };
        await state.supabase.auth.signOut();
        setLoginStatus(msg, 'status error');
        appConfirm(
          `${msg}\n\nCircle is where clients work. Only the account team signs in here.`,
          { title: 'Wrong door', confirmLabel: `Go to ${staffProduct}`, cancelLabel: 'Close' }
        ).then((go) => { if (go) window.location.href = `https://${STAFF_HOST}`; }).catch(() => {});
        return;
      }
      state.staffOnCircle = true;
    }

    applySignedInChrome(employeeProfile, authEmail, wasAuthenticated);

    // Came in via the "Partner sign in" button with an youragency account?
    // Routing is by email, so they got the employee view — say so, or this
    // reads as "the partner button is broken" (3 Aug 2026).
    let partnerIntent = false;
    try {
      partnerIntent = sessionStorage.getItem('colony_partner_intent') === '1';
      sessionStorage.removeItem('colony_partner_intent');
    } catch (e) { /* private mode */ }
    // On Circle that button is the only door, so a reviewer using it is doing
    // the right thing — the warning below is for someone on COLONY who wanted
    // the partner view and got the employee one.
    if (partnerIntent && !wasAuthenticated && !state.staffOnCircle) {
      appConfirm(
        'You signed in with your @youragency.com account, so you got the normal employee view — youragency accounts can never be partners. To try the partner side, add a personal (non-youragency) Google account under Briefs → Partners and sign in with that, ideally in an incognito window.',
        { title: 'That was the invited sign-in', confirmLabel: 'Got it', cancelLabel: 'Close' }
      ).catch(() => {});
    }

    // Skip full data reload on token refresh — preserves unsaved form inputs
    if (wasAuthenticated) {
      dismissSplash();
      return;
    }

    // Staff on Circle see only the client screens, which load their own data
    // (loadPartnerData and friends, via routeAfterSignIn). Loading the whole
    // employee app first — tasks, allocations, leave, clients, ~35 requests —
    // kept the splash up for ~8s on clients.youragency.com and faded it onto a
    // half-built page, where a click landed on the sign-in button and started
    // a second Google sign-in (17 Sep 2026; auth logs show /authorize
    // with no logout in between). The onboarding overlay and the leadership
    // badge are employee-app chrome the Circle bundle does not contain.
    if (!state.staffOnCircle) {
      await loadInitialAppData();

      // --- Onboarding: check if this is a new hire needing the welcome overlay ---
      const needsOnboarding = state.employeeProfile?.onboarding_completed === false;
      if (needsOnboarding) {
        await initOnboardingOverlay();
        dismissSplash();
        return;
      }

      // Load onboarding data for sidebar badge (leadership only)
      if (isLeadershipRole()) {
        loadOnboardingBadge().catch(console.error);
      }
    }

    routeAfterSignIn(wasAuthenticated, activeScreenBeforeAuthUpdate);
    dismissSplash();
  } catch (error) {
    console.error(error);
    const bootstrapError = `Unable to bootstrap employee profile: ${error.message}`;
    state.pendingAuthStatus = { message: bootstrapError, className: 'status error' };
    setLoginStatus(bootstrapError, 'status error');
    await state.supabase.auth.signOut();
    dismissSplash();
  }
}

// Phase: invited-outsider session (non-youragency email). Invite-only; the email
// decides which surface: partner (briefs) else new hire (joining checklist).
async function applyOutsiderAuthState(authEmail, wasAuthenticated) {
  try { sessionStorage.removeItem('colony_partner_intent'); } catch (e) { /* private mode */ }
  // The default splash copy ("Setting up your workspace") is employee language
  // and reads as a broken half-login when an invite check fails (3 Aug).
  const splashText = document.getElementById('splashText');
  if (splashText) splashText.textContent = 'Verifying your access…';
  try {
    const { data: partner, error } = await state.supabase.rpc('ensure_partner_profile');
    if (error) throw error;
    if (!partner || !partner.id) {
      // Not a partner — maybe an invited new hire.
      const { data: hire, error: hireError } = await state.supabase.rpc('ensure_hire_profile');
      if (hireError) throw hireError;
      if (hire && hire.id) {
        await applyHireAuthState(hire, authEmail, wasAuthenticated);
        return;
      }
      // The first thing a mistyped or uninvited client ever sees, so it must
      // name THEIR product. Said "No Colony invite" until 10 Sep 2026 — a
      // platform they have never heard of and cannot reach.
      const msg = `No ${productName(location.hostname)} invite for this email. Ask your Your Agency contact for an invite.`;
      state.pendingAuthStatus = { message: msg, className: 'status error' };
      await state.supabase.auth.signOut();
      setLoginStatus(msg, 'status error');
      // The status line under the sign-in buttons is easy to miss — say it
      // plainly, then the user is back on the sign-in screen.
      appConfirm(
        `${authEmail} isn't on ${productName(location.hostname)}'s invite list, so we've signed you out. If you're expecting access, ask your Your Agency contact to invite this exact email address.`,
        { title: 'Invited sign-in failed', confirmLabel: 'OK', cancelLabel: 'Close' }
      ).catch(() => {});
      return;
    }

    state.partnerProfile = partner;
    state.role = 'partner';
    state._realRole = null;

    // Clients sign in on Circle, and ONLY on Circle (8 Sep 2026).
    // A redirect would still have created a Colony session first and then asked
    // them to sign in again on the other origin, which is both a login they
    // should not have had and a worse experience. This refuses instead, and
    // says where to go — the same shape as the no-invite refusal below.
    if (homeHostFor('partner', location.hostname)) {
      const msg = `Clients sign in at ${CIRCLE_HOST}, not here.`;
      state.pendingAuthStatus = { message: msg, className: 'status error' };
      await state.supabase.auth.signOut();
      setLoginStatus(msg, 'status error');
      appConfirm(
        `This is Colony, the team's workspace. Your client workspace is Circle — sign in at ${CIRCLE_HOST} with this same Google account.`,
        { title: 'Wrong door', confirmLabel: `Go to ${productName(CIRCLE_HOST)}`, cancelLabel: 'Close' }
      ).then((go) => { if (go) window.location.href = `https://${CIRCLE_HOST}`; }).catch(() => {});
      return;
    }

    if (signInBtn) signInBtn.classList.add('hidden');
    if (registerBtn) registerBtn.classList.add('hidden');
    if (partnerSignInBtn) partnerSignInBtn.classList.add('hidden');
    if (logoutBtn) {
      logoutBtn.classList.remove('hidden');
      logoutBtn.disabled = false;
    }
    setAuthenticatedNavigation(true);
    // Notify bell is employee-signal-driven; partners get their own in Phase 1b.
    document.getElementById('notifyBellBtn')?.classList.add('hidden');
    setAuthSessionLine(`Signed in as ${displayPersonName(partner.full_name, 'Partner')} (${authEmail}) — ${partner.org}`);
    if (!wasAuthenticated) {
      setLoginStatus('Sign-in successful.', 'status');
    }
    state.authIntent = 'signin';
    applyRoleAccess();

    if (wasAuthenticated) {
      dismissSplash();
      return;
    }
    await loadPartnerData();
    navigateToScreen('partner-home', { replace: true });
    dismissSplash();
  } catch (error) {
    console.error(error);
    const msg = `Partner sign-in failed: ${error.message}`;
    state.pendingAuthStatus = { message: msg, className: 'status error' };
    setLoginStatus(msg, 'status error');
    await state.supabase.auth.signOut();
    dismissSplash();
  }
}

function isPartnerRole() {
  return Boolean(state.partnerProfile);
}

// Candidate session: personal Gmail bound to an active hire. One screen only.
async function applyHireAuthState(hire, authEmail, wasAuthenticated) {
  state.hireProfile = hire;
  state.role = 'hire';
  state._realRole = null;
  // Joining paperwork is Your Agency's own process, not a client one, so a
  // candidate belongs on Colony. They sign in with a personal Gmail, so the
  // @youragency.com check upstream never sees them — without this they would be
  // stranded on Circle.
  if (routeToHomeHost('hire')) return;
  if (signInBtn) signInBtn.classList.add('hidden');
  if (registerBtn) registerBtn.classList.add('hidden');
  if (partnerSignInBtn) partnerSignInBtn.classList.add('hidden');
  if (logoutBtn) { logoutBtn.classList.remove('hidden'); logoutBtn.disabled = false; }
  setAuthenticatedNavigation(true);
  document.getElementById('notifyBellBtn')?.classList.add('hidden');
  setAuthSessionLine(`Signed in as ${displayPersonName(hire.full_name, 'Candidate')} (${authEmail})`);
  state.authIntent = 'signin';
  applyRoleAccess();
  if (wasAuthenticated) { dismissSplash(); return; }
  renderHireChecklist();
  navigateToScreen('hire-checklist', { replace: true });
  dismissSplash();
}

// Hiring-only session (Leo/legal): youragency account, hiring section only.
async function applyHiringOnlyAuthState(authEmail, wasAuthenticated) {
  state.hiringOnlyMode = true;
  state.role = 'hiring-only';
  state._realRole = null;
  if (signInBtn) signInBtn.classList.add('hidden');
  if (registerBtn) registerBtn.classList.add('hidden');
  if (partnerSignInBtn) partnerSignInBtn.classList.add('hidden');
  if (logoutBtn) { logoutBtn.classList.remove('hidden'); logoutBtn.disabled = false; }
  setAuthenticatedNavigation(true);
  document.getElementById('notifyBellBtn')?.classList.add('hidden');
  setAuthSessionLine(`Signed in as ${authEmail} — New hire`);
  state.authIntent = 'signin';
  applyRoleAccess();
  placeHiringPanel('hiring-only');
  if (wasAuthenticated) { dismissSplash(); return; }
  await loadHiringPanel().catch(console.error);
  navigateToScreen('hiring-only', { replace: true });
  dismissSplash();
}

// The hiring panel lives in Team Directory for the crew, but is relocated
// into the standalone #hiring-only screen for hiring-only logins.
let hiringPanelHome = null;
function placeHiringPanel(mode) {
  const panel = document.getElementById('hiringPanel');
  if (!panel) return;
  if (!hiringPanelHome) hiringPanelHome = { parent: panel.parentElement, next: panel.nextElementSibling };
  if (mode === 'hiring-only') {
    document.getElementById('hiringOnlyPanelSlot')?.appendChild(panel);
  } else {
    // The panel's home is the Hiring screen (11 Sep 2026), not the directory
    // it was born in. Leo's hiring-only view still borrows the same node.
    const slot = document.getElementById('hiringScreenSlot');
    if (slot && panel.parentElement !== slot) slot.appendChild(panel);
  }
}

// loadPartnerData / renderPartnerHome live in the Brief pipeline block below.

async function startGoogleSignIn(intent = 'signin') {
  if (!state.supabase) {
    setLoginStatus('Supabase auth is not initialized yet.', 'status error');
    return;
  }
  state.authIntent = intent;

  const isRegisterIntent = intent === 'register';
  const isPartnerIntent = intent === 'partner';

  // Which button was clicked doesn't survive the OAuth redirect — stash it so
  // we can explain if a @youragency.com account comes back via the partner button
  // (routing is by email, and youragency accounts always get the employee view).
  try { sessionStorage.setItem('colony_partner_intent', isPartnerIntent ? '1' : ''); } catch (e) { /* private mode */ }

  // Partners sign in with non-youragency Google accounts, so no hd hint for them.
  // Which path a session takes is decided by email after the redirect, not by
  // this intent (the page reloads and intent state is lost).
  const queryParams = isPartnerIntent
    ? { prompt: 'select_account' }
    : {
        hd: 'youragency.com',
        prompt: isRegisterIntent ? 'consent select_account' : 'select_account'
      };

  const { error } = await state.supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}${window.location.pathname}`,
      queryParams
    }
  });

  if (error) {
    const actionLabel = isRegisterIntent ? 'registration' : 'sign-in';
    setLoginStatus(`Google ${actionLabel} failed: ${error.message}`, 'status error');
  }
}

async function signOutCurrentSession() {
  if (!state.supabase) return;
  const { error } = await state.supabase.auth.signOut();
  if (error) {
    setLoginStatus(`Sign-out failed: ${error.message}`, 'status error');
  }
}

async function initializeSupabaseAuth() {
  if (!window.supabase?.createClient) {
    setLoginStatus('Supabase SDK failed to load.', 'status error');
    return;
  }

  try {
    state.runtimeConfig = await fetchRuntimeConfig();
  } catch (error) {
    setLoginStatus(`Runtime configuration error: ${error.message}`, 'status error');
    return;
  }

  if (!state.runtimeConfig.supabaseUrl || !state.runtimeConfig.supabaseAnonKey) {
    setLoginStatus('Missing SUPABASE_URL or SUPABASE_ANON_KEY in Netlify environment.', 'status error');
    return;
  }

  const { createClient } = window.supabase;

  state.supabase = createClient(state.runtimeConfig.supabaseUrl, state.runtimeConfig.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // PKCE (the supabase-js default) serializes token refreshes across tabs
      // via the Web Locks API. The previous 'implicit' flow did not, so two
      // open tabs would refresh concurrently, rotate each other's refresh
      // token, and one would get "Refresh token is not valid" → forced logout.
      flowType: 'pkce'
    },
    db: {
      schema: 'app'
    },
    global: {
      // One place to notice a session that has died. With no valid token,
      // supabase-js falls back to the anon key, and anon has no USAGE on the
      // app schema — so every query returns "permission denied for schema
      // app", which reached users as a raw Postgres error in whichever panel
      // happened to load first (24 Aug 2026). Now a dead session is
      // recognised once, here, and turned into a normal re-sign-in.
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (response.status === 401 || response.status === 403) {
          handlePossibleAuthLoss(response.clone()).catch(() => {});
        }
        return response;
      }
    }
  });

  // PKCE returns auth as ?code= (handled by detectSessionInUrl), never as a
  // URL hash, so the old manual #access_token= fallback is now unreachable and
  // has been removed.
  const sessionResult = await state.supabase.auth.getSession();

  if (sessionResult.error) {
    setLoginStatus(`Unable to read auth session: ${sessionResult.error.message}`, 'status error');
    return;
  }

  await applyAuthState(sessionResult.data?.session || null);

  state.supabase.auth.onAuthStateChange((event, nextSession) => {
    // supabase-js replays INITIAL_SESSION to every new subscriber. It carries
    // the session applyAuthState() just finished with, so handling it again
    // re-ran the whole identity chain (5 sequential queries) on every page
    // load. Token refreshes and real sign-in/out still go through.
    if (event === 'INITIAL_SESSION'
        && (nextSession?.access_token || null) === (state.session?.access_token || null)) {
      return;
    }
    window.setTimeout(() => {
      applyAuthState(nextSession).catch((error) => {
        console.error(error);
        setLoginStatus(`Auth state error: ${error.message}`, 'status error');
      });
    }, 0);
  });
}

if (signInBtn) {
  signInBtn.addEventListener('click', () => {
    startGoogleSignIn('signin').catch((error) => {
      console.error(error);
      setLoginStatus(`Google sign-in failed: ${error.message}`, 'status error');
    });
  });
}

if (registerBtn) {
  registerBtn.addEventListener('click', () => {
    startGoogleSignIn('register').catch((error) => {
      console.error(error);
      setLoginStatus(`Google registration failed: ${error.message}`, 'status error');
    });
  });
}

if (partnerSignInBtn) {
  partnerSignInBtn.addEventListener('click', () => {
    startGoogleSignIn('partner').catch((error) => {
      console.error(error);
      setLoginStatus(`Partner sign-in failed: ${error.message}`, 'status error');
    });
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    signOutCurrentSession().catch((error) => {
      console.error(error);
      setLoginStatus(`Sign-out failed: ${error.message}`, 'status error');
    });
  });
}

const taskTodayLabel = document.getElementById('taskTodayLabel');
const taskEmployeeFilterWrap = document.getElementById('taskEmployeeFilterWrap');
const taskEmployeeFilter = document.getElementById('taskEmployeeFilter');
const taskActionHeader = document.getElementById('taskActionHeader');
const dailyTaskTableBody = document.getElementById('dailyTaskTableBody');
const newTaskTitleInput = document.getElementById('newTaskTitleInput');
const newTaskDescriptionInput = document.getElementById('newTaskDescriptionInput');
if (newTaskDescriptionInput) newTaskDescriptionInput.maxLength = TASK_DESCRIPTION_MAX;
const newTaskDeadlineInput = document.getElementById('newTaskDeadlineInput');
const newTaskClientSelect = document.getElementById('newTaskClientSelect');
const weeklyPlannerTableBody = document.getElementById('weeklyPlannerTableBody');
const weeklyTaskActionHeader = document.getElementById('weeklyTaskActionHeader');
const addWeeklyTaskBtn = document.getElementById('addWeeklyTaskBtn');
const dailyTaskNotice = document.getElementById('dailyTaskNotice');
const taskArchiveCalendar = document.getElementById('taskArchiveCalendar');
const archiveDayDetail = document.getElementById('archiveDayDetail');
const archiveDayDetailLabel = document.getElementById('archiveDayDetailLabel');
const archiveDayDetailBody = document.getElementById('archiveDayDetailBody');
const archiveDayDetailClose = document.getElementById('archiveDayDetailClose');
const homeStatCards = document.getElementById('homeStatCards');
const homeFeedList = document.getElementById('homeFeedList');
const homeFeedEmpty = document.getElementById('homeFeedEmpty');
const featureRequestThread = document.getElementById('featureRequestThread');
const featureRequestNotice = document.getElementById('featureRequestNotice');
const newFeatureRequestInput = document.getElementById('newFeatureRequestInput');
const submitFeatureRequestBtn = document.getElementById('submitFeatureRequestBtn');
const featureRequestsFooterLink = document.getElementById('featureRequestsFooterLink');
const frCompletedList = document.getElementById('frCompletedList');
const peopleDirectoryBody = document.getElementById('peopleDirectoryBody');
const directorySearch = document.getElementById('directorySearch');
const toggleOrgChartBtn = document.getElementById('toggleOrgChartBtn');
const orgChartPanel = document.getElementById('orgChartPanel');
const orgChartCanvas = document.getElementById('orgChartCanvas');
const orgChartScope = document.getElementById('orgChartScope');
const fullAccessTableBody = document.getElementById('fullAccessTableBody');
const saveAccessRolesBtn = document.getElementById('saveAccessRolesBtn');
const fullAccessNotice = document.getElementById('fullAccessNotice');

// True while a task row is open for editing. A background reload re-renders
// the table and throws the half-typed row away — which is the "it refreshed
// and I lost the update" half of Dev's report (20 Sep 2026). Explicit
// user actions still render; only the background paths defer.
function taskEditInProgress() {
  return Boolean(document.querySelector('[data-task-action="save-edit"]'));
}

function setDailyTaskNotice(message = '') {
  if (!dailyTaskNotice) return;
  dailyTaskNotice.textContent = message;
}

function getDailyTaskStatusMeta(status) {
  if (status === 'done') return { className: 'approved', label: 'Completed' };
  if (status === 'archived') return { className: 'archived', label: 'Archived' };
  return { className: 'pending', label: 'In progress' };
}

function getEmployeeNameById(employeeId) {
  // Resolve via central helper (includes offboarded). Falls back to own profile
  // if the id is the current user's, then to a generic 'Employee' label.
  const row = lookupEmployee(employeeId);
  if (row?.full_name) {
    const display = displayPersonName(row.full_name, 'Employee');
    return row._offboarded ? `${display} (offboarded)` : display;
  }
  if (state.currentEmployeeId === employeeId) {
    return displayPersonName(state.employeeProfile?.full_name || DEFAULT_EMPLOYEE, 'Employee');
  }
  return 'Employee';
}

function getEmployeeIdByName(fullName) {
  return lookupEmployeeByFullName(fullName)?.id || null;
}

function getTaskViewEmployeeId() {
  if (isLeadershipRole()) {
    return state.taskViewEmployeeId || state.currentEmployeeId || null;
  }
  return state.currentEmployeeId || null;
}

function tasksForDate(employeeId, dateIso) {
  return state.dailyTasks.filter((task) => task.employee_id === employeeId && task.task_date === dateIso);
}

function tasksForWeeklyBacklog(employeeId) {
  return state.dailyTasks.filter(
    (task) => task.employee_id === employeeId && task.task_date === null && task.status !== 'archived'
  );
}

function dedupeSortedNames(values) {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function taskClientNamesFromState() {
  const clientNames = state.clients
    .filter((row) => row.is_active !== false)
    .map((row) => row.name)
    .filter((name) => normalizeClientNameKey(name) !== 'internal');
  return dedupeSortedNames(clientNames);
}

function renderTaskClientOptions() {
  if (!newTaskClientSelect) return;
  const current = newTaskClientSelect.value;
  const names = taskClientNamesFromState();
  newTaskClientSelect.innerHTML = '<option value="">Select client</option>';
  names.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    newTaskClientSelect.appendChild(option);
  });
  if (current && names.includes(current)) {
    newTaskClientSelect.value = current;
  }
}

function renderPeopleDirectory() {
  if (!peopleDirectoryBody) return;
  peopleDirectoryBody.innerHTML = '';
  const showAccessRole = isLeadershipRole();
  const showUtilization = isLeadershipRole();
  const colCount = (showAccessRole ? 1 : 0) + (showUtilization ? 1 : 0) + 7;

  // Toggle Access Role and Utilization header visibility
  const directoryTable = peopleDirectoryBody.closest('table');
  const headers = directoryTable?.querySelectorAll('thead th');
  if (headers?.[5]) headers[5].classList.toggle('hidden', !showAccessRole);
  if (headers?.[6]) headers[6].classList.toggle('hidden', !showUtilization);

  if (!state.employeeDirectory.length) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="${colCount}">No employees yet.</td>`;
    peopleDirectoryBody.appendChild(row);
    renderOrgChart();
    return;
  }

  // Compute per-employee utilization from current week allocations
  const empAllocTotals = new Map();
  state.homeAllocations.forEach(a => {
    const cur = empAllocTotals.get(a.employee_id) || 0;
    empAllocTotals.set(a.employee_id, cur + (a.allocation_percent || 0));
  });

  state.employeeDirectory.filter(e => !getHiddenEmployeeEmails().includes(normalizeEmail(e.email))).forEach((employee) => {
    const util = Math.min(Math.round(empAllocTotals.get(employee.id) || 0), 100);
    const displayName = displayPersonName(employee.full_name, 'Employee');
    const reportsTo = managerLabelForEmployee(employee);
    const accessRole = normalizeAccessLevel(employee.access_level || 'employee');
    const accessLabel = accessRole === 'admin' ? 'Admin' : accessRole === 'leadership' ? 'Leadership' : 'Employee';
    const canEdit = canEditEmployee(employee);
    const actionCell = canEdit
      ? `
        <button class="ghost small" type="button" data-directory-action="edit" data-employee-id="${employee.id}" data-employee="${escapeHtml(employee.full_name)}">Edit</button>
        <button class="ghost small" type="button" data-directory-action="offboard" data-employee-id="${employee.id}" data-employee="${escapeHtml(employee.full_name)}">Offboard</button>
      `
      : '<span class="mini-meta">View only</span>';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td data-label="Name">${state.onboardingEmployeeIds?.has(employee.id) ? '<span class="onboarding-dot" title="Onboarding in progress"></span>' : ''}<button class="name-link employee-link" data-employee="${escapeHtml(employee.full_name)}">${escapeHtml(displayName)}</button>${employee.current_city ? `<span class="directory-city">📍 ${escapeHtml(employee.current_city)}</span>` : ''}</td>
      <td data-label="Email">${escapeHtml(employee.email || '')}</td>
      <td data-label="Department">${escapeHtml(normalizeTeamName(employee.department?.name, TEAM_AM))}</td>
      <td data-label="Reports To">${escapeHtml(reportsTo)}</td>
      <td data-label="Type">${escapeHtml(employmentTypeLabel(employee.employment_type))}</td>
      ${showAccessRole ? `<td data-label="Access">${accessLabel}</td>` : ''}
      ${showUtilization ? `<td data-label="Utilization">${util}%</td>` : ''}
      <td data-label="">${actionCell}</td>
    `;
    peopleDirectoryBody.appendChild(row);
  });

  renderOrgChart();
  renderDeactivatedEmployees();
}

function renderDeactivatedEmployees() {
  const panel = document.getElementById('deactivatedEmployeesPanel');
  const body = document.getElementById('deactivatedEmployeesBody');
  if (!panel || !body) return;
  body.innerHTML = '';

  if (!isLeadershipRole() || !state.inactiveEmployees?.length) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  state.inactiveEmployees.forEach((emp) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td data-label="Name">${escapeHtml(displayPersonName(emp.full_name, 'Employee'))}</td>
      <td data-label="Email">${escapeHtml(emp.email || '')}</td>
      <td data-label="Department">${escapeHtml(emp.department?.name || '--')}</td>
      <td data-label="Actions"><button class="ghost small" type="button" data-reactivate-id="${emp.id}" data-reactivate-name="${escapeHtml(emp.full_name)}">Reactivate</button></td>
    `;
    body.appendChild(row);
  });
}

// Delegate reactivate clicks (once)
document.getElementById('deactivatedEmployeesPanel')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-reactivate-id]');
  if (!btn) return;
  const id = btn.dataset.reactivateId;
  const name = btn.dataset.reactivateName;
  if (!await appConfirm(`Reactivate ${name}?`)) return;
  const result = await state.supabase.from('employees').update({ is_active: true }).eq('id', id);
  if (result.error) {
    appAlert(`Unable to reactivate: ${result.error.message}`);
    return;
  }
  await loadEmployeeDirectoryFromSupabase();
});

function setOrgChartScope(message = '') {
  if (!orgChartScope) return;
  orgChartScope.textContent = message;
}

function buildOrgChartNode(employee, childrenByManagerEmail, { startExpanded = false } = {}) {
  const email = normalizeEmail(employee?.email);
  const role = normalizeAccessLevel(employee?.access_level || (isSuperadminEmail(email) ? 'admin' : 'employee'));
  const isRoot = isSuperadminEmail(email);
  const isLead = role === 'leadership' || role === 'admin';
  const name = displayPersonName(employee?.full_name || displayNameFromEmail(email), 'Employee');
  const team = employee?.department?.name ? normalizeTeamName(employee.department.name, TEAM_AM) : 'Leadership';
  const initial = (name.charAt(0) || '?').toUpperCase();

  const children = (childrenByManagerEmail.get(email) || []).sort((a, b) =>
    String(a.full_name || '').localeCompare(String(b.full_name || ''))
  );
  const hasChildren = children.length > 0;

  const node = document.createElement('li');
  const cardClass = isRoot ? 'vnode root' : isLead ? 'vnode lead' : 'vnode';
  const toggleHtml = hasChildren
    ? `<button class="toggle${startExpanded ? ' expanded' : ''}" type="button" aria-label="Toggle reports">&#x25B6;</button>`
    : '';

  node.innerHTML = `
    <div class="${cardClass}">
      <div class="avatar">${escapeHtml(initial)}</div>
      <div class="info">
        <span class="name">${escapeHtml(name)}</span>
        <span class="meta">${escapeHtml(team)}${isLead ? ' \u00b7 ' + (role === 'admin' ? 'Admin' : 'Leadership') : ''}</span>
      </div>
      ${toggleHtml}
    </div>
  `;

  if (!hasChildren) return node;

  const branch = document.createElement('ul');
  branch.className = startExpanded ? 'children' : 'children collapsed';
  children.forEach((child) => {
    branch.appendChild(buildOrgChartNode(child, childrenByManagerEmail));
  });
  node.appendChild(branch);

  const toggleBtn = node.querySelector('.toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const isExpanded = toggleBtn.classList.toggle('expanded');
      branch.classList.toggle('collapsed', !isExpanded);
    });
  }

  return node;
}

function renderOrgChart() {
  if (!orgChartCanvas) return;
  orgChartCanvas.innerHTML = '';

  if (!state.employeeDirectory.length) {
    orgChartCanvas.innerHTML = '<p class="mini-meta">No employees available for org chart.</p>';
    setOrgChartScope('Reporting structure based on leadership mapping.');
    return;
  }

  const rootEmployee =
    employeeByEmail(SUPERADMIN_EMAIL) || {
      full_name: displayNameFromEmail(SUPERADMIN_EMAIL),
      email: SUPERADMIN_EMAIL,
      access_level: 'admin',
      department: { name: 'Leadership' }
    };

  const childrenByManagerEmail = new Map();
  state.employeeDirectory.forEach((employee) => {
    const managerEmail = managerEmailForEmployee(employee);
    if (!managerEmail) return;
    if (!childrenByManagerEmail.has(managerEmail)) {
      childrenByManagerEmail.set(managerEmail, []);
    }
    childrenByManagerEmail.get(managerEmail).push(employee);
  });

  const tree = document.createElement('ul');
  tree.className = 'vtree';
  tree.appendChild(buildOrgChartNode(rootEmployee, childrenByManagerEmail, { startExpanded: true }));
  orgChartCanvas.appendChild(tree);
}

async function deactivateDirectoryEmployee(employeeId, employeeName = 'Employee') {
  if (!employeeId || !isLeadershipRole()) return;

  const displayName = displayPersonName(employeeName, 'Employee');
  if (employeeId === state.currentEmployeeId) {
    appAlert('You cannot deactivate your own account.');
    return;
  }

  const confirmDeactivate = await appConfirm(`Deactivate ${displayName}?`);
  if (!confirmDeactivate) return;

  if (!state.supabase || !state.isAuthenticated) {
    state.employeeDirectory = state.employeeDirectory.filter((entry) => entry.id !== employeeId);
    renderPeopleDirectory();
    renderTaskEmployeeFilterOptions();
    renderAllocationEmployeeFilterOptions();
    renderFullAccessUsers();
    return;
  }

  const result = await state.supabase.from('employees').update({ is_active: false }).eq('id', employeeId);
  if (result.error) {
    appAlert(`Unable to deactivate ${displayName}: ${result.error.message}`);
    return;
  }

  if (state.taskViewEmployeeId === employeeId) {
    state.taskViewEmployeeId = state.currentEmployeeId;
  }
  if (state.allocationViewEmployeeId === employeeId) {
    state.allocationViewEmployeeId = state.currentEmployeeId;
  }

  await loadEmployeeDirectoryFromSupabase();
  await loadDailyTasksFromSupabase();
  await loadWeeklyAllocationsFromSupabase();
  setSelectedEmployee(state.employeeProfile?.full_name || DEFAULT_EMPLOYEE);
}

// ─── Offboarding flow ───────────────────────────────────────────────
function ensureOffboardModalStyles() {
  if (document.getElementById('offboardModalStyles')) return;
  const s = document.createElement('style');
  s.id = 'offboardModalStyles';
  s.textContent = `
    .ofb-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}
    .ofb-modal{background:var(--panel-bg,#161b26);color:var(--text,#e6ebf5);border:1px solid var(--panel-border,#262d3d);border-radius:14px;max-width:680px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.5)}
    .ofb-head{padding:18px 22px;border-bottom:1px solid var(--panel-border,#262d3d)}
    .ofb-head h3{margin:0;font-size:18px}
    .ofb-head .ofb-sub{font-size:12px;color:var(--text-muted,#8b95a8);margin-top:4px}
    .ofb-body{padding:16px 22px;overflow-y:auto;flex:1}
    .ofb-section{margin-bottom:14px;padding:12px 14px;border:1px solid var(--panel-border,#262d3d);border-radius:10px;background:var(--panel-bg-alt,#1a1f2c)}
    .ofb-section h4{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted,#8b95a8)}
    .ofb-section .ofb-count{font-size:20px;font-weight:600}
    .ofb-section ul{margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--text-muted,#8b95a8)}
    .ofb-reassign-row{display:flex;gap:8px;align-items:center;margin:6px 0;font-size:13px}
    .ofb-reassign-row .ofb-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ofb-reassign-row select{flex:1;min-width:160px}
    .ofb-empty{color:var(--text-muted,#8b95a8);font-size:13px}
    .ofb-foot{padding:14px 22px;border-top:1px solid var(--panel-border,#262d3d);display:flex;gap:10px;justify-content:flex-end;align-items:center}
    .ofb-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--panel-border,#262d3d);background:transparent;color:var(--text,#e6ebf5);cursor:pointer;font-size:13px}
    .ofb-btn.danger{background:#c0392b;border-color:#c0392b;color:#fff;font-weight:600}
    .ofb-btn:disabled{opacity:.45;cursor:not-allowed}
    .ofb-status{font-size:12px;color:var(--text-muted,#8b95a8);margin-right:auto}
  `;
  document.head.appendChild(s);
}

async function openOffboardEmployeeFlow(employeeId, employeeName) {
  if (!employeeId || !isLeadershipRole()) return;
  if (!state.supabase) { appAlert('Not connected to database.'); return; }
  if (employeeId === state.currentEmployeeId) {
    appAlert('You cannot offboard your own account.');
    return;
  }
  ensureOffboardModalStyles();

  const today = new Date().toISOString().slice(0, 10);
  // current week monday in local
  const wkStart = (typeof getCurrentWeekStartIso === 'function') ? getCurrentWeekStartIso() : today;

  // Pre-flight scan
  const [tasksRes, leaveRes, allocRes, standingRes, onbRes, clientsRes, dealsRes] = await Promise.all([
    state.supabase.from('daily_tasks').select('id,task_title,status').eq('employee_id', employeeId).eq('status', 'in_progress'),
    state.supabase.from('leave_requests').select('id,start_date,end_date,status').eq('employee_id', employeeId).gte('end_date', today).in('status', ['approved', 'pending']),
    state.supabase.from('allocations').select('id,period_start').eq('employee_id', employeeId).gte('period_start', wkStart),
    state.supabase.from('client_standing_allocations').select('id').eq('employee_id', employeeId),
    state.supabase.from('onboarding_checklists').select('id,status').eq('employee_id', employeeId).eq('status', 'active'),
    state.supabase.from('clients').select('id,name').eq('account_owner_employee_id', employeeId),
    state.supabase.from('deals').select('id,deal_name').eq('poc_employee_id', employeeId)
  ]);

  const errors = [tasksRes, leaveRes, allocRes, standingRes, onbRes, clientsRes, dealsRes].filter(r => r.error);
  if (errors.length) {
    console.error('Offboard scan errors', errors);
    appAlert('Could not load offboarding data: ' + errors[0].error.message);
    return;
  }

  const data = {
    tasks: tasksRes.data || [],
    leave: leaveRes.data || [],
    allocs: allocRes.data || [],
    standing: standingRes.data || [],
    onboarding: onbRes.data || [],
    clients: clientsRes.data || [],
    deals: dealsRes.data || []
  };

  // Eligible reassignment targets (active employees, not the one being offboarded)
  const candidates = (state.employeeDirectory || [])
    .filter(e => e.is_active !== false && e.id !== employeeId)
    .map(e => ({ id: e.id, name: e.full_name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Build modal
  const backdrop = document.createElement('div');
  backdrop.className = 'ofb-backdrop';
  const reassignSelect = (kind, item, label) =>
    `<div class="ofb-reassign-row"><span class="ofb-name">${escapeHtml(label)}</span><select data-ofb-reassign="${kind}" data-id="${escapeHtml(item.id)}"><option value="">— Reassign to —</option>${candidates.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}</select></div>`;

  const sec = (title, count, body) =>
    `<div class="ofb-section"><h4>${title}</h4><div class="ofb-count">${count}</div>${body || ''}</div>`;

  const tasksBody = data.tasks.length
    ? `<ul>${data.tasks.slice(0, 6).map(t => `<li>${escapeHtml(t.task_title || 'Untitled')}</li>`).join('')}${data.tasks.length > 6 ? `<li>+${data.tasks.length - 6} more</li>` : ''}</ul>`
    : '';
  const leaveBody = data.leave.length ? `<ul>${data.leave.map(l => `<li>${escapeHtml(l.start_date)} → ${escapeHtml(l.end_date)} (${escapeHtml(l.status)})</li>`).join('')}</ul>` : '';
  const clientsBody = data.clients.length
    ? data.clients.map(c => reassignSelect('client', c, c.name || 'Untitled client')).join('')
    : '<div class="ofb-empty">None</div>';
  const dealsBody = data.deals.length
    ? data.deals.map(d => reassignSelect('deal', d, d.deal_name || 'Untitled deal')).join('')
    : '<div class="ofb-empty">None</div>';

  backdrop.innerHTML = `
    <div class="ofb-modal" role="dialog" aria-modal="true">
      <div class="ofb-head">
        <h3>Offboard ${escapeHtml(employeeName)}</h3>
        <div class="ofb-sub">Review what will be archived, reassigned, or cancelled. This cannot be undone from here.</div>
      </div>
      <div class="ofb-body">
        ${sec('Open tasks → archive', data.tasks.length, tasksBody)}
        ${sec('Future leave → cancel', data.leave.length, leaveBody)}
        ${sec('This week + future allocations → remove', data.allocs.length, '')}
        ${sec('Standing client allocations → remove', data.standing.length, '')}
        ${sec('Active onboarding checklists → delete', data.onboarding.length, '')}
        <div class="ofb-section"><h4>Owned clients → reassign</h4>${clientsBody}</div>
        <div class="ofb-section"><h4>Owned deals → reassign</h4>${dealsBody}</div>
      </div>
      <div class="ofb-foot">
        <span class="ofb-status" data-ofb-status></span>
        <button class="ofb-btn" data-ofb-cancel>Cancel</button>
        <button class="ofb-btn danger" data-ofb-confirm ${(data.clients.length || data.deals.length) ? 'disabled' : ''}>Confirm Offboard</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const confirmBtn = backdrop.querySelector('[data-ofb-confirm]');
  const statusEl = backdrop.querySelector('[data-ofb-status]');
  const close = () => backdrop.remove();

  const validateReassignments = () => {
    const selects = backdrop.querySelectorAll('select[data-ofb-reassign]');
    const allFilled = Array.from(selects).every(s => s.value);
    confirmBtn.disabled = !allFilled;
  };
  backdrop.addEventListener('change', (e) => {
    if (e.target.matches('select[data-ofb-reassign]')) validateReassignments();
  });

  backdrop.querySelector('[data-ofb-cancel]').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    statusEl.textContent = 'Working…';

    try {
      // Build reassignment maps
      const clientReassign = {};
      const dealReassign = {};
      backdrop.querySelectorAll('select[data-ofb-reassign="client"]').forEach(s => { clientReassign[s.dataset.id] = s.value; });
      backdrop.querySelectorAll('select[data-ofb-reassign="deal"]').forEach(s => { dealReassign[s.dataset.id] = s.value; });

      const ops = [];
      if (data.tasks.length) {
        ops.push(state.supabase.from('daily_tasks').update({ status: 'archived' }).in('id', data.tasks.map(t => t.id)));
      }
      if (data.leave.length) {
        ops.push(state.supabase.from('leave_requests').update({ status: 'cancelled' }).in('id', data.leave.map(l => l.id)));
      }
      if (data.allocs.length) {
        ops.push(state.supabase.from('allocations').delete().in('id', data.allocs.map(a => a.id)));
      }
      if (data.standing.length) {
        ops.push(state.supabase.from('client_standing_allocations').delete().in('id', data.standing.map(a => a.id)));
      }
      if (data.onboarding.length) {
        ops.push(state.supabase.from('onboarding_checklists').delete().in('id', data.onboarding.map(o => o.id)));
      }
      for (const [cid, newOwner] of Object.entries(clientReassign)) {
        ops.push(state.supabase.from('clients').update({ account_owner_employee_id: newOwner }).eq('id', cid));
      }
      for (const [did, newOwner] of Object.entries(dealReassign)) {
        ops.push(state.supabase.from('deals').update({ poc_employee_id: newOwner }).eq('id', did));
      }

      const results = await Promise.all(ops);
      const failed = results.find(r => r && r.error);
      if (failed) throw failed.error;

      // Finally flip is_active
      const flip = await state.supabase.from('employees').update({ is_active: false }).eq('id', employeeId);
      if (flip.error) throw flip.error;

      statusEl.textContent = 'Done.';
      // Refresh app state
      await loadEmployeeDirectoryFromSupabase();
      try { await loadDailyTasksFromSupabase(); } catch (_) {}
      try { await loadWeeklyAllocationsFromSupabase(); } catch (_) {}
      try { await loadClientsFromSupabase(); } catch (_) {}
      try { await loadDealsFromSupabase(); } catch (_) {}
      close();
    } catch (err) {
      console.error('Offboard failed', err);
      statusEl.textContent = '';
      appAlert('Offboarding failed: ' + (err.message || err));
      confirmBtn.disabled = false;
    }
  });
}

if (peopleDirectoryBody) {
  peopleDirectoryBody.addEventListener('click', (event) => {
    const actionBtn = event.target.closest('button[data-directory-action]');
    if (!actionBtn) return;

    const action = actionBtn.dataset.directoryAction;
    const employeeId = actionBtn.dataset.employeeId || '';
    const employeeName = actionBtn.dataset.employee || '';

    if (action === 'edit') {
      if (!employeeName || !isLeadershipRole()) return;
      setSelectedEmployee(employeeName);
      activateScreen('employee-profile');
      return;
    }

    if (action === 'offboard') {
      openOffboardEmployeeFlow(employeeId, employeeName).catch((error) => {
        console.error(error);
        appAlert(`Unable to start offboarding: ${error.message}`);
      });
      return;
    }

    if (action === 'deactivate') {
      deactivateDirectoryEmployee(employeeId, employeeName).catch((error) => {
        console.error(error);
        appAlert(`Unable to deactivate employee: ${error.message}`);
      });
    }
  });
}

if (toggleOrgChartBtn) {
  toggleOrgChartBtn.addEventListener('click', () => {
    if (!orgChartPanel) return;
    const willShow = orgChartPanel.classList.contains('hidden');
    orgChartPanel.classList.toggle('hidden', !willShow);
    toggleOrgChartBtn.textContent = willShow ? 'Hide Org Chart' : 'Org Chart';
    if (willShow) {
      renderOrgChart();
    }
  });
}

if (directorySearch) {
  directorySearch.addEventListener('input', () => {
    filterDirectoryBySearch(directorySearch.value);
  });
}

function filterDirectoryBySearch(query) {
  if (!peopleDirectoryBody) return;
  const term = String(query || '').toLowerCase().trim();
  const rows = peopleDirectoryBody.querySelectorAll('tr');
  rows.forEach((row) => {
    if (!term) {
      row.style.display = '';
      return;
    }
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(term) ? '' : 'none';
  });
}

function displayNameFromEmail(email) {
  const base = String(email || '').split('@')[0] || 'Employee';
  return base
    .split(/[._-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function setFullAccessNotice(message = '', className = 'mini-meta') {
  if (!fullAccessNotice) return;
  fullAccessNotice.className = className;
  fullAccessNotice.textContent = message;
}

function fullAccessRoleOptionsMarkup(selectedRole) {
  const role = normalizeAccessLevel(selectedRole);
  return `
    <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
    <option value="leadership" ${role === 'leadership' ? 'selected' : ''}>Leadership</option>
    <option value="employee" ${role === 'employee' ? 'selected' : ''}>Employee</option>
  `;
}

// ── Public Holidays admin (Admin Settings) ──
const holidaysAdminTableBody = document.getElementById('holidaysAdminTableBody');

function setHolidaysNotice(msg = '', cls = 'mini-meta') {
  const el = document.getElementById('holidaysAdminNotice');
  if (!el) return;
  el.className = cls;
  el.textContent = msg;
}

function renderHolidaysAdmin() {
  if (!holidaysAdminTableBody) return;
  const list = getPublicHolidays();
  const canEdit = isLeadershipRole();
  if (!list.length) {
    holidaysAdminTableBody.innerHTML = '<tr><td colspan="3">No holidays configured.</td></tr>';
    return;
  }
  const todayStr = toISODateLocal(new Date());
  holidaysAdminTableBody.innerHTML = list.map(h => {
    const past = h.date < todayStr;
    const label = formatDateForLabel(parseIsoDateLocal(h.date) || h.date);
    return `<tr${past ? ' class="mini-meta"' : ''}>
      <td data-label="Date">${escapeHtml(label)}</td>
      <td data-label="Holiday">${escapeHtml(h.name)}</td>
      <td data-label="Action">${canEdit ? `<button class="ghost small danger-text" data-remove-holiday="${escapeHtml(h.date)}" type="button">Remove</button>` : ''}</td>
    </tr>`;
  }).join('');
  // Hide the add form for non-editors
  const addBtn = document.getElementById('addHolidayBtn');
  if (addBtn) addBtn.closest('.editor-bar')?.classList.toggle('hidden', !canEdit);
}

async function addHoliday() {
  if (!state.supabase || !isLeadershipRole()) return;
  const dateEl = document.getElementById('newHolidayDate');
  const nameEl = document.getElementById('newHolidayName');
  const date = (dateEl?.value || '').trim();
  const name = (nameEl?.value || '').trim();
  if (!date || !name) { setHolidaysNotice('Pick a date and enter a name.', 'mini-meta warn'); return; }
  setHolidaysNotice('Saving…');
  const { error } = await state.supabase
    .from('public_holidays')
    .upsert({ holiday_date: date, name }, { onConflict: 'holiday_date' })
    .select();
  if (error) { setHolidaysNotice('Could not add: ' + error.message, 'mini-meta warn'); return; }
  if (dateEl) dateEl.value = '';
  if (nameEl) nameEl.value = '';
  await loadPublicHolidaysFromSupabase();
  renderHolidaysAdmin();
  setHolidaysNotice(`✓ Added ${name}.`);
}

async function removeHoliday(dateStr) {
  if (!state.supabase || !isLeadershipRole() || !dateStr) return;
  const target = getPublicHolidays().find(h => h.date === dateStr);
  if (!await appConfirm(`Remove "${target?.name || dateStr}" from the holiday list?`, { title: 'Remove holiday', confirmLabel: 'Remove', danger: true })) return;
  setHolidaysNotice('Removing…');
  // .select() to surface silent RLS failures (CLAUDE.md pattern)
  const { data, error } = await state.supabase
    .from('public_holidays')
    .delete()
    .eq('holiday_date', dateStr)
    .select();
  if (error) { setHolidaysNotice('Could not remove: ' + error.message, 'mini-meta warn'); return; }
  if (!data || !data.length) { setHolidaysNotice('Nothing removed (permission?).', 'mini-meta warn'); return; }
  await loadPublicHolidaysFromSupabase();
  renderHolidaysAdmin();
  setHolidaysNotice(`✓ Removed.`);
}

if (document.getElementById('addHolidayBtn')) {
  document.getElementById('addHolidayBtn').addEventListener('click', () => addHoliday().catch(console.error));
}
if (holidaysAdminTableBody) {
  holidaysAdminTableBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-holiday]');
    if (btn) removeHoliday(btn.dataset.removeHoliday).catch(console.error);
  });
}

// ── Partners admin (app.partners, invite-only external users) ──

let partnersAdminRows = [];

function setPartnersNotice(message = '', className = 'mini-meta') {
  const el = document.getElementById('partnersAdminNotice');
  if (!el) return;
  el.textContent = message;
  el.className = className;
}

async function loadPartnersAdmin() {
  const body = document.getElementById('partnersAdminTableBody');
  if (!body || !state.supabase) return;
  const { data, error } = await state.supabase
    .from('partners')
    .select('id, email, full_name, org, partner_role, is_active, auth_user_id, created_at')
    .order('created_at', { ascending: true });
  if (error) {
    body.innerHTML = `<tr><td colspan="6">Could not load partners: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  partnersAdminRows = data || [];
  renderPartnersAdmin();
}

function renderPartnersAdmin() {
  const body = document.getElementById('partnersAdminTableBody');
  if (!body) return;
  const canEdit = isBriefReviewer();
  if (!partnersAdminRows.length) {
    body.innerHTML = '<tr><td colspan="6">No partners yet. Add one below to enable their sign-in.</td></tr>';
  } else {
    body.innerHTML = partnersAdminRows.map(p => `<tr${p.is_active ? '' : ' class="mini-meta"'}>
      <td data-label="Name">${escapeHtml(p.full_name)}</td>
      <td data-label="Email">${escapeHtml(p.email)}</td>
      <td data-label="Org">${escapeHtml(p.org)}</td>
      <td data-label="Role">${canEdit
        ? `<select class="partner-role-select" data-partner-role="${escapeHtml(p.id)}" ${p.is_active ? '' : 'disabled'} aria-label="Role for ${escapeHtml(p.full_name)}">
             ${PARTNER_ROLE_OPTIONS.map(([value, label]) =>
               `<option value="${value}"${p.partner_role === value ? ' selected' : ''}>${label}</option>`).join('')}
           </select>`
        : escapeHtml(p.partner_role)}</td>
      <td data-label="Status">${p.is_active ? (p.auth_user_id ? 'Active' : 'Invited') : 'Deactivated'}</td>
      <td data-label="Action">${canEdit ? `<button class="ghost small ${p.is_active ? 'danger-text' : ''}" data-toggle-partner="${escapeHtml(p.id)}" type="button">${p.is_active ? 'Deactivate' : 'Reactivate'}</button>` : ''}</td>
    </tr>`).join('');
  }
  const addBtn = document.getElementById('addPartnerBtn');
  if (addBtn) addBtn.closest('.editor-bar')?.classList.toggle('hidden', !canEdit);
}

// The one list of partner roles, shared by the add bar and the row editor, so
// a new role cannot appear in one and not the other.
const PARTNER_ROLE_OPTIONS = [
  ['submitter', 'Submitter'],
  ['coordinator', 'Coordinator'],
  ['client_viewer', 'Client viewer']
];

// Changing a role in place — Alex, 10 Sep 2026. The database already allowed
// any brief reviewer to update a partner, so this was only ever a missing
// control: the role rendered as plain text and the row's only action was
// deactivate. Rhea had to get a partner's role right at the moment she
// invited them, or ask us.
async function changePartnerRole(partnerId, nextRole) {
  if (!state.supabase || !isBriefReviewer()) return;
  const row = partnersAdminRows.find((p) => String(p.id) === String(partnerId));
  if (!row || row.partner_role === nextRole) return;

  // Coordinator is not a bigger version of submitter: it approves briefs on
  // the client's behalf — the the client gate — and can edit anyone's brief in the org.
  // Worth a beat before granting it by dropdown.
  if (nextRole === 'coordinator') {
    const ok = await appConfirm(
      `Make ${row.full_name} a coordinator?\n\nCoordinators approve their org's briefs before they reach Your Agency, and can edit any brief in the org.`,
      { title: 'Change partner role', confirmLabel: 'Make coordinator' }
    );
    if (!ok) { renderPartnersAdmin(); return; }   // put the dropdown back
  }

  setPartnersNotice('Saving…');
  const { error } = await state.supabase.from('partners')
    .update({ partner_role: nextRole }).eq('id', partnerId);
  if (error) {
    setPartnersNotice(`Could not change the role: ${error.message}`, 'status error');
    renderPartnersAdmin();   // never leave the dropdown showing a value that did not save
    return;
  }
  row.partner_role = nextRole;
  setPartnersNotice(`${row.full_name} is now a ${PARTNER_ROLE_OPTIONS.find(([v]) => v === nextRole)?.[1].toLowerCase() || nextRole}.`);
  renderPartnersAdmin();
}

async function addPartner() {
  if (!state.supabase || !isBriefReviewer()) return;
  const nameEl = document.getElementById('newPartnerName');
  const emailEl = document.getElementById('newPartnerEmail');
  const orgEl = document.getElementById('newPartnerOrg');
  const roleEl = document.getElementById('newPartnerRole');
  const full_name = (nameEl?.value || '').trim();
  const email = normalizeEmail(emailEl?.value || '');
  const org = (orgEl?.value || '').trim() || 'Example Collective';
  const partner_role = roleEl?.value || 'submitter';
  if (!full_name || !email || !email.includes('@')) {
    setPartnersNotice('Enter a name and a valid email.', 'mini-meta warn');
    return;
  }
  if (email.endsWith(ANT_DOMAIN)) {
    setPartnersNotice('Your Agency people are employees, not partners.', 'mini-meta warn');
    return;
  }
  setPartnersNotice('Saving…');
  const { data, error } = await state.supabase
    .from('partners')
    .insert({ email, full_name, org, partner_role, created_by: state.currentEmployeeId })
    .select();
  if (error) { setPartnersNotice('Could not add: ' + error.message, 'mini-meta warn'); return; }
  if (!data || !data.length) { setPartnersNotice('Nothing saved (permission?).', 'mini-meta warn'); return; }
  if (nameEl) nameEl.value = '';
  if (emailEl) emailEl.value = '';
  setPartnersNotice(`✓ Added ${full_name}. They can now sign in via "Partner sign in with Google".`);
  await loadPartnersAdmin();
}

async function togglePartnerActive(partnerId) {
  if (!state.supabase || !isBriefReviewer() || !partnerId) return;
  const target = partnersAdminRows.find(p => p.id === partnerId);
  if (!target) return;
  const deactivating = target.is_active;
  if (deactivating && !await appConfirm(`Deactivate ${target.full_name}? Their sign-in stops working immediately.`, { title: 'Deactivate partner', confirmLabel: 'Deactivate', danger: true })) return;
  setPartnersNotice(deactivating ? 'Deactivating…' : 'Reactivating…');
  // .select() to surface silent RLS failures (CLAUDE.md pattern)
  const { data, error } = await state.supabase
    .from('partners')
    .update({ is_active: !deactivating, updated_at: new Date().toISOString() })
    .eq('id', partnerId)
    .select();
  if (error) { setPartnersNotice('Could not update: ' + error.message, 'mini-meta warn'); return; }
  if (!data || !data.length) { setPartnersNotice('Nothing updated (permission?).', 'mini-meta warn'); return; }
  setPartnersNotice('✓ Updated.');
  await loadPartnersAdmin();
}

if (document.getElementById('addPartnerBtn')) {
  document.getElementById('addPartnerBtn').addEventListener('click', () => addPartner().catch(console.error));
  // Built from the same list as the row editor, so the two can never drift.
  const newRoleSel = document.getElementById('newPartnerRole');
  if (newRoleSel) {
    const keep = newRoleSel.value;
    newRoleSel.innerHTML = PARTNER_ROLE_OPTIONS
      .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    if (keep) newRoleSel.value = keep;
  }
}
if (document.getElementById('partnersAdminTableBody')) {
  document.getElementById('partnersAdminTableBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle-partner]');
    if (btn) togglePartnerActive(btn.dataset.togglePartner).catch(console.error);
  });
  // A <select> fires change, not click — the click listener above never sees it.
  document.getElementById('partnersAdminTableBody').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-partner-role]');
    if (sel) changePartnerRole(sel.dataset.partnerRole, sel.value).catch(console.error);
  });
}

// ── Operational config admin (app.app_config, superadmin-only) ──
// Generic editor for the six DB-backed lists/maps. Each `get` reads the
// EFFECTIVE value (DB override or the in-code fallback), so editing a key that
// has no override yet promotes the current default into the DB plus the change.
// Clearing a key's last entry leaves it empty in the DB and the accessor falls
// back to the built-in default (a wipe can't silently empty a visibility list).
const APP_CONFIG_FIELDS = [
  // `implicit` names people who ALWAYS have the access regardless of the list,
  // so each panel shows effective access rather than just the extras — the
  // Deal Flow incident started with a panel that looked like the whole story.
  // NOTE: there is deliberately NO invoice_viewer_emails entry. Invoice viewers
  // are HARDCODED (INVOICE_VIEWER_EMAILS + app.is_invoice_viewer in the DB) per
  // Alex, 23 Jul 2026 — compensation data must not be openable by a panel edit
  // or config mistake. Changing viewers is a code change in both places.
  { key: 'invoice_excluded_emails', kind: 'list', get: getInvoiceExcludedEmails, label: 'Invoice-excluded',
    help: 'Hidden from the invoice checklist and their own invoice upload panel.' },
  { key: 'hidden_employee_emails',  kind: 'list', get: getHiddenEmployeeEmails,  label: 'Hidden employees',
    help: 'Keep their access but hide them from directory, team and exec views.' },
  { key: 'deal_flow_extra_emails',  kind: 'list', get: getDealFlowExtraEmails,   label: 'Deal-flow viewers',
    implicit: () => (state.employeeDirectory || [])
      .filter(e => e.is_active !== false && ['leadership', 'admin'].includes(normalizeAccessLevel(e.access_level)))
      .map(e => normalizeEmail(e.email)),
    help: 'Extra people who can see the Deal Flow board and pipeline data (screen + database reads and writes).' },
  { key: 'setup_approver_emails',   kind: 'list', get: getSetupApproverEmails,   label: 'Setup approvers',
    implicit: () => [SUPERADMIN_EMAIL],
    help: 'Who confirms a new joiner\'s team, type, capacity and clients in Awaiting Setup. Deliberately not leadership-wide — activating someone grants client access.' },
  { key: 'brief_reviewer_emails',   kind: 'list', get: getBriefReviewerEmails,   label: 'Brief reviewers',
    implicit: () => (state.employeeDirectory || [])
      .filter(e => e.is_active !== false && ['leadership', 'admin'].includes(normalizeAccessLevel(e.access_level)))
      .map(e => normalizeEmail(e.email)),
    help: 'Who reviews, locks and assigns the client briefs (and gets brief notification emails). Leadership always qualifies.' },
  { key: 'team_manager_by_team',    kind: 'map',  get: getTeamManagerMap,        label: 'Team approver',
    keyLabel: 'Team', valLabel: 'Approver email', keyOptions: ['AM', 'Art', 'Copy', 'Video', 'Strategy'],
    help: 'Department → leave/allocation approver when an employee has no explicit manager.' },
  { key: 'direct_manager_by_email', kind: 'map',  get: getDirectManagerMap,      label: 'Direct manager',
    keyLabel: 'Employee email', valLabel: 'Manager email',
    help: 'Explicit employee → manager overrides (take precedence over the team map).' },
  // NOTE: analytics_personas_by_client (Audience Intelligence target personas)
  // is deliberately NOT in this panel anymore — raw nested JSON in Admin
  // Settings confused more than it helped (29 Jul 2026). The DB value
  // still drives the feature via getConfigMap('analytics_personas_by_client',
  // ANALYTICS_PERSONAS_BY_CLIENT); changing a persona is a scripts/sql.sh job.
];

const appConfigEditors = document.getElementById('appConfigEditors');

function setAppConfigNotice(msg = '', cls = 'mini-meta') {
  const el = document.getElementById('appConfigNotice');
  if (!el) return;
  el.className = cls;
  el.textContent = msg;
}

function renderAppConfigAdmin() {
  if (!appConfigEditors) return;
  if (!isSuperadminUser()) { appConfigEditors.innerHTML = '<p class="mini-meta">Superadmin only.</p>'; return; }
  appConfigEditors.innerHTML = APP_CONFIG_FIELDS.map(field => {
    const stored = state.appConfig && state.appConfig[field.key];
    // "customised" means a value is STORED, not that it's non-empty — an
    // explicitly emptied list is very much a customisation, and labelling it
    // "built-in default" would contradict the empty table right below it.
    const isCustom = field.kind === 'list'
      ? Array.isArray(stored)
      : Boolean(stored && typeof stored === 'object');
    const badge = isCustom
      ? '<span class="mini-meta" style="color:var(--accent, #e8590c)">customised</span>'
      : '<span class="mini-meta">built-in default</span>';
    const head = `<div class="config-block-head"><h4>${escapeHtml(field.label)}</h4> ${badge}</div>
      <p class="mini-meta">${escapeHtml(field.help)}</p>`;

    if (field.kind === 'json') {
      const pretty = JSON.stringify(field.get(), null, 2);
      return `<div class="config-block">${head}
        <textarea data-cfg-json-input="${escapeHtml(field.key)}" rows="12" spellcheck="false" style="width:100%;font-family:var(--mono, monospace);font-size:12px">${escapeHtml(pretty)}</textarea>
        <div class="editor-bar action-row">
          <button class="primary" type="button" data-cfg-save-json="${escapeHtml(field.key)}">Save JSON</button>
        </div></div>`;
    }

    if (field.kind === 'list') {
      const emails = field.get();
      // People with the access regardless of this list (leadership for Deal
      // Flow, the superadmin for setup approvals) render as fixed rows, so the
      // panel shows who ACTUALLY has access, not just the removable extras.
      const implicitEmails = (typeof field.implicit === 'function' ? field.implicit() : [])
        .filter(e => !emails.includes(e));
      const implicitRows = implicitEmails.map(e => `<tr>
          <td data-label="Email">${escapeHtml(e)}</td>
          <td data-label="Action"><span class="mini-meta">${field.key === 'setup_approver_emails' ? 'superadmin' : 'leadership'} — always included</span></td>
        </tr>`).join('');
      const rows = implicitRows + (emails.length
        ? emails.map(e => `<tr>
            <td data-label="Email">${escapeHtml(e)}</td>
            <td data-label="Action"><button class="ghost small danger-text" type="button" data-cfg-remove-list="${escapeHtml(field.key)}" data-val="${escapeHtml(e)}">Remove</button></td>
          </tr>`).join('')
        : `<tr><td colspan="2" class="mini-meta">${implicitEmails.length ? 'Nobody extra listed.' : 'Empty — nobody listed.'}</td></tr>`);
      return `<div class="config-block">${head}
        <table class="m-card-table"><tbody>${rows}</tbody></table>
        <div class="editor-bar action-row">
          <input type="email" data-cfg-add-input="${escapeHtml(field.key)}" placeholder="name@youragency.com" aria-label="${escapeHtml(field.label)} email">
          <button class="primary" type="button" data-cfg-add-list="${escapeHtml(field.key)}">Add</button>
        </div></div>`;
    }

    const map = field.get();
    const keys = Object.keys(map).sort();
    const rows = keys.length
      ? keys.map(k => `<tr>
          <td data-label="${escapeHtml(field.keyLabel)}">${escapeHtml(k)}</td>
          <td data-label="${escapeHtml(field.valLabel)}">${escapeHtml(map[k])}</td>
          <td data-label="Action"><button class="ghost small danger-text" type="button" data-cfg-remove-map="${escapeHtml(field.key)}" data-mapkey="${escapeHtml(k)}">Remove</button></td>
        </tr>`).join('')
      : '<tr><td colspan="3" class="mini-meta">Empty — no mappings.</td></tr>';
    const keyControl = field.keyOptions
      ? `<select data-cfg-mapkey-input="${escapeHtml(field.key)}" aria-label="${escapeHtml(field.keyLabel)}">${field.keyOptions.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}</select>`
      : `<input type="email" data-cfg-mapkey-input="${escapeHtml(field.key)}" placeholder="${escapeHtml(field.keyLabel)}" aria-label="${escapeHtml(field.keyLabel)}">`;
    return `<div class="config-block">${head}
      <table class="m-card-table">
        <thead><tr><th>${escapeHtml(field.keyLabel)}</th><th>${escapeHtml(field.valLabel)}</th><th>Action</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="editor-bar action-row">
        ${keyControl}
        <input type="email" data-cfg-mapval-input="${escapeHtml(field.key)}" placeholder="${escapeHtml(field.valLabel)}" aria-label="${escapeHtml(field.valLabel)}">
        <button class="primary" type="button" data-cfg-add-map="${escapeHtml(field.key)}">Set</button>
      </div></div>`;
  }).join('');
}

async function saveAppConfigKey(key, value) {
  if (!state.supabase || !isSuperadminUser()) { setAppConfigNotice('Superadmin only.', 'mini-meta warn'); return false; }
  setAppConfigNotice('Saving…');
  const { error } = await state.supabase
    .from('app_config')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select();
  if (error) { setAppConfigNotice('Could not save: ' + error.message, 'mini-meta warn'); return false; }
  await loadAppConfig();
  renderAppConfigAdmin();
  return true;
}

function cfgFieldByKey(key) { return APP_CONFIG_FIELDS.find(f => f.key === key); }

async function addConfigListEntry(key) {
  const field = cfgFieldByKey(key); if (!field) return;
  const input = appConfigEditors.querySelector(`[data-cfg-add-input="${key}"]`);
  const email = normalizeEmail(input?.value || '');
  if (!email) { setAppConfigNotice('Enter an email.', 'mini-meta warn'); return; }
  if (!email.endsWith(ANT_DOMAIN)) { setAppConfigNotice('Must be a @youragency.com email.', 'mini-meta warn'); return; }
  const current = field.get().map(normalizeEmail);
  if (current.includes(email)) { setAppConfigNotice(`${email} is already listed.`, 'mini-meta warn'); return; }
  if (await saveAppConfigKey(key, current.concat(email))) setAppConfigNotice(`✓ Added ${email} to ${field.label}.`);
}

async function removeConfigListEntry(key, email) {
  const field = cfgFieldByKey(key); if (!field) return;
  if (!await appConfirm(`Remove ${email} from ${field.label}?`, { title: 'Remove entry', confirmLabel: 'Remove', danger: true })) return;
  const next = field.get().map(normalizeEmail).filter(e => e !== normalizeEmail(email));
  if (await saveAppConfigKey(key, next)) {
    setAppConfigNotice(next.length ? `✓ Removed ${email}.` : `✓ Removed ${email}. List is now empty.`);
  }
}

async function setConfigMapEntry(key) {
  const field = cfgFieldByKey(key); if (!field) return;
  const keyInput = appConfigEditors.querySelector(`[data-cfg-mapkey-input="${key}"]`);
  const valInput = appConfigEditors.querySelector(`[data-cfg-mapval-input="${key}"]`);
  const rawKey = (keyInput?.value || '').trim();
  const val = normalizeEmail(valInput?.value || '');
  // Employee-email key is normalised; team key keeps its label casing.
  const mapKey = field.keyOptions ? rawKey : normalizeEmail(rawKey);
  if (!mapKey) { setAppConfigNotice(`Enter a ${field.keyLabel.toLowerCase()}.`, 'mini-meta warn'); return; }
  if (!field.keyOptions && !mapKey.endsWith(ANT_DOMAIN)) { setAppConfigNotice(`${field.keyLabel} must be a @youragency.com email.`, 'mini-meta warn'); return; }
  if (!val) { setAppConfigNotice(`Enter a ${field.valLabel.toLowerCase()}.`, 'mini-meta warn'); return; }
  if (!val.endsWith(ANT_DOMAIN)) { setAppConfigNotice(`${field.valLabel} must be a @youragency.com email.`, 'mini-meta warn'); return; }
  const next = Object.assign({}, field.get(), { [mapKey]: val });
  if (await saveAppConfigKey(key, next)) {
    if (valInput) valInput.value = '';
    setAppConfigNotice(`✓ ${field.label}: ${mapKey} → ${val}.`);
  }
}

async function removeConfigMapEntry(key, mapKey) {
  const field = cfgFieldByKey(key); if (!field) return;
  if (!await appConfirm(`Remove the ${field.label} mapping for ${mapKey}?`, { title: 'Remove mapping', confirmLabel: 'Remove', danger: true })) return;
  const next = Object.assign({}, field.get());
  delete next[mapKey];
  if (await saveAppConfigKey(key, next)) setAppConfigNotice(`✓ Removed mapping for ${mapKey}.`);
}

if (appConfigEditors) {
  appConfigEditors.addEventListener('click', (e) => {
    const addList = e.target.closest('[data-cfg-add-list]');
    if (addList) { addConfigListEntry(addList.dataset.cfgAddList).catch(console.error); return; }
    const rmList = e.target.closest('[data-cfg-remove-list]');
    if (rmList) { removeConfigListEntry(rmList.dataset.cfgRemoveList, rmList.dataset.val).catch(console.error); return; }
    const addMap = e.target.closest('[data-cfg-add-map]');
    if (addMap) { setConfigMapEntry(addMap.dataset.cfgAddMap).catch(console.error); return; }
    const rmMap = e.target.closest('[data-cfg-remove-map]');
    if (rmMap) { removeConfigMapEntry(rmMap.dataset.cfgRemoveMap, rmMap.dataset.mapkey).catch(console.error); return; }
    const saveJson = e.target.closest('[data-cfg-save-json]');
    if (saveJson) {
      const key = saveJson.dataset.cfgSaveJson;
      const ta = appConfigEditors.querySelector(`[data-cfg-json-input="${key}"]`);
      let parsed;
      try { parsed = JSON.parse(ta?.value || ''); } catch (err) {
        setAppConfigNotice(`Invalid JSON: ${err.message}`, 'mini-meta warn');
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setAppConfigNotice('Expected a JSON object (client name → persona).', 'mini-meta warn');
        return;
      }
      saveAppConfigKey(key, parsed).then(ok => { if (ok) setAppConfigNotice('Saved.'); }).catch(console.error);
      return;
    }
  });
}

// ── Scheduled jobs health (Admin Settings) ──
// Reads cron_heartbeat rows (written by withCronHeartbeat in every scheduled
// function) so a dead scheduler is visible here within a day — the Apr–Jun
// 2026 outage went unnoticed for two months because nothing surfaced it.
const CRON_JOBS = [
  { fn: 'daily-reminders',           label: 'Daily reminders (digest + birthdays)',   cadence: 'daily',   schedule: '10:00 IST daily' },
  { fn: 'task-nudge',                label: 'Task nudge (untouched tasklists)',       cadence: 'daily',   schedule: '11:00 local weekdays' },
  { fn: 'invoice-reminder',          label: 'Invoice upload reminders',               cadence: 'monthly', schedule: '10:00 IST, 25th → month-end' },
  { fn: 'analytics-upload-reminder', label: 'Analytics upload reminder',              cadence: 'weekly',  schedule: '10:00 IST Tuesdays' },
  { fn: 'policy-update-reminder',    label: 'Policy review reminder',                 cadence: 'weekly',  schedule: '10:00 IST Mondays' }
];

async function loadCronHealth() {
  if (!state.supabase || !isLeadershipRole()) return null;
  const { data, error } = await state.supabase
    .from('notification_log')
    .select('subject, payload, status, created_at')
    .eq('kind', 'cron_heartbeat')
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) { console.warn('Cron health load failed:', error.message); return null; }
  const latestByFn = new Map();
  (data || []).forEach(row => {
    const fn = row.payload?.function;
    if (fn && !latestByFn.has(fn)) latestByFn.set(fn, row);
  });
  return latestByFn;
}

function renderCronHealthAdmin(latestByFn) {
  const body = document.getElementById('cronHealthTableBody');
  if (!body) return;
  const CHIP = {
    ok:      '<span class="feed-bullet-tag shipped">ok</span>',
    late:    '<span class="feed-bullet-tag new">late</span>',
    dead:    '<span class="feed-bullet-tag new">DEAD</span>',
    error:   '<span class="feed-bullet-tag new">errors</span>',
    unknown: '<span class="mini-meta">no heartbeat yet</span>'
  };
  body.innerHTML = CRON_JOBS.map(job => {
    const row = latestByFn ? latestByFn.get(job.fn) : null;
    let health = cronHealthStatus(row?.created_at || null, job.cadence);
    if (health === 'ok' && row?.status === 'error') health = 'error';
    const lastRun = row ? formatTimestamp(new Date(row.created_at)) : 'never (heartbeats began 10 Jun 2026)';
    const note = row && row.status === 'error' ? escapeHtml(row.subject) : escapeHtml(job.schedule);
    return `<tr>
      <td data-label="Job">${escapeHtml(job.label)}</td>
      <td data-label="Last run">${escapeHtml(lastRun)}</td>
      <td data-label="Status">${CHIP[health] || CHIP.unknown}</td>
      <td data-label="Schedule" class="mini-meta">${note}</td>
    </tr>`;
  }).join('');
}

// ── Awaiting Setup (Admin Settings, setup approvers only) ──
// New joiners who finished onboarding and need confirming. This is the
// persistent half of the notification: the email is a ping that can be missed
// on a busy day, but a project-based person is locked out of every client until
// someone acts, so the outstanding work has to stay visible until it's done.
async function loadPendingSetups() {
  if (!state.supabase || !isSetupApprover()) return [];
  const { data, error } = await state.supabase
    .from('employees')
    .select('id, full_name, email, employment_type, created_at, timezone, current_city, direct_manager_email, requested_department:departments!employees_requested_department_id_fkey(id, name), department:departments!employees_department_id_fkey(id, name)')
    .eq('is_active', true).eq('setup_pending', true)
    .order('created_at', { ascending: true });
  if (error) { console.warn('Pending setups load failed:', error.message); return []; }
  // What is already scheduled, so the panel can say so rather than offering to
  // schedule the same person twice.
  const sched = await state.supabase.from('scheduled_activations')
    .select('employee_id, activate_on').is('applied_at', null);
  state.scheduledActivations = sched.error ? [] : (sched.data || []);
  return data || [];
}

async function renderPendingSetupAdmin() {
  const panel = document.getElementById('pendingSetupPanel');
  const list = document.getElementById('pendingSetupList');
  if (!panel || !list) return;
  if (!isSetupApprover()) { panel.style.display = 'none'; return; }

  const rows = await loadPendingSetups();
  // Keep the panel in place even when empty: hiding it after an approval made
  // the page reflow and dumped the approver onto whatever panel came next
  // (the Operational Config JSON editor — very confusing).
  panel.style.display = '';
  if (!rows.length) {
    list.innerHTML = '<p class="mini-meta">No one waiting — all new joiners are set up. ✓</p>';
    return;
  }

  // Active, real clients only. Archived ones are out (you can't be "dedicated
  // to" an archived client — 7 of the 26 rows), as are the internal buckets in
  // NON_CLIENT_BUCKETS, which are allocation targets rather than clients.
  const clients = (state.clients || [])
    .filter((c) => c.is_active !== false
      && !NON_CLIENT_BUCKETS.includes(String(c.name || '').trim().toLowerCase()))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  list.innerHTML = rows.map((emp) => {
    const requested = emp.requested_department?.name || '';
    const scheduledFor = (state.scheduledActivations || []).find((a) => a.employee_id === emp.id) || null;
    // EVERY department, not ONBOARDING_DEPARTMENTS. That list exists to stop a
    // new joiner declaring themselves Leadership or Finance — it is about what
    // someone may claim, not about what an approver may assign. Reusing it here
    // meant Maya, who is Strategy, could not be put in Strategy at all
    // (9 Sep 2026). Falls back to the onboarding list only if the
    // departments have not loaded, so the select is never empty.
    const assignableTeams = (state.departmentOptions || []).length
      ? state.departmentOptions.map((d) => d.name)
      : ONBOARDING_DEPARTMENTS;
    const teamOptions = assignableTeams.map((name) =>
      `<option value="${escapeHtml(name)}"${name === requested ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('');
    const isProject = employmentIsScoped(emp.employment_type);
    // Layout lives in .setup-client-grid (styles.css), not inline: the fix
    // needed an attribute selector for the checkbox width, which inline styles
    // can't express cleanly. See that rule for why width:auto is load-bearing.
    const clientChecks = clients.map((c) =>
      `<label class="mini-meta">
         <input type="checkbox" class="setup-client" value="${escapeHtml(c.id)}" />
         <span>${escapeHtml(c.name)}</span>
       </label>`).join('');
    return `
      <div class="pending-setup-row" data-employee="${escapeHtml(emp.id)}" style="border-top:1px solid var(--line);padding:12px 0;">
        <div><strong>${escapeHtml(displayPersonName(emp.full_name, 'New joiner'))}</strong>
          <span class="mini-meta"> · ${escapeHtml(emp.email || '')}${emp.current_city ? ` · 📍 ${escapeHtml(emp.current_city)}` : ''}</span></div>
        <p class="mini-meta">Asked for <strong>${escapeHtml(requested || 'no team')}</strong> · says <strong>${escapeHtml(employmentTypeLabel(emp.employment_type).toLowerCase())}</strong>${isProject ? ' · <span class="status warn">no client access until activated</span>' : ''}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:6px 0;">
          <label class="mini-meta">Team<br/><select class="setup-team">${teamOptions}</select></label>
          <label class="mini-meta">Type<br/><select class="setup-type">${EMPLOYMENT_TYPES.map((t) =>
            `<option value="${t}"${emp.employment_type === t ? ' selected' : ''}>${escapeHtml(employmentTypeLabel(t))}</option>`).join('')}
          </select></label>
          <label class="mini-meta">Capacity %<br/><input class="setup-capacity" value="${isProject ? '50' : '100'}" style="width:70px;" /></label>
          <button class="btn-primary setup-activate" type="button">Activate</button>
          <label class="mini-meta">or activate on<br/>
            <input type="date" class="setup-activate-on" min="${escapeHtml(shiftIsoDays(istToday(), 1))}" />
          </label>
          <button class="ghost small setup-schedule" type="button">Schedule</button>
        </div>
        <details class="setup-clients"${isProject ? ' open' : ''}${isProject ? '' : ' hidden'}>
          <summary class="mini-meta">Clients they work on (at least one required)</summary>
          <div class="setup-client-grid">${clientChecks}</div>
        </details>
        ${scheduledFor ? `<p class="mini-meta hire-next-step">Scheduled to activate on ${escapeHtml(briefDateLabel(scheduledFor.activate_on))} — <button class="ghost small setup-cancel-schedule" type="button">cancel</button></p>` : ''}
        <p class="mini-meta setup-notice" style="display:none;"></p>
      </div>`;
  }).join('');
}

// Only a fractional person is scoped to named clients — for anyone else the
// picker is a control that does nothing at all, since app.is_client_scoped()
// stopped honouring scope rows for non-fractional employees on 1 Sep. It was
// still being shown to full-time joiners, offering an approver a choice that
// would be silently discarded (7 Sep 2026, activating Dev).
function syncSetupClientPicker(row) {
  if (!row) return;
  const scoped = employmentIsScoped(row.querySelector('.setup-type')?.value);
  const details = row.querySelector('.setup-clients');
  if (details) {
    details.hidden = !scoped;
    if (scoped) details.open = true;
    // Ticks made before the type was corrected must not survive as inert rows.
    else row.querySelectorAll('.setup-client:checked').forEach((cb) => { cb.checked = false; });
  }
  const capacity = row.querySelector('.setup-capacity');
  if (capacity) capacity.value = scoped ? '50' : '100';
}

document.getElementById('pendingSetupList')?.addEventListener('change', (event) => {
  if (event.target.matches('.setup-type')) syncSetupClientPicker(event.target.closest('.pending-setup-row'));
});

// Schedule instead of activating: the approver decides now, Colony applies it
// on the day. The payload is validated server-side at scheduling time too, so a
// bad one is refused while someone is looking at it rather than failing in a
// cron on the joiner's start date.
document.getElementById('pendingSetupList')?.addEventListener('click', async (event) => {
  const sched = event.target.closest('.setup-schedule');
  if (sched) {
    const row = sched.closest('.pending-setup-row');
    const notice = row.querySelector('.setup-notice');
    const say = (msg, cls = 'mini-meta') => { notice.className = `${cls} setup-notice`; notice.style.display = ''; notice.textContent = msg; };
    const on = row.querySelector('.setup-activate-on')?.value;
    if (!on) return say('Pick a date first.', 'status error');
    const team = row.querySelector('.setup-team')?.value;
    const type = row.querySelector('.setup-type')?.value;
    const capacity = parseCapacityPercentInput(row.querySelector('.setup-capacity')?.value);
    const clientIds = employmentIsScoped(type)
      ? [...row.querySelectorAll('.setup-client:checked')].map((i) => i.value) : [];
    const dept = departmentByExactName(team);
    if (!dept) return say('Pick a team.', 'status error');
    say('Scheduling…');
    const { error } = await state.supabase.rpc('schedule_employee_setup', {
      p_employee_id: row.dataset.employee, p_activate_on: on, p_department_id: dept.id,
      p_employment_type: type, p_capacity_percent: capacity, p_client_ids: clientIds
    });
    if (error) return say(error.message, 'status error');
    await renderPendingSetupAdmin();
    return;
  }
  const cancel = event.target.closest('.setup-cancel-schedule');
  if (cancel) {
    const row = cancel.closest('.pending-setup-row');
    const { error } = await state.supabase.rpc('cancel_scheduled_activation', { p_employee_id: row.dataset.employee });
    if (error) console.error(error);
    await renderPendingSetupAdmin();
    return;
  }
  const btn = event.target.closest('.setup-activate');
  if (!btn) return;
  const row = btn.closest('.pending-setup-row');
  const notice = row.querySelector('.setup-notice');
  const say = (msg, cls = 'mini-meta') => { notice.className = `${cls} setup-notice`; notice.style.display = ''; notice.textContent = msg; };

  const team = row.querySelector('.setup-team')?.value;
  const type = row.querySelector('.setup-type')?.value;
  const capacity = parseCapacityPercentInput(row.querySelector('.setup-capacity')?.value);
  // Belt and braces: the picker is hidden for non-fractional types, but a
  // stale tick must never become an inert scope row on their record.
  const clientIds = employmentIsScoped(type)
    ? [...row.querySelectorAll('.setup-client:checked')].map((i) => i.value)
    : [];

  if (capacity === null || capacity <= 0 || capacity > 100) return say('Capacity must be a number from 1 to 100.', 'status error');
  // Mirrors the DB guard. Without at least one client a project-based person
  // reads as "unscoped" and would see every client — the hole this closes.
  if (employmentIsScoped(type) && !clientIds.length) return say('Pick at least one client — a fractional person with none would see them all.', 'status error');

  btn.disabled = true; btn.textContent = 'Activating…';
  try {
    const deptId = await resolveDepartmentIdByName(team, null);
    if (!deptId) throw new Error(`Could not resolve the team "${team}".`);
    const { error } = await state.supabase.rpc('activate_employee_setup', {
      p_employee_id: row.dataset.employee,
      p_department_id: deptId,
      p_employment_type: type,
      p_capacity_percent: capacity,
      p_client_ids: clientIds
    });
    if (error) throw error;
    say('Activated.', 'status');
    // Refresh what activation changed: the directory (team/type/capacity) and
    // the scope map that drives capacity exclusion + client gating.
    await loadEmployeeDirectoryFromSupabase().catch(() => {});
    await loadClientScope().catch(() => {});
    await renderPendingSetupAdmin();
    loadNotifySignals().catch(() => {});
  } catch (err) {
    say(`Activation failed: ${err.message}`, 'status error');
    btn.disabled = false; btn.textContent = 'Activate';
  }
});

// ── Enforced Access overrides admin (Admin Settings, superadmin-only) ──
const accessOverridesTableBody = document.getElementById('accessOverridesTableBody');

function setOverridesNotice(msg = '', cls = 'mini-meta') {
  const el = document.getElementById('accessOverridesNotice');
  if (!el) return;
  el.className = cls;
  el.textContent = msg;
}

function renderAccessOverridesAdmin() {
  if (!accessOverridesTableBody) return;
  const map = getEnforcedAccessMap();
  const emails = Object.keys(map).sort();
  const canEdit = isSuperadminUser();
  if (!emails.length) {
    accessOverridesTableBody.innerHTML = '<tr><td colspan="3">No enforced access pins.</td></tr>';
    return;
  }
  accessOverridesTableBody.innerHTML = emails.map(email => {
    const role = map[email];
    const isSelf = isSuperadminEmail(email);
    return `<tr>
      <td data-label="Email">${escapeHtml(email)}</td>
      <td data-label="Pinned Role">${escapeHtml(role.charAt(0).toUpperCase() + role.slice(1))}</td>
      <td data-label="Action">${(canEdit && !isSelf) ? `<button class="ghost small danger-text" data-remove-override="${escapeHtml(email)}" type="button">Remove</button>` : (isSelf ? '<span class="mini-meta">superadmin</span>' : '')}</td>
    </tr>`;
  }).join('');
}

async function addAccessOverride() {
  if (!state.supabase || !isSuperadminUser()) return;
  const emailEl = document.getElementById('newOverrideEmail');
  const roleEl = document.getElementById('newOverrideRole');
  const email = normalizeEmail(emailEl?.value || '');
  const role = roleEl?.value || 'leadership';
  if (!email) { setOverridesNotice('Enter an email.', 'mini-meta warn'); return; }
  if (!email.endsWith(ANT_DOMAIN)) { setOverridesNotice('Must be a @youragency.com email.', 'mini-meta warn'); return; }
  setOverridesNotice('Saving…');
  const { error } = await state.supabase
    .from('access_overrides')
    .upsert({ email, role }, { onConflict: 'email' })
    .select();
  if (error) { setOverridesNotice('Could not save: ' + error.message, 'mini-meta warn'); return; }
  if (emailEl) emailEl.value = '';
  await loadAccessOverrides();
  renderAccessOverridesAdmin();
  renderFullAccessUsers();
  setOverridesNotice(`✓ Pinned ${email} to ${role}. Takes effect on their next login.`);
}

async function removeAccessOverride(email) {
  if (!state.supabase || !isSuperadminUser() || !email) return;
  if (isSuperadminEmail(email)) { setOverridesNotice('The superadmin pin cannot be removed.', 'mini-meta warn'); return; }
  if (!await appConfirm(`Remove the enforced-access pin for ${email}? Their role will then follow the DB ("Save Roles") instead.`, { title: 'Remove access pin', confirmLabel: 'Remove', danger: true })) return;
  setOverridesNotice('Removing…');
  const { data, error } = await state.supabase
    .from('access_overrides')
    .delete()
    .eq('email', email)
    .select();
  if (error) { setOverridesNotice('Could not remove: ' + error.message, 'mini-meta warn'); return; }
  if (!data || !data.length) { setOverridesNotice('Nothing removed (permission?).', 'mini-meta warn'); return; }
  await loadAccessOverrides();
  renderAccessOverridesAdmin();
  renderFullAccessUsers();
  setOverridesNotice('✓ Pin removed.');
}

if (document.getElementById('addOverrideBtn')) {
  document.getElementById('addOverrideBtn').addEventListener('click', () => addAccessOverride().catch(console.error));
}
if (accessOverridesTableBody) {
  accessOverridesTableBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-override]');
    if (btn) removeAccessOverride(btn.dataset.removeOverride).catch(console.error);
  });
}

function renderFullAccessUsers() {
  if (!fullAccessTableBody) return;
  const canManage = canManageAccessRoles();

  // Merge DB-persisted roles with hardcoded enforced overrides
  const seenEmails = new Set();
  const merged = [];

  // First: all directory entries with admin/leadership in DB
  state.employeeDirectory
    .filter((entry) => entry.access_level === 'admin' || entry.access_level === 'leadership')
    .forEach((entry) => {
      const email = normalizeEmail(entry.email);
      const enforced = getEnforcedAccessLevel(email);
      seenEmails.add(email);
      merged.push({
        full_name: entry.full_name,
        email,
        access_level: normalizeAccessLevel(enforced || entry.access_level)
      });
    });

  // Second: enforced overrides not yet in merged list (DB says employee but an
  // override says leadership/admin). Uses the effective map (DB or fallback).
  Object.entries(getEnforcedAccessMap()).forEach(([email, role]) => {
    const normEmail = normalizeEmail(email);
    if (seenEmails.has(normEmail)) return;
    const dirEntry = lookupActiveEmployeeByEmail(normEmail);
    if (!dirEntry) return; // not in directory at all — skip
    merged.push({
      full_name: dirEntry.full_name,
      email: normEmail,
      access_level: normalizeAccessLevel(role)
    });
  });

  fullAccessTableBody.innerHTML = '';
  if (!merged.length) {
    fullAccessTableBody.innerHTML = '<tr><td colspan="4">No full-access users configured.</td></tr>';
    return;
  }

  merged.forEach((row) => {
    const tr = document.createElement('tr');
    tr.dataset.email = row.email;
    tr.dataset.name = row.full_name || displayNameFromEmail(row.email);
    const visibleName = displayPersonName(tr.dataset.name, displayNameFromEmail(row.email));
    const role = normalizeAccessLevel(row.access_level);
    const accessLabel = role === 'employee' ? 'Limited' : 'Full';
    tr.innerHTML = `
      <td data-label="Name">${escapeHtml(visibleName)}</td>
      <td data-label="Email">${escapeHtml(row.email)}</td>
      <td data-label="Role"><select class="full-access-role" ${canManage ? '' : 'disabled'}>${fullAccessRoleOptionsMarkup(role)}</select></td>
      <td data-label="Access" class="full-access-level-cell">${accessLabel}</td>
    `;
    fullAccessTableBody.appendChild(tr);
  });

  if (saveAccessRolesBtn) {
    saveAccessRolesBtn.disabled = !canManage;
  }
}

async function saveFullAccessRoles() {
  if (!state.supabase || !state.isAuthenticated) {
    setFullAccessNotice('Sign in first to save access roles.');
    return;
  }
  if (!canManageAccessRoles()) {
    setFullAccessNotice('Access role changes are restricted.', 'status warn');
    return;
  }
  if (!fullAccessTableBody) return;

  const rows = [...fullAccessTableBody.querySelectorAll('tr[data-email]')];
  if (!rows.length) {
    setFullAccessNotice('No rows to save.');
    return;
  }

  const leadershipDeptResult = await state.supabase.from('departments').select('id').eq('name', 'Leadership').single();
  if (leadershipDeptResult.error) {
    setFullAccessNotice(`Unable to load Leadership department: ${leadershipDeptResult.error.message}`);
    return;
  }
  const leadershipDeptId = leadershipDeptResult.data.id;

  let updatedCount = 0;
  let insertedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    const email = normalizeEmail(row.dataset.email);
    const fullName = row.dataset.name || displayNameFromEmail(email);
    const selectedRole = normalizeAccessLevel(row.querySelector('.full-access-role')?.value);

    if (!email.endsWith(ANT_DOMAIN)) {
      skippedCount += 1;
      continue;
    }

    const existingResult = await state.supabase.from('employees').select('id').eq('email', email).maybeSingle();
    if (existingResult.error && existingResult.error.code !== 'PGRST116') {
      setFullAccessNotice(`Unable to check employee ${email}: ${existingResult.error.message}`);
      return;
    }

    if (existingResult.data?.id) {
      const updateResult = await state.supabase
        .from('employees')
        .update({
          access_level: selectedRole,
          role_title: selectedRole === 'admin' ? 'Admin' : selectedRole === 'leadership' ? 'Leadership' : 'Employee',
          is_active: true
        })
        .eq('id', existingResult.data.id);
      if (updateResult.error) {
        setFullAccessNotice(`Unable to update ${email}: ${updateResult.error.message}`);
        return;
      }
      updatedCount += 1;
    } else if (selectedRole === 'employee') {
      skippedCount += 1;
    } else {
      const insertResult = await state.supabase.from('employees').insert({
        email,
        full_name: fullName,
        department_id: leadershipDeptId,
        employment_type: 'full-time',
        access_level: selectedRole,
        role_title: selectedRole === 'admin' ? 'Admin' : 'Leadership',
        leave_tracking_enabled: true,
        is_active: true,
        onboarding_completed: false
      }).select('id').single();
      if (insertResult.error) {
        setFullAccessNotice(`Unable to add ${email}: ${insertResult.error.message}`);
        return;
      }
      // Auto-spawn onboarding checklist for the new employee
      if (insertResult.data?.id) {
        spawnOnboardingForEmployee(insertResult.data.id).catch(console.error);
      }
      insertedCount += 1;
    }
  }

  await loadEmployeeDirectoryFromSupabase();
  setFullAccessNotice(`Saved. Updated ${updatedCount}, added ${insertedCount}, skipped ${skippedCount}.`);
}

if (fullAccessTableBody) {
  fullAccessTableBody.addEventListener('change', (event) => {
    if (!canManageAccessRoles()) return;
    const select = event.target.closest('.full-access-role');
    if (!select) return;
    const row = select.closest('tr');
    const levelCell = row?.querySelector('.full-access-level-cell');
    if (levelCell) {
      levelCell.textContent = normalizeAccessLevel(select.value) === 'employee' ? 'Limited' : 'Full';
    }
  });
}

if (saveAccessRolesBtn) {
  saveAccessRolesBtn.addEventListener('click', () => {
    saveFullAccessRoles().catch((error) => {
      console.error(error);
      setFullAccessNotice(`Unable to save roles: ${error.message}`);
    });
  });
}

function renderTaskEmployeeFilterOptions() {
  if (!taskEmployeeFilter) return;
  taskEmployeeFilter.innerHTML = '';
  state.employeeDirectory.forEach((employee) => {
    const option = document.createElement('option');
    option.value = employee.id;
    option.textContent = displayPersonName(employee.full_name, 'Employee');
    taskEmployeeFilter.appendChild(option);
  });

  if (!state.taskViewEmployeeId) {
    state.taskViewEmployeeId = state.currentEmployeeId;
  }

  if (state.taskViewEmployeeId && [...taskEmployeeFilter.options].some((opt) => opt.value === state.taskViewEmployeeId)) {
    taskEmployeeFilter.value = state.taskViewEmployeeId;
  } else if (taskEmployeeFilter.options.length) {
    state.taskViewEmployeeId = taskEmployeeFilter.options[0].value;
    taskEmployeeFilter.value = state.taskViewEmployeeId;
  }
}

function parseTaskDeadlineInput(value) {
  const text = String(value || '').trim();
  if (!text) return { value: null, valid: true };
  const parsed = parseIsoDateLocal(text);
  if (!parsed || toISODateLocal(parsed) !== text) {
    return { value: null, valid: false };
  }
  return { value: text, valid: true };
}

function renderDailyTaskTable() {
  if (!dailyTaskTableBody) return;
  const todayIso = toISODateLocal();
  const taskEmployeeId = getTaskViewEmployeeId();
  const rows = taskEmployeeId
    ? tasksForDate(taskEmployeeId, todayIso).filter((t) => t.status !== 'archived').sort((a, b) => {
        if ((a.status === 'done') !== (b.status === 'done')) return (a.status === 'done') - (b.status === 'done');
        const aPri = a.sort_order || 0;
        const bPri = b.sort_order || 0;
        if (aPri && bPri) return aPri - bPri;
        if (aPri) return -1;
        if (bPri) return 1;
        return new Date(b.created_at) - new Date(a.created_at);
      })
    : [];
  const showActionColumn = canManageTaskView(taskEmployeeId);

  if (taskTodayLabel) {
    taskTodayLabel.textContent = `Today\u2019s Focus`;
  }
  if (taskActionHeader) {
    taskActionHeader.classList.toggle('hidden', !showActionColumn);
  }

  dailyTaskTableBody.innerHTML = '';
  if (!rows.length) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="${showActionColumn ? 6 : 5}">No tasks for today. Promote tasks from Weekly Planner below.</td>`;
    dailyTaskTableBody.appendChild(row);
    return;
  }

  rows.forEach((task) => {
    const canManage = canManageTask(task);
    const row = document.createElement('tr');
    if (task.status === 'done') row.classList.add('task-done');
    const priorityVal = task.sort_order || '';
    const priorityCell = canManage
      ? `<td data-label="Priority"><select class="priority-input" data-task-id="${task.id}"><option value="0">\u2013</option>${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}"${Number(priorityVal) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></td>`
      : `<td data-label="Priority">${priorityVal || '\u2013'}</td>`;
    const hasWeeklyOriginal = state.dailyTasks.some(
      (t) => taskTitleKey(t.task_title) === taskTitleKey(task.task_title) && t.notes === task.notes && t.employee_id === task.employee_id && t.task_date === null && t.status !== 'archived' && t.id !== task.id
    );
    const demoteBtn = hasWeeklyOriginal
      ? `<button class="ghost small" data-task-action="demote" data-task-id="${task.id}">\u2190 Weekly</button>`
      : '';
    const actionCell = canManage
      ? `
        <td data-label="Actions">
          <button class="ghost small" data-task-action="edit" data-task-id="${task.id}">Edit</button>
          ${demoteBtn}
          <button class="ghost small" data-task-action="delete" data-task-id="${task.id}">Delete</button>
        </td>
      `
      : '';
    row.innerHTML = `
      ${priorityCell}
      <td data-label="Task">${task.recurring_task_id ? '<span class="recur-mark" title="Repeats monthly">\u21bb</span> ' : ''}${taskTitleHtml(task)}${hasWeeklyOriginal ? ' <span class="weekly-chip" title="This is today\u2019s copy of a Weekly Planner task">weekly</span>' : ''}</td>
      <td data-label="Client">${escapeHtml(task.notes || '--')}</td>
      <td data-label="Description">${escapeHtml(taskLinkParts(task.description).displayDesc || '--')}</td>
      <td data-label="Status">
        <select class="status-select" data-task-id="${task.id}">
          <option value="in_progress"${task.status !== 'done' ? ' selected' : ''}>In progress</option>
          <option value="done"${task.status === 'done' ? ' selected' : ''}>Completed</option>
        </select>
      </td>
      ${actionCell}
    `;
    dailyTaskTableBody.appendChild(row);
  });
}

// Task Archive month navigation state
state._archiveMonthOffset = 0;

const archiveMonthPrev = document.getElementById('archiveMonthPrev');
const archiveMonthNext = document.getElementById('archiveMonthNext');
const archiveMonthLabel = document.getElementById('archiveMonthLabel');

if (archiveMonthPrev) {
  archiveMonthPrev.addEventListener('click', () => {
    state._archiveMonthOffset--;
    renderTaskArchiveCalendar();
  });
}
if (archiveMonthNext) {
  archiveMonthNext.addEventListener('click', () => {
    if (state._archiveMonthOffset < 0) {
      state._archiveMonthOffset++;
      renderTaskArchiveCalendar();
    }
  });
}

function renderTaskArchiveCalendar() {
  if (!taskArchiveCalendar) return;
  const employeeId = getTaskViewEmployeeId();
  const today = new Date();
  const baseDate = new Date(today.getFullYear(), today.getMonth() + (state._archiveMonthOffset || 0), 1);
  const year = baseDate.getFullYear();
  const month = baseDate.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayIso = toISODateLocal(today);

  // Update month label and nav buttons
  if (archiveMonthLabel) {
    archiveMonthLabel.textContent = baseDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  if (archiveMonthNext) archiveMonthNext.disabled = (state._archiveMonthOffset || 0) >= 0;

  taskArchiveCalendar.innerHTML = '';

  /* Day-of-week headers */
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  dayLabels.forEach((lbl) => {
    const hdr = document.createElement('div');
    hdr.className = 'archive-day-header';
    hdr.textContent = lbl;
    taskArchiveCalendar.appendChild(hdr);
  });

  /* Empty spacers before the 1st */
  for (let i = 0; i < firstWeekday; i += 1) {
    const empty = document.createElement('div');
    empty.className = 'archive-cell spacer-day';
    empty.setAttribute('aria-hidden', 'true');
    taskArchiveCalendar.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateIso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isPast = dateIso < todayIso;
    const isToday = dateIso === todayIso;
    const cell = document.createElement('div');

    let cls = 'archive-cell';
    if (isPast) cls += ' past-day';
    else if (isToday) cls += ' is-today';
    else cls += ' future-day';

    cell.className = cls;
    cell.textContent = String(day);
    if (isPast && employeeId) {
      cell.style.cursor = 'pointer';
      cell.addEventListener('click', () => showArchiveDayDetail(dateIso, employeeId));
    }
    taskArchiveCalendar.appendChild(cell);
  }

  // Auto-select the most recent past date so detail panel shows by default
  if (employeeId) {
    const todayDate = new Date();
    let autoSelectDate;
    if ((state._archiveMonthOffset || 0) === 0) {
      // Current month: select yesterday (or today if today is the 1st)
      const yesterday = new Date(todayDate);
      yesterday.setDate(yesterday.getDate() - 1);
      if (yesterday.getMonth() === month && yesterday.getFullYear() === year) {
        autoSelectDate = toISODateLocal(yesterday);
      } else {
        // First of the month — no past day to select
        autoSelectDate = null;
      }
    } else {
      // Past month: select the last day of that month
      autoSelectDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
    }
    if (autoSelectDate) {
      showArchiveDayDetail(autoSelectDate, employeeId);
    } else if (archiveDayDetail) {
      archiveDayDetail.classList.add('hidden');
      archiveDayDetail.closest('.archive-layout')?.classList.remove('has-detail');
    }
  } else if (archiveDayDetail) {
    archiveDayDetail.classList.add('hidden');
    archiveDayDetail.closest('.archive-layout')?.classList.remove('has-detail');
  }
}

async function showArchiveDayDetail(dateIso, employeeId) {
  if (!archiveDayDetail || !archiveDayDetailBody) return;
  archiveDayDetailLabel.textContent = formatDateForLabel(dateIso);
  archiveDayDetailBody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
  archiveDayDetail.classList.remove('hidden');
  archiveDayDetail.closest('.archive-layout')?.classList.add('has-detail');

  // Lazy-load tasks for this date directly from DB (includes archived)
  let tasks = tasksForDate(employeeId, dateIso);
  if (!tasks.length && state.supabase && state.isAuthenticated) {
    const res = await state.supabase
      .from('daily_tasks')
      .select('id, employee_id, task_date, task_title, status, notes, description, deadline, created_at, updated_at, sort_order, recurring_task_id')
      .eq('employee_id', employeeId)
      .eq('task_date', dateIso)
      .limit(200);
    if (!res.error && res.data?.length) {
      tasks = res.data;
      // Merge into state so subsequent clicks don't re-fetch
      const existingIds = new Set(state.dailyTasks.map(t => t.id));
      res.data.forEach(t => { if (!existingIds.has(t.id)) state.dailyTasks.push(t); });
    }
  }

  archiveDayDetailBody.innerHTML = '';
  if (!tasks.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="4">No tasks logged for this day.</td>';
    archiveDayDetailBody.appendChild(row);
  } else {
    tasks.forEach((task) => {
      const row = document.createElement('tr');
      const isDone = task.status === 'done' || task.status === 'archived';
      const statusLabel = isDone ? 'Completed' : 'In progress';
      row.innerHTML = `
        <td data-label="Task">${task.recurring_task_id ? '<span class="recur-mark" title="Repeats monthly">\u21bb</span> ' : ''}${taskTitleHtml(task)}</td>
        <td data-label="Client">${escapeHtml(task.notes || '--')}</td>
        <td data-label="Description">${escapeHtml(taskLinkParts(task.description).displayDesc || '--')}</td>
        <td data-label="Status"><span class="chip ${isDone ? 'approved-chip' : 'pending-chip'}">${statusLabel}</span></td>
      `;
      archiveDayDetailBody.appendChild(row);
    });
  }

  // Highlight selected cell
  taskArchiveCalendar.querySelectorAll('.archive-cell').forEach((c) => c.classList.remove('selected-day'));
  const cells = taskArchiveCalendar.querySelectorAll('.archive-cell:not(.spacer-day)');
  const dayNum = parseInt(dateIso.split('-')[2], 10);
  if (cells[dayNum - 1]) cells[dayNum - 1].classList.add('selected-day');
}

async function loadEmployeeDirectoryFromSupabase() {
  if (!state.supabase || !state.isAuthenticated) {
    state.employeeDirectory = [];
    state.inactiveEmployees = [];
    renderPeopleDirectory();
    renderTaskEmployeeFilterOptions();
    renderAllocationEmployeeFilterOptions();
    renderFullAccessUsers();
    renderClientOwnerOptions();
    return;
  }

  const response = await state.supabase
    .from('employees')
    .select(`
      id,
      full_name,
      email,
      is_active,
      capacity_percent,
      employment_type,
      leave_tracking_enabled,
      access_level,
      created_at,
      direct_manager_email,
      date_of_birth,
      current_city,
      timezone,
      onboarding_completed,
      setup_pending,
      job_title,
      department:departments!employees_department_id_fkey (
        id,
        name,
        leave_tracking_enabled
      )
    `)
    .eq('is_active', true)
    .order('full_name', { ascending: true });

  if (response.error) {
    console.error(response.error);
    return;
  }

  state.employeeDirectory = (response.data || []).map(stripMiddleNameOnEmployee);
  state.employeeDirectory.forEach((employee) => upsertEmployeeInStore(employee));

  // Load deactivated employees for leadership reactivation
  if (isLeadershipRole()) {
    const inactiveRes = await state.supabase
      .from('employees')
      .select('id, full_name, email, department:departments!employees_department_id_fkey (name)')
      .eq('is_active', false)
      .order('full_name', { ascending: true });
    state.inactiveEmployees = (inactiveRes.data || []).map(stripMiddleNameOnEmployee);
  } else {
    state.inactiveEmployees = [];
  }

  if (!state.taskViewEmployeeId) {
    state.taskViewEmployeeId = state.currentEmployeeId;
  }

  renderPeopleDirectory();
  renderTaskEmployeeFilterOptions();
  renderAllocationEmployeeFilterOptions();
  renderFullAccessUsers();
  renderClientOwnerOptions();
  loadTeamDashboardFromSupabase().catch((error) => {
    console.error(error);
    setTeamDashboardScopeNote(`Unable to load team dashboard: ${error.message}`, 'status warn');
  });
}

async function loadDailyTasksFromSupabase() {
  if (!state.supabase || !state.isAuthenticated) {
    state.dailyTasks = [];
    renderDailyTaskViews();
    return;
  }

  // Fetch only active (non-archived) tasks. Archived tasks are loaded
  // on-demand when the archive calendar is clicked (lazy load).
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const response = await state.supabase
    .from('daily_tasks')
    .select('id, employee_id, task_date, task_title, status, notes, description, deadline, created_at, updated_at, sort_order, recurring_task_id')
    .neq('status', 'archived')
    .or(`task_date.is.null,task_date.gte.${thirtyDaysAgo}`)
    .order('task_date', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(2000);

  if (response.error) {
    console.error(response.error);
    setDailyTaskNotice(`Unable to load tasks: ${response.error.message}`);
    return;
  }

  state.dailyTasks = response.data || [];

  // Daily cleanup: archive done daily tasks + carry forward unfinished.
  // Runs ONCE per page-load session to avoid re-creating tasks the user
  // just deleted (carry-forward would see the past-day original and clone it again).
  const today = toISODateLocal();
  const myId = state.currentEmployeeId;
  const cleanupAlreadyDoneToday = localStorage.getItem('colony_task_cleanup_date') === today;
  if (myId && !_carryForwardDoneThisSession && !cleanupAlreadyDoneToday) {
    _carryForwardDoneThisSession = true;
    const myTasks = state.dailyTasks.filter((t) => t.employee_id === myId);

    // All carry-forward/archival DECISIONS are pure and live in js/tasks.js
    // (planDailyCleanup, unit-tested); only the I/O happens here.
    const plan = planDailyCleanup(myTasks, {
      todayIso: today,
      weekStartIso: getCurrentWeekStartIso(),
      dayOfWeek: new Date().getDay(), // 0=Sun, 1=Mon
      employeeId: myId
    });

    // Archive my completed tasks from PAST days only (today's completed stays visible)
    if (plan.pastDoneDaily.length) {
      const archiveRes = await state.supabase
        .from('daily_tasks')
        .update({ status: 'archived' })
        .in('id', plan.pastDoneDaily.map((t) => t.id));
      if (archiveRes.error) {
        console.error('Auto-archive daily cleanup failed:', archiveRes.error.message);
      } else {
        plan.pastDoneDaily.forEach((t) => { t.status = 'archived'; });
      }
    }

    // Carry forward my unfinished tasks: insert fresh copies for today, then
    // archive the originals so they don't pile up and re-trigger carry-forward.
    if (plan.carryTasks.length) {
      const insertRes = await state.supabase.from('daily_tasks').insert(plan.copies).select();
      if (insertRes.error) {
        console.error('Task carry-forward copy failed:', insertRes.error.message);
        setDailyTaskNotice(`Carry-forward failed: ${insertRes.error.message}`);
      } else if (insertRes.data) {
        state.dailyTasks.push(...insertRes.data);
      }
      const archiveOriginRes = await state.supabase
        .from('daily_tasks')
        .update({ status: 'archived' })
        .in('id', plan.carryTasks.map((t) => t.id));
      if (!archiveOriginRes.error) {
        plan.carryTasks.forEach((t) => { t.status = 'archived'; });
      }
    }

    // Weekly cleanup: archive done weekly backlog tasks (all on Monday; other
    // days only those finished before this week started)
    if (plan.weeklyDone.length) {
      const archiveRes = await state.supabase
        .from('daily_tasks')
        .update({ status: 'archived' })
        .in('id', plan.weeklyDone.map((t) => t.id));
      if (archiveRes.error) {
        console.error('Auto-archive weekly cleanup failed:', archiveRes.error.message);
      } else {
        plan.weeklyDone.forEach((t) => { t.status = 'archived'; });
      }
    }

    // Mark today's cleanup as done so visibility-change handler doesn't re-trigger
    try { localStorage.setItem('colony_task_cleanup_date', toISODateLocal()); } catch (_) {}
  }

  renderTaskClientOptions();
  renderDailyTaskViews();
}

function renderWeeklyPlannerTable() {
  if (!weeklyPlannerTableBody) return;
  const taskEmployeeId = getTaskViewEmployeeId();
  const rows = taskEmployeeId ? tasksForWeeklyBacklog(taskEmployeeId).sort((a, b) => {
    if ((a.status === 'done') !== (b.status === 'done')) return (a.status === 'done') - (b.status === 'done');
    const aPri = a.sort_order || 0;
    const bPri = b.sort_order || 0;
    if (aPri && bPri) return aPri - bPri;
    if (aPri) return -1;
    if (bPri) return 1;
    return new Date(b.created_at) - new Date(a.created_at);
  }) : [];
  const showActionColumn = canManageTaskView(taskEmployeeId);

  if (weeklyTaskActionHeader) {
    weeklyTaskActionHeader.classList.toggle('hidden', !showActionColumn);
  }

  weeklyPlannerTableBody.innerHTML = '';
  if (!rows.length) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="${showActionColumn ? 6 : 5}">No tasks in the weekly planner. Add tasks below.</td>`;
    weeklyPlannerTableBody.appendChild(row);
    return;
  }

  rows.forEach((task) => {
    const canManage = canManageTask(task);
    const row = document.createElement('tr');
    if (task.status === 'done') row.classList.add('task-done');
    const priorityVal = task.sort_order || '';
    const priorityCell = canManage
      ? `<td data-label="Priority"><select class="priority-input" data-task-id="${task.id}"><option value="0">\u2013</option>${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}"${Number(priorityVal) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></td>`
      : `<td data-label="Priority">${priorityVal || '\u2013'}</td>`;
    const actionCell = canManage
      ? `
        <td data-label="Actions">
          <button class="ghost small" data-task-action="edit" data-task-id="${task.id}">Edit</button>
          <button class="ghost small" data-task-action="promote" data-task-id="${task.id}">\u2192 Today</button>
          <button class="ghost small danger-text" data-task-action="delete" data-task-id="${task.id}">Delete</button>
        </td>
      `
      : '';
    row.innerHTML = `
      ${priorityCell}
      <td data-label="Task">${task.recurring_task_id ? '<span class="recur-mark" title="Repeats monthly">\u21bb</span> ' : ''}${taskTitleHtml(task)}${hasDailyCopyToday(task, state.dailyTasks, toISODateLocal()) ? ' <span class="today-chip">today \u2713</span>' : ''}</td>
      <td data-label="Client">${escapeHtml(task.notes || '--')}</td>
      <td data-label="Description">${escapeHtml(taskLinkParts(task.description).displayDesc || '--')}</td>
      <td data-label="Status">
        <select class="status-select" data-task-id="${task.id}">
          <option value="in_progress"${task.status !== 'done' ? ' selected' : ''}>In progress</option>
          <option value="done"${task.status === 'done' ? ' selected' : ''}>Completed</option>
        </select>
      </td>
      ${actionCell}
    `;
    weeklyPlannerTableBody.appendChild(row);
  });
}

function renderDailyTaskViews() {
  renderDailyTaskTable();
  renderWeeklyPlannerTable();
  renderTaskArchiveCalendar();
  renderProfileDailyTasks();
}

async function addTask(targetDate = null) {
  if (addTask._inFlight) {
    // Never let a hung save silently eat every future click (2 Jul
    // 2026: one wedged request killed task-adds for a whole day in one tab).
    // Tell the user, and self-heal if the previous attempt is clearly dead.
    if (Date.now() - (addTask._inFlightAt || 0) < 20000) {
      setDailyTaskNotice('Still saving the previous task… try again in a few seconds.');
      return;
    }
    addTask._inFlight = false;
  }
  const title = String(newTaskTitleInput?.value || '').trim();
  const client = String(newTaskClientSelect?.value || '').trim();
  const normalizedClient = normalizeClientNameKey(client);
  if (!title) {
    setDailyTaskNotice('Enter a task title first.');
    return;
  }
  if (title.length > 25) {
    setDailyTaskNotice('Task title must be 25 characters or less.');
    return;
  }
  if (!client) {
    setDailyTaskNotice('Select a client first.');
    return;
  }
  if (!normalizedClient || normalizedClient === 'internal') {
    setDailyTaskNotice('Select a valid client before saving.');
    return;
  }

  const description = String(newTaskDescriptionInput?.value || '').trim() || null;
  if (description && description.length > TASK_DESCRIPTION_MAX) {
    setDailyTaskNotice(`Description must be ${TASK_DESCRIPTION_MAX} characters or less.`);
    return;
  }
  const deadline = newTaskDeadlineInput?.value || null;
  const noticeTarget = targetDate ? 'Today' : 'Weekly Planner';

  // ↻ Weekly / ↻ Monthly: save a recurring rule instead of a one-time task. The
  // 10 AM cron spawns it on the chosen day (short months clamp for monthly); if
  // today IS the day, spawn immediately too.
  const repeatMode = document.getElementById('newTaskRepeatSelect')?.value || '';
  if ((repeatMode === 'monthly' || repeatMode === 'weekly') && state.supabase && state.isAuthenticated) {
    // Exactly one of the two days is sent — the schedule CHECK constraint
    // rejects a rule carrying both.
    const rule = repeatMode === 'weekly'
      ? { frequency: 'weekly', day_of_week: Number(document.getElementById('newTaskRepeatWeekday')?.value ?? new Date().getDay()), day_of_month: null }
      : { frequency: 'monthly', day_of_month: Number(document.getElementById('newTaskRepeatDay')?.value) || new Date().getDate(), day_of_week: null };
    addTask._inFlight = true;
    addTask._inFlightAt = Date.now();
    try {
      const ruleRes = await state.supabase.from('recurring_tasks')
        .insert({ employee_id: state.currentEmployeeId, task_title: title, notes: client, description, ...rule })
        .select().single();
      if (ruleRes.error) { setDailyTaskNotice(`Could not save repeating task: ${ruleRes.error.message}`); return; }
      if (recurringRuleDueOn(rule, toISODateLocal())) {
        const spawn = await state.supabase.rpc('create_daily_task', {
          p_task_date: toISODateLocal(), p_task_title: title, p_notes: client,
          p_status: 'in_progress', p_description: description, p_deadline: null
        });
        if (!spawn.error) await loadDailyTasksFromSupabase();
      }
      if (newTaskTitleInput) newTaskTitleInput.value = '';
      if (newTaskClientSelect) newTaskClientSelect.value = '';
      if (newTaskDescriptionInput) newTaskDescriptionInput.value = '';
      const rsel = document.getElementById('newTaskRepeatSelect');
      if (rsel) { rsel.value = ''; rsel.dispatchEvent(new Event('change')); }
      setDailyTaskNotice(`\u21bb Saved — "${title}" repeats ${recurringRuleLabel(rule)}.`);
      loadRecurringTasks().catch(console.error);
    } finally { addTask._inFlight = false; }
    return;
  }

  if (!state.supabase || !state.isAuthenticated) {
    const localTask = {
      id: `local-${Date.now()}`,
      employee_id: getTaskViewEmployeeId() || state.currentEmployeeId,
      task_date: targetDate,
      task_title: title,
      status: 'in_progress',
      notes: client,
      description,
      deadline,
      sort_order: 0,
      created_at: new Date().toISOString()
    };
    state.dailyTasks.push(localTask);
    if (newTaskTitleInput) newTaskTitleInput.value = '';
    if (newTaskClientSelect) newTaskClientSelect.value = '';
    if (newTaskDescriptionInput) newTaskDescriptionInput.value = '';
    if (newTaskDeadlineInput) newTaskDeadlineInput.value = '';
    setDailyTaskNotice('');
    renderDailyTaskViews();
    return;
  }

  addTask._inFlight = true;
  addTask._inFlightAt = Date.now();
  try {
    if (isLeadershipRole()) {
      const targetEmployeeId = getTaskViewEmployeeId() || state.currentEmployeeId;
      const insertResult = await state.supabase.from('daily_tasks').insert({
        employee_id: targetEmployeeId,
        task_date: targetDate,
        task_title: title,
        status: 'in_progress',
        notes: client,
        description,
        deadline,
        sort_order: 0
      });

      if (insertResult.error) {
        setDailyTaskNotice(`Task add failed: ${insertResult.error.message}`);
        return;
      }
      // Only your own list counts: a lead adding a task for someone else is
      // not that person's streak, and not the lead's either.
      if (targetEmployeeId === state.currentEmployeeId) recordTaskActivity();
    } else {
      const createResult = await state.supabase.rpc('create_daily_task', {
        p_task_date: targetDate,
        p_task_title: title,
        p_notes: client,
        p_status: 'in_progress',
        p_description: description,
        p_deadline: deadline
      });

      if (createResult.error) {
        setDailyTaskNotice(`Task add failed: ${createResult.error.message}`);
        return;
      }
      // create_daily_task always creates for the caller, so this is always own.
      recordTaskActivity();
    }

    if (newTaskTitleInput) newTaskTitleInput.value = '';
    if (newTaskClientSelect) newTaskClientSelect.value = '';
    if (newTaskDescriptionInput) newTaskDescriptionInput.value = '';
    if (newTaskDeadlineInput) newTaskDeadlineInput.value = '';
    setDailyTaskNotice('');
    await loadDailyTasksFromSupabase();
  } finally {
    addTask._inFlight = false;
  }
}

async function deleteTaskById(taskId) {
  if (!taskId) return;
  const task = state.dailyTasks.find((item) => item.id === taskId) || null;
  if (!canManageTask(task)) return;
  const isWeekly = task.task_date === null;
  const confirmMsg = isWeekly
    ? 'Delete this task from the weekly planner? Daily copies already promoted will not be affected.'
    : 'Delete this task from today? The weekly copy is not affected.';
  if (!await appConfirm(confirmMsg)) return;

  if (!state.supabase || !state.isAuthenticated) {
    state.dailyTasks = state.dailyTasks.filter((t) => t.id !== taskId);
    renderDailyTaskViews();
    setDailyTaskNotice('Task deleted.');
    return;
  }

  // Always filter by employee_id for own tasks. RLS handles leadership separately —
  // don't skip this filter based on client-side role (DB access_level may differ).
  let deleteQuery = state.supabase.from('daily_tasks').delete().eq('id', taskId).select();
  if (task.employee_id === state.currentEmployeeId) {
    deleteQuery = deleteQuery.eq('employee_id', state.currentEmployeeId);
  }
  const result = await deleteQuery;
  if (result.error) {
    setDailyTaskNotice(`Unable to delete task: ${result.error.message}`);
    return;
  }
  if (!result.data || result.data.length === 0) {
    setDailyTaskNotice('Unable to delete task: permission denied or task not found.');
    return;
  }
  if (task.employee_id === state.currentEmployeeId) recordTaskActivity();

  // Remove from local state immediately for instant UI feedback
  state.dailyTasks = state.dailyTasks.filter((t) => t.id !== taskId);
  renderDailyTaskViews();
  setDailyTaskNotice('Task deleted.');
}

async function promoteTaskToToday(taskId) {
  if (!taskId) return;
  const task = state.dailyTasks.find((item) => item.id === taskId) || null;
  if (!canManageTask(task)) return;

  const todayIso = toISODateLocal();

  // Prevent duplicate copies (case-insensitive to match DB unique index)
  const taskKey = taskTitleKey(task.task_title);
  const alreadyCopied = state.dailyTasks.some(
    (t) =>
      taskTitleKey(t.task_title) === taskKey &&
      t.employee_id === task.employee_id &&
      t.task_date === todayIso &&
      t.status !== 'archived'
  );
  if (alreadyCopied) {
    setDailyTaskNotice('This task is already on today\u2019s list.');
    return;
  }

  const copyData = {
    employee_id: task.employee_id,
    task_date: todayIso,
    task_title: task.task_title,
    status: 'in_progress',
    notes: task.notes || null,
    description: task.description || null,
    deadline: task.deadline || null
  };

  if (!state.supabase || !state.isAuthenticated) {
    state.dailyTasks.push({ ...copyData, id: `local-${Date.now()}` });
    renderDailyTaskViews();
    setDailyTaskNotice('Task copied to Today.');
    return;
  }

  if (isLeadershipRole()) {
    const insertResult = await state.supabase.from('daily_tasks').insert(copyData);
    if (insertResult.error) {
      setDailyTaskNotice(`Unable to copy task: ${insertResult.error.message}`);
      return;
    }
  } else {
    const createResult = await state.supabase.rpc('create_daily_task', {
      p_task_date: todayIso,
      p_task_title: task.task_title,
      p_notes: task.notes || null,
      p_status: 'in_progress',
      p_description: task.description || null,
      p_deadline: task.deadline || null
    });
    if (createResult.error) {
      setDailyTaskNotice(`Unable to copy task: ${createResult.error.message}`);
      return;
    }
  }

  setDailyTaskNotice('Task copied to Today.');
  // Moving your own work into Today is the daily ritual — it has to count.
  if (task.employee_id === state.currentEmployeeId) recordTaskActivity();
  await loadDailyTasksFromSupabase();
}

async function demoteTaskToWeekly(taskId) {
  if (!taskId) return;
  const task = state.dailyTasks.find((item) => item.id === taskId) || null;
  if (!canManageTask(task) || task.task_date === null) return;

  if (!state.supabase || !state.isAuthenticated) {
    state.dailyTasks = state.dailyTasks.filter((t) => t.id !== taskId);
    renderDailyTaskViews();
    setDailyTaskNotice('Removed from today. Task stays in Weekly Planner.');
    return;
  }

  let deleteQuery = state.supabase.from('daily_tasks').delete().eq('id', taskId).select();
  if (task.employee_id === state.currentEmployeeId) {
    deleteQuery = deleteQuery.eq('employee_id', state.currentEmployeeId);
  }
  const result = await deleteQuery;
  if (result.error) {
    setDailyTaskNotice(`Unable to remove from today: ${result.error.message}`);
    return;
  }
  if (!result.data || result.data.length === 0) {
    setDailyTaskNotice('Unable to remove task: permission denied or task not found.');
    return;
  }

  state.dailyTasks = state.dailyTasks.filter((t) => t.id !== taskId);
  if (task.employee_id === state.currentEmployeeId) recordTaskActivity();
  renderDailyTaskViews();
  setDailyTaskNotice('Removed from today. Task stays in Weekly Planner.');
}

// ── Task streaks ────────────────────────────────────────────────────────────
// Recorded when a PERSON acts on their own tasks. Never inferred from row
// timestamps: the nightly cleanup archives and carries tasks forward, so
// updated_at would credit everyone with a streak they never earned.
let streakActivityDates = new Set();   // 'YYYY-MM-DD' for me
let streakMyLeaveDates = new Set();    // my approved leave, so it never breaks my streak
let streakLeaderboard = [];            // [{ name, count }], only those on a run
let streakTeamSize = 0;                // everyone counted, so the rank has a stable denominator

function renderStreakStrip() {
  const wrap = document.getElementById('homeStreakPanel');
  if (!wrap) return;
  if (!state.currentEmployeeId || !streakLeaderboard) { wrap.classList.add('hidden'); return; }

  const today = istToday();
  const mine = computeStreak(streakActivityDates, today, holidayDates(), streakMyLeaveDates);
  const progress = streakProgress(mine.count);
  const top = streakLeaderboard.slice(0, 3);
  // Rank among the team, shown only once you actually have a streak.
  const myIndex = streakLeaderboard.findIndex((p) => p.id === state.currentEmployeeId);
  const myRank = mine.count > 0 && myIndex >= 0 ? myIndex + 1 : null;

  // Show a zero state rather than hiding: on launch day nobody has a streak, and
  // an invisible feature is one nobody starts (26 Aug 2026).
  const empty = !mine.count && !top.length;

  // Celebrated the day it lands, then it clears itself. Broken streaks are
  // never announced — the point is to restart quietly, not to be seen falling.
  const milestoneRows = streakLeaderboard
    .filter((p) => milestoneReached(p.count))
    .map((p) => `<span class="streak-pill is-milestone">🎉 ${escapeHtml(p.name)} hit <b>${milestoneLabel(p.count)}</b></span>`);

  const meId = state.currentEmployeeId;
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
    ${milestoneRows.length ? `<div class="streak-milestone"><span class="streak-lead-label">Milestone</span>${milestoneRows.join('')}</div>` : ''}
    <div class="streak-strip">
      <div class="streak-mine">
        <span class="streak-flame">${mine.count ? '🔥' : '·'}</span>
        <span class="streak-count">${mine.count}<small>day streak</small></span>
      </div>
      <div class="streak-progress">
        ${empty ? '' : `<div class="streak-bar"><i style="width:${progress.next ? progress.percent : 100}%"></i></div>`}
        ${myRank ? `<p class="streak-rank">You're ${ordinal(myRank)} of ${streakTeamSize}</p>` : ''}
        <p class="streak-next">${empty
          ? 'Update any task today to start your streak.'
          : (progress.next
            ? `Next: <b>${milestoneLabel(progress.next)}</b> — ${progress.remaining} working day${progress.remaining === 1 ? '' : 's'} to go`
            : 'Every milestone reached. Nothing left to chase.')}</p>
      </div>
      <div class="streak-lead">
        ${top.length ? '<span class="streak-lead-label">Leading now</span>' : ''}
        ${top.map((p) => `<span class="streak-pill${p.id === meId ? ' is-me' : ''}">🔥 <b>${p.count}</b> ${escapeHtml(p.name.split(' ')[0])}</span>`).join('')}
        <span class="streak-help">
          <button class="streak-help-btn" type="button" id="streakHelpBtn">ⓘ How streaks work</button>
          <div class="streak-tip hidden" id="streakTip">
            <h4>How streaks work</h4>
            <ul>
              <li>Update <b>any one task</b> on a working day and the day counts.</li>
              <li>Weekends, public holidays and approved leave <b>never break</b> a streak — they simply don't count.</li>
              <li>Everyone gets <b>one grace day a month</b>, applied automatically if you miss a day.</li>
            </ul>
            <p class="rungs">Milestones: <b>${STREAK_MILESTONES.join(' · ')}</b><br>A half-day off at <b>${STREAK_REWARD_DAY} days</b>.</p>
          </div>
        </span>
      </div>
    </div>`;

  document.getElementById('streakHelpBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('streakTip')?.classList.toggle('hidden');
  });
}

// Click anywhere else to dismiss the explainer.
document.addEventListener('click', (e) => {
  const tip = document.getElementById('streakTip');
  if (tip && !tip.classList.contains('hidden') && !e.target.closest('.streak-help')) tip.classList.add('hidden');
});

// Everyone's last ~5 months of activity plus approved leave: enough history to
// resolve any streak worth showing, small enough to fetch in one go.
async function loadStreakData() {
  if (!state.supabase || !state.currentEmployeeId) return;
  const since = shiftIsoDays(istToday(), -170);
  const [actRes, leaveRes] = await Promise.all([
    state.supabase.from('task_activity').select('employee_id, activity_date').gte('activity_date', since),
    state.supabase.from('leave_requests').select('employee_id, start_date, end_date').eq('status', 'approved').gte('end_date', since)
  ]);
  if (actRes.error) { console.warn('Streaks unavailable:', actRes.error.message); return; }

  const byEmployee = new Map();
  (actRes.data || []).forEach((r) => {
    if (!byEmployee.has(r.employee_id)) byEmployee.set(r.employee_id, new Set());
    byEmployee.get(r.employee_id).add(r.activity_date);
  });

  // Approved leave expanded to individual dates, so a fortnight off does not
  // read as a fortnight of missed days.
  const leaveByEmployee = new Map();
  (leaveRes.data || []).forEach((r) => {
    if (!leaveByEmployee.has(r.employee_id)) leaveByEmployee.set(r.employee_id, new Set());
    const set = leaveByEmployee.get(r.employee_id);
    let d = r.start_date;
    for (let i = 0; i < 60 && d <= r.end_date; i++) { set.add(d); d = shiftIsoDays(d, 1); }
  });

  const today = istToday();
  const hols = holidayDates();
  streakActivityDates = byEmployee.get(state.currentEmployeeId) || new Set();
  streakMyLeaveDates = leaveByEmployee.get(state.currentEmployeeId) || new Set();

  const hidden = getHiddenEmployeeEmails();
  const considered = (state.employeeDirectory || [])
    .filter((e) => e.is_active !== false && !hidden.includes(normalizeEmail(e.email)));
  streakTeamSize = considered.length;
  streakLeaderboard = considered
    .map((e) => ({
      id: e.id,
      name: displayPersonName(e.full_name, 'Employee'),
      count: computeStreak(byEmployee.get(e.id) || new Set(), today, hols, leaveByEmployee.get(e.id) || new Set()).count
    }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  renderStreakStrip();
}

let streakWriteInFlight = false;

async function recordTaskActivity() {
  if (!state.supabase || !state.currentEmployeeId || streakWriteInFlight) return;
  // IST, because the insert policy pins activity_date to the agency day.
  const today = istToday();
  if (streakActivityDates.has(today)) return;
  streakWriteInFlight = true;
  // Fire and forget — a streak must never delay or fail a task action.
  state.supabase.from('task_activity')
    .insert({ employee_id: state.currentEmployeeId, activity_date: today })
    .then(({ error }) => {
      streakWriteInFlight = false;
      const duplicate = error && String(error.message || '').toLowerCase().includes('duplicate');
      if (error && !duplicate) {
        // Do NOT mark the day as logged: a later action in this session should
        // get another chance rather than the streak being lost silently.
        console.warn('Streak activity not recorded:', error.message);
        return;
      }
      streakActivityDates.add(today);
      renderStreakStrip();
    });
}

async function updateTaskStatus(taskId, newStatus) {
  const task = state.dailyTasks.find((t) => t.id === taskId);
  if (!task || !canManageTask(task)) return;
  if (task.status === 'archived') return;

  // Lock previous days — only today's tasks can change status
  if (task.task_date !== null && task.task_date !== toISODateLocal()) return;

  if (!state.supabase || !state.isAuthenticated) {
    task.status = newStatus;
    if (newStatus === 'done') {
      handleDoneCascadeLocal(task);
    } else {
      syncLinkedTaskStatusLocal(task, newStatus);
    }
    renderDailyTaskViews();
    return;
  }

  let updateQuery = state.supabase.from('daily_tasks').update({ status: newStatus }).eq('id', taskId).select();
  if (task.employee_id === state.currentEmployeeId) {
    updateQuery = updateQuery.eq('employee_id', state.currentEmployeeId);
  }
  const result = await updateQuery;
  // Your own tasks only — a lead updating someone else's row is not that
  // person's streak, and is not the lead's either.
  if (!result.error && task.employee_id === state.currentEmployeeId) recordTaskActivity();

  if (result.error) {
    setDailyTaskNotice(`Status update failed: ${result.error.message}`);
    renderDailyTaskViews();
    return;
  }
  if (!result.data || result.data.length === 0) {
    setDailyTaskNotice('Status update failed: permission denied.');
    renderDailyTaskViews();
    return;
  }

  task.status = newStatus;

  if (newStatus === 'done') {
    await handleDoneCascade(task);
  } else {
    await syncLinkedTaskStatus(task, newStatus);
  }

  renderDailyTaskViews();
}

// Sibling selection for both cascade functions lives in js/tasks.js
// (linkedTasksFor, unit-tested) — daily done cascades to the weekly original +
// all other daily copies; weekly done cascades to all daily copies.
function handleDoneCascadeLocal(task) {
  linkedTasksFor(task, state.dailyTasks, 'cascade-done').forEach((sib) => { sib.status = 'done'; });
}

async function handleDoneCascade(task) {
  const siblings = linkedTasksFor(task, state.dailyTasks, 'cascade-done');
  for (const sib of siblings) {
    let cascadeQuery = state.supabase
      .from('daily_tasks')
      .update({ status: 'done' })
      .eq('id', sib.id);
    if (sib.employee_id === state.currentEmployeeId) {
      cascadeQuery = cascadeQuery.eq('employee_id', state.currentEmployeeId);
    }
    const cascadeResult = await cascadeQuery;
    if (!cascadeResult.error) {
      sib.status = 'done';
    }
  }
}

// Status-sync selection also lives in js/tasks.js — 'sync-status' mode targets
// the weekly original (for a daily change) or all daily copies (for a weekly
// change), and unlike cascade-done it can move tasks OUT of done.
function syncLinkedTaskStatusLocal(task, newStatus) {
  linkedTasksFor(task, state.dailyTasks, 'sync-status').forEach((t) => { t.status = newStatus; });
}

async function syncLinkedTaskStatus(task, newStatus) {
  const linked = linkedTasksFor(task, state.dailyTasks, 'sync-status');
  for (const t of linked) {
    let q = state.supabase.from('daily_tasks').update({ status: newStatus }).eq('id', t.id);
    if (t.employee_id === state.currentEmployeeId) q = q.eq('employee_id', state.currentEmployeeId);
    const res = await q;
    if (!res.error) t.status = newStatus;
  }
}

function editTaskById(taskId) {
  const task = state.dailyTasks.find((item) => item.id === taskId) || null;
  if (!task || !canManageTask(task)) return;

  // Single-row edit: if another row is already mid-edit, collapse it first
  // (re-render resets every row to display). Previously several rows could be
  // open at once, and saving one re-rendered the list and silently wiped the
  // unsaved edits in the others. Now only one row is editable at a time.
  if (document.querySelector('[data-task-action="save-edit"]')) {
    renderDailyTaskViews();
  }

  const row = document.querySelector(`[data-task-action="edit"][data-task-id="${taskId}"]`)?.closest('tr');
  if (!row) return;

  const clientOptions = taskClientNamesFromState()
    .map(n => `<option value="${escapeHtml(n)}"${n === task.notes ? ' selected' : ''}>${escapeHtml(n)}</option>`)
    .join('');

  row.innerHTML = `
    <td data-label="Priority"><select class="priority-input" data-task-id="${task.id}"><option value="0">\u2013</option>${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}"${(task.sort_order || 0) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></td>
    <td><input type="text" class="edit-task-title" value="${escapeHtml(task.task_title || '')}" maxlength="25" /></td>
    <td><select class="edit-task-client"><option value="">Select client</option>${clientOptions}</select></td>
    <td><input type="text" class="edit-task-desc" value="${escapeHtml(task.description || '')}" placeholder="Optional" maxlength="${TASK_DESCRIPTION_MAX}" /></td>
    <td>
      <select class="status-select" data-task-id="${task.id}">
        <option value="in_progress"${task.status !== 'done' ? ' selected' : ''}>In progress</option>
        <option value="done"${task.status === 'done' ? ' selected' : ''}>Completed</option>
      </select>
    </td>
    <td>
      <button class="ghost small" data-task-action="save-edit" data-task-id="${task.id}">Save</button>
      <button class="ghost small" data-task-action="cancel-edit" data-task-id="${task.id}">Cancel</button>
    </td>
  `;

  row.querySelector('.edit-task-title')?.focus();
}

async function saveTaskEdit(taskId) {
  const task = state.dailyTasks.find((item) => item.id === taskId) || null;
  if (!task || !canManageTask(task)) return;

  const row = document.querySelector(`[data-task-action="save-edit"][data-task-id="${taskId}"]`)?.closest('tr');
  if (!row) return;

  const nextTitle = String(row.querySelector('.edit-task-title')?.value || '').trim();
  const nextClient = String(row.querySelector('.edit-task-client')?.value || '').trim();
  const nextDescription = String(row.querySelector('.edit-task-desc')?.value || '').trim() || null;

  if (!nextTitle) { setDailyTaskNotice('Task title cannot be empty.'); return; }
  if (nextTitle.length > 25) { setDailyTaskNotice('Task title must be 25 characters or less.'); return; }
  if (!nextClient) { setDailyTaskNotice('Client cannot be empty.'); return; }
  if (nextDescription && nextDescription.length > TASK_DESCRIPTION_MAX) { setDailyTaskNotice(`Description must be ${TASK_DESCRIPTION_MAX} characters or less.`); return; }

  const updates = { task_title: nextTitle, notes: nextClient, description: nextDescription };

  if (!state.supabase || !state.isAuthenticated) {
    Object.assign(task, updates);
    renderDailyTaskViews();
    setDailyTaskNotice('Task updated locally.');
    return;
  }

  let updateQuery = state.supabase.from('daily_tasks').update(updates).eq('id', taskId);
  if (task.employee_id === state.currentEmployeeId) {
    updateQuery = updateQuery.eq('employee_id', state.currentEmployeeId);
  }
  const result = await updateQuery;
  if (result.error) {
    setDailyTaskNotice(`Task update failed: ${result.error.message}`);
    return;
  }

  if (task.employee_id === state.currentEmployeeId) recordTaskActivity();
  const oldTitle = task.task_title;
  const oldClient = task.notes;
  const isWeekly = task.task_date === null;
  Object.assign(task, updates);

  // Cascade title/client/description edits to keep weekly↔daily in sync
  const nextDesc = updates.description;
  if (oldTitle !== nextTitle || oldClient !== nextClient || task.description !== nextDesc) {
    if (isWeekly) {
      // Weekly edited → update all daily copies
      const oldKey = taskTitleKey(oldTitle);
      const dailyCopies = state.dailyTasks.filter(
        (t) => taskTitleKey(t.task_title) === oldKey && t.notes === oldClient &&
               t.employee_id === task.employee_id &&
               t.task_date !== null && t.status !== 'archived' && t.id !== task.id
      );
      for (const daily of dailyCopies) {
        let cq = state.supabase.from('daily_tasks').update(updates).eq('id', daily.id);
        if (daily.employee_id === state.currentEmployeeId) cq = cq.eq('employee_id', state.currentEmployeeId);
        const cRes = await cq;
        if (!cRes.error) Object.assign(daily, updates);
      }
    } else {
      // Daily edited → update the weekly original
      const oldKey = taskTitleKey(oldTitle);
      const weeklyOriginal = state.dailyTasks.find(
        (t) => taskTitleKey(t.task_title) === oldKey && t.notes === oldClient &&
               t.employee_id === task.employee_id &&
               t.task_date === null && t.status !== 'archived' && t.id !== task.id
      );
      if (weeklyOriginal) {
        let wq = state.supabase.from('daily_tasks').update(updates).eq('id', weeklyOriginal.id);
        if (weeklyOriginal.employee_id === state.currentEmployeeId) wq = wq.eq('employee_id', state.currentEmployeeId);
        const wRes = await wq;
        if (!wRes.error) Object.assign(weeklyOriginal, updates);
      }
    }
  }

  renderDailyTaskViews();
  setDailyTaskNotice('Task updated.');
}

function syncTaskManagerUi() {
  const managerMode = isLeadershipRole();
  taskEmployeeFilterWrap?.classList.toggle('hidden', !managerMode);
  renderDailyTaskViews();
}

if (taskEmployeeFilter) {
  taskEmployeeFilter.addEventListener('change', () => {
    state.taskViewEmployeeId = taskEmployeeFilter.value || null;
    renderDailyTaskViews();
  });
}

if (archiveDayDetailClose) {
  archiveDayDetailClose.addEventListener('click', () => {
    archiveDayDetail?.classList.add('hidden');
    archiveDayDetail?.closest('.archive-layout')?.classList.remove('has-detail');
    taskArchiveCalendar?.querySelectorAll('.archive-cell').forEach((c) => c.classList.remove('selected-day'));
  });
}

// ── Recurring tasks: form controls + manage list ──
(function wireRecurringControls() {
  const sel = document.getElementById('newTaskRepeatSelect');
  const daySel = document.getElementById('newTaskRepeatDay');
  const wdaySel = document.getElementById('newTaskRepeatWeekday');
  if (!sel || !daySel || !wdaySel) return;
  daySel.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}"${i + 1 === new Date().getDate() ? ' selected' : ''}>on the ${i + 1}</option>`).join('');
  // Value is the 0=Sunday index the DB stores; the list starts at Monday
  // because that is how the team reads a week.
  wdaySel.innerHTML = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => `<option value="${d}"${d === new Date().getDay() ? ' selected' : ''}>every ${WEEKDAY_NAMES[d]}</option>`).join('');
  // Only one day picker is ever visible, so the two can't disagree.
  sel.addEventListener('change', () => {
    daySel.classList.toggle('hidden', sel.value !== 'monthly');
    wdaySel.classList.toggle('hidden', sel.value !== 'weekly');
  });
})();

async function loadRecurringTasks() {
  if (!state.supabase || !state.isAuthenticated) return;
  const res = await state.supabase.from('recurring_tasks').select('*').eq('is_active', true)
    .order('frequency').order('day_of_week', { nullsFirst: false }).order('day_of_month', { nullsFirst: false });
  if (res.error) { console.warn('Recurring load failed:', res.error.message); return; }
  const list = document.getElementById('recurringTasksList');
  const count = document.getElementById('recurringCount');
  if (!list) return;
  const rows = res.data || [];
  if (count) count.textContent = String(rows.length);
  list.innerHTML = rows.length ? rows.map(r => `
    <div class="notify-item" style="display:flex;align-items:center;gap:10px;cursor:default;">
      <span class="recur-mark" title="Repeats ${escapeHtml(recurringRuleLabel(r))}">\u21bb</span>
      <span style="flex:1;">${escapeHtml(r.task_title)} <span class="mini-meta">· ${escapeHtml(r.notes || '')} · ${escapeHtml(recurringRuleLabel(r))}</span></span>
      <button class="ghost small danger-text" type="button" data-stop-recurring="${escapeHtml(r.id)}">stop</button>
    </div>`).join('') : '<p class="mini-meta">None yet — pick "\u21bb Weekly" or "\u21bb Monthly" when adding a task.</p>';
}

document.getElementById('recurringTasksList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-stop-recurring]');
  if (!btn) return;
  if (!await appConfirm('Stop this repeating task? Already-created tasks stay.', { title: 'Stop repeating', confirmLabel: 'Stop', danger: true })) return;
  const res = await state.supabase.from('recurring_tasks').update({ is_active: false }).eq('id', btn.dataset.stopRecurring).select();
  if (res.error || !res.data?.length) { setDailyTaskNotice('Could not stop (permission?).'); return; }
  loadRecurringTasks().catch(console.error);
});

if (addWeeklyTaskBtn) {
  addWeeklyTaskBtn.addEventListener('click', () => {
    addTask(null).catch((error) => {
      console.error(error);
      setDailyTaskNotice(`Task add failed: ${error.message}`);
    });
  });
}


function handleTaskTableClick(event) {
  const actionBtn = event.target.closest('button[data-task-action]');
  if (!actionBtn) return;

  const action = actionBtn.dataset.taskAction;
  const taskId = actionBtn.dataset.taskId;

  if (action === 'delete') {
    deleteTaskById(taskId).catch((error) => {
      console.error(error);
      setDailyTaskNotice(`Unable to delete task: ${error.message}`);
    });
    return;
  }

  if (action === 'promote') {
    promoteTaskToToday(taskId).catch((error) => {
      console.error(error);
      setDailyTaskNotice(`Unable to copy task: ${error.message}`);
    });
    return;
  }

  if (action === 'demote') {
    demoteTaskToWeekly(taskId).catch((error) => {
      console.error(error);
      setDailyTaskNotice(`Unable to remove from today: ${error.message}`);
    });
    return;
  }

  if (action === 'edit') {
    editTaskById(taskId);
    return;
  }

  if (action === 'save-edit') {
    saveTaskEdit(taskId).catch((error) => {
      console.error(error);
      setDailyTaskNotice(`Unable to save task: ${error.message}`);
    });
    return;
  }

  if (action === 'cancel-edit') {
    renderDailyTaskViews();
  }
}

async function updateTaskSortOrder(taskId, newOrder) {
  const task = state.dailyTasks.find((t) => t.id === taskId);
  if (!task || !canManageTask(task)) return;

  const oldOrder = task.sort_order;
  task.sort_order = newOrder;

  if (state.supabase && state.isAuthenticated) {
    let updateQuery = state.supabase
      .from('daily_tasks')
      .update({ sort_order: newOrder })
      .eq('id', taskId);
    if (task.employee_id === state.currentEmployeeId) {
      updateQuery = updateQuery.eq('employee_id', state.currentEmployeeId);
    }
    const result = await updateQuery;
    if (result.error) {
      task.sort_order = oldOrder; // rollback
      console.error('Priority update failed:', result.error.message);
      setDailyTaskNotice(`Priority update failed: ${result.error.message}`);
      renderDailyTaskViews();
      return;
    }
  }

  renderDailyTaskViews();
}

function handleTaskTableChange(event) {
  const select = event.target.closest('select.status-select');
  if (select) {
    const taskId = select.dataset.taskId;
    const newStatus = select.value;
    updateTaskStatus(taskId, newStatus).catch((error) => {
      console.error(error);
      setDailyTaskNotice(`Status update failed: ${error.message}`);
    });
    return;
  }

  const priorityInput = event.target.closest('select.priority-input');
  if (priorityInput) {
    const taskId = priorityInput.dataset.taskId;
    const newOrder = parseInt(priorityInput.value, 10) || 0;
    updateTaskSortOrder(taskId, newOrder).catch((error) => {
      console.error(error);
      setDailyTaskNotice(`Priority update failed: ${error.message}`);
    });
  }
}

if (dailyTaskTableBody) {
  dailyTaskTableBody.addEventListener('click', handleTaskTableClick);
  dailyTaskTableBody.addEventListener('change', handleTaskTableChange);
}
if (weeklyPlannerTableBody) {
  weeklyPlannerTableBody.addEventListener('click', handleTaskTableClick);
  weeklyPlannerTableBody.addEventListener('change', handleTaskTableChange);
}

/* ── Feature Requests ── */

function setFeatureRequestNotice(message = '') {
  if (!featureRequestNotice) return;
  featureRequestNotice.textContent = message;
}

async function loadFeatureRequestsFromSupabase() {
  if (!state.supabase || !state.isAuthenticated) {
    state.featureRequests = [];
    renderFeatureRequests();
    return;
  }

  const response = await state.supabase
    .from('feature_requests')
    .select('id, employee_id, author_partner_id, author_name, request_text, request_type, status, created_at, updated_at, links, attachments, employee:employees!feature_requests_employee_id_fkey(full_name)')
    .order('created_at', { ascending: true })
    .limit(2000);

  if (response.error) {
    console.error(response.error);
    setFeatureRequestNotice(`Unable to load feature requests: ${response.error.message}`);
    return;
  }

  state.loadedAt.featureRequests = Date.now();
  const requests = (response.data || []).map(r => ({
    ...r,
    // Partner-authored posts carry a denormalized author_name (partners can't
    // be joined through employees); employee posts keep the join.
    author_name: r.employee?.full_name
      ? displayPersonName(r.employee.full_name, 'Unknown')
      : (r.author_name || 'Unknown'),
    replies: []
  }));

  // Batch-load all replies
  const repliesRes = await state.supabase
    .from('feature_request_replies')
    .select('id, feature_request_id, employee_id, author_partner_id, author_name, reply_text, created_at, attachments, employee:employees!feature_request_replies_employee_id_fkey(full_name)')
    .order('created_at', { ascending: true })
    .limit(2000);

  if (!repliesRes.error && repliesRes.data) {
    const byFr = {};
    for (const r of repliesRes.data) {
      const frId = r.feature_request_id;
      if (!byFr[frId]) byFr[frId] = [];
      byFr[frId].push({
        ...r,
        author_name: r.employee?.full_name
          ? displayPersonName(r.employee.full_name, 'Unknown')
          : (r.author_name || 'Unknown')
      });
    }
    for (const req of requests) {
      req.replies = byFr[req.id] || [];
    }
  }

  // Batch-load all upvotes
  const upvotesRes = await state.supabase
    .from('feature_request_upvotes')
    .select('feature_request_id, employee_id')
    .limit(2000);

  if (!upvotesRes.error && upvotesRes.data) {
    const byFr = {};
    for (const u of upvotesRes.data) {
      const frId = u.feature_request_id;
      if (!byFr[frId]) byFr[frId] = [];
      byFr[frId].push(u.employee_id);
    }
    for (const req of requests) {
      req.upvote_employee_ids = byFr[req.id] || [];
    }
  }

  // Sort by upvote count (most popular first), then by created_at
  requests.sort((a, b) => {
    const diff = (b.upvote_employee_ids?.length || 0) - (a.upvote_employee_ids?.length || 0);
    return diff !== 0 ? diff : new Date(a.created_at) - new Date(b.created_at);
  });

  state.featureRequests = requests;
  renderFeatureRequests();
}

// Shared reply renderer — used by the active cards AND the completed section
// (completed items expand on click to show their reply thread).
function renderFrReply(reply) {
  const rts = new Date(reply.created_at);
  const rTimeStr = rts.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    + ' · ' + rts.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const replyAttach = (reply.attachments || []).length ? `<div class="fr-attachments">${(reply.attachments || []).map(a =>
    `<a href="#" class="fr-attachment-thumb" data-storage-path="${escapeHtml(a.path)}" title="${escapeHtml(a.name)}"><img class="fr-thumb-img" data-storage-path="${escapeHtml(a.path)}" alt="${escapeHtml(a.name)}"></a>`
  ).join('')}</div>` : '';
  return `<div class="fr-reply" data-reply-id="${reply.id}">
    <div class="fr-reply-head">
      <strong>${escapeHtml(reply.author_name)}</strong>
      <span>${rTimeStr}</span>
    </div>
    <div class="fr-reply-body">${escapeHtml(reply.reply_text).replace(/\n/g, '<br>')}</div>
    ${replyAttach}
  </div>`;
}

function renderFeatureRequests() {
  if (!featureRequestThread) return;

  const activeRequests = state.featureRequests.filter(fr => fr.status !== 'done' && fr.status !== 'archived');
  const doneRequests = state.featureRequests.filter(fr => fr.status === 'done');
  const archivedRequests = state.featureRequests.filter(fr => fr.status === 'archived');

  // Render completed section — split into Features and Bugs
  if (frCompletedList) {
    if (!doneRequests.length) {
      frCompletedList.innerHTML = '<p class="mini-meta">No completed requests yet.</p>';
    } else {
      // Latest completed first (updated_at = completion time)
      const byLatestDone = (a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
      const doneFeatures = doneRequests.filter(fr => fr.request_type !== 'bug').sort(byLatestDone);
      const doneBugs = doneRequests.filter(fr => fr.request_type === 'bug').sort(byLatestDone);

      const renderCompletedItem = (fr) => {
        const ts = new Date(fr.updated_at || fr.created_at);
        const dateStr = ts.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        const isBug = fr.request_type === 'bug';
        const isOwner = fr.employee_id === state.currentEmployeeId;
        const reopenBtn = (isBug && (isOwner || isSuperadminUser()))
          ? ` <button class="ghost small" data-fr-action="reopen" data-fr-id="${fr.id}">Re-open</button>`
          : '';
        // Replies stay hidden until the item is clicked — so what was said
        // (diagnosis, fix notes) is discoverable without cluttering the list.
        const replies = fr.replies || [];
        const replyCount = replies.length
          ? ` · <span class="fr-completed-reply-count">💬 ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}</span>`
          : '';
        const repliesBlock = replies.length
          ? `<div class="fr-completed-replies" style="display:none">${replies.map(renderFrReply).join('')}</div>`
          : '';
        return `<div class="fr-completed-item${replies.length ? ' fr-completed-expandable' : ''}">
          <div class="fr-completed-text">${escapeHtml(fr.request_text)}</div>
          <div class="fr-completed-meta">by ${escapeHtml(fr.author_name)} · completed ${dateStr}${replyCount}${reopenBtn}</div>
          ${repliesBlock}
        </div>`;
      };

      const featuresHtml = doneFeatures.length
        ? doneFeatures.map(renderCompletedItem).join('')
        : '<p class="mini-meta">No completed features yet.</p>';
      const bugsHtml = doneBugs.length
        ? doneBugs.map(renderCompletedItem).join('')
        : '<p class="mini-meta">No resolved bugs yet.</p>';

      frCompletedList.innerHTML = `
        <div class="fr-completed-columns">
          <div class="fr-completed-column">
            <h4 class="fr-completed-section-label">Features</h4>
            ${featuresHtml}
          </div>
          <div class="fr-completed-column">
            <h4 class="fr-completed-section-label">Bugs</h4>
            ${bugsHtml}
          </div>
        </div>`;
    }
  }

  // Render archived section (collapsed by default)
  const frArchivedPanel = document.getElementById('frArchivedPanel');
  if (frArchivedPanel) {
    if (!archivedRequests.length) {
      frArchivedPanel.style.display = 'none';
    } else {
      frArchivedPanel.style.display = '';
      const archivedList = document.getElementById('frArchivedList');
      if (archivedList) {
        const isSA = isSuperadminUser();
        archivedRequests.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
        archivedList.innerHTML = archivedRequests.map(fr => {
          const ts = new Date(fr.updated_at || fr.created_at);
          const dateStr = ts.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
          const isBug = fr.request_type === 'bug';
          const typeChip = isBug
            ? '<span class="fr-type-chip fr-type-bug">Bug</span>'
            : '<span class="fr-type-chip fr-type-feature">Feature</span>';
          const restoreBtn = isSA
            ? ` <button class="ghost small" data-fr-action="unarchive" data-fr-id="${fr.id}">Restore</button>`
            : '';
          return `<div class="fr-completed-item">
            <div class="fr-completed-text">${typeChip} ${escapeHtml(fr.request_text)}</div>
            <div class="fr-completed-meta">by ${escapeHtml(fr.author_name)} · archived ${dateStr}${restoreBtn}</div>
          </div>`;
        }).join('');
      }
    }
  }

  if (!activeRequests.length) {
    featureRequestThread.innerHTML = '<p class="mini-meta">No open bugs or feature requests. Be the first!</p>';
    return;
  }

  // Most recent on top
  const byNewest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
  const featureItems = activeRequests.filter(fr => fr.request_type !== 'bug').sort(byNewest);
  const bugItems = activeRequests.filter(fr => fr.request_type === 'bug').sort(byNewest);

  const isSuperAdmin = isSuperadminUser();
  const myId = state.currentEmployeeId;

  const renderCard = (fr) => {
    const ts = new Date(fr.created_at);
    const timeStr = ts.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      + ' · ' + ts.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    const statusLabel = fr.status === 'in_progress' ? 'In Progress'
      : fr.status === 'done' ? 'Done' : 'Requested';
    const statusClass = fr.status === 'in_progress' ? 'in-progress'
      : fr.status === 'done' ? 'done' : 'requested';

    const canEdit = fr.employee_id === myId && fr.status === 'requested';

    let statusHtml;
    if (isSuperAdmin) {
      statusHtml = `<select class="fr-status-select" data-fr-id="${fr.id}">
        <option value="requested"${fr.status === 'requested' ? ' selected' : ''}>Requested</option>
        <option value="in_progress"${fr.status === 'in_progress' ? ' selected' : ''}>In Progress</option>
        <option value="done"${fr.status === 'done' ? ' selected' : ''}>Done</option>
      </select>`;
    } else {
      statusHtml = `<span class="fr-status ${statusClass}">${statusLabel}</span>`;
    }

    const editBtn = canEdit
      ? ` <button class="ghost small" data-fr-action="edit" data-fr-id="${fr.id}">Edit</button>`
      : '';
    const deleteBtn = canEdit
      ? ` <button class="ghost small danger-text" data-fr-action="delete" data-fr-id="${fr.id}">Delete</button>`
      : '';

    const upvoteIds = fr.upvote_employee_ids || [];
    const upvoteCount = upvoteIds.length;
    const hasUpvoted = upvoteIds.includes(myId);
    const upvoteBtn = `<button class="fr-upvote${hasUpvoted ? ' upvoted' : ''}" data-fr-action="upvote" data-fr-id="${fr.id}">\u25B2 ${upvoteCount}</button>`;

    // Replies
    const replies = fr.replies || [];
    const VISIBLE_COUNT = 2;
    const hasHidden = replies.length > VISIBLE_COUNT;
    const hiddenCount = replies.length - VISIBLE_COUNT;

    const renderReply = renderFrReply;

    let repliesHtml = '';
    if (replies.length) {
      const visibleReplies = hasHidden ? replies.slice(-VISIBLE_COUNT) : replies;
      const hiddenReplies = hasHidden ? replies.slice(0, -VISIBLE_COUNT) : [];

      repliesHtml = `<div class="fr-replies">`;
      if (hasHidden) {
        repliesHtml += `<div class="fr-reply-toggle" data-fr-action="toggle-replies" data-fr-id="${fr.id}">Show ${hiddenCount} earlier ${hiddenCount === 1 ? 'reply' : 'replies'}</div>`;
        repliesHtml += `<div class="fr-replies-hidden" data-fr-id="${fr.id}" style="display:none;flex-direction:column;gap:8px;">${hiddenReplies.map(renderReply).join('')}</div>`;
      }
      repliesHtml += visibleReplies.map(renderReply).join('');
      repliesHtml += `</div>`;
    }

    const replyForm = `<div class="fr-reply-form">
      <textarea class="fr-reply-input" data-fr-id="${fr.id}" rows="1" placeholder="Reply..."></textarea>
      <label class="fr-attach-label"><input type="file" class="fr-reply-file-input" data-fr-id="${fr.id}" accept="image/*" multiple hidden><span class="ghost small fr-attach-btn">📎</span></label>
      <button class="ghost small" data-fr-action="submit-reply" data-fr-id="${fr.id}">Reply</button>
    </div>
    <div class="fr-reply-pending fr-pending-files" data-fr-id="${fr.id}"></div>`;

    const isBug = fr.request_type === 'bug';
    let typeChipHtml;
    if (isSuperAdmin) {
      typeChipHtml = `<select class="fr-type-select" data-fr-id="${fr.id}">
        <option value="feature"${!isBug ? ' selected' : ''}>Feature</option>
        <option value="bug"${isBug ? ' selected' : ''}>Bug</option>
      </select>`;
    } else {
      typeChipHtml = isBug
        ? '<span class="fr-type-chip fr-type-bug">Bug</span>'
        : '<span class="fr-type-chip fr-type-feature">Feature</span>';
    }

    const archiveBtn = isSuperAdmin
      ? ` <button class="ghost small" data-fr-action="archive" data-fr-id="${fr.id}">Archive</button>`
      : '';

    // Links display
    const frLinks = fr.links || [];
    const linksHtml = frLinks.length ? `<div class="fr-links">${frLinks.map(url => {
      let label;
      try { label = new URL(url).hostname.replace('www.',''); } catch { label = 'link'; }
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="fr-link-pill">${escapeHtml(label)}</a>`;
    }).join('')}</div>` : '';

    // Attachments display
    const frAttachments = fr.attachments || [];
    const attachHtml = frAttachments.length ? `<div class="fr-attachments">${frAttachments.map(a =>
      `<a href="#" class="fr-attachment-thumb" data-storage-path="${escapeHtml(a.path)}" title="${escapeHtml(a.name)}"><img class="fr-thumb-img" data-storage-path="${escapeHtml(a.path)}" alt="${escapeHtml(a.name)}"></a>`
    ).join('')}</div>` : '';

    return `<div class="fr-card ${isBug ? 'fr-card-bug' : ''}" data-fr-id="${fr.id}">
      <div class="fr-card-head">
        ${typeChipHtml}
        <strong>${escapeHtml(fr.author_name)}</strong>
        <span class="mini-meta">${timeStr}</span>
      </div>
      <div class="fr-card-body">${escapeHtml(fr.request_text).replace(/\n/g, '<br>')}</div>
      ${linksHtml}
      ${attachHtml}
      <div class="fr-card-foot">
        ${upvoteBtn} ${statusHtml}${editBtn}${deleteBtn}${archiveBtn}
      </div>
      ${repliesHtml}
      ${replyForm}
    </div>`;
  };

  const featureHtml = featureItems.length
    ? featureItems.map(renderCard).join('')
    : '<p class="mini-meta">No feature requests yet.</p>';
  const bugHtml = bugItems.length
    ? bugItems.map(renderCard).join('')
    : '<p class="mini-meta">No bug reports yet.</p>';

  featureRequestThread.innerHTML = `
    <div class="fr-columns">
      <div class="fr-column">${featureHtml}</div>
      <div class="fr-column">${bugHtml}</div>
    </div>`;

  loadFeatureAttachmentThumbs();
}

async function loadFeatureAttachmentThumbs() {
  if (!state.supabase) return;
  const imgs = document.querySelectorAll('.fr-thumb-img[data-storage-path]');
  if (!imgs.length) return;
  // Batch-load signed URLs for all attachment thumbnails
  const paths = [...new Set([...imgs].map(img => img.dataset.storagePath))];
  const urlMap = {};
  for (const p of paths) {
    const { data } = await state.supabase.storage.from('feature-attachments').createSignedUrl(p, 3600);
    if (data?.signedUrl) urlMap[p] = data.signedUrl;
  }
  imgs.forEach(img => {
    const url = urlMap[img.dataset.storagePath];
    if (url) img.src = url;
  });
}

async function uploadFeatureAttachments(files) {
  if (!state.supabase || !files.length) return [];
  const empId = state.currentEmployeeId;
  const attachments = [];
  for (const file of files) {
    const filePath = `${empId}/${Date.now()}_${file.name}`;
    const { error } = await state.supabase.storage
      .from('feature-attachments')
      .upload(filePath, file, { upsert: false });
    if (error) {
      console.error('Attachment upload error:', error);
      continue;
    }
    attachments.push({ path: filePath, name: file.name, size: file.size });
  }
  return attachments;
}

function renderFrPendingFiles(containerOrId, files) {
  const container = typeof containerOrId === 'string'
    ? (document.getElementById(containerOrId) || document.querySelector(containerOrId))
    : containerOrId;
  if (!container) return;
  if (!files.length) { container.innerHTML = ''; return; }
  container.innerHTML = files.map((f, i) => {
    const thumbUrl = URL.createObjectURL(f);
    return `<div class="fr-pending-thumb" data-index="${i}">
      <img src="${thumbUrl}" alt="${escapeHtml(f.name)}">
      <button type="button" class="fr-remove-file" data-index="${i}">\u00d7</button>
    </div>`;
  }).join('');
}

async function submitFeatureRequest() {
  const text = String(newFeatureRequestInput?.value || '').trim();
  const typeSelect = document.getElementById('newFeatureRequestType');
  const linksInput = document.getElementById('newFeatureRequestLinks');
  const requestType = typeSelect?.value || 'feature';
  if (!text) {
    setFeatureRequestNotice('Please describe the bug or feature.');
    return;
  }

  if (!state.supabase || !state.isAuthenticated) {
    setFeatureRequestNotice('You must be signed in to submit.');
    return;
  }

  // Parse links — comma or space separated URLs
  const linksRaw = String(linksInput?.value || '').trim();
  const links = linksRaw
    ? linksRaw.split(/[,\s]+/).filter(l => l.startsWith('http'))
    : [];

  const submitBtn = document.getElementById('submitFeatureRequestBtn');
  if (submitBtn) submitBtn.disabled = true;

  // Upload attachments if any
  let attachments = [];
  if (state.frPendingFiles && state.frPendingFiles.length) {
    setFeatureRequestNotice('Uploading attachments...');
    attachments = await uploadFeatureAttachments(state.frPendingFiles);
  }

  const result = await state.supabase.from('feature_requests').insert({
    employee_id: state.currentEmployeeId,
    request_text: text,
    request_type: requestType,
    links: links,
    attachments: attachments
  }).select('id').single();

  if (submitBtn) submitBtn.disabled = false;

  if (result.error) {
    setFeatureRequestNotice(`Submit failed: ${result.error.message}`);
    return;
  }

  // Notify admin on new posts (bugs AND feature requests)
  if (result.data?.id) {
    notifyFeatureRequestOwner('new_bug', result.data.id);
  }

  if (newFeatureRequestInput) newFeatureRequestInput.value = '';
  if (linksInput) linksInput.value = '';
  state.frPendingFiles = [];
  const pendingContainer = document.getElementById('frPendingFiles');
  if (pendingContainer) pendingContainer.innerHTML = '';
  setFeatureRequestNotice('Request submitted!');
  await loadFeatureRequestsFromSupabase();
}

function editFeatureRequest(frId) {
  const fr = state.featureRequests.find(r => r.id === frId);
  if (!fr || fr.employee_id !== state.currentEmployeeId || fr.status !== 'requested') return;

  const card = featureRequestThread?.querySelector(`.fr-card[data-fr-id="${frId}"]`);
  if (!card) return;

  const body = card.querySelector('.fr-card-body');
  if (!body) return;

  body.innerHTML = `<textarea class="fr-edit-text" rows="3">${escapeHtml(fr.request_text)}</textarea>
    <div style="margin-top:6px;display:flex;gap:6px;">
      <button class="ghost small" data-fr-action="save-edit" data-fr-id="${frId}">Save</button>
      <button class="ghost small" data-fr-action="cancel-edit" data-fr-id="${frId}">Cancel</button>
    </div>`;

  body.querySelector('.fr-edit-text')?.focus();
}

async function saveFeatureRequestEdit(frId) {
  const fr = state.featureRequests.find(r => r.id === frId);
  if (!fr) return;

  const card = featureRequestThread?.querySelector(`.fr-card[data-fr-id="${frId}"]`);
  const textarea = card?.querySelector('.fr-edit-text');
  if (!textarea) return;

  const newText = String(textarea.value || '').trim();
  if (!newText) {
    setFeatureRequestNotice('Request text cannot be empty.');
    return;
  }

  if (!state.supabase || !state.isAuthenticated) return;

  const result = await state.supabase.from('feature_requests')
    .update({ request_text: newText })
    .eq('id', frId)
    .eq('employee_id', state.currentEmployeeId);

  if (result.error) {
    setFeatureRequestNotice(`Edit failed: ${result.error.message}`);
    return;
  }

  fr.request_text = newText;
  setFeatureRequestNotice('Request updated.');
  renderFeatureRequests();
}

function notifyFeatureRequestOwner(type, featureRequestId, extra = {}) {
  if (!state.session?.access_token) return;
  const actorName = displayPersonName(state.employeeProfile?.full_name || '', 'Someone');
  fetch('/api/feature-request-notify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.session.access_token}`
    },
    body: JSON.stringify({ type, featureRequestId, actorName, ...extra })
  }).catch(err => console.error('Feature request notification failed:', err));
}

function notifyClientStatusChange(type, extra = {}) {
  if (!state.session?.access_token) return;
  const actorName = displayPersonName(state.employeeProfile?.full_name || '', 'Someone');
  fetch('/api/client-status-notify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.session.access_token}`
    },
    body: JSON.stringify({ type, actorName, ...extra })
  }).catch(err => console.error('Client status notification failed:', err));
}

async function toggleFeatureRequestUpvote(frId) {
  if (!state.supabase || !state.isAuthenticated) return;

  const fr = state.featureRequests.find(r => r.id === frId);
  if (!fr) return;

  const ids = fr.upvote_employee_ids || [];
  const hasUpvoted = ids.includes(state.currentEmployeeId);

  if (hasUpvoted) {
    const result = await state.supabase.from('feature_request_upvotes')
      .delete()
      .eq('feature_request_id', frId)
      .eq('employee_id', state.currentEmployeeId);
    if (result.error) {
      setFeatureRequestNotice(`Upvote failed: ${result.error.message}`);
      return;
    }
    fr.upvote_employee_ids = ids.filter(id => id !== state.currentEmployeeId);
  } else {
    const result = await state.supabase.from('feature_request_upvotes').insert({
      feature_request_id: frId,
      employee_id: state.currentEmployeeId
    });
    if (result.error) {
      setFeatureRequestNotice(`Upvote failed: ${result.error.message}`);
      return;
    }
    fr.upvote_employee_ids = [...ids, state.currentEmployeeId];
    notifyFeatureRequestOwner('upvote', frId);
  }

  // Update button in-place (no full re-render)
  const btn = featureRequestThread?.querySelector(`.fr-upvote[data-fr-id="${frId}"]`);
  if (btn) {
    const nowUpvoted = fr.upvote_employee_ids.includes(state.currentEmployeeId);
    btn.classList.toggle('upvoted', nowUpvoted);
    btn.textContent = '\u25B2 ' + fr.upvote_employee_ids.length;
  }
}

async function submitFeatureRequestReply(frId) {
  const textarea = featureRequestThread?.querySelector(`.fr-reply-input[data-fr-id="${frId}"]`);
  const text = String(textarea?.value || '').trim();
  if (!text && !(state.frReplyPendingFiles && state.frReplyPendingFiles[frId]?.length)) return;

  if (!state.supabase || !state.isAuthenticated) {
    setFeatureRequestNotice('You must be signed in to reply.');
    return;
  }

  // Upload reply attachments if any
  let attachments = [];
  const replyFiles = state.frReplyPendingFiles?.[frId] || [];
  if (replyFiles.length) {
    setFeatureRequestNotice('Uploading attachments...');
    attachments = await uploadFeatureAttachments(replyFiles);
  }

  const result = await state.supabase.from('feature_request_replies').insert({
    feature_request_id: frId,
    employee_id: state.currentEmployeeId,
    // Denormalized for partner-authored posts: the partner reading this reply
    // can't join app.employees to resolve the name.
    author_name: state.employeeProfile?.full_name || null,
    reply_text: text || '(screenshot)',
    attachments: attachments
  });

  if (result.error) {
    setFeatureRequestNotice(`Reply failed: ${result.error.message}`);
    return;
  }

  if (state.frReplyPendingFiles) delete state.frReplyPendingFiles[frId];
  setFeatureRequestNotice('Reply added.');
  notifyFeatureRequestOwner('reply', frId, { replyText: text || '(screenshot)' });
  await loadFeatureRequestsFromSupabase();
}

async function updateFeatureRequestStatus(frId, newStatus) {
  if (!isSuperadminUser()) return;
  if (!state.supabase || !state.isAuthenticated) return;

  const now = new Date().toISOString();
  const result = await state.supabase.from('feature_requests')
    .update({ status: newStatus, updated_at: now })
    .eq('id', frId);

  if (result.error) {
    setFeatureRequestNotice(`Status update failed: ${result.error.message}`);
    await loadFeatureRequestsFromSupabase();
    return;
  }

  const fr = state.featureRequests.find(r => r.id === frId);
  if (fr) { fr.status = newStatus; fr.updated_at = now; }
  notifyFeatureRequestOwner('status_change', frId, { newStatus });
  renderFeatureRequests();
}

async function reopenBug(frId) {
  if (!state.supabase || !state.isAuthenticated) return;
  const fr = state.featureRequests.find(r => r.id === frId);
  if (!fr || fr.request_type !== 'bug' || fr.status !== 'done') return;
  if (fr.employee_id !== state.currentEmployeeId && !isSuperadminUser()) return;

  const now = new Date().toISOString();
  const result = await state.supabase.from('feature_requests')
    .update({ status: 'requested', updated_at: now })
    .eq('id', frId);

  if (result.error) {
    setFeatureRequestNotice(`Re-open failed: ${result.error.message}`);
    return;
  }

  fr.status = 'requested';
  fr.updated_at = now;
  setFeatureRequestNotice('Bug re-opened.');
  renderFeatureRequests();
}

async function updateFeatureRequestType(frId, newType) {
  if (!isSuperadminUser()) return;
  if (!state.supabase || !state.isAuthenticated) return;

  const now = new Date().toISOString();
  const result = await state.supabase.from('feature_requests')
    .update({ request_type: newType, updated_at: now })
    .eq('id', frId);

  if (result.error) {
    setFeatureRequestNotice(`Type update failed: ${result.error.message}`);
    await loadFeatureRequestsFromSupabase();
    return;
  }

  const fr = state.featureRequests.find(r => r.id === frId);
  if (fr) { fr.request_type = newType; fr.updated_at = now; }
  renderFeatureRequests();
}

async function archiveFeatureRequest(frId) {
  if (!isSuperadminUser()) return;
  if (!state.supabase || !state.isAuthenticated) return;

  const now = new Date().toISOString();
  const result = await state.supabase.from('feature_requests')
    .update({ status: 'archived', updated_at: now })
    .eq('id', frId);

  if (result.error) {
    setFeatureRequestNotice(`Archive failed: ${result.error.message}`);
    await loadFeatureRequestsFromSupabase();
    return;
  }

  const fr = state.featureRequests.find(r => r.id === frId);
  if (fr) { fr.status = 'archived'; fr.updated_at = now; }
  renderFeatureRequests();
  setFeatureRequestNotice('Request archived.');
}

async function unarchiveFeatureRequest(frId) {
  if (!isSuperadminUser()) return;
  if (!state.supabase || !state.isAuthenticated) return;

  const now = new Date().toISOString();
  const result = await state.supabase.from('feature_requests')
    .update({ status: 'requested', updated_at: now })
    .eq('id', frId);

  if (result.error) {
    setFeatureRequestNotice(`Restore failed: ${result.error.message}`);
    await loadFeatureRequestsFromSupabase();
    return;
  }

  const fr = state.featureRequests.find(r => r.id === frId);
  if (fr) { fr.status = 'requested'; fr.updated_at = now; }
  renderFeatureRequests();
  setFeatureRequestNotice('Request restored.');
}

async function deleteFeatureRequest(frId) {
  if (!state.supabase || !state.isAuthenticated) return;

  const fr = state.featureRequests.find(r => r.id === frId);
  if (!fr) return;
  if (fr.employee_id !== state.currentEmployeeId || fr.status !== 'requested') {
    setFeatureRequestNotice('You can only delete your own requests that are still in "Requested" status.');
    return;
  }

  if (!await appConfirm('Delete this feature request? This cannot be undone.', { title: 'Delete request', confirmLabel: 'Delete', danger: true })) return;

  // Delete related data first (upvotes, replies), then the request
  const upvoteDel = await state.supabase.from('feature_request_upvotes').delete().eq('feature_request_id', frId).select();
  if (upvoteDel.error) { setFeatureRequestNotice(`Delete failed: ${upvoteDel.error.message}`); return; }
  const replyDel = await state.supabase.from('feature_request_replies').delete().eq('feature_request_id', frId).select();
  if (replyDel.error) { setFeatureRequestNotice(`Delete failed: ${replyDel.error.message}`); return; }
  const result = await state.supabase.from('feature_requests').delete().eq('id', frId).select();

  if (result.error) {
    setFeatureRequestNotice(`Delete failed: ${result.error.message}`);
    return;
  }

  state.featureRequests = state.featureRequests.filter(r => r.id !== frId);
  renderFeatureRequests();
  setFeatureRequestNotice('Request deleted.');
}

if (submitFeatureRequestBtn) {
  submitFeatureRequestBtn.addEventListener('click', () => {
    submitFeatureRequest().catch(error => {
      console.error(error);
      setFeatureRequestNotice(`Submit failed: ${error.message}`);
    });
  });
}

// ── Feature request file attachment handlers ──
const frFileInput = document.getElementById('newFeatureRequestFiles');
if (frFileInput) {
  frFileInput.addEventListener('change', () => {
    if (!state.frPendingFiles) state.frPendingFiles = [];
    const newFiles = [...frFileInput.files];
    state.frPendingFiles.push(...newFiles);
    renderFrPendingFiles('frPendingFiles', state.frPendingFiles);
    frFileInput.value = ''; // reset so same file can be re-selected
  });
}

// Pending files container — remove button clicks
const frPendingContainer = document.getElementById('frPendingFiles');
if (frPendingContainer) {
  frPendingContainer.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.fr-remove-file');
    if (!removeBtn) return;
    const idx = parseInt(removeBtn.dataset.index, 10);
    if (!isNaN(idx) && state.frPendingFiles) {
      state.frPendingFiles.splice(idx, 1);
      renderFrPendingFiles('frPendingFiles', state.frPendingFiles);
    }
  });
}

if (featureRequestThread) {
  featureRequestThread.addEventListener('click', (event) => {
    // Handle toggle-replies (div, not button)
    const toggle = event.target.closest('[data-fr-action="toggle-replies"]');
    if (toggle) {
      const frId = toggle.dataset.frId;
      const hidden = featureRequestThread.querySelector(`.fr-replies-hidden[data-fr-id="${frId}"]`);
      if (hidden) {
        const visible = hidden.style.display === 'none';
        hidden.style.display = visible ? 'flex' : 'none';
        toggle.textContent = visible ? 'Hide earlier replies' : toggle.textContent.replace('Hide', 'Show');
        if (!visible) {
          const replies = state.featureRequests.find(r => r.id === frId)?.replies || [];
          const hiddenCount = replies.length - 2;
          toggle.textContent = `Show ${hiddenCount} earlier ${hiddenCount === 1 ? 'reply' : 'replies'}`;
        }
      }
      return;
    }

    // Attachment thumbnail click → open full-size in new tab
    const thumb = event.target.closest('.fr-attachment-thumb');
    if (thumb) {
      event.preventDefault();
      const path = thumb.dataset.storagePath;
      if (!path || !state.supabase) return;
      state.supabase.storage.from('feature-attachments').createSignedUrl(path, 3600).then(({ data }) => {
        if (data?.signedUrl) window.open(data.signedUrl, '_blank');
      });
      return;
    }

    // Reply pending file remove buttons
    const removeBtn = event.target.closest('.fr-reply-pending .fr-remove-file');
    if (removeBtn) {
      const idx = parseInt(removeBtn.dataset.index, 10);
      const pendingContainer = removeBtn.closest('.fr-reply-pending');
      const frId = pendingContainer?.dataset.frId;
      if (!isNaN(idx) && frId && state.frReplyPendingFiles?.[frId]) {
        state.frReplyPendingFiles[frId].splice(idx, 1);
        renderFrPendingFiles(pendingContainer, state.frReplyPendingFiles[frId]);
      }
      return;
    }

    const btn = event.target.closest('button[data-fr-action]');
    if (!btn) return;

    const action = btn.dataset.frAction;
    const frId = btn.dataset.frId;

    if (action === 'edit') {
      editFeatureRequest(frId);
      return;
    }

    if (action === 'delete') {
      deleteFeatureRequest(frId).catch(error => {
        console.error(error);
        setFeatureRequestNotice(`Delete failed: ${error.message}`);
      });
      return;
    }

    if (action === 'save-edit') {
      saveFeatureRequestEdit(frId).catch(error => {
        console.error(error);
        setFeatureRequestNotice(`Edit failed: ${error.message}`);
      });
      return;
    }

    if (action === 'cancel-edit') {
      renderFeatureRequests();
      return;
    }

    if (action === 'submit-reply') {
      submitFeatureRequestReply(frId).catch(error => {
        console.error(error);
        setFeatureRequestNotice(`Reply failed: ${error.message}`);
      });
      return;
    }

    if (action === 'upvote') {
      toggleFeatureRequestUpvote(frId).catch(error => {
        console.error(error);
        setFeatureRequestNotice(`Upvote failed: ${error.message}`);
      });
      return;
    }

    if (action === 'archive') {
      archiveFeatureRequest(frId).catch(error => {
        console.error(error);
        setFeatureRequestNotice(`Archive failed: ${error.message}`);
      });
      return;
    }

    if (action === 'unarchive') {
      unarchiveFeatureRequest(frId).catch(error => {
        console.error(error);
        setFeatureRequestNotice(`Restore failed: ${error.message}`);
      });
    }
  });

  featureRequestThread.addEventListener('change', (event) => {
    const statusSelect = event.target.closest('select.fr-status-select');
    if (statusSelect) {
      const frId = statusSelect.dataset.frId;
      const newStatus = statusSelect.value;
      updateFeatureRequestStatus(frId, newStatus).catch(error => {
        console.error(error);
        setFeatureRequestNotice(`Status update failed: ${error.message}`);
      });
      return;
    }

    const typeSelect = event.target.closest('select.fr-type-select');
    if (typeSelect) {
      const frId = typeSelect.dataset.frId;
      const newType = typeSelect.value;
      updateFeatureRequestType(frId, newType).catch(error => {
        console.error(error);
        setFeatureRequestNotice(`Type update failed: ${error.message}`);
      });
      return;
    }

    // Reply file input change handler (delegated)
    const replyFileInput = event.target.closest('.fr-reply-file-input');
    if (replyFileInput) {
      const frId = replyFileInput.dataset.frId;
      if (!frId) return;
      if (!state.frReplyPendingFiles) state.frReplyPendingFiles = {};
      if (!state.frReplyPendingFiles[frId]) state.frReplyPendingFiles[frId] = [];
      const newFiles = [...replyFileInput.files];
      state.frReplyPendingFiles[frId].push(...newFiles);
      const pendingContainer = featureRequestThread.querySelector(`.fr-reply-pending[data-fr-id="${frId}"]`);
      if (pendingContainer) {
        renderFrPendingFiles(pendingContainer, state.frReplyPendingFiles[frId]);
      }
      replyFileInput.value = '';
    }
  });

}

// Archived panel uses delegated events on its own container
const frArchivedList = document.getElementById('frArchivedList');
if (frArchivedList) {
  frArchivedList.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-fr-action="unarchive"]');
    if (!btn) return;
    const frId = btn.dataset.frId;
    unarchiveFeatureRequest(frId).catch(error => {
      console.error(error);
      setFeatureRequestNotice(`Restore failed: ${error.message}`);
    });
  });
}

if (frCompletedList) {
  frCompletedList.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-fr-action="reopen"]');
    if (btn) {
      reopenBug(btn.dataset.frId).catch(error => {
        console.error(error);
        setFeatureRequestNotice(`Re-open failed: ${error.message}`);
      });
      return;
    }

    // Reply attachment → open full size (same behavior as the active thread)
    const thumb = event.target.closest('.fr-attachment-thumb');
    if (thumb) {
      event.preventDefault();
      const path = thumb.dataset.storagePath;
      if (path && state.supabase) {
        state.supabase.storage.from('feature-attachments').createSignedUrl(path, 3600).then(({ data }) => {
          if (data?.signedUrl) window.open(data.signedUrl, '_blank');
        });
      }
      return;
    }

    // Click anywhere on a completed item → expand/collapse its replies
    const item = event.target.closest('.fr-completed-expandable');
    if (item) {
      const block = item.querySelector('.fr-completed-replies');
      if (block) block.style.display = block.style.display === 'none' ? 'flex' : 'none';
    }
  });
}

if (featureRequestsFooterLink) {
  featureRequestsFooterLink.addEventListener('click', (event) => {
    event.preventDefault();
    // Staff on Circle have no employee wall here; they get the client one.
    navigateToScreen((isPartnerRole() || state.staffOnCircle) ? 'partner-feedback' : 'feature-requests');
  });
}

const allocSummary = document.getElementById('allocSummary');

// Over capacity is an error, near it a warning — the one place that decides.
function allocTotalVariant(totalPct) {
  if (totalPct > 100) return 'error';
  if (totalPct > 90) return 'warn';
  return '';
}

// Writes the figure and its unit separately, so the total stacks under the
// right-aligned inputs rather than floating in the middle of the column.
function setAllocTotal(value, unit, variant) {
  if (!allocSummary) return;
  const valueEl = document.getElementById('allocSummaryValue');
  const unitEl = document.getElementById('allocSummaryUnit');
  if (valueEl) valueEl.textContent = value;
  if (unitEl) unitEl.textContent = unit || '';
  allocSummary.className = `status alloc-total${variant ? ` ${variant}` : ''}`;
}

// A failure is a sentence, not a figure: no unit, and it takes the whole cell.
function setAllocTotalMessage(text, variant) {
  setAllocTotal(text, '', variant);
  if (allocSummary) allocSummary.classList.add('is-message');
}
const addRow = document.getElementById('addRow');
const saveAllocationsBtn = document.getElementById('saveAllocationsBtn');
const allocWeekDisplay = document.getElementById('allocWeekDisplay');
const allocWeekPrevBtn = document.getElementById('allocWeekPrev');
const allocWeekNextBtn = document.getElementById('allocWeekNext');
const allocMonthSelect = document.getElementById('allocMonth');
const allocEmployeeFilterWrap = document.getElementById('allocEmployeeFilterWrap');
const allocEmployeeFilter = document.getElementById('allocEmployeeFilter');
const allocClientFilterWrap = document.getElementById('allocClientFilterWrap');
const allocClientFilter = document.getElementById('allocClientFilter');
const allocEditPolicyNote = document.getElementById('allocEditPolicyNote');
const allocationTable = document.getElementById('allocationTable')?.querySelector('tbody');

// mondayWeekStartDate lives in js/alloc.js

// getCurrentWeekStartIso lives in js/alloc.js

function getEffectiveWorkDaysForWeek(weekStartIso, employeeId) {
  const weekStart = parseIsoDateLocal(weekStartIso);
  if (!weekStart) return { workDays: 5, holidays: [], leaveDays: 0 };
  const weekDates = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    weekDates.push(toISODateLocal(d));
  }
  const holidays = getPublicHolidays().filter(h => weekDates.includes(h.date));
  const holidayDates = new Set(holidays.map(h => h.date));
  let leaveDayCount = 0;
  if (employeeId && state.leaveRowsById) {
    state.leaveRowsById.forEach((row) => {
      if (row.employee_id !== employeeId) return;
      if (row.status !== 'approved') return;
      weekDates.forEach((dateStr) => {
        if (holidayDates.has(dateStr)) return;
        if (dateStr >= row.start_date && dateStr <= row.end_date) leaveDayCount++;
      });
    });
  }
  return { workDays: Math.max(0, 5 - holidays.length - leaveDayCount), holidays, leaveDays: leaveDayCount };
}

function getEffectiveHoursForWeek(weekStartIso, employeeId) {
  return getEffectiveWorkDaysForWeek(weekStartIso, employeeId).workDays * HOURS_PER_DAY;
}

function getCurrentAllocEffectiveHours() {
  return getEffectiveHoursForWeek(getSelectedAllocWeekIso(), getAllocationViewEmployeeId());
}

/* ── Allocation week navigation ── */

function allocMonthWindow() {
  // Pure math lives in js/alloc.js; this just reads My Allocation's <select>.
  return monthWindowFor(allocMonthSelect?.value);
}

function allocWeekStartsForMonth() {
  const mw = allocMonthWindow();
  return plannerWeekStartsForMonth(mw);
}

function getSelectedAllocWeekIso() {
  const weeks = allocWeekStartsForMonth();
  const idx = state._allocSelectedWeekIndex;
  if (idx != null && idx >= 0 && idx < weeks.length) return weeks[idx];
  // Default: find the current week in the list, or last week
  const current = getCurrentWeekStartIso();
  const match = weeks.indexOf(current);
  return match >= 0 ? weeks[match] : weeks[weeks.length - 1] || current;
}

function populateAllocMonthSelector() {
  if (!allocMonthSelect) return;
  const today = new Date();
  const months = [];
  for (let offset = -1; offset <= 2; offset++) {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    months.push({ value, label });
  }
  allocMonthSelect.innerHTML = '';
  months.forEach(({ value, label }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    allocMonthSelect.appendChild(opt);
  });
  // Default to current month
  const currentValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  allocMonthSelect.value = currentValue;
}

function updateAllocWeekNav() {
  const weeks = allocWeekStartsForMonth();
  const selectedIso = getSelectedAllocWeekIso();
  const idx = weeks.indexOf(selectedIso);
  state._allocSelectedWeekIndex = idx >= 0 ? idx : null;
  if (allocWeekDisplay) {
    allocWeekDisplay.textContent = `Week of ${formatWeekRangeLabel(selectedIso)}`;
  }
  if (allocWeekPrevBtn) allocWeekPrevBtn.disabled = idx <= 0;
  if (allocWeekNextBtn) allocWeekNextBtn.disabled = idx >= weeks.length - 1;
}

function navigateAllocWeek(delta) {
  const weeks = allocWeekStartsForMonth();
  const currentIdx = state._allocSelectedWeekIndex ?? weeks.indexOf(getSelectedAllocWeekIso());
  const newIdx = Math.max(0, Math.min(weeks.length - 1, currentIdx + delta));
  state._allocSelectedWeekIndex = newIdx;
  loadWeeklyAllocationsFromSupabase().catch((error) => {
    console.error(error);
    setAllocationPolicyNote(`Unable to load weekly allocation: ${error.message}`);
  });
}

function getAllocationViewEmployeeId() {
  if (isLeadershipRole()) {
    return state.allocationViewEmployeeId || state.currentEmployeeId || null;
  }
  return state.currentEmployeeId || null;
}

function getSelectedProfileEmployeeId() {
  return getEmployeeIdByName(state.currentEmployee) || state.currentEmployeeId || null;
}

function currentAllocationTeam() {
  const targetEmployeeId = getAllocationViewEmployeeId();
  const fromDirectory = lookupActiveEmployee(targetEmployeeId);
  if (fromDirectory?.department?.name) return normalizeTeamName(fromDirectory.department.name, TEAM_AM);
  const profile = selectedEmployeeRecord();
  return normalizeTeamName(profile.team, TEAM_AM);
}

function canEditWeeklyAllocation(weekIso) {
  const selectedWeek = weekIso || getSelectedAllocWeekIso();
  const currentWeek = getCurrentWeekStartIso();
  // Past weeks are read-only for everyone
  if (selectedWeek < currentWeek) return false;

  const targetEmployeeId = getAllocationViewEmployeeId();
  const targetEmployee = lookupActiveEmployee(targetEmployeeId);
  const targetEmail = normalizeEmail(targetEmployee?.email);

  // Rule 1: Superadmin allocations can only be edited by the superadmin themselves
  if (targetEmail && isSuperadminEmail(targetEmail) && targetEmployeeId !== state.currentEmployeeId) return false;

  const currentEmail = normalizeEmail(state.employeeProfile?.email || state.session?.user?.email || '');

  if (isLeadershipRole()) {
    // Editing own allocations — always allowed for leadership
    if (targetEmployeeId === state.currentEmployeeId) return true;

    // Rule 2: Leadership cannot edit other leadership allocations
    const targetAccess = normalizeAccessLevel(targetEmployee?.access_level || 'employee');
    if (targetAccess === 'leadership' || targetAccess === 'admin') return false;

    // Rule 4: Leadership can only edit allocations of people reporting to them
    if (targetEmployee && !employeeReportsToManager(targetEmployee, currentEmail)) return false;

    return true;
  }

  // Rule 3: Employees can only edit their own allocations
  return targetEmployeeId === state.currentEmployeeId;
}

function setAllocationPolicyNote(message = '', className = 'mini-meta') {
  if (!allocEditPolicyNote) return;
  allocEditPolicyNote.className = className;
  allocEditPolicyNote.textContent = message;
}

function getAllocViewMode() {
  try {
    return localStorage.getItem('allocViewMode') === 'hours' ? 'hours' : 'percent';
  } catch (_error) {
    return 'percent';
  }
}

function setAllocViewMode(mode) {
  try {
    localStorage.setItem('allocViewMode', mode);
  } catch (_error) {
    // Ignore storage write failures; UI can still function with default mode.
  }
}

function pctToAllocDisplay(pct) {
  if (getAllocViewMode() === 'hours') {
    return Math.round((pct / 100) * getCurrentAllocEffectiveHours());
  }
  return Math.round(pct);
}

function allocDisplayToPct(val) {
  if (getAllocViewMode() === 'hours') {
    const effective = getCurrentAllocEffectiveHours();
    return effective > 0 ? Math.round(((val / effective) * 100) * 100) / 100 : 0;
  }
  return val;
}

function syncAllocViewModeLabels() {
  const isHours = getAllocViewMode() === 'hours';
  const toggleBtn = document.getElementById('allocViewToggle');
  if (toggleBtn) toggleBtn.textContent = isHours ? 'Switch to %' : 'Switch to hrs';
  const allocHeader = document.getElementById('allocUnitHeader');
  if (allocHeader) allocHeader.textContent = isHours ? 'Allocation (hrs)' : 'Allocation %';
}

function renderAllocationEmployeeFilterOptions() {
  if (!allocEmployeeFilter) return;
  allocEmployeeFilter.innerHTML = '';
  state.employeeDirectory.forEach((employee) => {
    const option = document.createElement('option');
    option.value = employee.id;
    option.textContent = displayPersonName(employee.full_name, 'Employee');
    allocEmployeeFilter.appendChild(option);
  });

  if (!state.allocationViewEmployeeId) {
    state.allocationViewEmployeeId = state.currentEmployeeId;
  }

  if (state.allocationViewEmployeeId && [...allocEmployeeFilter.options].some((opt) => opt.value === state.allocationViewEmployeeId)) {
    allocEmployeeFilter.value = state.allocationViewEmployeeId;
  } else if (allocEmployeeFilter.options.length) {
    state.allocationViewEmployeeId = allocEmployeeFilter.options[0].value;
    allocEmployeeFilter.value = state.allocationViewEmployeeId;
  }
}

function renderAllocationClientFilterOptions(rows = []) {
  if (!allocClientFilter) return;
  const current = String(state.allocationClientFilter || 'all');
  const fromState = state.clients.filter((row) => row.is_active !== false).map((row) => String(row.name || '').trim()).filter(Boolean).filter(n => normalizeClientNameKey(n) !== 'internal');
  const fromRows = rows.map((row) => String(row.client || '').trim()).filter(Boolean).filter(n => normalizeClientNameKey(n) !== 'internal');
  const options = dedupeSortedNames([...fromState, ...fromRows]);

  allocClientFilter.innerHTML = '<option value="all">All clients</option>';
  options.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    allocClientFilter.appendChild(option);
  });

  const hasCurrent = [...allocClientFilter.options].some((opt) => opt.value === current);
  state.allocationClientFilter = hasCurrent ? current : 'all';
  allocClientFilter.value = state.allocationClientFilter;
}

function applyAllocationClientRowFilter() {
  if (!allocationTable) return;
  const selectedClient = String(state.allocationClientFilter || 'all');
  const normalizedClient = selectedClient.toLowerCase();
  const rows = [...allocationTable.querySelectorAll('tr[data-allocation-row="line"]')];
  let visibleCount = 0;

  rows.forEach((row) => {
    const rowClient = String(row.dataset.client || '').toLowerCase();
    const visible = normalizedClient === 'all' || rowClient === normalizedClient;
    row.classList.toggle('hidden', !visible);
    if (visible) visibleCount += 1;
  });

  allocationTable.querySelectorAll('tr[data-allocation-row="filter-empty"]').forEach((row) => row.remove());
  if (rows.length && !visibleCount) {
    const empty = document.createElement('tr');
    empty.dataset.allocationRow = 'filter-empty';
    empty.innerHTML = '<td colspan="5">No allocation lines for selected client.</td>';
    allocationTable.appendChild(empty);
  }
}

function updateAllocationSummary() {
  const isHours = getAllocViewMode() === 'hours';
  const effectiveHours = getCurrentAllocEffectiveHours();
  const weekStartIso = getSelectedAllocWeekIso();
  const weekInfo = getEffectiveWorkDaysForWeek(weekStartIso, getAllocationViewEmployeeId());
  const allocInputs = [...document.querySelectorAll('.alloc-input')];
  const totalPct = allocInputs.reduce((sum, input) => {
    const value = Number(input.value);
    const pct = isHours ? (effectiveHours > 0 ? (value / effectiveHours) * 100 : 0) : value;
    return sum + (Number.isFinite(pct) ? pct : 0);
  }, 0);
  const freePct = 100 - totalPct;
  const total = Math.round(totalPct);
  const free = Math.round(freePct);

  if (!allocSummary) return;

  // The unit is a separate element so the figure lines up with the column of
  // right-aligned inputs above it; writing textContent straight onto the
  // paragraph would delete it.
  if (isHours) {
    setAllocTotal(String(Math.round((totalPct / 100) * effectiveHours)), 'hrs', allocTotalVariant(totalPct));
  } else {
    setAllocTotal(String(total), '%', allocTotalVariant(totalPct));
  }

  const allocWeekNote = document.getElementById('allocWeekNote');
  if (allocWeekNote) {
    if (weekInfo.workDays < 5) {
      const parts = [];
      if (weekInfo.holidays.length) parts.push(`${weekInfo.holidays.length} holiday${weekInfo.holidays.length > 1 ? 's' : ''}: ${weekInfo.holidays.map(h => h.name).join(', ')}`);
      if (weekInfo.leaveDays) parts.push(`${weekInfo.leaveDays} leave day${weekInfo.leaveDays > 1 ? 's' : ''}`);
      allocWeekNote.textContent = `${weekInfo.workDays} working days this week (${parts.join('; ')})`;
    } else {
      allocWeekNote.textContent = '';
    }
  }

  const allocationEmployeeId = getAllocationViewEmployeeId();
  const selectedProfileEmployeeId = getSelectedProfileEmployeeId();
  if (allocationEmployeeId && selectedProfileEmployeeId && allocationEmployeeId === selectedProfileEmployeeId) {
    const profile = selectedEmployeeRecord();
    profile.utilization.week = Math.min(100, Math.round(total));
    const profileUtilWeekEl = document.getElementById('profileUtilWeek');
    if (profileUtilWeekEl) profileUtilWeekEl.textContent = `${profile.utilization.week}%`;
  }
}

function bindAllocationInputListeners() {
  document.querySelectorAll('.alloc-input').forEach((input) => {
    input.addEventListener('input', updateAllocationSummary);
  });
}

function allocationClientOptionsMarkup(selectedClient = '') {
  const selected = String(selectedClient || '').trim();
  const fromState = state.clients.filter((row) => row.is_active !== false).map((row) => String(row.name || '').trim()).filter(Boolean).filter(n => normalizeClientNameKey(n) !== 'internal');
  const names = dedupeSortedNames(selected ? [...fromState, selected] : fromState);
  const options = ['<option value="">Select client</option>'];
  names.forEach((name) => {
    const isSelected = name === selected;
    options.push(`<option value="${escapeHtml(name)}" ${isSelected ? 'selected' : ''}>${escapeHtml(name)}</option>`);
  });
  return options.join('');
}

function isGarbageProjectName(name) {
  return !name || name.length > 100 || name.startsWith('Select client');
}

function getClientType(clientName) {
  const name = String(clientName || '').trim().toLowerCase();
  const match = state.clients.find((c) => String(c.name || '').trim().toLowerCase() === name);
  return match?.type || 'project';
}

function appendAllocationRow(line, editable) {
  if (!allocationTable) return;
  const row = document.createElement('tr');
  const clientName = String(line.client || '').trim();
  const percent = Number.isFinite(Number(line.allocation_percent)) ? Number(line.allocation_percent) : 0;
  const updatedLabel = line.updated_at ? formatTimestamp(line.updated_at) : '--';
  const isHours = getAllocViewMode() === 'hours';
  const displayValue = pctToAllocDisplay(percent);
  const effectiveHours = getCurrentAllocEffectiveHours();
  const maxValue = isHours ? effectiveHours : 100;
  const minValue = isHours ? Math.max(1, Math.round((5 / 100) * effectiveHours)) : 5;
  const stepValue = '1';
  const unitLabel = isHours ? 'hrs' : '%';
  const clientType = getClientType(clientName);
  const isPitch = clientType === 'pitch';
  const isRetainer = clientType === 'retainer';
  const showPopulate = editable && !isPitch;
  row.dataset.allocationRow = 'line';
  row.dataset.client = clientName.toLowerCase();
  const populateHtml = showPopulate ? `<span class="populate-wrapper"><button class="ghost small populate-btn" type="button" data-client="${escapeHtml(clientName)}">Copy to\u2026</button><span class="populate-menu hidden" data-client="${escapeHtml(clientName)}"><button type="button" data-populate-scope="next-week" data-client="${escapeHtml(clientName)}">Next Week</button><button type="button" data-populate-scope="month" data-client="${escapeHtml(clientName)}">Rest of Month</button><button type="button" data-populate-scope="indefinite" data-client="${escapeHtml(clientName)}">Indefinitely</button></span></span>` : '';
  const deleteHtml = editable ? `<button class="alloc-delete-btn" type="button" title="Remove row">\u00d7</button>` : '';
  row.innerHTML = `
    <td data-label="Client"></td>
    <td data-label="Allocation">
      <div class="alloc-percent-field">
        <input class="alloc-input" type="number" min="${minValue}" max="${maxValue}" step="${stepValue}" value="${displayValue}" ${editable ? '' : 'disabled'} placeholder="Min ${minValue}" />
        <span>${unitLabel}</span>
      </div>
    </td>
    <td data-label="Type"><span class="chip ${isRetainer ? 'good' : isPitch ? 'info' : ''}" style="font-size:10px">${isRetainer ? 'Retainer' : isPitch ? 'Pitch' : 'Project'}</span></td>
    <td data-label="Updated" class="alloc-updated-at" data-employee="${escapeHtml(state.currentEmployee)}">${updatedLabel}</td>
    <td data-label="" class="${editable ? '' : 'hidden'}">${populateHtml}${deleteHtml}</td>
  `;

  /* Build select via DOM to avoid innerHTML parsing quirks across browsers */
  const clientSelect = document.createElement('select');
  if (!editable) clientSelect.disabled = true;
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Select client';
  clientSelect.appendChild(defaultOpt);
  const fromState = state.clients.filter((r) => r.is_active !== false).map((r) => String(r.name || '').trim()).filter(Boolean).filter(n => normalizeClientNameKey(n) !== 'internal');
  const names = dedupeSortedNames(clientName ? [...fromState, clientName] : fromState);
  names.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === clientName) opt.selected = true;
    clientSelect.appendChild(opt);
  });
  row.querySelector('td:nth-child(1)').appendChild(clientSelect);

  allocationTable.appendChild(row);
  const stampCell = row.querySelector('.alloc-updated-at');
  if (stampCell) applyTimestampClass(stampCell, updatedLabel);
  if (clientSelect) {
    clientSelect.addEventListener('change', () => {
      row.dataset.client = String(clientSelect.value || '').trim().toLowerCase();
      applyAllocationClientRowFilter();
    });
  }
}

function readAllocationLinesFromTable() {
  if (!allocationTable) return [];
  const hardcodedTeam = currentAllocationTeam();
  const lines = [...allocationTable.querySelectorAll('tr')]
    .map((row) => {
      const clientSelect = row.querySelector('td:nth-child(1) select');
      const clientCell = row.querySelector('td:nth-child(1)');
      const allocationInput = row.querySelector('.alloc-input');
      if (!allocationInput) return null;

      const projectName = (clientSelect?.value || '').trim();
      const rawValue = Number(allocationInput?.value);
      const allocationPercent = allocDisplayToPct(Number.isFinite(rawValue) ? rawValue : 0);

      if (!projectName) return null;

      return {
        project_name: projectName,
        team: hardcodedTeam,
        allocation_percent: Number.isFinite(allocationPercent) ? allocationPercent : 0
      };
    })
    .filter(Boolean);
  const deduped = new Map();
  lines.forEach((line) => {
    deduped.set(line.project_name.toLowerCase(), line);
  });
  return [...deduped.values()];
}

function renderWeeklyAllocationViews() {
  if (!allocationTable) return;
  const managerMode = isLeadershipRole();
  const targetEmployeeId = getAllocationViewEmployeeId();
  updateAllocWeekNav();

  allocationTable.innerHTML = '';
  const editable = canEditWeeklyAllocation();
  const rows = (state.weeklyAllocations || [])
    .map((line) => ({
      client: line.project?.name || line.client || '',
      allocation_percent: line.allocation_percent,
      updated_at: line.updated_at
    }))
    .filter((r) => r.client && !isGarbageProjectName(r.client))
    .sort((a, b) => String(a.client || '').localeCompare(String(b.client || '')));

  renderAllocationClientFilterOptions(rows);
  if (allocClientFilter) allocClientFilter.disabled = !rows.length;

  // Show/hide action column when editable
  const showActionCol = editable && rows.length > 0;
  const allocPopulateHeader = document.getElementById('allocPopulateHeader');
  if (allocPopulateHeader) allocPopulateHeader.classList.toggle('hidden', !showActionCol);

  if (!rows.length) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="${showActionCol ? 5 : 4}">No allocation lines for this week.</td>`;
    allocationTable.appendChild(row);
  } else {
    rows.forEach((line) => appendAllocationRow(line, editable));
  }

  bindAllocationInputListeners();
  applyAllocationClientRowFilter();
  updateAllocationSummary();
  if (addRow) addRow.disabled = !editable;
  if (copyLastWeekBtn) copyLastWeekBtn.disabled = !editable;
  if (copyLastWeekBtn) copyLastWeekBtn.style.display = editable ? '' : 'none';
  if (saveAllocationsBtn) saveAllocationsBtn.disabled = !editable;

  const selectedWeek = getSelectedAllocWeekIso();
  const isPast = selectedWeek < getCurrentWeekStartIso();
  const targetEmployee = lookupActiveEmployee(targetEmployeeId);
  const targetEmail = normalizeEmail(targetEmployee?.email);
  if (isPast) {
    setAllocationPolicyNote('Viewing a past week (read-only).');
  } else if (!editable && targetEmail && isSuperadminEmail(targetEmail)) {
    setAllocationPolicyNote('Superadmin allocations are read-only.');
  } else if (!editable && managerMode && targetEmployeeId !== state.currentEmployeeId) {
    const targetAccess = normalizeAccessLevel(targetEmployee?.access_level || 'employee');
    if (targetAccess === 'leadership' || targetAccess === 'admin') {
      setAllocationPolicyNote('Leadership allocations can only be viewed, not edited.');
    } else {
      setAllocationPolicyNote('You can only edit allocations for people who report to you.');
    }
  } else if (!editable) {
    setAllocationPolicyNote('You can only edit your own allocations.');
  } else if (managerMode) {
    setAllocationPolicyNote('Manager mode: you can update this employee\'s allocation now.');
  } else {
    setAllocationPolicyNote('Set your weekly allocation below.');
  }

  syncAllocViewModeLabels();
}

async function loadWeeklyAllocationsFromSupabase() {
  const targetEmployeeId = getAllocationViewEmployeeId();
  if (!state.supabase || !state.isAuthenticated || !targetEmployeeId) {
    state.weeklyAllocations = [];
    renderWeeklyAllocationViews();
    const selectedProfileEmployeeId = getSelectedProfileEmployeeId();
    if (!targetEmployeeId || (selectedProfileEmployeeId && targetEmployeeId === selectedProfileEmployeeId)) {
      state.profileAllocationRows = [];
      applySelectedEmployeeAllocationSnapshot([]);
    }
    return;
  }

  const weekStartIso = getSelectedAllocWeekIso();
  const response = await state.supabase
    .from('allocations')
    .select(`
      id,
      employee_id,
      period_start,
      allocation_percent,
      updated_at,
      project:projects!allocations_project_id_fkey (
        id,
        name
      )
    `)
    .eq('employee_id', targetEmployeeId)
    .eq('period_type', 'week')
    .eq('period_start', weekStartIso)
    .order('updated_at', { ascending: true });

  if (response.error) {
    console.error(response.error);
    state.weeklyAllocations = [];
    renderWeeklyAllocationViews();
    setAllocationPolicyNote(`Unable to load weekly allocation: ${response.error.message}`);
    const selectedProfileEmployeeId = getSelectedProfileEmployeeId();
    if (selectedProfileEmployeeId && targetEmployeeId === selectedProfileEmployeeId) {
      state.profileAllocationRows = [];
      applySelectedEmployeeAllocationSnapshot([]);
    }
    return;
  }

  state.weeklyAllocations = response.data || [];
  renderWeeklyAllocationViews();

  // Load allocation archive (non-blocking)
  loadAllocArchive().catch(console.error);

  const selectedProfileEmployeeId = getSelectedProfileEmployeeId();
  if (targetEmployeeId && selectedProfileEmployeeId && targetEmployeeId === selectedProfileEmployeeId) {
    await loadProfileAllocationHistoryFromSupabase(targetEmployeeId);
  }

  if (isLeadershipRole()) {
    loadTeamDashboardFromSupabase().catch((error) => {
      console.error(error);
      setTeamDashboardScopeNote(`Unable to refresh team dashboard: ${error.message}`, 'status warn');
    });
  }
}

async function ensureInternalClientId() {
  const lookup = await state.supabase.from('clients').select('id').eq('name', 'Internal').maybeSingle();
  if (lookup.error && lookup.error.code !== 'PGRST116') throw lookup.error;
  if (lookup.data?.id) return lookup.data.id;

  const insert = await state.supabase
    .from('clients')
    .insert({
      name: 'Internal',
      account_owner_employee_id: state.currentEmployeeId || null,
      is_active: true
    })
    .select('id')
    .single();
  if (insert.error) throw insert.error;
  return insert.data.id;
}

async function ensureInternalProjectId(clientId, projectName) {
  const lookup = await state.supabase
    .from('projects')
    .select('id')
    .eq('client_id', clientId)
    .eq('name', projectName)
    .maybeSingle();
  if (lookup.error && lookup.error.code !== 'PGRST116') throw lookup.error;
  if (lookup.data?.id) return lookup.data.id;

  const insert = await state.supabase
    .from('projects')
    .insert({
      client_id: clientId,
      name: projectName,
      engagement_type: 'project',
      status: 'active',
      owner_employee_id: state.currentEmployeeId || null
    })
    .select('id')
    .single();
  if (insert.error) throw insert.error;
  return insert.data.id;
}

async function resolveProjectIdForLine(line, internalClientId) {
  const projectName = String(line.project_name || '').trim();
  if (!projectName) return null;

  // Always use Internal-client projects — must match save_my_allocations RPC
  // which resolves project names under the Internal client. Resolution goes
  // through the SECURITY DEFINER RPC: client-scoped employees (Ruby, Mara)
  // can't SEE the Internal client under RLS, so the old client-side
  // find-or-create silently failed for them (Ruby's bug, 5 Aug 2026).
  const { data, error } = await state.supabase.rpc('resolve_internal_project', {
    p_project_name: projectName
  });
  if (error) throw error;
  if (data) return data;
  // Fallback for callers that already resolved the Internal client id.
  return internalClientId ? ensureInternalProjectId(internalClientId, projectName) : null;
}

async function persistAllocationLinesForEmployeeDirect(targetEmployeeId, lines, weekStartIso) {
  const internalClientId = await ensureInternalClientId();

  // Resolve project IDs for incoming lines
  const incomingProjectIds = new Set();
  const lineEntries = [];
  for (const line of lines) {
    const projectId = await resolveProjectIdForLine(line, internalClientId);
    incomingProjectIds.add(projectId);
    lineEntries.push({ projectId, allocation_percent: line.allocation_percent });
  }

  // Remove allocations that are no longer in the incoming set
  const existing = await state.supabase
    .from('allocations')
    .select('project_id, allocation_percent')
    .eq('employee_id', targetEmployeeId)
    .eq('period_type', 'week')
    .eq('period_start', weekStartIso);
  if (existing.error) throw existing.error;

  const toDelete = (existing.data || [])
    .filter(row => !incomingProjectIds.has(row.project_id))
    .map(row => row.project_id);
  if (toDelete.length) {
    const del = await state.supabase
      .from('allocations')
      .delete()
      .eq('employee_id', targetEmployeeId)
      .eq('period_type', 'week')
      .eq('period_start', weekStartIso)
      .in('project_id', toDelete);
    if (del.error) throw del.error;
  }

  // Build lookup of existing percentages for change detection
  const existingMap = new Map((existing.data || []).map(r => [r.project_id, Number(r.allocation_percent)]));

  // Upsert only changed or new lines
  for (const entry of lineEntries) {
    const prev = existingMap.get(entry.projectId);
    if (prev === entry.allocation_percent) continue; // unchanged, skip

    const upsert = await state.supabase.from('allocations').upsert({
      employee_id: targetEmployeeId,
      project_id: entry.projectId,
      period_type: 'week',
      period_start: weekStartIso,
      allocation_percent: entry.allocation_percent,
      created_by_employee_id: state.currentEmployeeId,
      overridden_by_employee_id: state.currentEmployeeId
    }, { onConflict: 'employee_id,project_id,period_type,period_start' });
    if (upsert.error) throw upsert.error;
  }
}

async function populateAllocationForClient(clientName, scope) {
  if (!state.supabase || !state.isAuthenticated) return;

  const lines = readAllocationLinesFromTable();
  const targetLine = lines.find(
    (line) => String(line.project_name || '').trim().toLowerCase() === String(clientName || '').trim().toLowerCase()
  );

  if (!targetLine) {
    setAllocationPolicyNote(`No allocation line found for ${clientName}.`);
    return;
  }

  const selectedWeek = getSelectedAllocWeekIso();
  let targetWeeks;

  if (scope === 'next-week') {
    const selectedDate = parseIsoDateLocal(selectedWeek) || new Date(selectedWeek);
    const nextMonday = new Date(selectedDate);
    nextMonday.setDate(selectedDate.getDate() + 7);
    targetWeeks = [toISODateLocal(nextMonday)];
  } else if (scope === 'indefinite') {
    // Generate weekly slots for the next 26 weeks (~6 months)
    const selectedDate = parseIsoDateLocal(selectedWeek) || new Date(selectedWeek);
    targetWeeks = [];
    for (let i = 1; i <= 26; i++) {
      const d = new Date(selectedDate);
      d.setDate(selectedDate.getDate() + 7 * i);
      targetWeeks.push(toISODateLocal(d));
    }
  } else {
    // 'month' — all remaining weeks in the selected month
    const mw = allocMonthWindow();
    const allWeeks = plannerWeekStartsForMonth(mw);
    targetWeeks = allWeeks.filter((w) => w > selectedWeek);
  }

  if (!targetWeeks.length) {
    setAllocationPolicyNote('No target weeks to populate.');
    return;
  }

  const targetEmployeeId = getAllocationViewEmployeeId() || state.currentEmployeeId;
  // No ensureInternalClientId() here: that lookup runs under RLS and fails for
  // client-scoped employees. The RPC inside resolveProjectIdForLine handles it.
  const projectId = await resolveProjectIdForLine(targetLine, null);
  if (!projectId) {
    setAllocationPolicyNote(`Unable to resolve project for ${clientName}.`);
    return;
  }

  // Conflict detection — check existing allocations for target weeks
  const existingRes = await state.supabase
    .from('allocations')
    .select('period_start, allocation_percent')
    .eq('employee_id', targetEmployeeId)
    .eq('project_id', projectId)
    .eq('period_type', 'week')
    .in('period_start', targetWeeks);

  const existingRows = existingRes.data || [];
  const newPct = targetLine.allocation_percent;
  const conflicting = existingRows.filter(r => Number(r.allocation_percent) !== newPct);
  const alreadyMatching = existingRows.filter(r => Number(r.allocation_percent) === newPct);

  if (conflicting.length > 0 && alreadyMatching.length === 0 && conflicting.length === targetWeeks.length) {
    // All target weeks already have the same different value — show conflict
    const weekLabels = conflicting.map(r => `${formatWeekRangeLabel(r.period_start)} (${r.allocation_percent}%)`).join(', ');
    const ok = await appConfirm(`${clientName} already has allocations for ${weekLabels}. Overwrite with ${newPct}%?`);
    if (!ok) {
      setAllocationPolicyNote('Populate cancelled.');
      return;
    }
  } else if (conflicting.length > 0) {
    const weekLabels = conflicting.map(r => `${formatWeekRangeLabel(r.period_start)} (${r.allocation_percent}%)`).join(', ');
    const ok = await appConfirm(`${clientName} has different allocations for: ${weekLabels}. Overwrite with ${newPct}%?`);
    if (!ok) {
      setAllocationPolicyNote('Populate cancelled.');
      return;
    }
  } else if (alreadyMatching.length === targetWeeks.length) {
    // All target weeks already have the same value
    setAllocationPolicyNote(`${clientName} already has ${newPct}% for ${scope === 'next-week' ? 'next week' : 'remaining weeks'}. No changes needed.`);
    return;
  }

  let populatedCount = 0;
  for (const weekIso of targetWeeks) {
    // Skip weeks that already match
    if (alreadyMatching.some(r => r.period_start === weekIso)) continue;

    const delResult = await state.supabase
      .from('allocations')
      .delete()
      .eq('employee_id', targetEmployeeId)
      .eq('project_id', projectId)
      .eq('period_type', 'week')
      .eq('period_start', weekIso);
    if (delResult.error) { console.error('Alloc delete failed:', delResult.error.message); continue; }

    const insert = await state.supabase.from('allocations').insert({
      employee_id: targetEmployeeId,
      project_id: projectId,
      period_type: 'week',
      period_start: weekIso,
      allocation_percent: newPct,
      created_by_employee_id: state.currentEmployeeId,
      overridden_by_employee_id: state.currentEmployeeId
    });
    if (insert.error) throw insert.error;
    populatedCount++;
  }

  const label = scope === 'next-week' ? 'next week' : scope === 'indefinite' ? `${populatedCount} weeks (~6 months)` : `${populatedCount} week${populatedCount > 1 ? 's' : ''}`;
  setAllocationPolicyNote(`${clientName} allocation (${newPct}%) copied to ${label}.`);
  // Refresh the local cache so the copied weeks show up when the user
  // navigates to them — without this the copy landed in the DB but the view
  // looked unchanged (the other half of Ruby's "did not reflect").
  await loadWeeklyAllocationsFromSupabase().catch(console.error);
  renderWeeklyAllocationViews();
}

async function persistAllocationsToSupabase() {
  if (!state.supabase || !state.isAuthenticated) return { synced: false, count: 0 };

  const lines = readAllocationLinesFromTable();
  const weekStartIso = getSelectedAllocWeekIso();
  const targetEmployeeId = getAllocationViewEmployeeId() || state.currentEmployeeId;

  if (isLeadershipRole() && targetEmployeeId && targetEmployeeId !== state.currentEmployeeId) {
    await persistAllocationLinesForEmployeeDirect(targetEmployeeId, lines, weekStartIso);
    return {
      synced: true,
      count: lines.length
    };
  }

  const { data, error } = await state.supabase.rpc('save_my_allocations', {
    p_period_type: 'week',
    p_period_start: weekStartIso,
    p_lines: lines
  });

  if (error) throw error;

  return {
    synced: true,
    count: Number(data || 0)
  };
}

function syncAllocationManagerUi() {
  const managerMode = isLeadershipRole();
  allocEmployeeFilterWrap?.classList.toggle('hidden', !managerMode);
  renderAllocationEmployeeFilterOptions();
  populateAllocMonthSelector();
  // Ensure week index points to current week if not explicitly set by user navigation
  if (state._allocSelectedWeekIndex == null) {
    const weeks = allocWeekStartsForMonth();
    const currentWeek = getCurrentWeekStartIso();
    const currentIdx = weeks.indexOf(currentWeek);
    state._allocSelectedWeekIndex = currentIdx >= 0 ? currentIdx : null;
  }
  loadWeeklyAllocationsFromSupabase().catch((error) => {
    console.error(error);
    setAllocationPolicyNote(`Unable to load weekly allocation: ${error.message}`);
  });
}

// ── Allocation week navigation listeners ──
if (allocWeekPrevBtn) allocWeekPrevBtn.addEventListener('click', () => navigateAllocWeek(-1));
if (allocWeekNextBtn) allocWeekNextBtn.addEventListener('click', () => navigateAllocWeek(1));
if (allocMonthSelect) {
  allocMonthSelect.addEventListener('change', () => {
    // When switching to the current month, select the current week; otherwise week 1
    const weeks = allocWeekStartsForMonth();
    const currentWeek = getCurrentWeekStartIso();
    const currentIdx = weeks.indexOf(currentWeek);
    state._allocSelectedWeekIndex = currentIdx >= 0 ? currentIdx : 0;
    loadWeeklyAllocationsFromSupabase().catch((error) => {
      console.error(error);
      setAllocationPolicyNote(`Unable to load weekly allocation: ${error.message}`);
    });
  });
}

if (allocEmployeeFilter) {
  allocEmployeeFilter.addEventListener('change', () => {
    state.allocationViewEmployeeId = allocEmployeeFilter.value || null;
    loadWeeklyAllocationsFromSupabase().catch((error) => {
      console.error(error);
      setAllocationPolicyNote(`Unable to load weekly allocation: ${error.message}`);
    });
  });
}

if (allocClientFilter) {
  allocClientFilter.addEventListener('change', () => {
    state.allocationClientFilter = allocClientFilter.value || 'all';
    applyAllocationClientRowFilter();
  });
}

if (addRow && allocationTable) {
  addRow.addEventListener('click', () => {
    if (!canEditWeeklyAllocation()) {
      setAllocationPolicyNote('You can only edit your own allocations.');
      return;
    }
    if (state.allocationClientFilter !== 'all') {
      state.allocationClientFilter = 'all';
      if (allocClientFilter) allocClientFilter.value = 'all';
      applyAllocationClientRowFilter();
    }
    appendAllocationRow(
      {
        client: '',
        allocation_percent: 0,
        updated_at: ''
      },
      true
    );
    bindAllocationInputListeners();
    updateAllocationSummary();
  });
}

if (saveAllocationsBtn) {
  saveAllocationsBtn.addEventListener('click', async () => {
    if (!canEditWeeklyAllocation()) {
      setAllocationPolicyNote('You can only edit your own allocations.');
      return;
    }

    const lines = readAllocationLinesFromTable();
    const tooLow = lines.find((l) => l.allocation_percent > 0 && l.allocation_percent < 5);
    if (tooLow) {
      setAllocationPolicyNote(`Minimum allocation is 5%. "${tooLow.project_name}" has ${tooLow.allocation_percent}%.`);
      return;
    }

    saveAllocationsBtn.disabled = true;
    const originalText = saveAllocationsBtn.textContent;
    saveAllocationsBtn.textContent = 'Saving…';

    try {
      const syncResult = await persistAllocationsToSupabase();
      if (syncResult.synced && allocSummary) {
        allocSummary.className = 'status alloc-total';
      }
      saveAllocationsBtn.textContent = 'Saved!';
      await loadWeeklyAllocationsFromSupabase();
    } catch (error) {
      console.error(error);
      if (allocSummary) {
        setAllocTotalMessage(`Save failed: ${error.message}. Please check your connection and try again.`, 'warn');
      }
      saveAllocationsBtn.textContent = 'Retry Save';
    } finally {
      saveAllocationsBtn.disabled = false;
      setTimeout(() => {
        if (saveAllocationsBtn.textContent === 'Saved!' || saveAllocationsBtn.textContent === 'Retry Save') {
          saveAllocationsBtn.textContent = originalText;
        }
      }, 2500);
    }
  });
}

// Copy from last week button
const copyLastWeekBtn = document.getElementById('copyLastWeekBtn');
if (copyLastWeekBtn) {
  copyLastWeekBtn.addEventListener('click', async () => {
    if (!canEditWeeklyAllocation()) {
      setAllocationPolicyNote('You can only edit your own allocations.');
      return;
    }
    const targetEmployeeId = getAllocationViewEmployeeId();
    if (!targetEmployeeId || !state.supabase) return;

    // Determine previous week
    const currentWeekIso = getSelectedAllocWeekIso();
    const prevDate = parseIsoDateLocal(currentWeekIso);
    if (!prevDate) return;
    prevDate.setDate(prevDate.getDate() - 7);
    const prevWeekIso = toISODateLocal(prevDate);

    copyLastWeekBtn.disabled = true;
    copyLastWeekBtn.textContent = 'Loading…';

    try {
      const resp = await state.supabase
        .from('allocations')
        .select('allocation_percent, project:projects!allocations_project_id_fkey ( name )')
        .eq('employee_id', targetEmployeeId)
        .eq('period_type', 'week')
        .eq('period_start', prevWeekIso)
        .order('updated_at', { ascending: true });

      if (resp.error) throw resp.error;
      const prevRows = (resp.data || [])
        .map(r => ({ client: r.project?.name || '', allocation_percent: r.allocation_percent, updated_at: '' }))
        .filter(r => r.client && !isGarbageProjectName(r.client));

      if (!prevRows.length) {
        setAllocationPolicyNote('No allocations found for the previous week.');
        return;
      }

      // Clear current table and populate with previous week's data
      // allocationTable is already the <tbody> (see line 5094), not the <table>
      allocationTable.innerHTML = '';
      if (state.allocationClientFilter !== 'all') {
        state.allocationClientFilter = 'all';
        if (allocClientFilter) allocClientFilter.value = 'all';
      }
      prevRows.forEach(line => appendAllocationRow(line, true));
      bindAllocationInputListeners();
      applyAllocationClientRowFilter();
      updateAllocationSummary();
      setAllocationPolicyNote('Copied from last week. Review and save when ready.');
    } catch (err) {
      console.error(err);
      setAllocationPolicyNote(`Unable to copy: ${err.message}`);
    } finally {
      copyLastWeekBtn.disabled = false;
      copyLastWeekBtn.textContent = '← Copy from last week';
    }
  });
}

// Suggest allocations from this week's task planner (distribution logic is
// pure + tested: suggestAllocationsFromTasks, js/alloc.js). Suggestion only —
// nothing saves until the user hits Save Allocation.
const suggestFromTasksBtn = document.getElementById('suggestFromTasksBtn');
if (suggestFromTasksBtn) {
  suggestFromTasksBtn.addEventListener('click', async () => {
    if (!canEditWeeklyAllocation()) {
      setAllocationPolicyNote('You can only edit your own allocations.');
      return;
    }
    const targetEmployeeId = getAllocationViewEmployeeId();
    if (!targetEmployeeId || !state.supabase) return;
    const weekIso = getSelectedAllocWeekIso();
    if (!weekIso) return;

    suggestFromTasksBtn.disabled = true;
    suggestFromTasksBtn.textContent = 'Reading tasks…';
    try {
      const resp = await state.supabase
        .from('daily_tasks')
        .select('task_date, status, notes')
        .eq('employee_id', targetEmployeeId)
        .neq('status', 'archived');
      if (resp.error) throw resp.error;

      const suggested = suggestAllocationsFromTasks(resp.data || [], weekIso)
        .filter(r => !isGarbageProjectName(r.client));
      if (!suggested.length) {
        setAllocationPolicyNote('No active tasks tagged to clients this week — nothing to suggest.');
        return;
      }

      allocationTable.innerHTML = '';
      if (state.allocationClientFilter !== 'all') {
        state.allocationClientFilter = 'all';
        if (allocClientFilter) allocClientFilter.value = 'all';
      }
      suggested.forEach(line => appendAllocationRow({ client: line.client, allocation_percent: line.percent, updated_at: '' }, true));
      bindAllocationInputListeners();
      applyAllocationClientRowFilter();
      updateAllocationSummary();
      const totalTasks = suggested.reduce((s, r) => s + r.tasks, 0);
      setAllocationPolicyNote(`Suggested from ${totalTasks} task${totalTasks === 1 ? '' : 's'} across ${suggested.length} client${suggested.length === 1 ? '' : 's'} — task counts are a proxy, so adjust to reality and save.`);
    } catch (err) {
      console.error(err);
      setAllocationPolicyNote(`Unable to suggest: ${err.message}`);
    } finally {
      suggestFromTasksBtn.disabled = false;
      suggestFromTasksBtn.textContent = '✦ Suggest from tasks';
    }
  });
}

// ── Allocation Archive ──
const allocArchiveContainer = document.getElementById('allocArchiveContainer');

async function loadAllocArchive() {
  if (!allocArchiveContainer || !state.supabase || !state.isAuthenticated) return;
  const targetEmployeeId = getAllocationViewEmployeeId();
  if (!targetEmployeeId) return;

  const currentWeekIso = getCurrentWeekStartIso();

  // Fetch last 8 weeks of past allocations
  const eightWeeksAgo = new Date();
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const resp = await state.supabase
    .from('allocations')
    .select('period_start, allocation_percent, project:projects!allocations_project_id_fkey ( name )')
    .eq('employee_id', targetEmployeeId)
    .eq('period_type', 'week')
    .lt('period_start', currentWeekIso)
    .gte('period_start', toISODateLocal(eightWeeksAgo))
    .order('period_start', { ascending: false })
    .order('updated_at', { ascending: true });

  if (resp.error) {
    allocArchiveContainer.innerHTML = '<p class="mini-meta">Unable to load archive.</p>';
    return;
  }

  // Group by week
  const weekMap = new Map();
  (resp.data || []).forEach(row => {
    const week = row.period_start;
    if (!weekMap.has(week)) weekMap.set(week, []);
    const name = row.project?.name || 'Unassigned';
    if (!isGarbageProjectName(name)) {
      weekMap.get(week).push({ client: name, pct: row.allocation_percent });
    }
  });

  if (!weekMap.size) {
    allocArchiveContainer.innerHTML = '<p class="mini-meta">No past allocation data.</p>';
    return;
  }

  let html = '';
  const sortedWeeks = [...weekMap.keys()].sort((a, b) => b.localeCompare(a));
  sortedWeeks.forEach(week => {
    const lines = weekMap.get(week);
    const total = lines.reduce((s, l) => s + (l.pct || 0), 0);
    const weekLabel = formatWeekRangeLabel(week);
    const lineItems = lines
      .sort((a, b) => b.pct - a.pct)
      .map(l => `<span class="alloc-archive-item">${escapeHtml(l.client)} <strong>${Math.round(l.pct)}%</strong></span>`)
      .join('');
    html += `
      <div class="alloc-archive-week">
        <div class="alloc-archive-header">
          <span class="alloc-archive-label">Week of ${weekLabel}</span>
          <span class="alloc-archive-total">${Math.round(total)}% used</span>
        </div>
        <div class="alloc-archive-items">${lineItems}</div>
      </div>`;
  });

  allocArchiveContainer.innerHTML = html;
}

// Delegated click handler for per-row populate button + menu
const allocationTableEl = document.getElementById('allocationTable');
if (allocationTableEl) {
  allocationTableEl.addEventListener('click', async (event) => {
    // Delete row button
    const deleteBtn = event.target.closest('.alloc-delete-btn');
    if (deleteBtn) {
      const row = deleteBtn.closest('tr');
      if (!row) return;
      const clientSelect = row.querySelector('select');
      const clientName = clientSelect?.value || 'this row';
      if (!await appConfirm(`Remove ${clientName} from this week's allocation?`)) return;
      row.remove();
      updateAllocationSummary();
      applyAllocationClientRowFilter();
      return;
    }

    // Toggle menu on "Copy to..." button click
    const toggleBtn = event.target.closest('.populate-btn');
    if (toggleBtn) {
      const menu = toggleBtn.nextElementSibling;
      if (!menu) return;
      // Close all other open menus first
      allocationTableEl.querySelectorAll('.populate-menu:not(.hidden)').forEach(m => {
        if (m !== menu) m.classList.add('hidden');
      });
      const wasHidden = menu.classList.contains('hidden');
      menu.classList.toggle('hidden');
      if (wasHidden) {
        const rect = toggleBtn.getBoundingClientRect();
        const menuHeight = menu.offsetHeight;
        const menuWidth = menu.offsetWidth;
        // Open upward if not enough room below viewport
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < menuHeight + 8) {
          menu.style.top = (rect.top - menuHeight - 4) + 'px';
        } else {
          menu.style.top = (rect.bottom + 4) + 'px';
        }
        // Align right edge of menu with right edge of button
        let left = rect.right - menuWidth;
        if (left < 8) left = 8;
        menu.style.left = left + 'px';
      }
      return;
    }

    // Handle scope button click
    const scopeBtn = event.target.closest('[data-populate-scope]');
    if (!scopeBtn) return;
    const scope = scopeBtn.dataset.populateScope;
    const clientName = scopeBtn.dataset.client;
    if (!clientName || !canEditWeeklyAllocation()) return;
    const wrapper = scopeBtn.closest('.populate-wrapper');
    const mainBtn = wrapper?.querySelector('.populate-btn');
    const menu = scopeBtn.closest('.populate-menu');
    if (menu) menu.classList.add('hidden');
    if (mainBtn) {
      mainBtn.disabled = true;
      mainBtn.textContent = 'Copying\u2026';
    }
    try {
      await populateAllocationForClient(clientName, scope);
      if (mainBtn) {
        mainBtn.textContent = scope === 'next-week' ? 'Copied to next week \u2713' : scope === 'indefinite' ? 'Copied indefinitely \u2713' : 'Copied to month \u2713';
        mainBtn.classList.add('populate-success');
        setTimeout(() => {
          mainBtn.textContent = 'Copy to\u2026';
          mainBtn.classList.remove('populate-success');
        }, 2500);
      }
    } catch (error) {
      console.error(error);
      setAllocationPolicyNote(`Populate failed: ${error.message}`);
      if (mainBtn) mainBtn.textContent = 'Copy to\u2026';
    } finally {
      if (mainBtn) mainBtn.disabled = false;
    }
  });

  // Close menus when clicking outside
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.populate-wrapper')) {
      allocationTableEl.querySelectorAll('.populate-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
  });
}

const allocViewToggle = document.getElementById('allocViewToggle');
if (allocViewToggle) {
  allocViewToggle.addEventListener('click', () => {
    const oldMode = getAllocViewMode();
    const newMode = oldMode === 'hours' ? 'percent' : 'hours';

    // Convert existing inputs in-place so unsaved edits are preserved
    const effectiveHours = getCurrentAllocEffectiveHours();
    document.querySelectorAll('.alloc-input').forEach((input) => {
      const currentVal = Number(input.value);
      if (newMode === 'hours') {
        input.value = Math.round((currentVal / 100) * effectiveHours * 10) / 10;
        input.max = effectiveHours;
        input.step = '0.5';
      } else {
        input.value = effectiveHours > 0 ? Math.round((currentVal / effectiveHours) * 100) : 0;
        input.max = 100;
        input.step = '1';
      }
    });

    document.querySelectorAll('.alloc-percent-field span').forEach((span) => {
      span.textContent = newMode === 'hours' ? 'hrs' : '%';
    });

    setAllocViewMode(newMode);
    syncAllocViewModeLabels();
    updateAllocationSummary();
  });
}

renderWeeklyAllocationViews();

const leaveType = document.getElementById('leaveType');
const leaveStart = document.getElementById('leaveStart');
const leaveEnd = document.getElementById('leaveEnd');
const leaveReason = document.getElementById('leaveReason');
const leaveMedicalCertificateUrl = document.getElementById('leaveMedicalCertificateUrl');
const leaveRuleHint = document.getElementById('leaveRuleHint');
const submitLeaveBtn = document.getElementById('submitLeaveBtn');
const leaveEmailNotice = document.getElementById('leaveEmailNotice');
const leavePlHeadline = document.getElementById('leavePlHeadline');
const leavePlMeta = document.getElementById('leavePlMeta');
const leaveClHeadline = document.getElementById('leaveClHeadline');
const leaveClMeta = document.getElementById('leaveClMeta');
const leaveSlHeadline = document.getElementById('leaveSlHeadline');
const leaveSlMeta = document.getElementById('leaveSlMeta');
const leaveCycleLabel = document.getElementById('leaveCycleLabel');
const leaveCycleMeta = document.getElementById('leaveCycleMeta');
const leaveBalanceNotice = document.getElementById('leaveBalanceNotice');
const leaveArchiveBody = document.getElementById('leaveArchiveBody');
const leaveApprovalTableBody = document.getElementById('leaveApprovalTableBody');
const teamLeaveCalendarTable = document.getElementById('teamLeaveCalendarTable');
const pendingApprovalCount = document.getElementById('pendingApprovalCount');
const leaveApprovalNotice = document.getElementById('leaveApprovalNotice');
const onLeaveTodayCount = document.getElementById('onLeaveTodayCount');
const reporteeLeaveSnapshotBody = document.getElementById('reporteeLeaveSnapshotBody');
const reporteeLeaveSnapshotMeta = document.getElementById('reporteeLeaveSnapshotMeta');
const seeAllLeavesBtn = document.getElementById('seeAllLeavesBtn');
const profileLeaveSummaryNotice = document.getElementById('profileLeaveSummaryNotice');
let leaveRequestSeq = 0;

// leaveDayText lives in js/leave.js

function setLeaveBalanceNotice(message = '', className = 'mini-meta') {
  if (!leaveBalanceNotice) return;
  leaveBalanceNotice.className = className;
  leaveBalanceNotice.textContent = message;
}

// emptyLeaveSummary lives in js/leave.js

function renderLeaveArchiveRows(entries = []) {
  if (!leaveArchiveBody) return;
  leaveArchiveBody.innerHTML = '';
  if (!entries.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="5">No archived leave cycles yet.</td>';
    leaveArchiveBody.appendChild(row);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('tr');
    const archivedOn = entry.archived_at ? formatTimestamp(entry.archived_at) : '--';
    row.innerHTML = `
      <td data-label="Cycle">${escapeHtml(entry.cycle_label || '--')}</td>
      <td data-label="PL Rem.">${escapeHtml(leaveDayText(entry.pl_remaining))}</td>
      <td data-label="CL Rem.">${escapeHtml(leaveDayText(entry.cl_remaining))}</td>
      <td data-label="SL Rem.">${escapeHtml(leaveDayText(entry.sl_remaining))}</td>
      <td data-label="Archived">${escapeHtml(archivedOn)}</td>
    `;
    leaveArchiveBody.appendChild(row);
  });
}

function applyLeaveCycleSummary(summaryInput) {
  const summary = summaryInput && typeof summaryInput === 'object' ? summaryInput : emptyLeaveSummary();
  const pl = summary.pl || emptyLeaveSummary().pl;
  const cl = summary.cl || emptyLeaveSummary().cl;
  const sl = summary.sl || emptyLeaveSummary().sl;

  // Cascade: negative PL/CL overflow into SL
  let plRem = pl.remaining, clRem = cl.remaining, slRem = sl.remaining;
  if (plRem < 0) { slRem += plRem; plRem = 0; }
  if (clRem < 0) { slRem += clRem; clRem = 0; }

  state.leaveCycleSummary = summary;

  if (leavePlHeadline) {
    leavePlHeadline.textContent = `Remaining: ${leaveDayText(plRem)}`;
    leavePlHeadline.classList.toggle('leave-negative', plRem < 0);
  }
  if (leaveClHeadline) {
    leaveClHeadline.textContent = `Remaining: ${leaveDayText(clRem)}`;
    leaveClHeadline.classList.toggle('leave-negative', clRem < 0);
  }
  if (leaveSlHeadline) {
    leaveSlHeadline.textContent = `Remaining: ${leaveDayText(slRem)}`;
    leaveSlHeadline.classList.toggle('leave-negative', slRem < 0);
  }

  if (leavePlMeta) {
    leavePlMeta.textContent = `Allocated ${leaveDayText(pl.allocated)} | Taken ${leaveDayText(pl.taken)} | Applied ${leaveDayText(pl.applied)}`;
  }
  if (leaveClMeta) {
    leaveClMeta.textContent = `Allocated ${leaveDayText(cl.allocated)} | Taken ${leaveDayText(cl.taken)} | Applied ${leaveDayText(cl.applied)}`;
  }
  if (leaveSlMeta) {
    leaveSlMeta.textContent = `Allocated ${leaveDayText(sl.allocated)} | Taken ${leaveDayText(sl.taken)} | Applied ${leaveDayText(sl.applied)}`;
  }

  if (leaveCycleLabel) {
    leaveCycleLabel.textContent = summary.cycle_label || 'Apr-Mar';
  }
  if (leaveCycleMeta) {
    const startText = summary.cycle_start ? formatDateForLabel(summary.cycle_start) : '--';
    const endText = summary.cycle_end ? formatDateForLabel(summary.cycle_end) : '--';
    leaveCycleMeta.textContent = `Cycle: ${startText} to ${endText}`;
  }

  renderLeaveArchiveRows(Array.isArray(summary.archive) ? summary.archive : []);
}

async function loadLeaveCycleSummaryFromSupabase() {
  if (!state.supabase || !state.isAuthenticated) {
    applyLeaveCycleSummary(emptyLeaveSummary());
    setLeaveBalanceNotice('Sign in to load leave balances.');
    return;
  }

  const response = await state.supabase.rpc('get_my_leave_cycle_summary', {
    p_as_of_date: toISODateLocal()
  });

  if (response.error) {
    console.error(response.error);
    applyLeaveCycleSummary(emptyLeaveSummary());
    setLeaveBalanceNotice(`Unable to load leave balances: ${response.error.message}`, 'status warn');
    return;
  }

  applyLeaveCycleSummary(response.data || emptyLeaveSummary());
  setLeaveBalanceNotice('Leave balances are loaded from the active leave cycle.');
}

// calendarDayCount lives in js/leave.js

// formatShortDate lives in js/leave.js

// formatLeaveDateRange lives in js/leave.js

// ── Notification bell (top bar): action-required items, computed live ──
// Item building is pure (buildActionItems, js/notify.js, tested); this renders
// the badge + dropdown. Refreshed whenever leave rows land (renderLeaveRows).
// Cheap personal signals for the bell (invoice window, policy ack) — loaded at
// sign-in alongside the main data fan-out and after relevant user actions.
async function loadNotifySignals() {
  if (!state.supabase || !state.currentEmployeeId) { state.notifySignals = null; return; }
  const signals = { invoiceDue: false, policyAckPending: false, featureReplies: [] };
  try {
    const myEmail = normalizeEmail(state.employeeProfile?.email || '');
    const inWindow = new Date().getDate() >= 25;
    const excluded = getInvoiceExcludedEmails().includes(myEmail);
    const tracked = state.employeeProfile?.department?.leave_tracking_enabled !== false;
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const [invRes, ackRes, replyRes] = await Promise.all([
      (inWindow && !excluded && tracked)
        ? state.supabase.from('invoices').select('id', { count: 'exact', head: true })
            .eq('employee_id', state.currentEmployeeId).eq('invoice_month', currentInvoiceMonth())
        : Promise.resolve({ count: 1, error: null }),
      state.supabase.from('policy_acknowledgments').select('id', { count: 'exact', head: true })
        .eq('employee_id', state.currentEmployeeId).eq('policy_key', 'remote_working_policy'),
      // replies on MY requests by other people, recent window
      state.supabase.from('feature_request_replies')
        .select('id, created_at, replier:employees!feature_request_replies_employee_id_fkey(full_name), request:feature_requests!feature_request_replies_feature_request_id_fkey!inner(employee_id, request_text)')
        .eq('request.employee_id', state.currentEmployeeId)
        .neq('employee_id', state.currentEmployeeId)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(10)
    ]);
    signals.invoiceDue = !invRes.error && (invRes.count || 0) === 0;
    signals.policyAckPending = !ackRes.error && (ackRes.count || 0) === 0;
    // New joiners awaiting setup — only Alex/Nadia see these. (RLS doesn't
    // hide the rows; this is the same UX-level gate as the rest of the bell.)
    if (isSetupApprover()) {
      const pendRes = await state.supabase.from('employees')
        .select('id, full_name, employment_type, created_at, requested_department:departments!employees_requested_department_id_fkey(name)')
        .eq('is_active', true).eq('setup_pending', true)
        .order('created_at', { ascending: true });
      if (!pendRes.error) {
        signals.pendingSetups = (pendRes.data || []).map(p => ({
          id: p.id,
          fullName: p.full_name,
          employmentType: p.employment_type,
          requestedTeam: p.requested_department?.name || '',
          createdAt: p.created_at
        }));
      }
    }
    if (!replyRes.error) {
      signals.featureReplies = (replyRes.data || []).map(r => ({
        id: r.id,
        replierName: r.replier?.full_name || 'Someone',
        requestText: r.request?.request_text || '',
        createdAt: r.created_at
      }));
    }
    // Brief pipeline signals — reviewer counts for Rhea/Mara/leadership,
    // assigned-deliverable count for everyone.
    const nowIso = new Date().toISOString();
    const briefQueries = [
      state.supabase.from('brief_deliverables').select('id', { count: 'exact', head: true })
        .eq('assignee_employee_id', state.currentEmployeeId)
        .in('status', ['queued', 'in_progress', 'in_review'])
    ];
    if (isBriefReviewer()) {
      briefQueries.push(
        state.supabase.from('briefs').select('id', { count: 'exact', head: true })
          .eq('request_type', 'brief').eq('status', 'ready_for_review'),
        state.supabase.from('briefs').select('id', { count: 'exact', head: true })
          .eq('request_type', 'notify_only').eq('status', 'submitted'),
        state.supabase.from('brief_deliverables').select('id', { count: 'exact', head: true })
          .neq('status', 'delivered').not('due_at', 'is', null).lt('due_at', nowIso)
      );
    }
    const [mineRes, reviewRes, quickRes, overdueRes] = await Promise.all(briefQueries);
    signals.briefAssignedToMe = (!mineRes?.error && mineRes?.count) || 0;
    signals.briefsAwaitingReview = (!reviewRes?.error && reviewRes?.count) || 0;
    signals.briefQuickOpen = (!quickRes?.error && quickRes?.count) || 0;
    signals.briefOverdue = (!overdueRes?.error && overdueRes?.count) || 0;
    // Hiring pipeline: stages waiting on ME (crew employees only; Leo's
    // hiring-only surface IS his queue, no bell there).
    const myHireStages = [];
    if (isSetupApprover()) myHireStages.push('contract_uploaded');
    if (isSuperadminUser()) myHireStages.push('reviewed');
    if (getHiringCrewEmails().includes(myEmail)) myHireStages.push('signed');
    if (myHireStages.length) {
      const hireRes = await state.supabase.from('hires')
        .select('id', { count: 'exact', head: true })
        .in('stage', myHireStages);
      signals.hiresMyTurn = (!hireRes.error && hireRes.count) || 0;
    }
  } catch (err) { console.warn('Notify signals load failed:', err); }
  state.notifySignals = signals;
  refreshNotifyBell();
}

const NOTIFY_SEEN_LS_KEY = 'colony_notify_seen_v1';
function notifySeenKeys() {
  try { return new Set(JSON.parse(localStorage.getItem(NOTIFY_SEEN_LS_KEY) || '[]')); } catch (e) { return new Set(); }
}
function markNotifyItemsSeen(items) {
  try {
    const seen = notifySeenKeys();
    items.forEach(i => seen.add(i.key));
    localStorage.setItem(NOTIFY_SEEN_LS_KEY, JSON.stringify([...seen].slice(-200)));
  } catch (e) { /* private mode etc. */ }
}

function currentNotifyItems() {
  return state.isAuthenticated ? buildActionItems({
    myEmail: state.employeeProfile?.email || state.session?.user?.email || '',
    myEmployeeId: state.currentEmployeeId,
    isSuperadmin: isSuperadminUser(),
    leaveRows: state.leaveRowsById ? [...state.leaveRowsById.values()] : [],
    todayIso: toISODateLocal(),
    signals: state.notifySignals
  }) : [];
}

function refreshNotifyBell() {
  const badge = document.getElementById('notifyBadge');
  const list = document.getElementById('notifyPanelList');
  if (!badge || !list) return;
  const items = currentNotifyItems();
  // Badge counts UNSEEN only; opening the panel marks everything seen.
  const unseen = countUnseenItems(items, notifySeenKeys());
  badge.textContent = String(unseen);
  badge.classList.toggle('hidden', unseen === 0);
  list.innerHTML = items.length
    ? items.map(i => `<div class="notify-item" data-notify-screen="${escapeHtml(i.screen)}"${i.anchor ? ` data-notify-anchor="${escapeHtml(i.anchor)}"` : ''}>
        <div class="notify-item-text">${escapeHtml(i.icon)} ${escapeHtml(i.text)}</div>
        <div class="notify-item-detail">${escapeHtml(i.detail)}</div>
      </div>`).join('')
    : '<div class="notify-empty">All caught up — nothing needs your action.</div>';
}

// Scroll a just-opened screen to the section the notification points at.
// Screens aren't URL-sectioned; data loads reflow the page, so retry briefly
// until the element has real height, then flash it so the eye lands right.
// Keeps trying for ~15s: panels like Awaiting Setup stay display:none until
// their data has loaded, and on a cold load that took longer than the old 3s
// — the setup email then landed Alex at the top of Admin Settings with
// nothing to say why (15 Sep 2026, Asha's setup).
function scrollToNotifyAnchor(anchorId, attempt = 0) {
  const el = document.getElementById(anchorId);
  if (el && el.offsetHeight > 0) {
    // Instant, not smooth: the canvas is its own scroller and a smooth scroll
    // into it was being cancelled before it moved (verified 15 Sep 2026 —
    // scrollTop stayed 0). The flash does the "look here" job.
    el.scrollIntoView({ block: 'start' });
    el.classList.add('notify-anchor-flash');
    setTimeout(() => el.classList.remove('notify-anchor-flash'), 2400);
    return;
  }
  if (attempt < 50) setTimeout(() => scrollToNotifyAnchor(anchorId, attempt + 1), 300);
}

(function wireNotifyBell() {
  const bell = document.getElementById('notifyBellBtn');
  const panel = document.getElementById('notifyPanel');
  if (!bell || !panel) return;
  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    refreshNotifyBell();
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      // Expanding the panel marks everything as read (badge clears; items stay)
      markNotifyItemsSeen(currentNotifyItems());
      const badge = document.getElementById('notifyBadge');
      if (badge) badge.classList.add('hidden');
    }
  });
  panel.addEventListener('click', (e) => {
    const item = e.target.closest('[data-notify-screen]');
    if (!item) return;
    panel.classList.add('hidden');
    navigateToScreen(item.dataset.notifyScreen);
    if (item.dataset.notifyAnchor) scrollToNotifyAnchor(item.dataset.notifyAnchor);
  });
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== bell) {
      panel.classList.add('hidden');
    }
  });
})();

function refreshLeavePendingCount() {
  if (!leaveApprovalTableBody || !pendingApprovalCount) return;
  const pending = leaveApprovalTableBody.querySelectorAll('.leave-approval-status .chip.pending').length;
  pendingApprovalCount.textContent = `(${pending} pending)`;
}

function refreshOnLeaveTodayBadge() {
  if (!onLeaveTodayCount || !isLeadershipRole()) return;
  const todayStr = toISODateLocal();
  const names = new Set();
  state.leaveRowsById.forEach((row) => {
    if (row.status === 'approved' && row.start_date <= todayStr && row.end_date >= todayStr) {
      names.add(displayPersonName(row.employee?.full_name || 'Employee', 'Employee'));
    }
  });
  const count = names.size;
  onLeaveTodayCount.textContent = count === 0
    ? 'No one on leave today'
    : `${count} on leave today`;
  onLeaveTodayCount.className = count > 0 ? 'chip warn' : 'chip info';
  onLeaveTodayCount.title = count > 0 ? Array.from(names).join(', ') : '';
}

function setCalendarLeaveStatus(requestId, statusClass, label) {
  if (!teamLeaveCalendarTable) return;
  const row = teamLeaveCalendarTable.querySelector(`tr[data-request-id=\"${requestId}\"]`);
  const chip = row?.querySelector('.leave-calendar-status');
  if (!chip) return;
  chip.classList.remove('pending', 'approved', 'rejected');
  chip.classList.add(statusClass);
  chip.textContent = label;
}

function setApprovalRowStatus(row, statusClass, label, decisionText) {
  const statusCell = row.querySelector('.leave-approval-status');
  const decisionCell = row.querySelector('.leave-decision-meta');
  const actionButtons = row.querySelectorAll('button[data-leave-action]');
  if (statusCell) {
    statusCell.innerHTML = `<span class=\"chip ${statusClass}\">${label}</span>`;
  }
  if (decisionCell) {
    decisionCell.textContent = decisionText || '--';
  }
  actionButtons.forEach((btn) => {
    btn.disabled = statusClass !== 'pending';
  });
}

function addLeaveRequestToTables({ employee, type, dates }) {
  if (!leaveApprovalTableBody || !teamLeaveCalendarTable) return null;
  leaveRequestSeq += 1;
  const requestId = `lr-${String(leaveRequestSeq).padStart(3, '0')}`;
  const employeeName = escapeHtml(displayPersonName(employee, 'Employee'));

  leaveApprovalTableBody.querySelectorAll('tr').forEach((row) => {
    if (row.children.length === 1 && row.children[0]?.hasAttribute('colspan')) {
      row.remove();
    }
  });

  const approvalRow = document.createElement('tr');
  approvalRow.dataset.requestId = requestId;
  approvalRow.innerHTML = `
    <td>${employeeName}</td>
    <td>${type}</td>
    <td>${dates}</td>
    <td class=\"leave-approval-status\"><span class=\"chip pending\">Pending</span></td>
    <td>
      <button class=\"ghost small\" data-leave-action=\"approve\">Approve</button>
      <button class=\"ghost small\" data-leave-action=\"reject\">Reject</button>
    </td>
    <td class=\"leave-decision-meta\">--</td>
  `;
  leaveApprovalTableBody.appendChild(approvalRow);

  const calendarBody = teamLeaveCalendarTable.querySelector('tbody');
  if (calendarBody) {
    calendarBody.querySelectorAll('tr').forEach((row) => {
      if (row.children.length === 1 && row.children[0]?.hasAttribute('colspan')) {
        row.remove();
      }
    });
    const calendarRow = document.createElement('tr');
    calendarRow.dataset.requestId = requestId;
    calendarRow.innerHTML = `
      <td>${dates}</td>
      <td>${employeeName}</td>
      <td>${type}</td>
      <td><span class=\"chip pending leave-calendar-status\">Pending</span></td>
    `;
    calendarBody.appendChild(calendarRow);
  }

  return requestId;
}

// leaveStatusMeta lives in js/leave.js

function formatDecisionText(row) {
  if (!row.decided_at) return '--';
  const decisionTime = formatTimestamp(row.decided_at);
  const statusMeta = leaveStatusMeta(row.status);
  return `${statusMeta.label} on ${decisionTime}`;
}

function clearRenderedLeaveRows() {
  leaveApprovalTableBody?.querySelectorAll('tr').forEach((row) => row.remove());
  teamLeaveCalendarTable?.querySelectorAll('tbody tr').forEach((row) => row.remove());
}

let showAllHolidays = false;

function renderHolidaysToCalendar() {
  const holidayTable = document.getElementById('holidayCalendarTable');
  const calendarBody = holidayTable?.querySelector('tbody');
  const toggleBtn = document.getElementById('holidayToggleBtn');
  const heading = document.getElementById('holidayHeading');
  if (!calendarBody) return;
  calendarBody.innerHTML = '';
  const todayStr = toISODateLocal(new Date());

  const allHolidays = getPublicHolidays();
  const holidays = showAllHolidays
    ? allHolidays
    : allHolidays.filter((h) => h.date >= todayStr).slice(0, 3);

  if (!holidays.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = '<td colspan="3">No upcoming holidays.</td>';
    calendarBody.appendChild(emptyRow);
    if (toggleBtn) toggleBtn.classList.add('hidden');
    return;
  }

  holidays.forEach((h) => {
    const d = new Date(h.date + 'T00:00:00');
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const isPast = h.date < todayStr;
    const row = document.createElement('tr');
    if (isPast) row.classList.add('muted-row');
    row.innerHTML = `
      <td data-label="Date">${dateLabel}</td>
      <td data-label="Holiday">${escapeHtml(h.name)}</td>
      <td data-label="Status"><span class="chip ${isPast ? 'muted-chip' : 'approved'}">${isPast ? 'Past' : 'Holiday'}</span></td>
    `;
    calendarBody.appendChild(row);
  });

  if (heading) heading.textContent = showAllHolidays ? 'Public Holidays 2026' : 'Upcoming Public Holidays';
  if (toggleBtn) {
    toggleBtn.textContent = showAllHolidays ? 'Show upcoming only' : 'See all holidays';
    toggleBtn.classList.remove('hidden');
  }
}

const holidayToggleBtn = document.getElementById('holidayToggleBtn');
if (holidayToggleBtn) {
  holidayToggleBtn.addEventListener('click', () => {
    showAllHolidays = !showAllHolidays;
    renderHolidaysToCalendar();
  });
}

function renderLeaveRows(rows) {
  clearRenderedLeaveRows();
  state.leaveRowsById = new Map((rows || []).map((row) => [row.id, row]));
  refreshNotifyBell();

  // Render holidays into their own table
  renderHolidaysToCalendar();

  // Clear the team leave calendar tbody
  const teamLeaveBody = teamLeaveCalendarTable?.querySelector('tbody');
  if (teamLeaveBody) teamLeaveBody.innerHTML = '';

  if (!(rows || []).length) {
    if (leaveApprovalTableBody) {
      const emptyApproval = document.createElement('tr');
      emptyApproval.innerHTML = '<td colspan="6">No leave requests yet.</td>';
      leaveApprovalTableBody.appendChild(emptyApproval);
    }
    if (teamLeaveBody) {
      const emptyLeave = document.createElement('tr');
      emptyLeave.innerHTML = '<td colspan="4">No upcoming team leave.</td>';
      teamLeaveBody.appendChild(emptyLeave);
    }
    refreshLeavePendingCount();
    return;
  }

  // Calculate 30-day window for team leave visibility
  const todayDate = new Date();
  const todayStr = toISODateLocal(todayDate);
  const futureDate = new Date(todayDate);
  futureDate.setDate(futureDate.getDate() + 30);
  const futureStr = toISODateLocal(futureDate);

  let teamLeaveCount = 0;

  // Split into pending and decided for the approval table
  const pendingRows = (rows || []).filter(r => r.status === 'pending');
  const decidedRows = (rows || []).filter(r => r.status !== 'pending')
    .sort((a, b) => {
      // Rows with decided_at sort first (latest on top); imported rows without decision sink to bottom
      if (a.decided_at && !b.decided_at) return -1;
      if (!a.decided_at && b.decided_at) return 1;
      const da = a.decided_at || a.created_at || '';
      const db = b.decided_at || b.created_at || '';
      return db.localeCompare(da);
    });
  const DECIDED_PAGE_SIZE = 5;
  let decidedPage = 0;
  const toggleBtn = document.getElementById('leaveApprovalToggle');

  function buildApprovalRow(row) {
    const employeeName = displayPersonName(row.employee?.full_name || state.currentEmployee || 'Employee', 'Employee');
    const dateLabel = formatLeaveDateRange(row.start_date, row.end_date) + (row.is_half_day ? ' (½ day)' : '');
    const statusMeta = leaveStatusMeta(row.status);
    const requesterAccessLevel = normalizeAccessLevel(row.employee?.access_level || 'employee');
    const requiresSuperadminDecision = requesterAccessLevel === 'leadership';
    // Decisions belong to the ROUTED approver (direct manager) + superadmin —
    // not leadership-wide. Everyone in leadership still SEES the table.
    const routedToMe = approverEmailList(row.approver_emails)
      .includes(normalizeEmail(state.employeeProfile?.email || state.session?.user?.email || ''));
    const canDecide =
      row.status === 'pending' &&
      (routedToMe || isSuperadminUser()) &&
      (!requiresSuperadminDecision || isSuperadminUser());
    const tr = document.createElement('tr');
    tr.dataset.requestId = row.id;
    tr.innerHTML = `
      <td data-label="Employee">${escapeHtml(employeeName)}</td>
      <td data-label="Type">${escapeHtml(row.leave_type)}</td>
      <td data-label="Dates">${dateLabel}</td>
      <td data-label="Status" class="leave-approval-status"><span class="chip ${statusMeta.chipClass}">${statusMeta.label}</span></td>
      <td data-label="Action">
        <button class="ghost small" data-leave-action="approve" ${canDecide ? '' : 'disabled'}>Approve</button>
        <button class="ghost small" data-leave-action="reject" ${canDecide ? '' : 'disabled'}>Reject</button>
      </td>
      <td data-label="Decision" class="leave-decision-meta">${formatDecisionText(row)}</td>
    `;
    return tr;
  }

  function renderApprovalTable() {
    if (!leaveApprovalTableBody) return;
    leaveApprovalTableBody.querySelectorAll('tr').forEach(r => r.remove());

    // Pending first
    pendingRows.forEach(row => leaveApprovalTableBody.appendChild(buildApprovalRow(row)));

    // Then decided — paginated
    const totalDecidedPages = Math.max(1, Math.ceil(decidedRows.length / DECIDED_PAGE_SIZE));
    decidedPage = Math.min(decidedPage, totalDecidedPages - 1);
    const pageStart = decidedPage * DECIDED_PAGE_SIZE;
    const pageSlice = decidedRows.slice(pageStart, pageStart + DECIDED_PAGE_SIZE);
    pageSlice.forEach(row => leaveApprovalTableBody.appendChild(buildApprovalRow(row)));

    if (toggleBtn) {
      if (decidedRows.length > DECIDED_PAGE_SIZE) {
        toggleBtn.classList.remove('hidden');
        const pageLabel = `${decidedPage + 1} / ${totalDecidedPages}`;
        toggleBtn.innerHTML = `<button class="ghost small leave-page-prev" ${decidedPage === 0 ? 'disabled' : ''}>&larr;</button> <span style="font-size:13px;color:var(--muted)">Past decisions · ${pageLabel}</span> <button class="ghost small leave-page-next" ${decidedPage >= totalDecidedPages - 1 ? 'disabled' : ''}>&rarr;</button>`;
      } else {
        toggleBtn.classList.add('hidden');
      }
    }
  }

  renderApprovalTable();

  if (toggleBtn) {
    toggleBtn.onclick = (e) => {
      const totalPages = Math.max(1, Math.ceil(decidedRows.length / DECIDED_PAGE_SIZE));
      if (e.target.closest('.leave-page-next') && decidedPage < totalPages - 1) {
        decidedPage++;
        renderApprovalTable();
        refreshLeavePendingCount();
      } else if (e.target.closest('.leave-page-prev') && decidedPage > 0) {
        decidedPage--;
        renderApprovalTable();
        refreshLeavePendingCount();
      }
    };
  }

  // Team leave calendar
  const allTeamLeave = (rows || []).filter(
    (row) => (row.status === 'approved' || row.status === 'pending') && row.end_date >= todayStr
  );
  const next30Leave = allTeamLeave.filter((row) => row.start_date <= futureStr);
  let showAllTeamLeave = false;
  const teamLeaveToggle = document.getElementById('teamLeaveToggleBtn');
  const teamLeaveHeading = document.getElementById('teamLeaveHeading');

  function buildTeamLeaveRow(row) {
    const employeeName = displayPersonName(row.employee?.full_name || state.currentEmployee || 'Employee', 'Employee');
    const dateLabel = formatLeaveDateRange(row.start_date, row.end_date) + (row.is_half_day ? ' (½ day)' : '');
    const statusMeta = leaveStatusMeta(row.status);
    const tr = document.createElement('tr');
    tr.dataset.requestId = row.id;
    tr.innerHTML = `
      <td data-label="Date">${dateLabel}</td>
      <td data-label="Person">${escapeHtml(employeeName)}</td>
      <td data-label="Type">${escapeHtml(row.leave_type)}</td>
      <td data-label="Status"><span class="chip ${statusMeta.chipClass} leave-calendar-status">${statusMeta.label}</span></td>
    `;
    return tr;
  }

  function renderTeamLeaveCalendar() {
    if (!teamLeaveBody) return;
    teamLeaveBody.innerHTML = '';
    const visible = showAllTeamLeave ? allTeamLeave : next30Leave.slice(0, 5);
    if (!visible.length) {
      const emptyLeave = document.createElement('tr');
      emptyLeave.innerHTML = `<td colspan="4">No ${showAllTeamLeave ? '' : 'upcoming '}team leave${showAllTeamLeave ? '.' : ' in the next 30 days.'}</td>`;
      teamLeaveBody.appendChild(emptyLeave);
    } else {
      visible.forEach((row) => teamLeaveBody.appendChild(buildTeamLeaveRow(row)));
    }
    if (teamLeaveHeading) {
      teamLeaveHeading.textContent = showAllTeamLeave ? 'All Upcoming Team Leave' : 'Team Leave (Next 30 Days)';
    }
    if (teamLeaveToggle) {
      if (allTeamLeave.length > 0 && (showAllTeamLeave || next30Leave.length > 5 || allTeamLeave.length > next30Leave.length)) {
        teamLeaveToggle.classList.remove('hidden');
        teamLeaveToggle.textContent = showAllTeamLeave ? 'Show next 30 days only' : 'See all team leave';
      } else if (allTeamLeave.length > 0) {
        teamLeaveToggle.classList.remove('hidden');
        teamLeaveToggle.textContent = 'See all team leave';
      } else {
        teamLeaveToggle.classList.add('hidden');
      }
    }
  }

  renderTeamLeaveCalendar();

  if (teamLeaveToggle) {
    teamLeaveToggle.onclick = () => {
      showAllTeamLeave = !showAllTeamLeave;
      renderTeamLeaveCalendar();
    };
  }

  refreshLeavePendingCount();
  refreshOnLeaveTodayBadge();
}

async function loadLeaveRequestsFromSupabase() {
  if (!state.supabase || !state.isAuthenticated) {
    applyLeaveCycleSummary(emptyLeaveSummary());
    setLeaveBalanceNotice('Sign in to load leave balances.');
    clearRenderedLeaveRows();
    renderHolidaysToCalendar();
    return;
  }

  const leaveRowsResult = await state.supabase
    .from('leave_requests')
    .select(`
      id,
      employee_id,
      leave_type,
      start_date,
      end_date,
      reason,
      is_half_day,
      status,
      approver_emails,
      created_at,
      decided_at,
      employee:employees!leave_requests_employee_id_fkey (
        id,
        full_name,
        email,
        access_level
      )
    `)
    .order('created_at', { ascending: false })
    .limit(2000);

  if (leaveRowsResult.error) {
    console.error(leaveRowsResult.error);
    if (leaveApprovalNotice) {
      leaveApprovalNotice.textContent = `Unable to load leave requests: ${leaveRowsResult.error.message}`;
      leaveApprovalNotice.className = 'status warn';
    }
    setLeaveBalanceNotice(`Unable to load leave balances: ${leaveRowsResult.error.message}`, 'status warn');
    clearRenderedLeaveRows();
    renderHolidaysToCalendar();
    return;
  }

  renderLeaveRows(leaveRowsResult.data || []);
  await loadLeaveCycleSummaryFromSupabase();
  if (isLeadershipRole()) loadReporteeLeaveSnapshot();
}

function computeNextLeaveMap() {
  const todayStr = toISODateLocal();
  const nextLeaveByEmployee = new Map();
  state.leaveRowsById.forEach((row) => {
    if ((row.status === 'approved' || row.status === 'pending') && row.start_date > todayStr) {
      const empId = row.employee_id;
      const existing = nextLeaveByEmployee.get(empId);
      if (!existing || row.start_date < existing) {
        nextLeaveByEmployee.set(empId, row.start_date);
      }
    }
  });
  return nextLeaveByEmployee;
}

function buildLeaveSnapshotRow(emp, summaryMap, nextLeaveMap) {
  const s = summaryMap.get(emp.id) || {};
  let plRem = s.pl_remaining ?? 0;
  let clRem = s.cl_remaining ?? 0;
  let slRem = s.sl_remaining ?? 0;
  if (plRem < 0) { slRem += plRem; plRem = 0; }
  if (clRem < 0) { slRem += clRem; clRem = 0; }
  const totalTaken = (s.pl_taken ?? 0) + (s.cl_taken ?? 0) + (s.sl_taken ?? 0);
  const totalRemaining = plRem + clRem + slRem;
  const nextDate = nextLeaveMap.get(emp.id);
  const tr = document.createElement('tr');
  if (totalRemaining <= 0) tr.className = 'leave-row-warning';
  tr.innerHTML = `
    <td data-label="Name">${escapeHtml(displayPersonName(emp.full_name, '--'))}</td>
    <td data-label="PL Rem.">${leaveDayText(plRem)}</td>
    <td data-label="CL Rem.">${leaveDayText(clRem)}</td>
    <td data-label="SL Rem." class="${slRem < 0 ? 'leave-negative' : ''}">${leaveDayText(slRem)}</td>
    <td data-label="Taken">${leaveDayText(totalTaken)}</td>
    <td data-label="Total Rem."><strong>${leaveDayText(totalRemaining)}</strong></td>
    <td data-label="Next Leave">${nextDate ? formatDateForLabel(nextDate) : '--'}</td>
  `;
  return tr;
}

function renderReporteeLeaveSnapshotRows(employees, summaryMap, nextLeaveMap) {
  if (!reporteeLeaveSnapshotBody) return;
  reporteeLeaveSnapshotBody.innerHTML = '';
  if (!employees.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="7">No reportees with leave tracking.</td>';
    reporteeLeaveSnapshotBody.appendChild(row);
    return;
  }

  // Group by department
  const byDept = new Map();
  employees.forEach((emp) => {
    const dept = normalizeTeamName(emp.department?.name, TEAM_AM);
    if (!byDept.has(dept)) byDept.set(dept, []);
    byDept.get(dept).push(emp);
  });

  // Sort departments: alphabetical, leadership last
  const orderedDepts = [...byDept.keys()].sort((a, b) => {
    const aIsLeadership = a.toLowerCase() === 'leadership' ? 1 : 0;
    const bIsLeadership = b.toLowerCase() === 'leadership' ? 1 : 0;
    if (aIsLeadership !== bIsLeadership) return aIsLeadership - bIsLeadership;
    return a.localeCompare(b);
  });

  // Sort employees within each department by name
  orderedDepts.forEach((dept) => {
    byDept.get(dept).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  });

  orderedDepts.forEach((dept) => {
    const deptRow = document.createElement('tr');
    deptRow.className = 'matrix-dept-row';
    deptRow.innerHTML = `<td>${escapeHtml(dept)}</td>${'<td></td>'.repeat(6)}`;
    reporteeLeaveSnapshotBody.appendChild(deptRow);

    byDept.get(dept).forEach((emp) => {
      reporteeLeaveSnapshotBody.appendChild(buildLeaveSnapshotRow(emp, summaryMap, nextLeaveMap));
    });
  });
}

async function loadReporteeLeaveSnapshot() {
  if (!isLeadershipRole() || !state.supabase || !reporteeLeaveSnapshotBody) return;
  const managerEmail = normalizeEmail(state.employeeProfile?.email || state.session?.user?.email || '');
  const reportees = reporteeEmployeesForManager(managerEmail)
    .filter((e) => e.leave_tracking_enabled !== false);
  if (!reportees.length) {
    renderReporteeLeaveSnapshotRows([], new Map(), new Map());
    return;
  }
  const employeeIds = reportees.map((e) => e.id);
  try {
    const response = await state.supabase.rpc('get_leave_summaries_for_employees', {
      p_employee_ids: employeeIds,
      p_as_of_date: toISODateLocal()
    });
    if (response.error) {
      console.error('Reportee leave snapshot error:', response.error);
      reporteeLeaveSnapshotBody.innerHTML = `<tr><td colspan="7">Unable to load: ${escapeHtml(response.error.message)}</td></tr>`;
      return;
    }
    const summaries = Array.isArray(response.data) ? response.data : [];
    const summaryMap = new Map();
    summaries.forEach((s) => summaryMap.set(s.employee_id, s));
    const nextLeaveMap = computeNextLeaveMap();
    renderReporteeLeaveSnapshotRows(reportees, summaryMap, nextLeaveMap);
  } catch (error) {
    console.error('Reportee leave snapshot failed:', error);
  }
}

async function loadAllEmployeeLeaveSnapshot() {
  if (!isLeadershipRole() || !state.supabase || !reporteeLeaveSnapshotBody) return;
  const allEmployees = state.employeeDirectory
    .filter((e) => e.leave_tracking_enabled !== false && e.is_active !== false);
  if (!allEmployees.length) {
    renderReporteeLeaveSnapshotRows([], new Map(), new Map());
    return;
  }
  const employeeIds = allEmployees.map((e) => e.id);
  try {
    const response = await state.supabase.rpc('get_leave_summaries_for_employees', {
      p_employee_ids: employeeIds,
      p_as_of_date: toISODateLocal()
    });
    if (response.error) {
      console.error('All employee leave snapshot error:', response.error);
      return;
    }
    const summaries = Array.isArray(response.data) ? response.data : [];
    const summaryMap = new Map();
    summaries.forEach((s) => summaryMap.set(s.employee_id, s));
    const nextLeaveMap = computeNextLeaveMap();
    renderReporteeLeaveSnapshotRows(allEmployees, summaryMap, nextLeaveMap);
  } catch (error) {
    console.error('All employee leave snapshot failed:', error);
  }
}

if (seeAllLeavesBtn) {
  seeAllLeavesBtn.addEventListener('click', async () => {
    seeAllLeavesBtn.disabled = true;
    seeAllLeavesBtn.textContent = 'Loading...';
    try {
      await loadAllEmployeeLeaveSnapshot();
      seeAllLeavesBtn.textContent = 'Showing all employees';
    } catch (err) {
      console.error('Failed to load all employee leave snapshot:', err);
      seeAllLeavesBtn.textContent = 'See all employees';
    } finally {
      seeAllLeavesBtn.disabled = false;
    }
  });
}

async function notifyApproverOnLeaveSubmit(leaveRequestId) {
  if (!state.session?.access_token || !leaveRequestId) return;

  try {
    await fetch('/api/leave-submitted', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.session.access_token}`
      },
      body: JSON.stringify({ leaveRequestId })
    });
  } catch (error) {
    console.error('Leave notification trigger failed:', error);
  }
}

function updateLeaveHint() {
  if (!leaveType || !leaveStart || !leaveEnd || !leaveRuleHint) return;
  const employeeRecord = selectedEmployeeRecord();
  const leaveBlocked = employmentIsScoped(employeeRecord.employmentType) || employeeRecord.leaveTrackingEnabled === false;
  if (submitLeaveBtn) submitLeaveBtn.disabled = leaveBlocked;

  if (leaveBlocked) {
    leaveRuleHint.textContent = 'Leave workflow is unavailable for fractional or leave-excluded employees.';
    leaveRuleHint.className = 'status warn';
    return;
  }

  const startValue = leaveStart.value;
  const endValue = leaveEnd.value;

  if (!startValue && !endValue) {
    leaveRuleHint.textContent = '';
    leaveRuleHint.className = 'status';
    return;
  }

  if (!startValue || !endValue) {
    leaveRuleHint.textContent = '';
    leaveRuleHint.className = 'status';
    return;
  }

  const start = parseIsoDateLocal(startValue);
  const end = parseIsoDateLocal(endValue);

  if (!start || !end) {
    leaveRuleHint.textContent = 'Please select valid start and end dates.';
    leaveRuleHint.className = 'status error';
    return;
  }

  if (end < start) {
    leaveRuleHint.textContent = 'Invalid date range. End date must be on or after start date.';
    leaveRuleHint.className = 'status error';
    return;
  }

  // Policy rule lives in js/leave.js (leavePolicyCheck, unit-tested).
  // Calendar-day counting per policy: Fri→Mon = 4 days.
  const halfDayEl = document.getElementById('leaveHalfDay');
  const halfDay = Boolean(halfDayEl?.checked);
  if (halfDay && startValue !== endValue) {
    leaveRuleHint.textContent = 'Half day applies to single-day requests only — match the start and end date.';
    leaveRuleHint.className = 'status warn';
    return;
  }
  let days = calendarDayCount(start, end);
  if (halfDay && days === 1) days = 0.5;
  const check = leavePolicyCheck(leaveType.value, days);
  leaveRuleHint.textContent = check.text;
  leaveRuleHint.className = check.level === 'warn' ? 'status warn' : 'status';
}

if (document.getElementById('leaveHalfDay')) {
  document.getElementById('leaveHalfDay').addEventListener('change', updateLeaveHint);
}

[leaveType, leaveStart, leaveEnd].forEach((el) => {
  if (el) el.addEventListener('change', updateLeaveHint);
});
updateLeaveHint();

const medCertLabel = document.getElementById('medCertLabel');
if (leaveType && medCertLabel) {
  const toggleMedCert = () => {
    medCertLabel.classList.toggle('hidden', leaveType.value !== 'SL');
  };
  leaveType.addEventListener('change', toggleMedCert);
  toggleMedCert();
}

if (submitLeaveBtn) {
  submitLeaveBtn.addEventListener('click', async () => {
    const employeeName = displayPersonName(state.currentEmployee || DEFAULT_EMPLOYEE, 'Employee');
    const leaveCode = leaveType?.value || 'CL';
    const dates = formatLeaveDateRange(leaveStart?.value, leaveEnd?.value);
    const employeeRecord = selectedEmployeeRecord();
    const reason = (leaveReason?.value || '').trim();
    const medicalCertificateUrl = (leaveMedicalCertificateUrl?.value || '').trim();

    if (!dates) {
      if (leaveRuleHint) {
        leaveRuleHint.textContent = 'Please select a valid leave date range.';
        leaveRuleHint.className = 'status error';
      }
      return;
    }

    if (employmentIsScoped(employeeRecord.employmentType) || employeeRecord.leaveTrackingEnabled === false) {
      if (leaveEmailNotice) {
        leaveEmailNotice.textContent = 'Leave workflow is unavailable for fractional or leave-excluded employees.';
        leaveEmailNotice.className = 'mini-meta';
      }
      return;
    }

    if (state.leaveCycleSummary) {
      const s = state.leaveCycleSummary;
      const totalRemaining = (s.pl?.remaining ?? 0) + (s.cl?.remaining ?? 0) + (s.sl?.remaining ?? 0);
      if (totalRemaining <= 0) {
        if (leaveRuleHint) {
          leaveRuleHint.textContent = 'You have exhausted your leave balance for this cycle. Please contact leadership.';
          leaveRuleHint.className = 'status error';
        }
        return;
      }
    }

    submitLeaveBtn.disabled = true;
    const origLeaveText = submitLeaveBtn.textContent;
    submitLeaveBtn.textContent = 'Submitting…';

    try {
      if (state.supabase && state.isAuthenticated) {
        const leaveResult = await state.supabase.rpc('submit_leave_request', {
          p_leave_type: leaveCode,
          p_start_date: leaveStart?.value,
          p_end_date: leaveEnd?.value,
          p_reason: reason || null,
          p_medical_certificate_url: medicalCertificateUrl || null,
          p_is_half_day: Boolean(document.getElementById('leaveHalfDay')?.checked) && leaveStart?.value === leaveEnd?.value
        });

        if (leaveResult.error) {
          if (leaveEmailNotice) {
            leaveEmailNotice.textContent = `Leave submission failed: ${leaveResult.error.message}`;
            leaveEmailNotice.className = 'mini-meta';
          }
          return;
        }

        await notifyApproverOnLeaveSubmit(leaveResult.data?.id);
        await loadLeaveRequestsFromSupabase();
        loadLeaveCycleSummaryFromSupabase();
      } else {
        addLeaveRequestToTables({ employee: employeeName, type: leaveCode, dates });
        refreshLeavePendingCount();
      }

      if (leaveEmailNotice) {
        leaveEmailNotice.textContent = 'Leave submitted. Leadership has been notified by email for approval.';
        leaveEmailNotice.classList.add('ts-fresh');
      }
      if (leaveApprovalNotice) {
        leaveApprovalNotice.textContent = `${employeeName} leave request submitted. Leadership notified by email.`;
        leaveApprovalNotice.className = 'status';
      }
      submitLeaveBtn.textContent = 'Submitted!';
    } catch (error) {
      console.error(error);
      if (leaveEmailNotice) {
        leaveEmailNotice.textContent = `Leave submission failed: ${error.message}`;
        leaveEmailNotice.className = 'mini-meta';
      }
    } finally {
      submitLeaveBtn.disabled = false;
      setTimeout(() => { submitLeaveBtn.textContent = origLeaveText; }, 2000);
    }
  });
}

if (leaveApprovalTableBody) {
  leaveApprovalTableBody.addEventListener('click', async (event) => {
    const actionBtn = event.target.closest('button[data-leave-action]');
    if (!actionBtn) return;

    const row = actionBtn.closest('tr');
    const requestId = row?.dataset.requestId;
    if (!row || !requestId) return;

    const employee = row.children[0]?.textContent?.trim() || 'Employee';
    const action = actionBtn.dataset.leaveAction;
    const approved = action === 'approve';
    const statusClass = approved ? 'approved' : 'rejected';
    const label = approved ? 'Approved' : 'Rejected';
    const decision = `${label} by leadership on ${formatTimestamp()}`;

    // Routed-approver-only guard (matches buildApprovalRow + the RLS policy):
    // decisions belong to the request's approver_emails + superadmin.
    if (state.isAuthenticated) {
      const leaveRow = state.leaveRowsById?.get(requestId);
      const routedToMe = approverEmailList(leaveRow?.approver_emails || [])
        .includes(normalizeEmail(state.employeeProfile?.email || ''));
      if (leaveRow && !routedToMe && !isSuperadminUser()) {
        if (leaveApprovalNotice) {
          const approverList = approverEmailList(leaveRow.approver_emails).join(', ') || 'their manager';
          leaveApprovalNotice.textContent = `This request is routed to ${approverList} — only they (or the superadmin) can decide it.`;
          leaveApprovalNotice.className = 'status warn';
        }
        return;
      }
    }

    actionBtn.disabled = true;
    const origActionText = actionBtn.textContent;
    actionBtn.textContent = approved ? 'Approving…' : 'Rejecting…';
    /* Disable sibling action button too */
    const siblingBtns = row.querySelectorAll('button[data-leave-action]');
    siblingBtns.forEach((b) => { b.disabled = true; });

    try {
      if (state.supabase && state.isAuthenticated) {
        const updateResult = await state.supabase
          .from('leave_requests')
          .update({
            status: approved ? 'approved' : 'rejected',
            decided_at: new Date().toISOString(),
            decision_note: `${label} via leadership panel`
          })
          .eq('id', requestId);

        if (updateResult.error) {
          if (leaveApprovalNotice) {
            leaveApprovalNotice.textContent = `Leave decision failed: ${updateResult.error.message}`;
            leaveApprovalNotice.className = 'status warn';
          }
          return;
        }

        await loadLeaveRequestsFromSupabase();
      } else {
        setApprovalRowStatus(row, statusClass, label, decision);
        setCalendarLeaveStatus(requestId, statusClass, label);
        refreshLeavePendingCount();
    }

    if (leaveApprovalNotice) {
      leaveApprovalNotice.textContent = `${employee} leave has been ${label.toLowerCase()}. Email notification sent to employee.`;
      leaveApprovalNotice.className = approved ? 'status' : 'status warn';
    }
    } catch (error) {
      console.error(error);
      if (leaveApprovalNotice) {
        leaveApprovalNotice.textContent = `Leave decision failed: ${error.message}`;
        leaveApprovalNotice.className = 'status warn';
      }
    } finally {
      siblingBtns.forEach((b) => { b.disabled = false; });
      actionBtn.textContent = origActionText;
    }
  });
}

refreshLeavePendingCount();

const plannerMonth = document.getElementById('plannerMonth');
const weekPrevBtn = document.getElementById('weekPrev');
const weekNextBtn = document.getElementById('weekNext');
const weekLabelEl = document.getElementById('weekLabel');
const matrixSearch = document.getElementById('matrixSearch');
const plannerPeopleView = document.getElementById('plannerPeopleView');
const plannerClientView = document.getElementById('plannerClientView');
const teamDashboardScopeNote = document.getElementById('teamDashboardScopeNote');
let _plannerActiveView = 'people'; // 'people' | 'clients'
const portfolioTableBody = document.getElementById('portfolioTableBody');
const newClientName = document.getElementById('newClientName');
const newClientType = document.getElementById('newClientType');
const newClientOwner = document.getElementById('newClientOwner');
const addClientBtn = document.getElementById('addClientBtn');
const cancelClientEditBtn = document.getElementById('cancelClientEditBtn');
const clientFormNotice = document.getElementById('clientFormNotice');
let editingClientId = null;

function addMonths(dateValue, months) {
  return new Date(dateValue.getFullYear(), dateValue.getMonth() + months, 1);
}

// formatPlannerMonthLabel lives in js/alloc.js

function populatePlannerMonthOptions() {
  if (!plannerMonth) return;

  const previousValue = String(plannerMonth.value || '').trim();
  const base = new Date();
  const monthDates = [0, 1, 2].map((offset) => addMonths(base, offset));

  plannerMonth.innerHTML = '';
  monthDates.forEach((monthDate, index) => {
    const option = document.createElement('option');
    option.value = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
    option.textContent = formatPlannerMonthLabel(monthDate);
    if (previousValue) {
      option.selected = option.value === previousValue;
    } else {
      option.selected = index === 0;
    }
    plannerMonth.appendChild(option);
  });

  if (!plannerMonth.value && plannerMonth.options.length) {
    plannerMonth.selectedIndex = 0;
  }
}

function setTeamDashboardScopeNote(message = '', className = 'mini-meta') {
  if (!teamDashboardScopeNote) return;
  teamDashboardScopeNote.className = className;
  teamDashboardScopeNote.textContent = message;
}

function plannerMonthWindow() {
  // Pure math lives in js/alloc.js; this just reads the month <select>.
  return monthWindowFor(plannerMonth?.value);
}

// plannerWeekStartsForMonth lives in js/alloc.js

// shortWeekLabel lives in js/alloc.js

// utilizationStatusMeta lives in js/alloc.js

function formatUtilPercentCompact(value, { zeroAsDash = false } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return zeroAsDash ? '—' : '0%';
  }
  return `${Math.round(numeric)}%`;
}

function weekUtilToneClass(value) {
  const numeric = Number(value) || 0;
  if (numeric > 100) return 'over';
  if (numeric > 0) return 'active';
  return 'zero';
}

function weekChipMarkup(weekStartIso, value, { primary = false } = {}) {
  const toneClass = weekUtilToneClass(value);
  const weekLabel = shortWeekLabel(weekStartIso);
  const valueLabel = formatUtilPercentCompact(value, { zeroAsDash: true });
  const weekId = weekIdentifierFromIsoDate(weekStartIso);
  const emphasisClass = primary ? 'week-chip-primary' : 'week-chip-secondary';
  return `<span class="week-chip ${emphasisClass} week-chip-${toneClass}" title="${escapeHtml(weekId)}">${escapeHtml(
    weekLabel
  )} ${escapeHtml(valueLabel)}</span>`;
}

function formatWeekSpread(weekStarts = [], totalsByWeek = new Map()) {
  if (!weekStarts.length) return '--';
  const primaryWeekStart = weekStarts[0];
  const primaryValue = Number(totalsByWeek.get(primaryWeekStart) || 0);
  const secondaryMarkup = weekStarts
    .slice(1)
    .map((weekStartIso) => weekChipMarkup(weekStartIso, Number(totalsByWeek.get(weekStartIso) || 0)))
    .join('');

  return `
    <div class="week-spread">
      ${weekChipMarkup(primaryWeekStart, primaryValue, { primary: true })}
      ${secondaryMarkup ? `<div class="week-spread-secondary">${secondaryMarkup}</div>` : ''}
    </div>
  `;
}

function renderTeamDashboardEmpty(message = 'No allocation data yet.') {
  if (plannerPeopleView) plannerPeopleView.innerHTML = `<p class="mini-meta" style="padding:var(--space-3)">${escapeHtml(message)}</p>`;
  if (plannerClientView) plannerClientView.innerHTML = '';
}

function renderResourceMatrix(teamMembers, allocationRows, weekStarts, monthLabel) {
  if (!plannerPeopleView) return;

  if (!teamMembers.length) {
    renderTeamDashboardEmpty('No reportees mapped for this leadership user yet.');
    setTeamDashboardScopeNote('No reportees mapped for this leadership user yet.');
    return;
  }

  // ── Build shared planner data ──
  const empWeekProjectAlloc = new Map();
  teamMembers.forEach((emp) => {
    empWeekProjectAlloc.set(emp.id, new Map());
    weekStarts.forEach((ws) => empWeekProjectAlloc.get(emp.id).set(ws, new Map()));
  });
  (allocationRows || []).forEach((row) => {
    const weekMap = empWeekProjectAlloc.get(row.employee_id);
    if (!weekMap) return;
    const projName = String(row.project?.name || 'Unassigned').trim();
    if (isGarbageProjectName(projName)) return;
    const value = Number(row.allocation_percent) || 0;
    const weekIso = String(row.period_start || '').trim();
    if (weekMap.has(weekIso)) {
      const projWeekMap = weekMap.get(weekIso);
      projWeekMap.set(projName, (projWeekMap.get(projName) || 0) + value);
    }
  });

  // Determine selected week
  const currentWeekIso = toISODateLocal(mondayWeekStartDate());
  if (state._matrixSelectedWeekIndex == null) {
    const currentIdx = weekStarts.indexOf(currentWeekIso);
    state._matrixSelectedWeekIndex = currentIdx >= 0 ? currentIdx : 0;
  }
  const selectedIdx = Math.max(0, Math.min(state._matrixSelectedWeekIndex, weekStarts.length - 1));
  const selectedWeek = weekStarts[selectedIdx] || currentWeekIso;

  if (weekLabelEl) {
    const weekDate = new Date(selectedWeek + 'T00:00:00');
    weekLabelEl.textContent = `Week of ${weekDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }
  if (weekPrevBtn) weekPrevBtn.disabled = selectedIdx <= 0;
  if (weekNextBtn) weekNextBtn.disabled = selectedIdx >= weekStarts.length - 1;

  // Per-employee allocations for selected week
  const empProjectAlloc = new Map();
  teamMembers.forEach((emp) => {
    const weekMap = empWeekProjectAlloc.get(emp.id);
    empProjectAlloc.set(emp.id, weekMap?.get(selectedWeek) || new Map());
  });

  // Build employee metrics grouped by department
  const byDept = new Map();
  teamMembers.forEach((emp) => {
    const team = normalizeTeamName(emp.department?.name, TEAM_AM);
    if (!byDept.has(team)) byDept.set(team, []);
    const projMap = empProjectAlloc.get(emp.id) || new Map();
    const totalPercent = [...projMap.values()].reduce((s, v) => s + v, 0);
    const capacity = Number(emp.capacity_percent) || 100;
    const freePercent = capacity - totalPercent;
    byDept.get(team).push({ employee: emp, team, projMap, totalPercent, capacity, freePercent, status: utilizationStatusMeta(totalPercent, capacity) });
  });

  const orderedDepts = [...byDept.keys()].sort((a, b) => {
    const aL = a.toLowerCase() === 'leadership' ? 1 : 0;
    const bL = b.toLowerCase() === 'leadership' ? 1 : 0;
    return aL !== bL ? aL - bL : a.localeCompare(b);
  });
  orderedDepts.forEach((dept) => {
    byDept.get(dept).sort((a, b) => {
      if (a.status.key === 'over' && b.status.key !== 'over') return -1;
      if (a.status.key !== 'over' && b.status.key === 'over') return 1;
      return a.freePercent - b.freePercent;
    });
  });

  // Store for re-render
  state._matrixWeekStarts = weekStarts;
  state._matrixEmpWeekProjectAlloc = empWeekProjectAlloc;
  state._matrixTeamMembers = teamMembers;
  state._matrixAllocationRows = allocationRows;
  state._plannerByDept = byDept;
  state._plannerOrderedDepts = orderedDepts;
  state._plannerEmpProjectAlloc = empProjectAlloc;

  setTeamDashboardScopeNote('');
  renderActivePlannerView();
}

// ── Client color palette ──
const PLANNER_CLIENT_COLORS = [
  '#7c6f9c', '#5a8a7a', '#b8865e', '#6a8caf', '#a1716e',
  '#8b9e6b', '#c2855c', '#6e7fa8', '#9b7b8e', '#7aaa8e',
  '#b09060', '#5f8e9e', '#a8827a', '#88a070', '#c09070'
];
const _clientColorMap = new Map();
function getClientColor(clientName) {
  const key = normalizeClientNameKey(clientName);
  if (key === 'internal') return 'rgba(var(--text-rgb), 0.12)';
  if (!_clientColorMap.has(key)) {
    _clientColorMap.set(key, PLANNER_CLIENT_COLORS[_clientColorMap.size % PLANNER_CLIENT_COLORS.length]);
  }
  return _clientColorMap.get(key);
}
if (typeof window !== 'undefined') window.getClientColor = getClientColor;

function renderActivePlannerView() {
  if (_plannerActiveView === 'clients') {
    renderPlannerClientView();
  } else {
    renderPlannerPeopleView();
  }
  // Show/hide containers
  if (plannerPeopleView) plannerPeopleView.style.display = _plannerActiveView === 'people' ? '' : 'none';
  if (plannerClientView) plannerClientView.style.display = _plannerActiveView === 'clients' ? '' : 'none';
}

// ── People View: stacked bars per person ──
function renderPlannerPeopleView() {
  if (!plannerPeopleView || !state._plannerByDept) return;
  const byDept = state._plannerByDept;
  const orderedDepts = state._plannerOrderedDepts || [];

  let html = '';
  orderedDepts.forEach((dept) => {
    html += `<div class="rp-dept-header">${escapeHtml(dept)}</div><div class="rp-dept-grid">`;
    (byDept.get(dept) || []).forEach((metric) => {
      const emp = metric.employee;
      const empName = displayPersonName(emp.full_name, 'Employee');
      const totalPct = Math.round(metric.totalPercent);
      const freePct = Math.round(metric.freePercent);
      const freeClass = freePct < 0 ? 'rp-free-over' : freePct < 10 ? 'rp-free-tight' : 'rp-free-ok';
      const overClass = metric.status.key === 'over' ? ' rp-row-over' : metric.totalPercent === 0 ? ' rp-row-idle' : '';

      // Build stacked bar segments
      const projects = [...metric.projMap.entries()]
        .filter(([n]) => normalizeClientNameKey(n) !== 'internal')
        .sort((a, b) => b[1] - a[1]);
      const internalPct = Math.round(metric.projMap.get('Internal') || 0);

      let barSegments = '';
      projects.forEach(([name, pct]) => {
        const w = Math.round(pct);
        if (w <= 0) return;
        barSegments += `<div class="rp-bar-seg" style="width:${w}%;background:${getClientColor(name)}" title="${escapeHtml(name)} ${w}%"></div>`;
      });
      if (internalPct > 0) {
        barSegments += `<div class="rp-bar-seg" style="width:${internalPct}%;background:rgba(var(--text-rgb),0.12)" title="Internal ${internalPct}%"></div>`;
      }

      // Client labels below bar
      const labels = projects.map(([name, pct]) =>
        `<span class="rp-client-label"><span class="rp-client-dot" style="background:${getClientColor(name)}"></span>${escapeHtml(name)} ${Math.round(pct)}%</span>`
      ).join('');
      const internalLabel = internalPct > 0 ? `<span class="rp-client-label"><span class="rp-client-dot" style="background:rgba(var(--text-rgb),0.12)"></span>Internal ${internalPct}%</span>` : '';

      html += `
        <div class="rp-person${overClass}" data-emp-name="${(emp.full_name || '').toLowerCase()}" data-emp-dept="${(dept || '').toLowerCase()}">
          <div class="rp-person-head">
            <span class="rp-person-name" data-emp-id="${emp.id}">${escapeHtml(empName)}</span>
            <span class="rp-person-pct">${totalPct}% used</span>
            <span class="rp-person-free ${freeClass}">${freePct}% free</span>
          </div>
          <div class="rp-bar">${barSegments}</div>
          <div class="rp-client-labels">${labels}${internalLabel}</div>
        </div>`;
    });
    html += `</div>`;
  });

  plannerPeopleView.innerHTML = html || '<p class="mini-meta" style="padding:var(--space-3)">No allocation data.</p>';
}

// ── Client View: cards per client ──
function renderPlannerClientView() {
  if (!plannerClientView || !state._plannerByDept) return;
  const byDept = state._plannerByDept;
  const orderedDepts = state._plannerOrderedDepts || [];

  // Aggregate: client → [{empName, dept, pct}]
  const clientMap = new Map(); // clientName → { people: [], totalPct: 0 }
  orderedDepts.forEach((dept) => {
    (byDept.get(dept) || []).forEach((metric) => {
      const empName = displayPersonName(metric.employee.full_name, 'Employee');
      metric.projMap.forEach((pct, projName) => {
        if (normalizeClientNameKey(projName) === 'internal') return;
        if (pct <= 0) return;
        if (!clientMap.has(projName)) clientMap.set(projName, { people: [], totalPct: 0 });
        const entry = clientMap.get(projName);
        entry.people.push({ name: empName, dept, pct: Math.round(pct) });
        entry.totalPct += pct;
      });
    });
  });

  // Sort by total allocation descending
  const sortedClients = [...clientMap.entries()]
    .map(([name, data]) => ({ name, ...data, totalPct: Math.round(data.totalPct) }))
    .sort((a, b) => b.totalPct - a.totalPct);

  // Find unallocated people
  const allMetrics = orderedDepts.flatMap((d) => byDept.get(d) || []);
  const idlePeople = allMetrics
    .filter(m => m.totalPercent === 0)
    .map(m => ({ name: displayPersonName(m.employee.full_name, 'Employee'), dept: m.team }));

  let html = '';
  if (!sortedClients.length) {
    html = '<p class="mini-meta" style="padding:var(--space-3)">No client allocations this week.</p>';
  } else {
    html += '<div class="rp-client-grid">';
    sortedClients.forEach((client) => {
      const color = getClientColor(client.name);
      const totalHrs = Math.round(client.totalPct * 0.4 * 10) / 10; // 40hr week
      const peopleHtml = client.people
        .sort((a, b) => b.pct - a.pct)
        .map(p => {
          const pHrs = Math.round(p.pct * 0.4 * 10) / 10;
          return `<div class="rp-cv-person"><span>${escapeHtml(p.name)}</span><span class="rp-cv-dept">${escapeHtml(p.dept)}</span><span class="rp-cv-pct">${p.pct}%</span><span class="rp-cv-hrs">${pHrs}h</span></div>`;
        })
        .join('');

      html += `
        <div class="rp-client-card" data-client-name="${(client.name || '').toLowerCase()}">
          <div class="rp-cc-head">
            <span class="rp-cc-color" style="background:${color}"></span>
            <span class="rp-cc-name">${escapeHtml(client.name)}</span>
          </div>
          <div class="rp-cc-people">
            ${peopleHtml}
            <div class="rp-cv-total"><span>Total</span><span class="rp-cv-pct">${client.totalPct}%</span><span class="rp-cv-hrs">${totalHrs}h</span></div>
          </div>
        </div>`;
    });
    html += '</div>';
  }

  if (idlePeople.length) {
    html += `<div class="rp-dept-header" style="margin-top:var(--space-3)">Unallocated</div>`;
    idlePeople.forEach(p => {
      html += `<div class="rp-idle-person"><span>${escapeHtml(p.name)}</span><span class="rp-cv-dept">${escapeHtml(p.dept)}</span><span class="rp-cv-pct">0%</span></div>`;
    });
  }

  plannerClientView.innerHTML = html;
}

async function loadTeamDashboardFromSupabase() {
  if (!canAccessTeamDashboard()) {
    renderTeamDashboardEmpty('Team dashboard is available only for leadership and finance.');
    setTeamDashboardScopeNote('Team dashboard is available only for leadership and finance.');
    return;
  }

  if (!state.supabase || !state.isAuthenticated) {
    renderTeamDashboardEmpty('Sign in to load team allocation snapshots.');
    setTeamDashboardScopeNote('Sign in to load team allocation snapshots.');
    return;
  }

  const managerEmail = normalizeEmail(state.employeeProfile?.email || state.session?.user?.email || '');
  const teamMembers = (isLeadershipRole()
    ? state.employeeDirectory.slice().sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || '')))
    : reporteeEmployeesForManager(managerEmail))
    .filter(e => !getHiddenEmployeeEmails().includes(normalizeEmail(e.email)))
    // Not part of the capacity pool — the planner is for assigning against
    // available capacity, and these people don't have any to offer. They stay
    // visible everywhere else (directory, clients, scope owners, tasks).
    .filter(e => !isCapacityExcluded(e))
    .filter(e => e.is_active !== false);
  const monthWindow = plannerMonthWindow();
  const weekStarts = plannerWeekStartsForMonth(monthWindow);

  if (!teamMembers.length) {
    renderResourceMatrix([], [], weekStarts, monthWindow.monthLabel);
    return;
  }

  const teamEmployeeIds = teamMembers.map((employee) => employee.id);
  const response = await state.supabase
    .from('allocations')
    .select(`
      employee_id,
      period_start,
      allocation_percent,
      updated_at,
      project:projects!allocations_project_id_fkey (
        name
      )
    `)
    .eq('period_type', 'week')
    .in('employee_id', teamEmployeeIds)
    .gte('period_start', toISODateLocal(mondayWeekStartDate(monthWindow.monthStartDate)))
    .lte('period_start', monthWindow.monthEndIso)
    .order('period_start', { ascending: true })
    .order('updated_at', { ascending: true });

  if (response.error) {
    console.error(response.error);
    renderTeamDashboardEmpty(`Unable to load team dashboard: ${response.error.message}`);
    setTeamDashboardScopeNote(`Unable to load team dashboard: ${response.error.message}`, 'status warn');
    return;
  }

  renderResourceMatrix(teamMembers, response.data || [], weekStarts, monthWindow.monthLabel);
}

function setClientFormNotice(message = '', className = 'mini-meta') {
  if (!clientFormNotice) return;
  clientFormNotice.className = className;
  clientFormNotice.textContent = message;
}

function normalizeClientNameKey(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function currentClientOwnerFullName() {
  const ownDirectoryRow = lookupActiveEmployee(state.currentEmployeeId);
  const fallbackFromSession = displayNameFromEmail(state.session?.user?.email || '');
  return String(ownDirectoryRow?.full_name || state.employeeProfile?.full_name || fallbackFromSession || '').trim();
}

function resolveClientOwnerRow(owner) {
  const ownerDisplay = displayPersonName(owner, '');
  // Display-context match: try exact, then prettified comparison; fall back to current user.
  const all = _allEmployees();
  return (
    all.find((row) => row.full_name === owner || displayPersonName(row.full_name, '') === ownerDisplay) ||
    lookupActiveEmployee(state.currentEmployeeId) ||
    null
  );
}

function resetClientEditor() {
  editingClientId = null;
  if (addClientBtn) addClientBtn.textContent = 'Add Client';
  if (cancelClientEditBtn) cancelClientEditBtn.classList.add('hidden');
  if (newClientName) newClientName.value = '';
  if (newClientType) newClientType.value = 'retainer';
  renderClientOwnerOptions();
}

function startClientEdit(clientId) {
  const target = state.clients.find((row) => String(row.id) === String(clientId));
  if (!target) return;

  editingClientId = target.id;
  if (newClientName) newClientName.value = target.name || '';
  if (newClientType) newClientType.value = target.type === 'retainer' ? 'retainer' : target.type === 'pitch' ? 'pitch' : 'project';

  if (newClientOwner) {
    const preferredOwner = target.owner_full_name || '';
    const directMatch = [...newClientOwner.options].some((opt) => opt.value === preferredOwner);
    if (directMatch) {
      newClientOwner.value = preferredOwner;
    } else {
      const ownerDisplay = displayPersonName(target.owner || preferredOwner, '');
      const displayMatch = [...newClientOwner.options].find(
        (opt) => displayPersonName(opt.value, '') === ownerDisplay
      );
      if (displayMatch) {
        newClientOwner.value = displayMatch.value;
      }
    }
  }

  if (addClientBtn) addClientBtn.textContent = 'Update Client';
  if (cancelClientEditBtn) cancelClientEditBtn.classList.remove('hidden');
  setClientFormNotice(`Editing ${target.name}. Save to update, or cancel.`);
  if (newClientName) newClientName.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function refreshProjectFilterOptions() {
  if (isLeadershipRole()) {
    loadTeamDashboardFromSupabase().catch((error) => {
      console.error(error);
      setTeamDashboardScopeNote(`Unable to load team dashboard: ${error.message}`, 'status warn');
    });
  }
}

function renderClientOwnerOptions() {
  if (!newClientOwner) return;
  const leadershipMode = isLeadershipRole();
  const current = newClientOwner.value;
  const ownerNames = dedupeSortedNames(state.employeeDirectory.map((row) => row.full_name));
  const defaultOwner = currentClientOwnerFullName();
  const optionNames = leadershipMode
    ? ownerNames.length
      ? ownerNames
      : defaultOwner
        ? [defaultOwner]
        : []
    : defaultOwner
      ? [defaultOwner]
      : [];
  newClientOwner.disabled = !leadershipMode;

  newClientOwner.innerHTML = '';
  if (!optionNames.length) {
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = 'No owners available';
    newClientOwner.appendChild(emptyOption);
    return;
  }

  optionNames.forEach((fullName) => {
    const option = document.createElement('option');
    option.value = fullName;
    option.textContent = displayPersonName(fullName, 'Employee');
    newClientOwner.appendChild(option);
  });

  const selectedValue = optionNames.includes(current)
    ? current
    : optionNames.includes(defaultOwner)
      ? defaultOwner
      : optionNames[0];
  newClientOwner.value = selectedValue;
}

function addPortfolioRow({ client, type, owner, status = 'Active' }) {
  const normalizedName = String(client || '').trim();
  if (!normalizedName) return;
  const normalizedType = type === 'retainer' ? 'retainer' : type === 'pitch' ? 'pitch' : 'project';
  const ownerFullName = String(owner || '').trim();
  const ownerLabel = displayPersonName(ownerFullName || '-', '-');
  const existing = state.clients.find((row) => normalizeEmail(row.name) === normalizeEmail(normalizedName));
  if (existing) {
    existing.type = normalizedType;
    existing.owner = ownerLabel;
    existing.owner_full_name = ownerFullName;
    existing.status = status || existing.status || 'Active';
  } else {
    state.clients.push({
      id: `local-${Date.now()}`,
      name: normalizedName,
      type: normalizedType,
      owner: ownerLabel,
      owner_full_name: ownerFullName,
      is_active: true,
      status: status || 'Active'
    });
  }
  renderClientRegistryTable();
}

let clientSortColumn = 'name';
let clientSortAsc = true;

async function renderClientRegistryTable() {
  if (!portfolioTableBody) return;
  const showAdd = canAddClients();
  const showEdit = canEditClients();
  const showDelete = canDeleteClients();
  const showArchiveGlobal = canArchiveClients();

  // Fetch which clients have analytics data (distinct client_ids)
  let clientsWithAnalytics = new Set();
  try {
    const { data: analyticsRows } = await state.supabase
      .from('client_analytics')
      .select('client_id');
    if (analyticsRows) clientsWithAnalytics = new Set(analyticsRows.map(r => r.client_id));
  } catch (_) { /* ignore — just hide all analytics buttons */ }

  const hasAnyAction = true;

  // Show/hide add form based on permission
  const formPanel = portfolioTableBody.closest('section')?.querySelector('.client-form-inline')?.parentElement;
  if (formPanel) formPanel.style.display = showAdd ? '' : 'none';

  portfolioTableBody.innerHTML = '';
  const visibleClients = state.clients.filter((entry) =>
    normalizeClientNameKey(entry.name) !== 'internal' && entry.is_active !== false
  );
  const totalCols = hasAnyAction ? 5 : 4;
  if (!visibleClients.length) {
    const empty = document.createElement('tr');
    empty.innerHTML = `<td colspan="${totalCols}">No clients yet.</td>`;
    portfolioTableBody.appendChild(empty);
    refreshProjectFilterOptions();
    renderTaskClientOptions();
    renderArchivedClientsTable();
    return;
  }

  const sortFn = (a, b) => {
    let valA, valB;
    if (clientSortColumn === 'type') {
      valA = a.type || 'project';
      valB = b.type || 'project';
    } else if (clientSortColumn === 'status') {
      valA = a.status || 'active';
      valB = b.status || 'active';
    } else if (clientSortColumn === 'owner') {
      valA = a.owner || '';
      valB = b.owner || '';
    } else {
      valA = a.name || '';
      valB = b.name || '';
    }
    const cmp = typeof valA === 'number' ? valA - valB : String(valA).localeCompare(String(valB));
    return clientSortAsc ? cmp : -cmp;
  };

  // Update Actions column header visibility
  const table = portfolioTableBody.closest('table');
  const actionsHeader = table?.querySelector('thead th:last-child');
  if (actionsHeader) actionsHeader.style.display = hasAnyAction ? '' : 'none';

  const ordered = [...visibleClients].sort(sortFn);
  ordered.forEach((entry) => {
    const row = document.createElement('tr');
    const normalizedType = entry.type === 'retainer' ? 'Retainer' : entry.type === 'pitch' ? 'Pitch' : 'Project';
    const chipClass = entry.type === 'retainer' ? 'approved' : entry.type === 'pitch' ? 'info' : 'pending';
    const eid = escapeHtml(entry.id);
    const canArchiveThis = canArchiveClient(entry);
    const hasAnalytics = clientsWithAnalytics.has(entry.id);
    let nameIcons = '';
    if (canEditScopeCoverage()) nameIcons += `<button class="ghost small client-name-icon" type="button" data-client-action="scope-coverage" data-client-id="${eid}" title="Scope & Coverage">⚙️</button>`;
    let actions = hasAnalytics
      ? `<button class="ghost small" type="button" data-client-action="analytics" data-client-id="${eid}" title="Analytics">📊</button>`
      : `<button class="ghost small" type="button" data-client-action="analytics" data-client-id="${eid}" title="Upload analytics" style="opacity:0.35">📊</button>`;
    if (showEdit) actions += `<button class="ghost small" type="button" data-client-action="edit" data-client-id="${eid}">Edit</button>`;
    if (canArchiveThis) actions += `<button class="ghost small" type="button" data-client-action="archive" data-client-id="${eid}">Archive</button>`;
    if (showDelete) actions += `<button class="ghost small danger" type="button" data-client-action="delete" data-client-id="${eid}">Delete</button>`;
    row.innerHTML = `
      <td data-label="Client">${nameIcons}<a href="#" class="client-name-link" data-client-id="${eid}">${escapeHtml(entry.name)}</a></td>
      <td data-label="Type"><span class="chip ${chipClass}">${normalizedType}</span></td>
      <td data-label="Status">${escapeHtml(entry.status || 'Active')}</td>
      <td data-label="Owner">${escapeHtml(entry.owner || '-')}</td>
      <td data-label="">${actions}</td>
    `;
    portfolioTableBody.appendChild(row);
  });
  updateClientSortHeaders();
  refreshProjectFilterOptions();
  renderTaskClientOptions();
  renderWeeklyAllocationViews();
  renderArchivedClientsTable();
}

function updateClientSortHeaders() {
  const table = portfolioTableBody?.closest('table');
  if (!table) return;
  const headers = table.querySelectorAll('thead th');
  const columns = ['name', 'type', 'status', 'owner', null];
  headers.forEach((th, i) => {
    const col = columns[i];
    if (!col) { th.style.cursor = ''; return; }
    th.style.cursor = 'pointer';
    const baseText = th.textContent.replace(/\s*[\u25B2\u25BC\u25BD].*$/, '');
    if (clientSortColumn === col) {
      th.textContent = baseText + (clientSortAsc ? ' \u25B2' : ' \u25BC');
    } else {
      th.textContent = baseText + ' \u25BD';
    }
  });
}

function handleClientSortClick(event) {
  const table = portfolioTableBody?.closest('table');
  if (!table) return;
  const th = event.target.closest('th');
  if (!th) return;
  const headers = [...table.querySelectorAll('thead th')];
  const columns = ['name', 'type', 'status', 'owner', null];
  const idx = headers.indexOf(th);
  const col = columns[idx];
  if (!col) return;
  if (clientSortColumn === col) {
    clientSortAsc = !clientSortAsc;
  } else {
    clientSortColumn = col;
    clientSortAsc = true;
  }
  renderClientRegistryTable();
}

async function loadClientsFromSupabase() {
  if (!state.supabase || !state.isAuthenticated) {
    renderClientRegistryTable();
    return;
  }

  const response = await state.supabase
    .from('clients')
    .select(`
      id,
      name,
      is_active,
      created_at,
      updated_at,
      account_owner_employee_id,
      audience_persona,
      account_owner:employees!clients_account_owner_employee_id_fkey (
        id,
        full_name
      ),
      projects (
        engagement_type,
        status
      )
    `)
    .order('name', { ascending: true });

  if (response.error) {
    console.error(response.error);
    renderClientRegistryTable();
    return;
  }

  const mapped = (response.data || []).map((row) => {
    const firstProject = Array.isArray(row.projects) && row.projects.length ? row.projects[0] : null;
    const ownerFullName = row.account_owner?.full_name || '';
    return {
      id: row.id,
      name: row.name,
      type: firstProject?.engagement_type === 'retainer' ? 'retainer' : firstProject?.engagement_type === 'pitch' ? 'pitch' : 'project',
      owner_employee_id: row.account_owner?.id || null,
      owner: displayPersonName(ownerFullName || '-', '-'),
      owner_full_name: ownerFullName,
      is_active: row.is_active !== false,
      status: row.is_active === false ? 'Archived' : (firstProject?.status || 'Active'),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null
    };
  });

  const dedupedByName = new Map();
  mapped.forEach((entry) => {
    const key = normalizeClientNameKey(entry.name);
    if (!key) return;
    const existing = dedupedByName.get(key);
    if (!existing) {
      dedupedByName.set(key, entry);
      return;
    }
    const existingTime = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
    const nextTime = entry.updated_at ? new Date(entry.updated_at).getTime() : 0;
    const shouldReplace = nextTime > existingTime;
    if (shouldReplace) {
      dedupedByName.set(key, entry);
    }
  });
  state.clients = [...dedupedByName.values()].sort((a, b) => a.name.localeCompare(b.name));

  renderClientRegistryTable();
  renderClientOwnerOptions();
}


async function upsertClientToSupabase({ client, type, owner }) {
  const normalizedName = String(client || '').trim();
  if (!normalizedName || !state.supabase || !state.isAuthenticated) return;
  const ownerRow = isLeadershipRole() ? resolveClientOwnerRow(owner) : null;
  const ownerId = isLeadershipRole() ? ownerRow?.id || state.currentEmployeeId || null : state.currentEmployeeId || null;
  if (!ownerId) throw new Error('Could not resolve owner for this client.');

  const clientResult = await state.supabase
    .from('clients')
    .upsert(
      {
        name: normalizedName,
        account_owner_employee_id: ownerId,
        is_active: true
      },
      { onConflict: 'name' }
    )
    .select('id')
    .single();

  if (clientResult.error) throw clientResult.error;

  const projectResult = await state.supabase.from('projects').upsert(
    {
      client_id: clientResult.data.id,
      name: normalizedName,
      engagement_type: type === 'retainer' ? 'retainer' : type === 'pitch' ? 'pitch' : 'project',
      status: 'active',
      owner_employee_id: ownerId
    },
    { onConflict: 'client_id,name' }
  );

  if (projectResult.error) throw projectResult.error;
}

async function syncRenamedClientReferencesInSupabase({ previousName, nextName, ownerId }) {
  const oldName = String(previousName || '').trim();
  const newName = String(nextName || '').trim();
  if (!oldName || !newName || oldName === newName) return;

  const leadershipMode = isLeadershipRole();

  let taskUpdateQuery = state.supabase.from('daily_tasks').update({ notes: newName }).eq('notes', oldName);
  if (!leadershipMode) {
    taskUpdateQuery = taskUpdateQuery.eq('employee_id', state.currentEmployeeId);
  }
  const taskUpdate = await taskUpdateQuery;
  if (taskUpdate.error) {
    console.warn('Unable to sync renamed daily task references:', taskUpdate.error.message);
  }

  const internalClient = await state.supabase.from('clients').select('id').eq('name', 'Internal').maybeSingle();
  if (internalClient.error) {
    console.warn('Unable to locate Internal client for rename sync:', internalClient.error.message);
    return;
  }
  if (!internalClient.data?.id) return;

  let projectsQuery = state.supabase
    .from('projects')
    .select('id, name, owner_employee_id')
    .eq('client_id', internalClient.data.id)
    .in('name', [oldName, newName]);
  if (!leadershipMode) {
    projectsQuery = projectsQuery.eq('owner_employee_id', state.currentEmployeeId);
  }
  const projectsResult = await projectsQuery;
  if (projectsResult.error) {
    console.warn('Unable to load Internal projects for rename sync:', projectsResult.error.message);
    return;
  }

  const projects = projectsResult.data || [];
  const oldProject = projects.find((row) => row.name === oldName) || null;
  const nextProject = projects.find((row) => row.name === newName) || null;

  if (!oldProject) return;

  if (!nextProject) {
    const renameProject = await state.supabase
      .from('projects')
      .update({
        name: newName,
        owner_employee_id: ownerId || null
      })
      .eq('id', oldProject.id);
    if (renameProject.error) {
      console.warn('Unable to rename Internal project during client rename sync:', renameProject.error.message);
    }
    return;
  }

  let allocationUpdateQuery = state.supabase
    .from('allocations')
    .update({ project_id: nextProject.id })
    .eq('project_id', oldProject.id);
  if (!leadershipMode) {
    allocationUpdateQuery = allocationUpdateQuery.eq('employee_id', state.currentEmployeeId);
  }
  const migrateAllocations = await allocationUpdateQuery;
  if (migrateAllocations.error) {
    console.warn('Unable to migrate allocation project references during client rename sync:', migrateAllocations.error.message);
  }

  if (leadershipMode) {
    const deleteOldProject = await state.supabase.from('projects').delete().eq('id', oldProject.id);
    if (deleteOldProject.error) {
      console.warn('Unable to delete old Internal project during client rename sync:', deleteOldProject.error.message);
    }
  }
}

async function updateClientInSupabase({ clientId, client, type, owner }) {
  const normalizedName = String(client || '').trim();
  if (!clientId || !normalizedName || !state.supabase || !state.isAuthenticated) return;

  const currentClientResult = await state.supabase.from('clients').select('name').eq('id', clientId).maybeSingle();
  if (currentClientResult.error) throw currentClientResult.error;
  const previousName = String(currentClientResult.data?.name || '').trim();

  const ownerRow = isLeadershipRole() ? resolveClientOwnerRow(owner) : null;
  const ownerId = isLeadershipRole() ? ownerRow?.id || state.currentEmployeeId || null : state.currentEmployeeId || null;
  if (!ownerId) throw new Error('Could not resolve owner for this client.');

  const clientResult = await state.supabase
    .from('clients')
    .update({
      name: normalizedName,
      account_owner_employee_id: ownerId,
      is_active: true
    })
    .eq('id', clientId);

  if (clientResult.error) throw clientResult.error;

  const projectLookup = await state.supabase
    .from('projects')
    .select('id')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });
  if (projectLookup.error) throw projectLookup.error;

  const normalizedType = type === 'retainer' ? 'retainer' : type === 'pitch' ? 'pitch' : 'project';
  if ((projectLookup.data || []).length) {
    const updateProject = await state.supabase
      .from('projects')
      .update({
        name: normalizedName,
        engagement_type: normalizedType,
        status: 'active',
        owner_employee_id: ownerId
      })
      .eq('id', projectLookup.data[0].id);
    if (updateProject.error) throw updateProject.error;
  } else {
    const insertProject = await state.supabase.from('projects').insert({
      client_id: clientId,
      name: normalizedName,
      engagement_type: normalizedType,
      status: 'active',
      owner_employee_id: ownerId
    });
    if (insertProject.error) throw insertProject.error;
  }

  await syncRenamedClientReferencesInSupabase({
    previousName,
    nextName: normalizedName,
    ownerId
  });
}

function updateLocalClientById({ clientId, client, type, owner }) {
  const normalizedName = String(client || '').trim();
  if (!clientId || !normalizedName) return;

  const normalizedType = type === 'retainer' ? 'retainer' : type === 'pitch' ? 'pitch' : 'project';
  const ownerFullName = String(owner || '').trim();
  const ownerLabel = displayPersonName(ownerFullName || '-', '-');

  state.clients = state.clients.map((row) => {
    if (String(row.id) !== String(clientId)) return row;
    return {
      ...row,
      name: normalizedName,
      type: normalizedType,
      owner: ownerLabel,
      owner_full_name: ownerFullName,
      status: row.status || 'Active'
    };
  });
}

async function fetchClientDependencySummary(clientId, clientName) {
  if (!state.supabase || !state.isAuthenticated || String(clientId).startsWith('local-')) {
    return { lines: [], total: 0 };
  }
  const weekStartIso = getCurrentWeekStartIso();
  const tasks = [
    state.supabase.from('client_scope_items').select('id', { count: 'exact', head: true }).eq('client_id', clientId).eq('is_active', true),
    state.supabase.from('client_standing_allocations').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
    // Active allocations only — this week, joined via project (allocations has no
    // client_id, so the old .eq('client_id') silently errored and always returned 0).
    state.supabase.from('allocations').select('id, projects!inner(client_id)', { count: 'exact', head: true }).eq('projects.client_id', clientId).eq('period_type', 'week').eq('period_start', weekStartIso),
    // Active engagement only: contracted + still running. Completed / terminated /
    // lost deals are history and shouldn't make a wrapped-up client look in-use.
    state.supabase.from('deals').select('id', { count: 'exact', head: true }).eq('client_id', clientId).eq('stage', 'contracted').eq('termination_type', 'Active'),
  ];
  const [scopeRes, standingRes, weeklyRes, dealsRes] = await Promise.all(tasks);
  // Tasks table uses `notes` for client name
  let tasksCount = 0;
  if (clientName) {
    // Only LIVE tasks count as "currently linked". Archived/done tasks are
    // historical and show in no active view — counting them made dormant
    // clients (e.g. EXAMPLE RESEARCH: 9 archived + 1 in-progress) look busy at archive time.
    const tasksRes = await state.supabase.from('daily_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('notes', clientName)
      .neq('status', 'archived')
      .neq('status', 'done');
    if (!tasksRes.error) tasksCount = tasksRes.count || 0;
  }
  const rows = [
    ['Active scope items', scopeRes.count || 0],
    ['Standing allocations', standingRes.count || 0],
    ['Active allocations this week', weeklyRes.count || 0],
    ['Active deals', dealsRes.count || 0],
    ['Active daily tasks tagged to this client', tasksCount],
  ];
  const lines = rows.filter(([, n]) => n > 0).map(([label, n]) => `• ${label}: ${n}`);
  const total = rows.reduce((s, [, n]) => s + n, 0);
  return { lines, total };
}

async function deleteClientById(clientId) {
  if (!clientId) return;
  const target = state.clients.find((row) => String(row.id) === String(clientId));
  const targetName = target?.name || 'this client';
  let summaryText = '';
  try {
    const { lines, total } = await fetchClientDependencySummary(clientId, targetName);
    summaryText = total
      ? `\n\nThis will cascade-delete the following linked data:\n${lines.join('\n')}`
      : '\n\nNo linked data found.';
  } catch (err) {
    console.warn('Dependency summary failed:', err);
  }
  const confirmed = await appConfirm(`Delete ${targetName}?${summaryText}\n\nThis cannot be undone.`, { title: 'Delete client', confirmLabel: 'Delete', danger: true });
  if (!confirmed) return;

  if (state.supabase && state.isAuthenticated && !String(clientId).startsWith('local-')) {
    const deleteResult = await state.supabase.from('clients').delete().eq('id', clientId);
    if (deleteResult.error) throw deleteResult.error;
    await loadClientsFromSupabase();
    await loadWeeklyAllocationsFromSupabase();
  } else {
    state.clients = state.clients.filter((row) => String(row.id) !== String(clientId));
    renderClientRegistryTable();
  }

  if (String(editingClientId) === String(clientId)) {
    resetClientEditor();
  }
  setClientFormNotice(`Deleted ${targetName}.`);
}

async function archiveClientById(clientId) {
  if (!clientId) return;
  const target = state.clients.find((row) => String(row.id) === String(clientId));
  const targetName = target?.name || 'this client';
  let summaryText = '';
  try {
    const { lines, total } = await fetchClientDependencySummary(clientId, targetName);
    summaryText = total
      ? `\n\nCurrently linked (data will be preserved):\n${lines.join('\n')}`
      : '';
  } catch (err) {
    console.warn('Dependency summary failed:', err);
  }
  // If the client has a live engagement (active contracted deal), let the user
  // close it out here — so we never leave an "Active" deal on an archived client.
  let activeDeals = [];
  if (state.supabase && state.isAuthenticated && !String(clientId).startsWith('local-')) {
    const dr = await state.supabase.from('deals').select('id, deal_name')
      .eq('client_id', clientId).eq('stage', 'contracted').eq('termination_type', 'Active');
    if (!dr.error) activeDeals = dr.data || [];
  }

  let termination = null; // 'Good Termination' | 'Bad Termination' | null (leave the deal alone)
  if (activeDeals.length) {
    const dealLabel = activeDeals.map(d => d.deal_name).join(', ');
    const choice = await appChoice(
      `Archive ${targetName}? The client will be hidden but all data is preserved.${summaryText}\n\n${targetName} has a live engagement (${dealLabel}). How did it end?`,
      {
        title: 'Archive client',
        choices: [
          { label: 'Completed — good', value: 'Good Termination', variant: 'primary' },
          { label: 'Completed — ended badly', value: 'Bad Termination' },
          { label: 'Leave the deal as-is', value: 'leave' }
        ]
      }
    );
    if (!choice) return; // cancelled
    if (choice !== 'leave') termination = choice;
  } else {
    const confirmed = await appConfirm(`Archive ${targetName}? The client will be hidden but all data is preserved.${summaryText}`);
    if (!confirmed) return;
  }

  let dealNote = '';
  if (state.supabase && state.isAuthenticated && !String(clientId).startsWith('local-')) {
    const archiveResult = await state.supabase.from('clients').update({ is_active: false }).eq('id', clientId);
    if (archiveResult.error) throw archiveResult.error;

    // Close out the engagement deal(s) per the user's choice.
    if (termination && activeDeals.length) {
      const dealIds = activeDeals.map(d => d.id);
      const dealRes = await state.supabase.from('deals')
        .update({ termination_type: termination, updated_at: new Date().toISOString() })
        .in('id', dealIds)
        .select('id');
      if (dealRes.error) dealNote = ` (couldn't update the deal: ${dealRes.error.message})`;
      else if ((dealRes.data?.length || 0) < dealIds.length) dealNote = ' (deal not updated — you may not have deal-edit access)';
      else dealNote = ` Engagement marked ${termination}.`;
      if (state.deals?.length) await loadDealsFromSupabase().catch(() => {});
    }

    notifyClientStatusChange('client_archived', { clientId });
    await loadClientsFromSupabase();
  } else {
    state.clients = state.clients.map((row) =>
      String(row.id) === String(clientId) ? { ...row, is_active: false, status: 'Archived' } : row
    );
    renderClientRegistryTable();
  }

  if (String(editingClientId) === String(clientId)) {
    resetClientEditor();
  }
  setClientFormNotice(`Archived ${targetName}.${dealNote}`);
}

function renderArchivedClientsTable() {
  const archivedBody = document.getElementById('archivedClientsBody');
  if (!archivedBody) return;
  const archivedPanel = document.getElementById('archivedClientsPanel');

  const archivedClients = state.clients.filter((entry) =>
    normalizeClientNameKey(entry.name) !== 'internal' && entry.is_active === false
  );

  archivedBody.innerHTML = '';
  if (!archivedClients.length) {
    if (archivedPanel) archivedPanel.style.display = 'none';
    return;
  }

  // Only show archived clients that the user can see/unarchive
  const visibleArchived = archivedClients.filter(entry => canArchiveClient(entry));
  if (!visibleArchived.length) {
    if (archivedPanel) archivedPanel.style.display = 'none';
    return;
  }

  if (archivedPanel) archivedPanel.style.display = '';
  visibleArchived.sort((a, b) => a.name.localeCompare(b.name)).forEach((entry) => {
    const row = document.createElement('tr');
    const normalizedType = entry.type === 'retainer' ? 'Retainer' : entry.type === 'pitch' ? 'Pitch' : 'Project';
    const chipClass = entry.type === 'retainer' ? 'approved' : entry.type === 'pitch' ? 'info' : 'pending';
    const eid = escapeHtml(entry.id);
    row.innerHTML = `
      <td data-label="Client">${escapeHtml(entry.name)}</td>
      <td data-label="Type"><span class="chip ${chipClass}">${normalizedType}</span></td>
      <td data-label="Owner">${escapeHtml(entry.owner || '-')}</td>
      <td data-label=""><button class="ghost small" type="button" data-client-action="unarchive" data-client-id="${eid}">Unarchive</button></td>
    `;
    archivedBody.appendChild(row);
  });
}

async function unarchiveClientById(clientId) {
  if (!clientId) return;
  const target = state.clients.find((row) => String(row.id) === String(clientId));
  const targetName = target?.name || 'this client';

  if (state.supabase && state.isAuthenticated && !String(clientId).startsWith('local-')) {
    const result = await state.supabase.from('clients').update({ is_active: true }).eq('id', clientId);
    if (result.error) throw result.error;
    await loadClientsFromSupabase();
  } else {
    state.clients = state.clients.map((row) =>
      String(row.id) === String(clientId) ? { ...row, is_active: true, status: 'Active' } : row
    );
    renderClientRegistryTable();
  }

  setClientFormNotice(`Restored ${targetName}.`);
}

// ── Client Detail View ───────────────────────────────────────────
const clientDetailView = document.getElementById('clientDetailView');
const clientDetailBack = document.getElementById('clientDetailBack');
const clientDetailName = document.getElementById('clientDetailName');
const clientDetailMeta = document.getElementById('clientDetailMeta');
const clientDetailAllocBody = document.getElementById('clientDetailAllocBody');
const clientDetailTaskBody = document.getElementById('clientDetailTaskBody');
const clientDetailEngagement = document.getElementById('clientDetailEngagement');
const clientListPanels = document.querySelectorAll('#client-projects > .panel, #client-projects > .screen-head');

if (clientDetailEngagement) {
  clientDetailEngagement.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-client-action="scope-coverage"]');
    if (!btn || !canEditScopeCoverage()) return;
    scopeCoverageCurrentClientId = btn.dataset.clientId || '';
    navigateToScreen('client-scope-coverage');
  });
}

// Engagement & Scope summary on the client page: the live contract (from deals)
// + active scope items. The client page otherwise shows only this-week work
// (allocations + tasks), so a contracted-but-idle client looked empty.
async function renderClientEngagement(clientId) {
  if (!clientDetailEngagement) return;
  if (!state.supabase || !state.isAuthenticated) { clientDetailEngagement.innerHTML = ''; return; }
  clientDetailEngagement.innerHTML = '<h3>Engagement &amp; Scope</h3><p class="mini-meta">Loading…</p>';

  const [dealsRes, scopeRes] = await Promise.all([
    state.supabase.from('deals').select('deal_name, stage, termination_type').eq('client_id', clientId),
    state.supabase.from('client_scope_items').select('title, scope_type, end_month').eq('client_id', clientId).eq('is_active', true).order('sort_order', { ascending: true })
  ]);
  if (String(state.selectedClientId) !== String(clientId)) return; // user navigated away mid-fetch
  const deals = dealsRes.error ? [] : (dealsRes.data || []);
  const scope = scopeRes.error ? [] : (scopeRes.data || []);

  const active = deals.find(d => d.stage === 'contracted' && d.termination_type === 'Active');
  const completed = deals.find(d => d.stage === 'contracted' && d.termination_type && d.termination_type !== 'Active');
  const open = deals.find(d => ['qualified', 'discovery', 'proposal', 'negotiated'].includes(d.stage));
  let chip = 'pending', label = 'No active contract', dealName = '';
  if (active) { chip = 'approved'; label = 'Active'; dealName = active.deal_name; }
  else if (completed) { chip = 'pending'; label = 'Completed'; dealName = completed.deal_name; }
  else if (open) { chip = 'info'; label = 'In pipeline'; dealName = open.deal_name; }

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const fmtMonth = (iso) => { const d = new Date(String(iso).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }); };
  const scopeHtml = scope.length
    ? scope.map(s => {
        const stale = s.end_month && new Date(String(s.end_month).slice(0, 10) + 'T00:00:00') < monthStart;
        return `<div class="eng-scope-item"><span>${escapeHtml(s.title || 'Untitled')}</span><span class="chip">${escapeHtml(s.scope_type || 'scope')}</span>${stale ? `<span class="eng-stale">⚠ ended ${fmtMonth(s.end_month)} · still active</span>` : ''}</div>`;
      }).join('')
    : '<span class="mini-meta">No active scope defined.</span>';

  clientDetailEngagement.innerHTML = `
    <h3>Engagement &amp; Scope</h3>
    <div class="eng-row">
      <span class="eng-label">Contract</span>
      <span class="chip ${chip}">${label}</span>
      ${dealName ? `<span class="eng-deal-name">${escapeHtml(dealName)}</span>` : ''}
    </div>
    <div class="eng-row eng-row-scope">
      <span class="eng-label">Scope</span>
      <div class="eng-scope-list">${scopeHtml}</div>
      ${canEditScopeCoverage() ? `<button class="ghost small" type="button" data-client-action="scope-coverage" data-client-id="${escapeHtml(clientId)}">Scope &amp; Coverage →</button>` : ''}
    </div>
  `;
}

async function showClientDetail(clientId) {
  const client = state.clients.find(c => String(c.id) === String(clientId));
  if (!client || !clientDetailView) return;

  // Ensure allocation data is loaded (may be empty for non-leadership users)
  if (!state.homeAllocations.length) {
    await loadHomeStatsFromSupabase();
  }

  // Hide list panels, show detail view. Uses a dedicated class (not `hidden`)
  // because applyRoleAccess() toggles `hidden` on .leadership-only nodes — for a
  // leadership user an auth refresh would strip `hidden` off the Archived Clients
  // panel and make it reappear above the open detail view.
  clientListPanels.forEach(el => el.classList.add('detail-hidden'));
  clientDetailView.classList.remove('hidden');
  state.selectedClientId = clientId;
  renderClientEngagement(clientId).catch(console.error);

  // Push history state so browser back returns to client list
  const url = new URL(window.location.href);
  url.hash = 'client-projects';
  window.history.pushState({ screenId: 'client-projects', clientDetailId: clientId }, '', url.toString());

  // Allocations — find from homeAllocations where project's client matches.
  // Build maps from BOTH active and offboarded employees so historical names always resolve.
  const empNameMap = new Map();
  _allEmployees().forEach(e => {
    const display = displayPersonName(e.full_name, e.email);
    empNameMap.set(e.id, e.is_active === false ? `${display} (offboarded)` : display);
  });

  const clientName = client.name.toLowerCase().trim();
  const allocRows = (state.homeAllocations || []).filter(a => {
    const projName = (a.project?.name || '').toLowerCase().trim();
    return projName === clientName;
  });

  let totalClientHours = 0;
  if (!allocRows.length) {
    clientDetailAllocBody.innerHTML = '<tr><td colspan="3">No allocations this week.</td></tr>';
  } else {
    const empAllocMap = new Map();
    allocRows.forEach(a => {
      const current = empAllocMap.get(a.employee_id) || 0;
      empAllocMap.set(a.employee_id, current + (a.allocation_percent || 0));
    });
    let allocHtml = '';
    [...empAllocMap.entries()].sort((a, b) => b[1] - a[1]).forEach(([empId, pct]) => {
      const name = empNameMap.get(empId) || lookupEmployeeName(empId);
      // Client-level: everyone counts here, INCLUDING client-scoped people —
      // this is the work the client is actually getting. allocation % is
      // already % of a full week, so no capacity multiplier (that showed a
      // 40%-capacity person allocated 40% as 7.2h instead of 18h).
      const hrs = (pct / 100) * WORK_HOURS_PER_WEEK;
      totalClientHours += hrs;
      allocHtml += `<tr>
        <td data-label="Person">${escapeHtml(name)}</td>
        <td data-label="Allocation %">${pct}%</td>
        <td data-label="Hours">${hrs.toFixed(1)}h</td>
      </tr>`;
    });
    clientDetailAllocBody.innerHTML = allocHtml;
  }

  // Header
  const normalizedType = client.type === 'retainer' ? 'Retainer' : client.type === 'pitch' ? 'Pitch' : 'Project';
  clientDetailName.textContent = client.name;
  clientDetailMeta.innerHTML = `
    <div class="util-box"><div class="util-label">Type</div><div class="util-value">${escapeHtml(normalizedType)}</div></div>
    <div class="util-box"><div class="util-label">Status</div><div class="util-value">${escapeHtml(client.status || 'Active')}</div></div>
    <div class="util-box"><div class="util-label">Owner</div><div class="util-value">${escapeHtml(client.owner || '-')}</div></div>
    <div class="util-box"><div class="util-label">Hrs/Week</div><div class="util-value">${totalClientHours > 0 ? Math.round(totalClientHours) + 'h' : '-'}</div></div>
  `;

  // Tasks — find today's tasks where notes (client) matches this client.
  // Names are resolved via the central helper, so offboarded folks appear
  // with an "(offboarded)" suffix instead of as "Unknown".
  // All ACTIVE tasks for this client, across the whole team. RLS allows reading
  // everyone's tasks and state.dailyTasks is company-wide, so this surfaces what
  // each person is working on for the client. (Was filtered to today's dated
  // tasks only, which hid weekly/undated tasks and made the panel look empty.)
  const clientTasks = (state.dailyTasks || []).filter(t => {
    const taskClient = (t.notes || '').toLowerCase().trim();
    return taskClient === clientName && t.status !== 'archived' && t.status !== 'done';
  });

  if (!clientTasks.length) {
    clientDetailTaskBody.innerHTML = '<tr><td colspan="4">No active tasks for this client.</td></tr>';
  } else {
    let taskHtml = '';
    clientTasks.forEach(t => {
      const name = empNameMap.get(t.employee_id) || lookupEmployeeName(t.employee_id);
      const statusChip = t.status === 'done' ? 'approved' : 'pending';
      const statusLabel = t.status === 'done' ? 'Done' : t.status === 'in_progress' ? 'In Progress' : t.status;
      taskHtml += `<tr${t.status === 'done' ? ' class="task-done"' : ''}>
        <td data-label="Person">${escapeHtml(name)}</td>
        <td data-label="Task">${escapeHtml(t.task_title || '')}</td>
        <td data-label="Status"><span class="chip ${statusChip}">${statusLabel}</span></td>
        <td data-label="Priority">${t.sort_order || '\u2013'}</td>
      </tr>`;
    });
    clientDetailTaskBody.innerHTML = taskHtml;
  }
}

function hideClientDetail() {
  if (clientDetailView) clientDetailView.classList.add('hidden');
  // Remove only the navigation class — role visibility (`hidden` via
  // applyRoleAccess) must survive going back, or non-leadership users would
  // see leadership-only panels after visiting a client detail.
  clientListPanels.forEach(el => el.classList.remove('detail-hidden'));
  state.selectedClientId = null;
}

if (clientDetailBack) {
  clientDetailBack.addEventListener('click', () => {
    hideClientDetail();
    // Pop the detail history entry so back doesn't re-trigger
    if (window.history.state?.clientDetailId) window.history.back();
  });
}

// Delegate click on client name links
if (portfolioTableBody) {
  portfolioTableBody.addEventListener('click', (event) => {
    const link = event.target.closest('.client-name-link');
    if (link) {
      event.preventDefault();
      showClientDetail(link.dataset.clientId);
    }
  });
}

// =============================================
// CLIENT ANALYTICS — LinkedIn Performance Reports
// =============================================

const analyticsUploadInline = document.getElementById('analyticsUploadInline');
const analyticsFileInput = document.getElementById('analyticsFileInput');

let analyticsCurrentClientId = null;
let scopeCoverageCurrentClientId = null;

// Display labels: existing department names → friendlier labels for the Scope & Coverage screen
const SCOPE_DEPT_LABELS = {
  'AM': 'Account Mgmt',
  'Acc Management': 'Account Mgmt',
  'Art': 'Design'
};
function scopeDeptLabel(name) {
  return SCOPE_DEPT_LABELS[name] || name || '—';
}


// Analytics parsing toolkit (parsers, detectReportType, mergeByKey, format
// helpers) lives in js/analytics.js — relocated verbatim in slice 6.

// --- Upload Flow (auto-detect + append/merge) ---

// ── Comms DOCX pipeline: unzip → vision-extract per send → review → merge ──
// Numbers read from screenshots by a model are PROPOSALS: the uploader sees
// every extracted row next to its send and confirms before anything is saved.
async function handleCommsDocxUpload(file, metaEl, detectedLabel) {
  if (detectedLabel) { detectedLabel.textContent = 'Comms report (screenshots) detected'; detectedLabel.style.display = ''; }
  if (metaEl) metaEl.textContent = 'Reading document\u2026';

  const entries = await extractZipEntries(await file.arrayBuffer());
  const docXml = new TextDecoder().decode(entries['word/document.xml'] || new Uint8Array());
  const relsXml = new TextDecoder().decode(entries['word/_rels/document.xml.rels'] || new Uint8Array());
  const sends = parseCommsDocxStructure(docXml, relsXml);
  if (!sends.length) throw new Error('No send sections with screenshots found in this document.');

  const token = state.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const toB64 = (bytes) => {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  const rows = [];
  const failures = [];
  for (let i = 0; i < sends.length; i++) {
    const send = sends[i];
    if (metaEl) metaEl.textContent = `Reading screenshots ${i + 1}/${sends.length}\u2026`;
    const images = send.imagePaths
      .filter((path) => entries[path])
      .map((path) => ({ data: toB64(entries[path]), mediaType: path.endsWith('.jpeg') || path.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }));
    if (!images.length) { failures.push(send.heading); continue; }
    try {
      const res = await fetch('/.netlify/functions/extract-send-stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ heading: send.heading, images })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { stats } = await res.json();
      const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
      rows.push({
        date: send.dateIso,
        name: send.heading,
        send_type: send.sendType === 'Dispatch' ? 'Dispatches' : send.sendType,
        delivered: Math.round(n(stats.delivered)),
        delivered_rate: n(stats.delivered_rate),
        opened: Math.round(n(stats.opened)),
        open_rate: n(stats.open_rate),
        clicked: Math.round(n(stats.clicked) || n(stats.unique_clicks)),
        click_rate: n(stats.click_rate),
        unsubscribed: Math.round(n(stats.unsubscribed)),
        hard_bounce: Math.round(n(stats.hard_bounce)),
        skipped: Math.round(n(stats.skipped))
      });
    } catch (err) {
      failures.push(`${send.heading} (${err.message})`);
    }
  }
  if (metaEl) metaEl.textContent = '';
  if (!rows.length) throw new Error('No sends could be read.' + (failures.length ? ` Failed: ${failures.join(', ')}` : ''));

  const approved = await showCommsReviewModal(rows, failures);
  if (!approved) { if (metaEl) metaEl.textContent = 'Upload cancelled — nothing saved.'; return; }
  if (metaEl) metaEl.textContent = 'Saving\u2026';

  // Raw file to storage for the record, like every other upload
  const filePath = `${analyticsCurrentClientId}/${Date.now()}_${file.name}`;
  await state.supabase.storage.from('client-analytics').upload(filePath, file, { upsert: false });
  await logAnalyticsUpload({
    clientId: analyticsCurrentClientId,
    reportType: 'community_pulse',
    fileName: file.name,
    objectName: filePath.split('/').pop()
  });

  const { data: existing } = await state.supabase
    .from('client_analytics')
    .select('report_label, metrics_data, demographics_data')
    .eq('client_id', analyticsCurrentClientId)
    .eq('report_type', 'community_pulse')
    .maybeSingle();

  // Same merge rule as the workbook path: sends merge by date+name.
  // Demographics are untouched — this file has none, and wiping the workbook's
  // subscriber/forum snapshot with null would be data loss.
  const oldMetrics = existing?.metrics_data || [];
  const mergedMetrics = mergeByKey(oldMetrics, rows, (r) => `${r.date}|${r.name}`)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const mergedSummary = communityPulseSummary(mergedMetrics, existing?.demographics_data || { subscribers: null, forum: null });

  const record = {
    client_id: analyticsCurrentClientId,
    report_type: 'community_pulse',
    report_label: mergedSummary.date_from && mergedSummary.date_to
      ? `${mergedSummary.date_from} \u2013 ${mergedSummary.date_to}` : file.name,
    file_name: file.name,
    file_path: filePath,
    file_size_bytes: file.size,
    uploaded_by: state.currentEmployeeId,
    uploaded_at: new Date().toISOString(),
    insights_cache: {},
    metrics_data: mergedMetrics,
    summary: mergedSummary
  };
  record.data_through = computeDataThrough('community_pulse', { metricsData: mergedMetrics, summary: mergedSummary });

  const { error: dbError } = await state.supabase
    .from('client_analytics')
    .upsert(record, { onConflict: 'client_id,report_type' });
  if (dbError) throw new Error('Database save failed: ' + dbError.message);

  const added = mergedMetrics.length - oldMetrics.length;
  if (metaEl) metaEl.textContent = `\u2713 Comms report saved \u2014 ${added > 0 ? `${added} new send${added > 1 ? 's' : ''}` : 'sends updated'}`;
  await renderClientAnalyticsTab(analyticsCurrentClientId);
}

// Review table: every extracted row, editable nowhere — approve or cancel.
// (Editing invites silently "fixing" a misread into a different wrong number;
// if a row is wrong, cancel and tell Alex/the board.)
function showCommsReviewModal(rows, failures) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    const pct = (f) => `${((f || 0) * 100).toFixed(1)}%`;
    overlay.innerHTML = `
      <div style="background:var(--bg);border-radius:14px;max-width:820px;width:100%;max-height:85vh;overflow:auto;padding:22px;">
        <h3 style="margin-top:0">Review extracted sends</h3>
        <p class="mini-meta">These numbers were read from the screenshots in the document. Check them against the file before saving \u2014 nothing is stored until you confirm.</p>
        <table class="m-card-table" style="font-size:13px">
          <thead><tr><th>Date</th><th>Send</th><th>Type</th><th style="text-align:right">Delivered</th><th style="text-align:right">Open</th><th style="text-align:right">Click</th><th style="text-align:right">Unsubs</th></tr></thead>
          <tbody>
            ${rows.map((r) => `<tr>
              <td>${escapeHtml(r.date)}</td>
              <td>${escapeHtml(String(r.name).slice(0, 40))}</td>
              <td>${escapeHtml(r.send_type)}</td>
              <td style="text-align:right">${r.delivered ? r.delivered.toLocaleString() : '\u2014'}</td>
              <td style="text-align:right">${r.open_rate ? pct(r.open_rate) : '\u2014'}</td>
              <td style="text-align:right">${r.click_rate ? pct(r.click_rate) : '\u2014'}</td>
              <td style="text-align:right">${r.unsubscribed || 0}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${failures.length ? `<p class="status warn" style="margin-top:10px">Could not read: ${escapeHtml(failures.join(', '))}</p>` : ''}
        <div class="editor-bar action-row" style="margin-top:14px;justify-content:flex-end;gap:10px">
          <button type="button" class="ghost" data-comms-cancel>Cancel</button>
          <button type="button" class="primary" data-comms-save>Save ${rows.length} send${rows.length > 1 ? 's' : ''}</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-comms-save]')) { overlay.remove(); resolve(true); }
      else if (e.target.closest('[data-comms-cancel]') || e.target === overlay) { overlay.remove(); resolve(false); }
    });
    document.body.appendChild(overlay);
  });
}

// One row per FILE, so the archive can say what each upload was and who sent
// it. app.client_analytics keeps only one row per report type and overwrites
// its file_name, so without this only the newest file of each type could ever
// be labelled (18 Sep 2026). Best-effort: a failure here must never
// fail an upload whose data already landed — the file is safe either way.
async function logAnalyticsUpload({ clientId, reportType, fileName, objectName }) {
  try {
    await state.supabase.from('client_analytics_uploads').insert({
      client_id: clientId,
      report_type: reportType,
      file_name: fileName,
      object_name: objectName,
      uploaded_by: state.currentEmployeeId || null
    });
  } catch (err) {
    console.warn('Upload log failed (file is saved):', err);
  }
}

// One spreadsheet, start to finish: detect → parse → merge → upsert. Returns a
// RESULT instead of alerting, so a batch can report per file (24 Aug
// 2026). Batches must run these one at a time: every file merges into the
// existing row for its report type, so two files of the same type running in
// parallel would race and one would silently overwrite the other.
async function processAnalyticsSpreadsheet(file, batch = {}) {
    const detectedLabel = document.getElementById('analyticsDetectedType');
    const metaEl = document.getElementById('analyticsClientMeta');
    try {
      // Auto-detect report type from sheet names
      const { type: reportType, workbook } = await detectReportType(file);
      // Instagram metrics CSVs live on the same DB row as the post export
      // Per-metric CSVs share a DB row with their platform's post export.
      // Which platform that is cannot be known until the file is parsed, so
      // this is settled just below rather than here.
      let dbReportType = reportType === 'instagram_metrics' ? 'instagram' : reportType;
      if (detectedLabel) { detectedLabel.textContent = (reportType.charAt(0).toUpperCase() + reportType.slice(1)).replace(/_/g, ' ') + ' report detected'; detectedLabel.style.display = ''; }

      // Parse using detected type (reuse already-read workbook)
      let parsed;
      if (reportType === 'content') {
        parsed = await parseLinkedInAnalytics(file, workbook);
      } else if (reportType === 'followers') {
        parsed = await parseLinkedInFollowersReport(file, workbook);
      } else if (reportType === 'visitors') {
        parsed = await parseLinkedInVisitorsReport(file, workbook);
      } else if (reportType === 'instagram') {
        parsed = await parseInstagramAnalytics(file, workbook);
      } else if (reportType === 'community_pulse') {
        parsed = await parseCommunityPulse(file, workbook);
      } else if (reportType === 'instagram_metrics') {
        parsed = await parseInstagramMetricsCsv(file, workbook);
      }
      if (!parsed) throw new Error('Unknown report type');

      // Instagram and Facebook per-metric CSVs are the same file shape from the
      // same Meta screen. Some name their platform ("Facebook follows"); the
      // shared ones do not ("Viewers", "Content interactions"). Before this,
      // every one of them was filed as Instagram — so a client's Facebook
      // numbers merged into their Instagram figures, on the same metric keys,
      // with nothing on screen to show it (found against Example Collective's real
      // export, 10 Sep 2026).
      //
      // Where the file says, believe it. Where it does not, ask: there is no
      // other signal in the file, and a wrong guess quietly corrupts a client's
      // reporting.
      if (reportType === 'instagram_metrics') {
        // A file that names its own platform always wins; only the unnamed
        // ones need asking. Meta exports the same file shape for both
        // accounts, so there is no other signal — guessing would quietly
        // merge a client's Facebook numbers into their Instagram figures.
        //
        // Ask ONCE per upload, not once per file (18 Sep 2026: a
        // batch of metric CSVs meant a modal each, which read as an error).
        // Meta exports are downloaded per account, so one answer fits a
        // batch; the summary says how many it was applied to, so a wrong
        // answer is visible straight away rather than silently filed.
        let platform = parsed.platform;
        if (!platform && batch.platform) {
          platform = batch.platform;
          batch.platformApplied = (batch.platformApplied || 0) + 1;
        }
        if (!platform) {
          const more = Math.max(0, (batch.ambiguousTotal || 1) - 1);
          platform = await appChoice(
            `Meta names this file the same way for both accounts, so it doesn't say which one it is:\n\n"${parsed.title || parsed.metricLabel}"\n\nWhich account is this upload from?${more ? `\n\nYour answer covers the other ${more} file${more > 1 ? 's' : ''} in this upload that don't name a platform.` : ''}`,
            {
              title: 'Which account?',
              choices: [
                { label: 'Instagram', value: 'instagram', variant: 'primary' },
                { label: 'Facebook', value: 'facebook' }
              ],
              cancelLabel: 'Skip this file'
            }
          );
          if (platform) { batch.platform = platform; batch.platformApplied = 1; }
        }
        if (!platform) {
          if (detectedLabel) detectedLabel.style.display = 'none';
          return { ok: false, name: file.name, error: 'skipped — platform not chosen' };
        }
        dbReportType = platform;
        parsed.platform = platform;
        if (detectedLabel) {
          detectedLabel.textContent = `${platform === 'facebook' ? 'Facebook' : 'Instagram'} ${parsed.metricLabel} detected`;
          detectedLabel.style.display = '';
        }
      }

      // Instagram-only: warn if the file's IG account looks like it belongs
      // to a DIFFERENT existing client than the current page.
      if (reportType === 'instagram') {
        const suggestion = findIgClientSuggestion(
          parsed.summary?.account_name,
          parsed.summary?.account_username,
          analyticsCurrentClientId
        );
        if (suggestion) {
          const currentClient = (state.clients || []).find(c => c.id === analyticsCurrentClientId);
          const acct = parsed.summary?.account_name || parsed.summary?.account_username || 'this account';
          const ok = await appConfirm(
            `Heads up: this Instagram export is for "${acct}", which looks like it belongs to "${suggestion.name}".\n\n` +
            `You're currently uploading on "${currentClient?.name || 'the current client'}'s" page.\n\n` +
            `Continue and attach to ${currentClient?.name || 'the current client'} anyway?`
          );
          if (!ok) {
            if (detectedLabel) detectedLabel.style.display = 'none';
            return { ok: false, name: file.name, error: 'skipped — looks like another client\u2019s account' };
          }
        }
      }

      // Upload raw file to storage
      const filePath = `${analyticsCurrentClientId}/${Date.now()}_${file.name}`;
      const { error: storageError } = await state.supabase.storage
        .from('client-analytics')
        .upload(filePath, file, { upsert: false });
      if (storageError) throw new Error('Storage upload failed: ' + storageError.message);

      // Fetch existing record for this client + type (for merging)
      const { data: existing } = await state.supabase
        .from('client_analytics')
        .select('report_label, metrics_data, posts_data, summary, demographics_data, visitor_metrics')
        .eq('client_id', analyticsCurrentClientId)
        .eq('report_type', dbReportType)
        .maybeSingle();

      // Merge parsed data with existing data (append, not replace)
      let mergedMetrics, mergedPosts, mergedSummary, mergedDemographics, mergedVisitorMetrics;
      let newItemCount = 0;

      if (reportType === 'content') {
        const oldMetrics = existing?.metrics_data || [];
        const oldPosts = existing?.posts_data || [];
        mergedMetrics = mergeByKey(oldMetrics, parsed.metrics_data, r => r.week).sort((a, b) => a.week.localeCompare(b.week));
        mergedPosts = mergeByKey(oldPosts, parsed.posts_data, r => r['Post link']).sort((a, b) => (b.engagement_score || 0) - (a.engagement_score || 0));
        newItemCount = mergedMetrics.length - oldMetrics.length;
        const newPostCount = mergedPosts.length - oldPosts.length;
        // Recompute summary from merged metrics
        const impressions_organic = mergedMetrics.reduce((s, w) => s + (w['Impressions (organic)'] || 0), 0);
        const impressions_sponsored = mergedMetrics.reduce((s, w) => s + (w['Impressions (sponsored)'] || 0), 0);
        const impressions_total = mergedMetrics.reduce((s, w) => s + (w['Impressions (total)'] || 0), 0);
        const clicks = mergedMetrics.reduce((s, w) => s + (w['Clicks (total)'] || 0), 0);
        const reactions = mergedMetrics.reduce((s, w) => s + (w['Reactions (total)'] || 0), 0);
        const comments = mergedMetrics.reduce((s, w) => s + (w['Comments (total)'] || 0), 0);
        const reposts = mergedMetrics.reduce((s, w) => s + (w['Reposts (total)'] || 0), 0);
        const new_followers = mergedMetrics.reduce((s, w) => s + (w['New followers (total)'] || 0), 0);
        const avgEng = mergedMetrics.length ? mergedMetrics.reduce((s, w) => s + (w['Engagement rate (total)'] || 0), 0) / mergedMetrics.length : 0;
        let dateFrom = '', dateTo = '';
        if (mergedMetrics.length) { dateFrom = weekLabelAnalytics(mergedMetrics[0].week); dateTo = weekLabelAnalytics(mergedMetrics[mergedMetrics.length - 1].week); }
        mergedSummary = { impressions_total, impressions_organic, impressions_sponsored, clicks, reactions, comments, reposts, new_followers, avg_engagement: (avgEng * 100).toFixed(1), total_posts: mergedPosts.length, date_from: dateFrom, date_to: dateTo };
        // Show feedback
        if (metaEl) {
          const parts = [];
          if (newItemCount > 0) parts.push(`${newItemCount} new week${newItemCount > 1 ? 's' : ''}`);
          if (newPostCount > 0) parts.push(`${newPostCount} new post${newPostCount > 1 ? 's' : ''}`);
          if (newItemCount === 0 && newPostCount === 0) parts.push('data updated');
          metaEl.textContent = `\u2713 Content report merged \u2014 ${parts.join(', ')}`;
        }
      } else if (reportType === 'followers') {
        const oldMetrics = existing?.metrics_data || [];
        mergedMetrics = mergeByKey(oldMetrics, parsed.metrics_data, r => r.date).sort((a, b) => a.date.localeCompare(b.date));
        mergedDemographics = parsed.demographics_data; // always replace (cumulative snapshot)
        newItemCount = mergedMetrics.length - oldMetrics.length;
        if (metaEl) {
          metaEl.textContent = newItemCount > 0 ? `\u2713 Followers report merged \u2014 ${newItemCount} new day${newItemCount > 1 ? 's' : ''} added` : '\u2713 Followers report updated';
        }
      } else if (reportType === 'visitors') {
        const oldMetrics = existing?.visitor_metrics || [];
        mergedVisitorMetrics = mergeByKey(oldMetrics, parsed.visitor_metrics, r => r.date).sort((a, b) => a.date.localeCompare(b.date));
        mergedDemographics = parsed.demographics_data; // always replace
        newItemCount = mergedVisitorMetrics.length - oldMetrics.length;
        if (metaEl) {
          metaEl.textContent = newItemCount > 0 ? `\u2713 Visitors report merged \u2014 ${newItemCount} new day${newItemCount > 1 ? 's' : ''} added` : '\u2713 Visitors report updated';
        }
      } else if (reportType === 'instagram') {
        const oldPosts = existing?.posts_data || [];
        mergedPosts = mergeByKey(oldPosts, parsed.posts_data, r => r.post_id)
          .sort((a, b) => (b.views || 0) - (a.views || 0));
        const newPostCount = mergedPosts.length - oldPosts.length;

        // Recompute summary from merged posts
        const sum = (k) => mergedPosts.reduce((s, p) => s + (Number(p[k]) || 0), 0);
        const totalReach = sum('reach');
        const totalEng = sum('likes') + sum('comments') + sum('saves') + sum('shares');
        const engagementRate = totalReach > 0 ? (totalEng / totalReach) : 0;
        const dates = mergedPosts
          .map(p => p.date || (p.publish_time || '').slice(0, 10))
          .filter(Boolean).sort();

        mergedSummary = {
          total_posts: mergedPosts.length,
          total_views: sum('views'),
          total_reach: totalReach,
          total_likes: sum('likes'),
          total_comments: sum('comments'),
          total_saves: sum('saves'),
          total_shares: sum('shares'),
          total_follows: sum('follows'),
          engagement_rate: engagementRate,
          avg_engagement: (engagementRate * 100).toFixed(2),
          date_from: dates[0] || '',
          date_to: dates[dates.length - 1] || '',
          account_name: parsed.summary?.account_name || '',
          account_username: parsed.summary?.account_username || ''
        };
        newItemCount = newPostCount;
        if (metaEl) {
          metaEl.textContent = newPostCount > 0
            ? `\u2713 Instagram report merged \u2014 ${newPostCount} new post${newPostCount > 1 ? 's' : ''}`
            : '\u2713 Instagram report updated';
        }
      } else if (reportType === 'instagram_metrics') {
        // One metric per file; each upload sets its metric's column on the
        // shared per-date rows (so Follows.csv then Views.csv build up
        // {date, follows, views} without clobbering each other).
        const oldMetrics = existing?.metrics_data || [];
        const byDate = new Map(oldMetrics.map(r => [r.date, { ...r }]));
        parsed.daily.forEach(d => {
          const row = byDate.get(d.date) || { date: d.date };
          row[parsed.metric] = d.value;
          byDate.set(d.date, row);
        });
        mergedMetrics = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
        newItemCount = mergedMetrics.length - oldMetrics.length;
        if (metaEl) {
          const platformLabel = parsed.platform === 'facebook' ? 'Facebook' : 'Instagram';
          metaEl.textContent = `✓ ${platformLabel} ${parsed.metricLabel.toLowerCase()} merged — ${parsed.daily.length} day${parsed.daily.length > 1 ? 's' : ''}`;
        }
      } else if (reportType === 'community_pulse') {
        // Sends merge by date+name; subscriber/forum demographics are
        // point-in-time snapshots and always replace. Summary recomputed
        // from the merged sends (communityPulseSummary, js/analytics.js).
        const oldMetrics = existing?.metrics_data || [];
        mergedMetrics = mergeByKey(oldMetrics, parsed.metrics_data, r => `${r.date}|${r.name}`)
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        mergedDemographics = parsed.demographics_data;
        mergedSummary = communityPulseSummary(mergedMetrics, mergedDemographics);
        newItemCount = mergedMetrics.length - oldMetrics.length;
        if (metaEl) {
          metaEl.textContent = newItemCount > 0
            ? `\u2713 Community pulse merged \u2014 ${newItemCount} new send${newItemCount > 1 ? 's' : ''}`
            : '\u2713 Community pulse updated';
        }
      }

      // Build DB record with merged data
      const reportLabel = (reportType === 'content' || reportType === 'instagram') && mergedSummary
        ? (mergedSummary.date_from && mergedSummary.date_to ? `${mergedSummary.date_from} \u2013 ${mergedSummary.date_to}` : parsed.report_label)
        : parsed.report_label;

      const record = {
        client_id: analyticsCurrentClientId,
        report_type: dbReportType,
        report_label: reportLabel,
        file_name: file.name,
        file_path: filePath,
        file_size_bytes: file.size,
        uploaded_by: state.currentEmployeeId,
        // Must be set explicitly: the upsert UPDATEs the existing row on
        // re-upload, so the DB default only fires on first insert — without
        // this, "Data uploaded until" and the Tuesday staleness reminder
        // keep seeing the FIRST upload's date forever.
        uploaded_at: new Date().toISOString(),
        insights_cache: {} // clear cache to force re-generation
      };

      if (reportType === 'content') {
        record.metrics_data = mergedMetrics;
        record.posts_data = mergedPosts;
        record.summary = mergedSummary;
      } else if (reportType === 'followers') {
        record.metrics_data = mergedMetrics;
        record.demographics_data = mergedDemographics;
      } else if (reportType === 'visitors') {
        record.visitor_metrics = mergedVisitorMetrics;
        record.demographics_data = mergedDemographics;
      } else if (reportType === 'instagram') {
        record.posts_data = mergedPosts;
        record.summary = mergedSummary;
      } else if (reportType === 'instagram_metrics') {
        // Only the daily-metrics column; the row's posts/summary (if any)
        // are preserved by the upsert since they're omitted from the payload.
        // report_label must ALWAYS be sent: PostgREST upsert is an INSERT ..
        // ON CONFLICT, and Postgres enforces NOT NULL on the proposed insert
        // row before conflict resolution — omitting it broke every upload
        // onto an existing row (Rhea's second metrics CSV, 14 Jul 2026).
        record.metrics_data = mergedMetrics;
        record.report_label = existing?.report_label
          || (mergedMetrics.length
            ? `${mergedMetrics[0].date} – ${mergedMetrics[mergedMetrics.length - 1].date}`
            : parsed.metricLabel);
      } else if (reportType === 'community_pulse') {
        record.metrics_data = mergedMetrics;
        record.demographics_data = mergedDemographics;
        record.summary = mergedSummary;
        record.report_label = mergedSummary.date_from && mergedSummary.date_to
          ? `${mergedSummary.date_from} – ${mergedSummary.date_to}`
          : parsed.report_label;
      }

      // Data coverage end — staleness truth for the header + Tuesday reminder
      // (never uploaded_at; see computeDataThrough in js/analytics.js)
      record.data_through = computeDataThrough(dbReportType, {
        metricsData: record.metrics_data ?? existing?.metrics_data,
        postsData: record.posts_data ?? existing?.posts_data,
        visitorMetrics: record.visitor_metrics ?? existing?.visitor_metrics,
        summary: record.summary ?? existing?.summary
      });

      // Upsert using unique index (client_id, report_type)
      const { error: dbError } = await state.supabase
        .from('client_analytics')
        .upsert(record, { onConflict: 'client_id,report_type' });
      if (dbError) throw new Error('Database save failed: ' + dbError.message);

      await logAnalyticsUpload({
        clientId: analyticsCurrentClientId,
        reportType: dbReportType,
        fileName: file.name,
        objectName: filePath.split('/').pop()
      });

      if (detectedLabel) detectedLabel.style.display = 'none';
      return { ok: true, name: file.name, type: reportType };
    } catch (err) {
      console.error('Analytics upload error:', err);
      return { ok: false, name: file.name, error: err.message };
    }
}

if (analyticsFileInput) {
  analyticsFileInput.addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length || !analyticsCurrentClientId) return;
    const metaEl = document.getElementById('analyticsClientMeta');
    const detectedLabel = document.getElementById('analyticsDetectedType');
    const clear = () => { analyticsFileInput.value = ''; };

    const ok = [];
    const failed = [];
    const accept = [];
    for (const f of files) {
      const ext = f.name.split('.').pop().toLowerCase();
      if (!['xls', 'xlsx', 'csv', 'docx'].includes(ext)) {
        failed.push({ name: f.name, error: 'unsupported file type' });
      } else if (f.size > 20 * 1024 * 1024) {
        failed.push({ name: f.name, error: 'over 20 MB' });
      } else {
        accept.push({ file: f, ext });
      }
    }

    // The comms DOCX pipeline unzips, reads screenshots and needs a human to
    // check the extraction, so it stays a one-at-a-time job rather than being
    // dragged into a batch.
    const docx = accept.filter((f) => f.ext === 'docx');
    const sheets = accept.filter((f) => f.ext !== 'docx');
    if (docx.length && (sheets.length || docx.length > 1)) {
      docx.forEach((d) => failed.push({ name: d.file.name, error: 'comms reports must be uploaded on their own' }));
    } else if (docx.length === 1) {
      try {
        await handleCommsDocxUpload(docx[0].file, metaEl, detectedLabel);
      } catch (docxErr) {
        console.error('Comms docx upload failed:', docxErr);
        appAlert('Could not process the comms report: ' + docxErr.message);
      }
      clear();
      return;
    }

    // Strictly sequential — see processAnalyticsSpreadsheet. One batch
    // object carries the platform answer across the whole upload.
    const batch = { ambiguousTotal: sheets.length };
    for (let i = 0; i < sheets.length; i++) {
      if (sheets.length > 1 && detectedLabel) {
        detectedLabel.textContent = `Processing ${i + 1} of ${sheets.length}…`;
        detectedLabel.style.display = '';
      }
      const result = await processAnalyticsSpreadsheet(sheets[i].file, batch);
      (result?.ok ? ok : failed).push(result || { name: sheets[i].file.name, error: 'unknown error' });
      if (batch.ambiguousTotal > 1) batch.ambiguousTotal -= 1;
    }

    clear();
    if (detectedLabel) detectedLabel.style.display = 'none';

    // Re-render ONCE, after the last file — each upload clears the AI insight
    // cache, so doing this per file would regenerate insights repeatedly.
    if (ok.length) {
      renderClientAnalyticsTab(analyticsCurrentClientId);
      setTimeout(() => { if (analyticsCurrentClientId) renderClientAnalyticsTab(analyticsCurrentClientId); }, 4000);
    }

    // One failure must not bury the successes, or hide itself.
    if (failed.length) {
      const lines = failed.map((f) => `• ${f.name} — ${f.error}`).join('\n');
      appAlert(ok.length
        ? `${ok.length} file${ok.length > 1 ? 's' : ''} uploaded. ${failed.length} could not be:\n\n${lines}`
        : `Upload failed:\n\n${lines}`);
    } else if (ok.length > 1 && metaEl) {
      const filed = batch.platform && batch.platformApplied > 1
        ? ` \u00b7 ${batch.platformApplied} filed as ${batch.platform === 'facebook' ? 'Facebook' : 'Instagram'}`
        : '';
      metaEl.textContent = `\u2713 ${ok.length} reports uploaded${filed}`;
    }
  });
}

// ═══════════════════════════════════════════════════════
// NEW ANALYTICS TAB — Overview, Audience Intelligence, Post Performance
// ═══════════════════════════════════════════════════════

// Chart.js instance tracking for cleanup
const _analyticsChartInstances = [];
function destroyAnalyticsCharts() {
  while (_analyticsChartInstances.length) {
    const c = _analyticsChartInstances.pop();
    try { c.destroy(); } catch (_) {}
  }
}

// Per-client target persona definitions for Audience Intelligence.
// Keyed by normalized client name (normalizeClientNameKey). Clients without an
// entry get plain demographic bars — no green target highlighting, legend, or
// quality snapshot, since those metrics only mean something against a defined
// persona. Add new clients here as their personas get agreed.
const ANALYTICS_PERSONAS_BY_CLIENT = {
  'example materials': {
    industries: ['Pharmaceuticals', 'Biotechnology', 'Chemical Manufacturing', 'Research Services'],
    industriesLabel: 'Pharma, Biotech, Chemical, Research',
    jobFunctions: ['Research', 'Engineering', 'Business Development'],
    jobFunctionsLabel: 'Research, Engineering, BizDev',
    decisionMakerSeniority: ['Manager', 'Director', 'VP', 'CXO', 'Owner', 'Partner'],
    seniorityLabel: 'Manager – CXO'
  }
};

function currentAnalyticsPersona() {
  const client = (state.clients || []).find(c => String(c.id) === String(analyticsCurrentClientId));
  // Lives on the CLIENT (clients.audience_persona), set by the account-owner
  // AM via the editor on the Audience tab (29 Jul 2026). Legacy
  // config/in-code map kept as fallback for clients not yet migrated.
  if (client?.audience_persona) return client.audience_persona;
  const personas = getConfigMap('analytics_personas_by_client', ANALYTICS_PERSONAS_BY_CLIENT);
  return personas[normalizeClientNameKey(client?.name)] || null;
}

// State for current analytics data
window._analyticsReports = {}; // { content, followers, visitors }

// --- Main Analytics Screen Renderer ---
// ────────── Client Scope & Coverage (leadership-only) ──────────
// State for the currently-loaded client view
const scopeCoverageState = {
  clientId: null,
  client: null,
  scopeItems: [],          // [{ id, title, scope_type, description, owner_employee_id, sort_order, needs: [{id, department_id, percent_need, specialty_note}] }]
  allocations: [],         // standing allocations on this client
  allAllocations: [],      // ALL standing allocations across all clients (for total util)
  deptOptions: [],         // [{ id, name }] — the 5 disciplines
  employeeOptions: [],     // [{ id, full_name, department_id, department_name }]
  scopeFormState: null,    // { editingId | 'new', data: { title, scope_type, description, owner_employee_id, needs: [...] } }
  allocFormState: null,    // { editingId | 'new', data: { employee_id, department_id, percent, notes } }
  viewMonth: null          // {y, m} — month being viewed; null = current
};

// DEMO: pretend month range per scope item until DB has start/end columns.
// Anything that looks like a one-off project (refresh / launch / campaign) → May 2026 only.
function parseYM(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/^(\d{4})-(\d{1,2})/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) };
}
function getScopeMonthRange(item) {
  // Both retainers and projects may have an optional month range.
  let start = parseYM(item.start_month);
  let end = parseYM(item.end_month);
  if (start && !end) end = start;
  if (end && !start) start = end;
  if (start || end) return { start, end };
  // DEMO fallback for projects with no dates yet
  const t = (item.title || '').toLowerCase();
  if (/refresh|launch|campaign|relaunch|sprint|burst/.test(t)) {
    return { start: { y: 2026, m: 5 }, end: { y: 2026, m: 5 } };
  }
  return { start: null, end: null };
}
function isItemActiveInMonth(item, ym) {
  const r = getScopeMonthRange(item);
  if (!r.start && !r.end) return true;
  const key = ym.y * 12 + ym.m;
  if (r.start && key < r.start.y * 12 + r.start.m) return false;
  if (r.end && key > r.end.y * 12 + r.end.m) return false;
  return true;
}
function formatMonthLabel(ym) {
  if (!ym) return '—';
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${names[ym.m - 1]} ${ym.y}`;
}
function getCurrentViewMonth() {
  if (scopeCoverageState.viewMonth) return scopeCoverageState.viewMonth;
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}
function shiftMonth(ym, delta) {
  const k = ym.y * 12 + (ym.m - 1) + delta;
  return { y: Math.floor(k / 12), m: (k % 12) + 1 };
}

const SCOPE_DISCIPLINE_NAMES = ['AM', 'Art', 'Copy', 'Video', 'Strategy'];

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

(function wireScopeCoverageBackLink() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest('#scBackToClients, #scBackBtn');
    if (!link) return;
    event.preventDefault();
    navigateToScreen('client-projects');
  });
  document.addEventListener('click', (event) => {
    const prev = event.target.closest('#scMonthPrev');
    const next = event.target.closest('#scMonthNext');
    if (!prev && !next) return;
    const cur = getCurrentViewMonth();
    scopeCoverageState.viewMonth = shiftMonth(cur, prev ? -1 : 1);
    renderMonthSwitcher();
    renderScopeBlocks();
  });
})();

function renderMonthSwitcher() {
  const el = document.getElementById('scMonthLabel');
  if (el) el.textContent = formatMonthLabel(getCurrentViewMonth());
}

async function loadScopeCoverageReferenceData() {
  // Departments (only the 5 disciplines)
  if (!scopeCoverageState.deptOptions.length) {
    const deptRes = await state.supabase
      .from('departments')
      .select('id, name')
      .in('name', SCOPE_DISCIPLINE_NAMES);
    if (deptRes.error) throw deptRes.error;
    // Sort by SCOPE_DISCIPLINE_NAMES order
    scopeCoverageState.deptOptions = SCOPE_DISCIPLINE_NAMES
      .map((n) => (deptRes.data || []).find((d) => d.name === n))
      .filter(Boolean);
  }

  // Hidden employees come from config (Admin Settings → Operational Config),
  // never a hardcoded name: name tests broke on rename and were inconsistent
  // here (they filtered only Blake, so Anya — also hidden — still showed).
  const hiddenEmails = getHiddenEmployeeEmails();
  const isHidden = (emp) => hiddenEmails.includes(normalizeEmail(emp.email));

  // Employees (active, in one of the 5 disciplines)
  const validDeptIds = new Set(scopeCoverageState.deptOptions.map((d) => d.id));
  scopeCoverageState.employeeOptions = (state.employeeDirectory || [])
    .filter((emp) => emp.is_active !== false && emp.department && validDeptIds.has(emp.department.id) && !isHidden(emp))
    .map((emp) => ({
      id: emp.id,
      full_name: emp.full_name,
      department_id: emp.department.id,
      department_name: emp.department.name,
      access_level: emp.access_level
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  // Owner dropdown should be wide open: every active employee, regardless of discipline.
  scopeCoverageState.ownerOptions = (state.employeeDirectory || [])
    .filter((emp) => emp.is_active !== false && !isHidden(emp))
    .map((emp) => ({
      id: emp.id,
      full_name: emp.full_name,
      department_name: emp.department?.name || '',
      access_level: emp.access_level // consumers sort leadership last
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

async function loadScopeCoverageDataForClient(clientId) {
  // Scope items + nested discipline needs
  const scopeRes = await state.supabase
    .from('client_scope_items')
    .select('id, client_id, title, scope_type, description, owner_employee_id, sort_order, is_active, start_month, end_month, client_scope_discipline_needs(id, department_id, percent_need, specialty_note)')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (scopeRes.error) throw scopeRes.error;
  scopeCoverageState.scopeItems = (scopeRes.data || []).map((row) => ({
    ...row,
    needs: row.client_scope_discipline_needs || []
  }));

  // Standing allocations on THIS client
  const allocRes = await state.supabase
    .from('client_standing_allocations')
    .select('id, client_id, employee_id, department_id, percent, notes, scope_item_id')
    .eq('client_id', clientId);
  if (allocRes.error) throw allocRes.error;
  scopeCoverageState.allocations = allocRes.data || [];

  // ALL standing allocations across ALL clients (for total utilization math)
  const allAllocRes = await state.supabase
    .from('client_standing_allocations')
    .select('employee_id, percent, client_id, scope_item_id');
  if (allAllocRes.error) throw allAllocRes.error;
  scopeCoverageState.allAllocations = allAllocRes.data || [];

  // All scope items (id -> {start_month,end_month,scope_type,is_active}) for month-aware util across clients.
  const allScopeRes = await state.supabase
    .from('client_scope_items')
    .select('id, start_month, end_month, scope_type, is_active');
  if (!allScopeRes.error) {
    scopeCoverageState.allScopeItemsById = new Map((allScopeRes.data || []).map((s) => [s.id, s]));
  } else {
    scopeCoverageState.allScopeItemsById = new Map();
  }
}

// True if an allocation contributes utilization in the given YYYY-MM month.
// Null scope_item_id = client-wide/retainer = always active.
// Linked scope item: retainer = always; project = only if month in [start,end].
function isAllocActiveInMonth(alloc, monthStr) {
  if (!alloc || !alloc.scope_item_id) return true;
  const scope = (scopeCoverageState.allScopeItemsById && scopeCoverageState.allScopeItemsById.get(alloc.scope_item_id))
    || scopeCoverageState.scopeItems.find((s) => s.id === alloc.scope_item_id);
  if (!scope) return true;
  if (scope.is_active === false) return false;
  return isItemActiveInMonth(scope, monthStr);
}

function getEmployeeTotalUtil(employeeId) {
  const month = getCurrentViewMonth();
  return scopeCoverageState.allAllocations
    .filter((a) => a.employee_id === employeeId && isAllocActiveInMonth(a, month))
    .reduce((sum, a) => sum + Number(a.percent || 0), 0);
}

function getEmployeeName(employeeId) {
  if (!employeeId) return '—';
  const fromState = scopeCoverageState.employeeOptions.find((e) => e.id === employeeId);
  if (fromState) return fromState.full_name;
  const fromDir = (state.employeeDirectory || []).find((e) => e.id === employeeId);
  return fromDir?.full_name || '—';
}

function getDeptName(deptId) {
  const d = scopeCoverageState.deptOptions.find((x) => x.id === deptId);
  return d ? scopeDeptLabel(d.name) : '—';
}
window.getDeptName = getDeptName;
window.scopeDeptLabel = scopeDeptLabel;

// ── Coverage brain ─────────────────────────────────────────────
// Returns coverage class for a single (scopeItem, deptId, percentNeed) tuple
function classifyCoverage(deptId, percentNeed) {
  const allocRows = scopeCoverageState.allocations.filter((a) => a.department_id === deptId);
  const sumAlloc = allocRows.reduce((sum, a) => sum + Number(a.percent || 0), 0);
  const anyMaxed = allocRows.some((a) => getEmployeeTotalUtil(a.employee_id) >= 100);
  if (sumAlloc <= 0) return 'gap';
  if (sumAlloc < Number(percentNeed || 0)) return 'tight';
  if (anyMaxed) return 'tight';
  return 'ok';
}

// Roll-up across the entire client: returns { totalAlloc, totalNeed, byDept: { deptId: { alloc, need, label } }, overallStatus, gapDisciplines: [...] }
function computeCoverageRollup() {
  const byDept = {};
  for (const dept of scopeCoverageState.deptOptions) {
    byDept[dept.id] = {
      label: scopeDeptLabel(dept.name),
      need: 0,
      alloc: 0,
      status: 'ok',
      assignees: []
    };
  }
  // Sum needs across scope items
  for (const item of scopeCoverageState.scopeItems) {
    for (const n of item.needs) {
      if (byDept[n.department_id]) {
        byDept[n.department_id].need += Number(n.percent_need || 0);
      }
    }
  }
  // Sum allocations
  for (const a of scopeCoverageState.allocations) {
    if (byDept[a.department_id]) {
      byDept[a.department_id].alloc += Number(a.percent || 0);
      byDept[a.department_id].assignees.push({
        id: a.employee_id,
        name: getEmployeeName(a.employee_id),
        util: getEmployeeTotalUtil(a.employee_id)
      });
    }
  }
  // Per-dept status
  let overallStatus = 'ok';
  const gapDisciplines = [];
  for (const id of Object.keys(byDept)) {
    const d = byDept[id];
    if (d.need <= 0) { d.status = 'na'; continue; }
    const anyMaxed = d.assignees.some((p) => p.util >= 100);
    if (d.alloc <= 0) {
      d.status = 'gap';
      overallStatus = 'gap';
      gapDisciplines.push({ ...d });
    } else if (d.alloc < d.need) {
      d.status = 'tight';
      if (overallStatus !== 'gap') overallStatus = 'tight';
      gapDisciplines.push({ ...d });
    } else if (anyMaxed) {
      d.status = 'tight';
      if (overallStatus !== 'gap') overallStatus = 'tight';
    } else {
      d.status = 'ok';
    }
  }
  const totalAlloc = scopeCoverageState.allocations.reduce((s, a) => s + Number(a.percent || 0), 0);
  const totalNeed = Object.values(byDept).reduce((s, d) => s + d.need, 0);
  return { byDept, totalAlloc, totalNeed, overallStatus, gapDisciplines };
}

// ── Main render ────────────────────────────────────────────────
async function renderClientScopeCoverage(clientId) {
  const client = state.clients.find((c) => String(c.id) === String(clientId));
  if (!client) {
    setText('scClientName', 'Client not found');
    setText('scClientCrumb', '—');
    setText('scClientSub', '');
    return;
  }

  scopeCoverageState.clientId = clientId;
  scopeCoverageState.client = client;
  scopeCoverageState.scopeFormState = null;
  scopeCoverageState.allocFormState = null;
  scopeCoverageState.viewMonth = null;
  setTimeout(renderMonthSwitcher, 0);

  // Header
  setText('scClientName', client.name || 'Untitled client');
  setText('scClientCrumb', client.name || '—');

  const tagsEl = document.getElementById('scClientTags');
  if (tagsEl) {
    const typeTag = client.type === 'retainer'
      ? '<span class="sc-tag retainer">Retainer</span>'
      : client.type === 'pitch'
        ? '<span class="sc-tag">Pitch</span>'
        : '<span class="sc-tag project">Project</span>';
    const statusTag = (client.is_active === false)
      ? '<span class="sc-tag paused">Archived</span>'
      : '<span class="sc-tag active">Active</span>';
    tagsEl.innerHTML = typeTag + statusTag;
  }

  setText('scClientSub', `Owner: ${escapeHtml(client.owner || '—')}`);

  // Loading placeholders
  const scopeList = document.getElementById('scScopeList');
  if (scopeList) scopeList.innerHTML = '<div class="sc-empty">Loading scope…</div>';
  const allocBody = document.getElementById('scAllocBody');
  if (allocBody) allocBody.innerHTML = '<tr><td colspan="6" class="sc-empty-row">Loading allocations…</td></tr>';

  try {
    await loadScopeCoverageReferenceData();
    await loadScopeCoverageDataForClient(clientId);
  } catch (err) {
    console.error('Scope coverage load failed:', err);
    if (scopeList) scopeList.innerHTML = `<div class="sc-empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    return;
  }

  try {
    rerenderScopeCoverage();
  } catch (err) {
    console.error('Scope coverage render failed:', err);
    if (scopeList) scopeList.innerHTML = `<div class="sc-empty">Render failed: ${escapeHtml(err.message)}</div>`;
  }
}

function rerenderScopeCoverage() {
  renderScopeBlocks();
  renderAllocationRows();
  renderScopeCoverageStats();
}

function renderScopeCoverageStats() {
  const rollup = computeCoverageRollup();
  const items = scopeCoverageState.scopeItems;
  const allocs = scopeCoverageState.allocations;

  // Stat 1: Scope Items
  setText('scStatScopeCount', String(items.length));
  const distinctDisc = new Set();
  items.forEach((it) => it.needs.forEach((n) => distinctDisc.add(n.department_id)));
  setText('scStatScopeDelta', items.length ? `across ${distinctDisc.size} discipline${distinctDisc.size === 1 ? '' : 's'}` : 'no scope yet');

  // Stat 2: Team Allocated
  const distinctPeople = new Set(allocs.map((a) => a.employee_id));
  setText('scStatTeamCount', `${distinctPeople.size} ${distinctPeople.size === 1 ? 'person' : 'people'}`);
  setText('scStatTeamDelta', '');

  // Stat 3: Coverage
  const coverageEl = document.getElementById('scStatCoverage');
  const coverageDeltaEl = document.getElementById('scStatCoverageDelta');
  if (coverageEl && coverageDeltaEl) {
    coverageEl.classList.remove('amber', 'red', 'green');
    if (!items.length) {
      coverageEl.textContent = '—';
      coverageDeltaEl.textContent = 'awaiting scope';
    } else if (rollup.overallStatus === 'ok') {
      coverageEl.textContent = 'OK';
      coverageEl.classList.add('green');
      coverageDeltaEl.textContent = 'all disciplines covered';
    } else if (rollup.overallStatus === 'tight') {
      coverageEl.textContent = 'Tight';
      coverageEl.classList.add('amber');
      coverageDeltaEl.textContent = `${rollup.gapDisciplines.length} discipline${rollup.gapDisciplines.length === 1 ? '' : 's'} under-resourced`;
    } else {
      coverageEl.textContent = 'Gap';
      coverageEl.classList.add('red');
      coverageDeltaEl.textContent = `${rollup.gapDisciplines.length} discipline${rollup.gapDisciplines.length === 1 ? '' : 's'} with gaps`;
    }
  }

  // Gap banner
  const banner = document.getElementById('scGapBanner');
  if (banner) {
    if (!items.length || rollup.overallStatus === 'ok') {
      banner.style.display = 'none';
    } else {
      const parts = rollup.gapDisciplines.map((d) => {
        if (d.assignees.length === 0) {
          return `<b>${escapeHtml(d.label)}</b> (nobody assigned, need ${d.need.toFixed(0)}%)`;
        }
        const names = d.assignees.map((p) => `${escapeHtml(p.name)} at ${p.util.toFixed(0)}%`).join(', ');
        return `<b>${escapeHtml(d.label)}</b> (${names}; need ${d.need.toFixed(0)}%, have ${d.alloc.toFixed(0)}%)`;
      });
      banner.style.display = '';
      banner.innerHTML = `<b>Resourcing gap:</b> Scope needs ${parts.join(' and ')}. <b>Bench candidates flagged.</b>`;
    }
  }

  // Δ line
  const deltaLine = document.getElementById('scDeltaLine');
  if (deltaLine) {
    const delta = rollup.totalAlloc - rollup.totalNeed;
    const deltaSign = delta >= 0 ? '+' : '';
    const deltaClass = delta < 0 ? 'red' : delta === 0 ? 'amber' : 'green';
    const breakdown = Object.values(rollup.byDept)
      .filter((d) => d.need > 0 && d.alloc < d.need)
      .map((d) => `${d.label} ${(d.alloc - d.need).toFixed(0)}%`)
      .join(', ');
    deltaLine.innerHTML = `Total allocated: <b>${rollup.totalAlloc.toFixed(0)}%</b> · Scope implies ~<b>${rollup.totalNeed.toFixed(0)}%</b> · <b class="${deltaClass}">Δ ${deltaSign}${delta.toFixed(0)}%</b>${breakdown ? ` (${escapeHtml(breakdown)})` : ''}`;
  }
}

// ── Scope CRUD ─────────────────────────────────────────────────
function renderScopeBlocks() {
  const container = document.getElementById('scScopeList');
  if (!container) return;
  const items = scopeCoverageState.scopeItems;
  const formState = scopeCoverageState.scopeFormState;

  if (!items.length && !formState) {
    container.innerHTML = '<div class="sc-empty">No scope items yet. Add the first deliverable from the contract.</div>';
    return;
  }

  // Sort: in-month first (preserving sort_order), then out-of-month at the bottom.
  const vm = getCurrentViewMonth();
  const sortedItems = [...items].sort((a, b) => {
    const aIn = isItemActiveInMonth(a, vm) ? 0 : 1;
    const bIn = isItemActiveInMonth(b, vm) ? 0 : 1;
    if (aIn !== bIn) return aIn - bIn;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });
  let html = '';
  for (const item of sortedItems) {
    try {
      if (formState && formState.editingId === item.id) {
        html += renderScopeForm(formState);
      } else {
        html += renderScopeBlock(item);
      }
    } catch (err) {
      console.error('renderScopeBlock failed for item', item?.id, err);
      html += `<div class="sc-empty">Render error on "${escapeHtml(item?.title || item?.id || 'item')}": ${escapeHtml(err.message)}</div>`;
    }
  }
  if (formState && formState.editingId === 'new') {
    html += renderScopeForm(formState);
  }
  container.innerHTML = html;
}

function renderScopeBlock(item) {
  const eid = escapeHtml(item.id);
  const typeLabel = item.scope_type === 'project' ? 'Project' : 'Retainer';
  const ym = getCurrentViewMonth();
  const range = getScopeMonthRange(item);
  const isOngoing = !range.start && !range.end;
  const inMonth = isItemActiveInMonth(item, ym);
  const outClass = '';
  const monthBadge = isOngoing
    ? '<span class="sc-month-badge ongoing">Retainer</span>'
    : `<span class="sc-month-badge ${inMonth ? 'active' : ''}">${formatMonthLabel(range.start)}${range.end && (range.end.y !== range.start.y || range.end.m !== range.start.m) ? ' – ' + formatMonthLabel(range.end) : ''}</span>`;
  const ownerName = item.owner_employee_id ? getEmployeeName(item.owner_employee_id) : null;
  const ownerLine = ownerName ? ` · Owned by ${escapeHtml(ownerName)}` : '';

  // People allocated to this scope item
  const peopleAllocs = (scopeCoverageState.allocations || []).filter((a) => a.scope_item_id === item.id);
  const peopleHtml = peopleAllocs.length
    ? peopleAllocs.map((a) => `
        <span class="sc-person-chip">
          <b>${escapeHtml(getEmployeeName(a.employee_id))}</b>
          <span class="sc-person-meta">${escapeHtml(getDeptName(a.department_id))} · ${Number(a.percent || 0).toFixed(0)}%</span>
          ${canEditScopeCoverage() ? `<a class="sc-person-x" data-sc-action="remove-alloc" data-id="${escapeHtml(a.id)}" title="Remove">×</a>` : ''}
        </span>
      `).join('')
    : '';
  const addPersonLink = canEditScopeCoverage()
    ? `<a class="sc-add-person-link" data-sc-action="add-person-to-scope" data-id="${eid}">+ add person</a>`
    : '';

  // Inline add-person form (when the form state targets this scope item)
  const inlineForm = (() => {
    const fs = scopeCoverageState.allocFormState;
    if (!fs || fs.editingId !== 'new' || fs.data?.scope_item_id !== item.id) return '';
    const data = fs.data;
    // Hidden employees from config (not a hardcoded name — this used to filter
    // only Anya, so Blake, also hidden, still appeared here).
    const scHidden = getHiddenEmployeeEmails();
    const empSource = (state.employeeDirectory || [])
      .filter((e) => e.is_active !== false && !scHidden.includes(normalizeEmail(e.email)))
      .map((e) => ({ id: e.id, full_name: e.full_name, department_id: e.department?.id || '' }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
    const empOpts = '<option value="">Select person</option>' + empSource
      .map((e) => `<option value="${escapeHtml(e.id)}" data-dept-id="${escapeHtml(e.department_id)}"${e.id === data.employee_id ? ' selected' : ''}>${escapeHtml(e.full_name)}</option>`).join('');
    return `
      <div class="sc-inline-alloc-form" data-scope-inline="${eid}">
        <select data-inline-alloc="employee_id" onchange="(function(s){var o=s.options[s.selectedIndex];var did=o&&o.getAttribute('data-dept-id')||'';s.closest('.sc-inline-alloc-form').querySelector('[data-inline-alloc=&quot;department_id&quot;]').value=did;})(this)">${empOpts}</select>
        <input type="hidden" data-inline-alloc="department_id" value="${escapeHtml(data.department_id || '')}" />
        <input type="number" min="0" max="200" step="1" placeholder="%" value="${data.percent === '' || data.percent == null ? '' : Number(data.percent)}" data-inline-alloc="percent" style="width:60px" />
        <button class="sc-btn primary" type="button" data-sc-action="save-inline-alloc" data-id="${eid}">Save</button>
        <button class="sc-btn" type="button" data-sc-action="cancel-inline-alloc">Cancel</button>
      </div>
    `;
  })();

  // Discipline chips with coverage classification
  const chipsHtml = item.needs.length
    ? item.needs.map((n) => {
        const cls = classifyCoverage(n.department_id, n.percent_need);
        const icon = cls === 'ok' ? '✓' : cls === 'tight' ? '⚠' : '✗';
        const note = n.specialty_note ? ` (${escapeHtml(n.specialty_note)})` : '';
        return `<span class="sc-chip ${cls}">${escapeHtml(getDeptName(n.department_id))}${note} ${Number(n.percent_need || 0).toFixed(0)}% ${icon}</span>`;
      }).join('')
    : '<span class="sc-chip">No discipline needs set</span>';

  return `
    <div class="sc-scope-block${outClass}">
      <div class="sc-scope-head">
        <div class="sc-scope-title">${escapeHtml(item.title)}${monthBadge}</div>
        <div class="sc-scope-meta">
          ${typeLabel}
          · <a data-sc-action="edit-scope" data-id="${eid}">Edit</a>
          · <a data-sc-action="remove-scope" data-id="${eid}">Remove</a>
        </div>
      </div>
      ${item.description ? `<div class="sc-scope-desc">${escapeHtml(item.description)}${ownerLine}</div>` : (ownerLine ? `<div class="sc-scope-desc">${ownerLine.replace(/^ · /, '')}</div>` : '')}
      <div class="sc-scope-disc">${chipsHtml}</div>
      <div class="sc-scope-people">
        <div class="sc-scope-people-list">${peopleHtml}${addPersonLink}</div>
        ${inlineForm}
      </div>
    </div>
  `;
}

function renderScopeForm(formState) {
  const data = formState.data;
  const eid = formState.editingId === 'new' ? 'new' : escapeHtml(formState.editingId);
  const ownerOpts = '<option value="">— Owner —</option>' + (scopeCoverageState.ownerOptions || scopeCoverageState.employeeOptions)
    .map((e) => `<option value="${escapeHtml(e.id)}"${e.id === data.owner_employee_id ? ' selected' : ''}>${escapeHtml(e.full_name)}</option>`).join('');

  const needsRows = data.needs.map((n, idx) => {
    const deptOpts = '<option value="">— Discipline —</option>' + scopeCoverageState.deptOptions
      .map((d) => `<option value="${escapeHtml(d.id)}"${d.id === n.department_id ? ' selected' : ''}>${escapeHtml(scopeDeptLabel(d.name))}</option>`).join('');
    return `
      <div class="sc-need-row" data-need-idx="${idx}">
        <select data-sc-need="department_id">${deptOpts}</select>
        <input type="number" min="0" max="200" step="1" placeholder="%" value="${Number(n.percent_need || 0)}" data-sc-need="percent_need" style="width:60px" />
        <input type="text" placeholder="Specialty note (optional)" value="${escapeHtml(n.specialty_note || '')}" data-sc-need="specialty_note" />
        <button type="button" class="sc-btn danger" data-sc-action="remove-need" data-idx="${idx}">×</button>
      </div>
    `;
  }).join('');

  return `
    <div class="sc-scope-block sc-scope-form" data-form-id="${eid}">
      <div class="sc-form-grid">
        <input type="text" placeholder="Title (e.g. Monthly Content — 6 posts)" value="${escapeHtml(data.title || '')}" data-sc-field="title" />
        <select data-sc-field="scope_type">
          <option value="recurring"${data.scope_type === 'recurring' ? ' selected' : ''}>Retainer</option>
          <option value="project"${data.scope_type === 'project' ? ' selected' : ''}>Project</option>
        </select>
        <select data-sc-field="owner_employee_id">${ownerOpts}</select>
      </div>
      <textarea placeholder="Short description" data-sc-field="description" rows="2">${escapeHtml(data.description || '')}</textarea>
      <div class="sc-month-fields" style="display:flex;gap:8px;align-items:center;margin:4px 0;white-space:nowrap;">
        <span style="font-size:11px;color:var(--muted);">Active:</span>
        <input type="month" data-sc-field="start_month" value="${escapeHtml(data.start_month || '')}" style="height:26px;font-size:11px;padding:0 6px;width:140px;flex:0 0 auto;" />
        <span style="color:var(--muted);font-size:11px;">→</span>
        <input type="month" data-sc-field="end_month" value="${escapeHtml(data.end_month || '')}" style="height:26px;font-size:11px;padding:0 6px;width:140px;flex:0 0 auto;" />
        <span style="font-size:10px;color:var(--muted);font-style:italic;">leave blank for retainer</span>
      </div>
      <div class="sc-needs-label">Disciplines required (set % per discipline):</div>
      <div class="sc-needs-list">${needsRows || '<div class="sc-empty" style="padding:6px">No disciplines yet.</div>'}</div>
      <button type="button" class="sc-btn" data-sc-action="add-need">+ Add discipline</button>
      <div class="sc-form-actions">
        <button type="button" class="sc-btn primary" data-sc-action="save-scope">Save</button>
        <button type="button" class="sc-btn" data-sc-action="cancel-scope">Cancel</button>
      </div>
    </div>
  `;
}

function startNewScopeForm() {
  scopeCoverageState.scopeFormState = {
    editingId: 'new',
    data: { title: '', scope_type: 'recurring', description: '', owner_employee_id: '', start_month: '', end_month: '', needs: [] }
  };
  renderScopeBlocks();
}

function startEditScopeForm(scopeItemId) {
  const item = scopeCoverageState.scopeItems.find((i) => i.id === scopeItemId);
  if (!item) return;
  scopeCoverageState.scopeFormState = {
    editingId: scopeItemId,
    data: {
      title: item.title || '',
      scope_type: item.scope_type || 'recurring',
      description: item.description || '',
      owner_employee_id: item.owner_employee_id || '',
      start_month: item.start_month ? String(item.start_month).slice(0, 7) : '',
      end_month: item.end_month ? String(item.end_month).slice(0, 7) : '',
      needs: item.needs.map((n) => ({
        id: n.id,
        department_id: n.department_id,
        percent_need: Number(n.percent_need || 0),
        specialty_note: n.specialty_note || ''
      }))
    }
  };
  renderScopeBlocks();
}

function readScopeFormFromDom() {
  const formEl = document.querySelector('.sc-scope-form');
  if (!formEl) return null;
  const data = scopeCoverageState.scopeFormState?.data;
  if (!data) return null;
  data.title = formEl.querySelector('[data-sc-field="title"]').value.trim();
  data.scope_type = formEl.querySelector('[data-sc-field="scope_type"]').value;
  data.description = formEl.querySelector('[data-sc-field="description"]').value.trim();
  data.owner_employee_id = formEl.querySelector('[data-sc-field="owner_employee_id"]').value || null;
  data.start_month = formEl.querySelector('[data-sc-field="start_month"]')?.value || '';
  data.end_month = formEl.querySelector('[data-sc-field="end_month"]')?.value || '';
  const needsEls = formEl.querySelectorAll('.sc-need-row');
  data.needs = Array.from(needsEls).map((row) => {
    const idx = Number(row.dataset.needIdx);
    const existing = data.needs[idx] || {};
    return {
      id: existing.id,
      department_id: row.querySelector('[data-sc-need="department_id"]').value,
      percent_need: Number(row.querySelector('[data-sc-need="percent_need"]').value || 0),
      specialty_note: row.querySelector('[data-sc-need="specialty_note"]').value.trim()
    };
  });
  return data;
}

async function saveScopeForm() {
  const data = readScopeFormFromDom();
  if (!data) return;
  if (!data.title) { appAlert('Scope item needs a title.'); return; }

  const formState = scopeCoverageState.scopeFormState;
  const isNew = formState.editingId === 'new';
  const filteredNeeds = data.needs.filter((n) => n.department_id);
  const monthToFirstOfMonth = (s) => {
    if (!s) return null;
    const m = s.match(/^(\d{4})-(\d{1,2})/);
    if (!m) return null;
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-01`;
  };
  const startMonth = monthToFirstOfMonth(data.start_month);
  const endMonth = monthToFirstOfMonth(data.end_month);

  try {
    let scopeItemId;
    if (isNew) {
      const insRes = await state.supabase.from('client_scope_items').insert({
        client_id: scopeCoverageState.clientId,
        title: data.title,
        scope_type: data.scope_type,
        description: data.description || null,
        owner_employee_id: data.owner_employee_id || null,
        start_month: startMonth,
        end_month: endMonth,
        sort_order: scopeCoverageState.scopeItems.length
      }).select().single();
      if (insRes.error) throw insRes.error;
      scopeItemId = insRes.data.id;
    } else {
      scopeItemId = formState.editingId;
      const updRes = await state.supabase.from('client_scope_items').update({
        title: data.title,
        scope_type: data.scope_type,
        description: data.description || null,
        owner_employee_id: data.owner_employee_id || null,
        start_month: startMonth,
        end_month: endMonth
      }).eq('id', scopeItemId);
      if (updRes.error) throw updRes.error;

      // Wipe existing needs (simpler than diffing)
      const delRes = await state.supabase.from('client_scope_discipline_needs').delete().eq('scope_item_id', scopeItemId);
      if (delRes.error) throw delRes.error;
    }

    if (filteredNeeds.length) {
      const needsPayload = filteredNeeds.map((n) => ({
        scope_item_id: scopeItemId,
        department_id: n.department_id,
        percent_need: Number(n.percent_need) || 0,
        specialty_note: n.specialty_note || null
      }));
      const needsRes = await state.supabase.from('client_scope_discipline_needs').insert(needsPayload);
      if (needsRes.error) throw needsRes.error;
    }

    scopeCoverageState.scopeFormState = null;
    await loadScopeCoverageDataForClient(scopeCoverageState.clientId);
    rerenderScopeCoverage();
  } catch (err) {
    console.error('Save scope item failed:', err);
    appAlert('Save failed: ' + err.message);
  }
}

async function removeScopeItem(scopeItemId) {
  if (!await appConfirm('Remove this scope item? This cannot be undone.', { title: 'Remove scope item', confirmLabel: 'Remove', danger: true })) return;
  try {
    const res = await state.supabase.from('client_scope_items').delete().eq('id', scopeItemId);
    if (res.error) throw res.error;
    await loadScopeCoverageDataForClient(scopeCoverageState.clientId);
    rerenderScopeCoverage();
  } catch (err) {
    console.error('Remove scope item failed:', err);
    appAlert('Remove failed: ' + err.message);
  }
}

// ── Allocation CRUD ────────────────────────────────────────────
function renderAllocationRows() {
  const container = document.getElementById('scAllocBody');
  if (!container) { renderAvailableEmployees(); return; }
  const vm = getCurrentViewMonth();
  // Only show allocations active in the viewed month
  const allocs = (scopeCoverageState.allocations || []).filter((a) => isAllocActiveInMonth(a, vm));

  if (!allocs.length) {
    container.innerHTML = '<div class="sc-empty" style="padding:8px 0">No one assigned this month.</div>';
    renderAvailableEmployees();
    return;
  }

  // Group by department
  const byDept = new Map();
  for (const a of allocs) {
    const key = a.department_id || '—';
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key).push(a);
  }

  // Sort departments using the canonical discipline order
  const deptOrder = scopeCoverageState.deptOptions.map((d) => d.id);
  const sortedKeys = [...byDept.keys()].sort((a, b) => {
    const ai = deptOrder.indexOf(a);
    const bi = deptOrder.indexOf(b);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  let html = '';
  for (const deptId of sortedKeys) {
    const rows = byDept.get(deptId);
    const deptName = getDeptName(deptId);
    const subtotal = rows.reduce((s, r) => s + Number(r.percent || 0), 0);
    const peopleChips = rows.map((a) => {
      const scope = a.scope_item_id
        ? scopeCoverageState.scopeItems.find((s) => s.id === a.scope_item_id)
        : null;
      const scopeTag = scope ? ` · ${escapeHtml(scope.title || '')}` : '';
      return `
        <span class="sc-person-chip">
          <b>${escapeHtml(getEmployeeName(a.employee_id))}</b>
          <span class="sc-person-meta">${Number(a.percent || 0).toFixed(0)}%${scopeTag}</span>
          ${canEditScopeCoverage() ? `<a class="sc-person-x" data-sc-action="remove-alloc" data-id="${escapeHtml(a.id)}" title="Remove">×</a>` : ''}
        </span>
      `;
    }).join('');
    html += `
      <div class="sc-alloc-dept-group">
        <div class="sc-alloc-dept-head">
          <span class="sc-alloc-dept-name">${escapeHtml(deptName)}</span>
          <span class="sc-alloc-dept-total">${subtotal.toFixed(0)}%</span>
        </div>
        <div class="sc-alloc-dept-list">${peopleChips}</div>
      </div>
    `;
  }
  container.innerHTML = html;
  renderAvailableEmployees();
}

function renderAvailableEmployees() {
  const wrap = document.getElementById('scAvailableList');
  if (!wrap) return;
  const viewMonthForAssigned = getCurrentViewMonth();
  const assignedHere = new Set(
    scopeCoverageState.allocations
      .filter((a) => isAllocActiveInMonth(a, viewMonthForAssigned))
      .map((a) => a.employee_id)
  );
  const clientById = new Map((state.clients || []).map((c) => [String(c.id), c.name || 'Untitled']));

  // Both option lists are already filtered against hidden_employee_emails
  // where they're built (loadScopeCoverageRefData) — no name test needed.
  const sourceList = scopeCoverageState.ownerOptions || scopeCoverageState.employeeOptions;
  const month = getCurrentViewMonth();
  const rows = sourceList.map((emp) => {
    const allocs = scopeCoverageState.allAllocations.filter((a) => a.employee_id === emp.id && isAllocActiveInMonth(a, month));
    const byClient = new Map();
    let used = 0;
    for (const a of allocs) {
      const pct = Number(a.percent || 0);
      used += pct;
      const cname = clientById.get(String(a.client_id)) || 'Unknown';
      byClient.set(cname, (byClient.get(cname) || 0) + pct);
    }
    return {
      ...emp,
      used: Math.round(used),
      available: Math.max(0, 100 - Math.round(used)),
      segments: [...byClient.entries()].sort((a, b) => b[1] - a[1])
    };
  }).sort((a, b) => {
    return a.used - b.used || a.full_name.localeCompare(b.full_name);
  });

  if (!rows.length) {
    wrap.innerHTML = '<div class="sc-empty" style="padding:10px 0">No employees loaded.</div>';
    return;
  }

  const colorOf = (typeof window !== 'undefined' && window.getClientColor) ? window.getClientColor : (() => 'var(--primary)');

  wrap.innerHTML = rows.map((e) => {
    const segments = e.segments.map(([name, pct]) => {
      const w = Math.round(pct);
      if (w <= 0) return '';
      return `<div class="sc-bar-seg" style="width:${w}%;background:${colorOf(name)}" title="${escapeHtml(name)} ${w}%"></div>`;
    }).join('');
    const labels = e.segments.map(([name, pct]) =>
      `<span class="sc-client-label"><span class="sc-client-dot" style="background:${colorOf(name)}"></span>${escapeHtml(name)} ${Math.round(pct)}%</span>`
    ).join('');
    const isOnThisClient = assignedHere.has(e.id);
    const showAssign = e.available > 0 && !isOnThisClient;
    const rightSide = showAssign
      ? `<button class="sc-btn primary" type="button" data-sc-action="assign-emp" data-id="${escapeHtml(e.id)}">Assign</button>`
      : isOnThisClient
        ? `<span class="sc-avail-state on">On this client</span>`
        : `<span class="sc-avail-state full">Fully booked</span>`;
    const freeCls = e.available <= 0 ? 'full' : e.available < 20 ? 'tight' : 'ok';
    return `
      <div class="sc-avail-row">
        <div class="sc-avail-name"><b>${escapeHtml(e.full_name)}</b><span class="sc-avail-dept">${escapeHtml(scopeDeptLabel(e.department_name))}</span></div>
        <div class="sc-avail-stack">
          <div class="sc-stack-bar">${segments}</div>
          <div class="sc-stack-labels">${labels || '<span class="sc-client-label muted">Idle</span>'}</div>
        </div>
        <div class="sc-avail-pct ${freeCls}">${e.available}% free</div>
        <div class="sc-avail-action">${rightSide}</div>
      </div>
    `;
  }).join('');
}

function startAssignAllocForm(employeeId) {
  // Always resolve through the directory so we get the real department id.
  const dirEmp = (state.employeeDirectory || []).find((e) => e.id === employeeId);
  const emp = dirEmp
    ? { id: dirEmp.id, full_name: dirEmp.full_name, department_id: dirEmp.department?.id || '' }
    : (scopeCoverageState.ownerOptions || scopeCoverageState.employeeOptions).find((e) => e.id === employeeId);
  if (!emp) return;
  // Auto-pick scope if exactly one is active in the viewed month
  const month = getCurrentViewMonth();
  const active = (scopeCoverageState.scopeItems || []).filter((s) => s.is_active !== false && isItemActiveInMonth(s, month));
  const scopeId = active.length === 1 ? active[0].id : '';
  scopeCoverageState.allocFormState = {
    editingId: 'new',
    data: {
      employee_id: emp.id,
      department_id: emp.department_id || emp.department?.id || '',
      percent: '',
      scope_item_id: scopeId
    }
  };
  renderAllocationRows();
  // Scroll the form into view
  setTimeout(() => {
    const row = document.querySelector('.sc-alloc-form-row');
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 50);
}

function renderAllocRow(alloc) {
  const eid = escapeHtml(alloc.id);
  const totalUtil = getEmployeeTotalUtil(alloc.employee_id);
  const barCls = totalUtil >= 100 ? 'red' : totalUtil >= 85 ? 'amber' : '';
  const barWidth = Math.min(100, totalUtil);
  let pillCls = 'ok';
  let pillLabel = 'OK';
  if (totalUtil >= 100) { pillCls = 'tight'; pillLabel = 'Maxed'; }
  else if (Number(alloc.percent || 0) === 0) { pillCls = 'gap'; pillLabel = 'Underfilled'; }

  const scope = alloc.scope_item_id
    ? scopeCoverageState.scopeItems.find((s) => s.id === alloc.scope_item_id)
    : null;
  const scopeLabel = scope
    ? escapeHtml(scope.title || '')
    : '<span style="color:var(--text-muted,#8b95a8)">—</span>';
  return `
    <tr>
      <td><b>${escapeHtml(getEmployeeName(alloc.employee_id))}</b></td>
      <td>${escapeHtml(getDeptName(alloc.department_id))}</td>
      <td style="font-size:12px">${scopeLabel}</td>
      <td>${Number(alloc.percent || 0).toFixed(0)}%</td>
      <td><div class="sc-bar ${barCls}"><span style="width:${barWidth}%"></span></div> <span style="font-size:11px;color:var(--text-muted,#8b95a8)">${totalUtil.toFixed(0)}%</span></td>
      <td><span class="sc-pill ${pillCls}">${pillLabel}</span></td>
      <td>
        <button class="sc-btn" type="button" data-sc-action="edit-alloc" data-id="${eid}">Edit</button>
        <button class="sc-btn danger" type="button" data-sc-action="remove-alloc" data-id="${eid}">×</button>
      </td>
    </tr>
  `;
}

function renderAllocFormRow(formState) {
  const data = formState.data;
  // Filter out employees already on this client unless we're editing them
  const usedKeys = new Set(scopeCoverageState.allocations
    .filter((a) => formState.editingId === 'new' || a.id !== formState.editingId)
    .map((a) => `${a.employee_id}::${a.department_id}`));

  // Build full employee list from directory (so people like Nadia outside
  // the 5-discipline shortlist still appear).
  const empSource = (state.employeeDirectory || [])
    .filter((e) => e.is_active !== false)
    .map((e) => ({ id: e.id, full_name: e.full_name, department_id: e.department?.id || '' }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  const empOpts = '<option value="">— Person —</option>' + empSource
    .map((e) => `<option value="${escapeHtml(e.id)}" data-dept-id="${escapeHtml(e.department_id)}"${e.id === data.employee_id ? ' selected' : ''}>${escapeHtml(e.full_name)}</option>`).join('');
  const currentDeptLabel = data.department_id ? getDeptName(data.department_id) : '—';

  return `
    <tr class="sc-alloc-form-row">
      <td><select data-sc-alloc="employee_id" onchange="(function(s){var o=s.options[s.selectedIndex];var did=o&&o.getAttribute('data-dept-id')||'';var row=s.closest('tr');row.querySelector('[data-sc-alloc=&quot;department_id&quot;]').value=did;row.querySelector('[data-sc-dept-label]').textContent=did?window.getDeptName(did):'—';})(this)">${empOpts}</select></td>
      <td><span data-sc-dept-label style="color:var(--text-muted,#8b95a8)">${escapeHtml(currentDeptLabel)}</span><input type="hidden" data-sc-alloc="department_id" value="${escapeHtml(data.department_id || '')}" /></td>
      <td><select data-sc-alloc="scope_item_id" style="width:100%"><option value="">Select</option>${(scopeCoverageState.scopeItems || []).map((it) => `<option value="${escapeHtml(it.id)}"${(data.scope_item_id || '') === it.id ? ' selected' : ''}>${escapeHtml(it.title || '')}</option>`).join('')}</select></td>
      <td><input type="number" min="0" max="200" step="1" value="${data.percent === '' || data.percent == null ? '' : Number(data.percent)}" placeholder="0" data-sc-alloc="percent" style="width:70px" />%</td>
      <td></td>
      <td></td>
      <td><div class="sc-alloc-actions"><button class="sc-btn primary" type="button" data-sc-action="save-alloc">Save</button><button class="sc-btn" type="button" data-sc-action="cancel-alloc">Cancel</button></div></td>
    </tr>
  `;
}

function startNewAllocForm(prefillScopeItemId) {
  // If not provided, auto-pick when exactly one scope is active in viewMonth.
  let scopeId = prefillScopeItemId || '';
  if (!scopeId) {
    const month = getCurrentViewMonth();
    const active = (scopeCoverageState.scopeItems || []).filter((s) => s.is_active !== false && isItemActiveInMonth(s, month));
    if (active.length === 1) scopeId = active[0].id;
  }
  scopeCoverageState.allocFormState = {
    editingId: 'new',
    data: { employee_id: '', department_id: '', percent: 0, scope_item_id: scopeId }
  };
  renderAllocationRows();
}

function startEditAllocForm(allocId) {
  const alloc = scopeCoverageState.allocations.find((a) => a.id === allocId);
  if (!alloc) return;
  scopeCoverageState.allocFormState = {
    editingId: allocId,
    data: {
      employee_id: alloc.employee_id,
      department_id: alloc.department_id,
      percent: Number(alloc.percent || 0),
      scope_item_id: alloc.scope_item_id || ''
    }
  };
  renderAllocationRows();
}

function readAllocFormFromDom() {
  const row = document.querySelector('.sc-alloc-form-row');
  if (!row) return null;
  return {
    employee_id: row.querySelector('[data-sc-alloc="employee_id"]').value,
    department_id: row.querySelector('[data-sc-alloc="department_id"]').value,
    percent: Number(row.querySelector('[data-sc-alloc="percent"]').value || 0),
    scope_item_id: row.querySelector('[data-sc-alloc="scope_item_id"]').value || null
  };
}

async function saveAllocForm() {
  const data = readAllocFormFromDom();
  if (!data) return;
  if (!data.employee_id || !data.department_id) { appAlert('Pick a person and discipline.'); return; }

  const formState = scopeCoverageState.allocFormState;
  const isNew = formState.editingId === 'new';

  try {
    if (isNew) {
      const scopeTitle = data.scope_item_id
        ? (scopeCoverageState.scopeItems.find((s) => s.id === data.scope_item_id)?.title || null)
        : null;
      const insRes = await state.supabase.from('client_standing_allocations').insert({
        client_id: scopeCoverageState.clientId,
        employee_id: data.employee_id,
        department_id: data.department_id,
        percent: data.percent,
        scope_item_id: data.scope_item_id || null,
        notes: scopeTitle
      });
      if (insRes.error) throw insRes.error;
    } else {
      const scopeTitle = data.scope_item_id
        ? (scopeCoverageState.scopeItems.find((s) => s.id === data.scope_item_id)?.title || null)
        : null;
      const updRes = await state.supabase.from('client_standing_allocations').update({
        employee_id: data.employee_id,
        department_id: data.department_id,
        percent: data.percent,
        scope_item_id: data.scope_item_id || null,
        notes: scopeTitle
      }).eq('id', formState.editingId);
      if (updRes.error) throw updRes.error;
    }

    scopeCoverageState.allocFormState = null;
    await loadScopeCoverageDataForClient(scopeCoverageState.clientId);
    rerenderScopeCoverage();
  } catch (err) {
    console.error('Save allocation failed:', err);
    appAlert('Save failed: ' + err.message);
  }
}

async function removeAllocation(allocId) {
  if (!await appConfirm('Remove this person from this client?')) return;
  try {
    const res = await state.supabase.from('client_standing_allocations').delete().eq('id', allocId);
    if (res.error) throw res.error;
    await loadScopeCoverageDataForClient(scopeCoverageState.clientId);
    rerenderScopeCoverage();
  } catch (err) {
    console.error('Remove allocation failed:', err);
    appAlert('Remove failed: ' + err.message);
  }
}

// ── Click delegation for the whole screen ─────────────────────
(function wireScopeCoverageClicks() {
  document.addEventListener('click', (event) => {
    const screen = document.getElementById('client-scope-coverage');
    if (!screen) return;
    // Only act if the click actually originated inside this screen.
    if (!screen.contains(event.target)) return;

    // Top-level buttons
    if (event.target.closest('#scAddScopeBtn')) { startNewScopeForm(); return; }
    if (event.target.closest('#scAddAllocBtn')) { startNewAllocForm(); return; }

    // Action delegation
    const actionEl = event.target.closest('[data-sc-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.scAction;
    const id = actionEl.dataset.id;
    const idx = actionEl.dataset.idx;

    if (action === 'edit-scope') { startEditScopeForm(id); return; }
    if (action === 'remove-scope') { removeScopeItem(id); return; }
    if (action === 'cancel-scope') { scopeCoverageState.scopeFormState = null; renderScopeBlocks(); return; }
    if (action === 'save-scope') { saveScopeForm(); return; }
    if (action === 'add-need') {
      const data = readScopeFormFromDom();
      if (data) { data.needs.push({ department_id: '', percent_need: 0, specialty_note: '' }); renderScopeBlocks(); }
      return;
    }
    if (action === 'remove-need') {
      const data = readScopeFormFromDom();
      if (data) { data.needs.splice(Number(idx), 1); renderScopeBlocks(); }
      return;
    }

    if (action === 'assign-emp') { startAssignAllocForm(id); return; }
    if (action === 'add-person-to-scope') {
      scopeCoverageState.allocFormState = {
        editingId: 'new',
        data: { employee_id: '', department_id: '', percent: '', scope_item_id: id }
      };
      renderScopeBlocks();
      setTimeout(() => {
        const f = document.querySelector(`[data-scope-inline="${id}"]`);
        if (f) f.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 30);
      return;
    }
    if (action === 'cancel-inline-alloc') {
      scopeCoverageState.allocFormState = null;
      renderScopeBlocks();
      return;
    }
    if (action === 'save-inline-alloc') {
      const f = document.querySelector(`[data-scope-inline="${id}"]`);
      if (!f) return;
      const employeeId = f.querySelector('[data-inline-alloc="employee_id"]').value;
      const departmentId = f.querySelector('[data-inline-alloc="department_id"]').value;
      const percent = Number(f.querySelector('[data-inline-alloc="percent"]').value || 0);
      if (!employeeId || !departmentId) { appAlert('Pick a person.'); return; }
      (async () => {
        try {
          const scopeTitle = scopeCoverageState.scopeItems.find((s) => s.id === id)?.title || null;
          const res = await state.supabase.from('client_standing_allocations').insert({
            client_id: scopeCoverageState.clientId,
            employee_id: employeeId,
            department_id: departmentId,
            percent,
            scope_item_id: id,
            notes: scopeTitle
          });
          if (res.error) throw res.error;
          scopeCoverageState.allocFormState = null;
          await loadScopeCoverageDataForClient(scopeCoverageState.clientId);
          rerenderScopeCoverage();
        } catch (err) {
          console.error('Inline alloc save failed:', err);
          appAlert('Save failed: ' + err.message);
        }
      })();
      return;
    }
    if (action === 'edit-alloc') { startEditAllocForm(id); return; }
    if (action === 'remove-alloc') { removeAllocation(id); return; }
    if (action === 'cancel-alloc') { scopeCoverageState.allocFormState = null; renderAllocationRows(); return; }
    if (action === 'save-alloc') { saveAllocForm(); return; }
  });
})();

async function renderClientAnalyticsTab(clientId) {
  const overviewPanel = document.getElementById('analyticsTabOverview');
  const audiencePanel = document.getElementById('analyticsTabAudience');
  const postsPanel = document.getElementById('analyticsTabPosts');
  if (!overviewPanel) return;

  // Populate screen header with client name
  const clientEntry = (state.clients || []).find(c => c.id === clientId);
  const nameEl = document.getElementById('analyticsClientName');
  const metaEl = document.getElementById('analyticsClientMeta');
  if (nameEl) nameEl.textContent = clientEntry ? `${clientEntry.name} — Analytics` : 'Analytics';

  // Show upload button for AMs / leadership / admin
  if (analyticsUploadInline) {
    analyticsUploadInline.style.display = canUploadAnalytics() ? '' : 'none';
  }

  overviewPanel.innerHTML = '<p class="mini-meta" style="padding:var(--space-4)">Loading analytics...</p>';

  const { data: reports, error } = await state.supabase
    .from('client_analytics')
    .select('id, report_type, report_label, file_name, uploaded_at, data_through, metrics_data, posts_data, summary, demographics_data, visitor_metrics, uploaded_by, insights_cache')
    .eq('client_id', clientId)
    .order('uploaded_at', { ascending: false });

  if (error) {
    overviewPanel.innerHTML = '<p class="mini-meta" style="padding:var(--space-4)">Failed to load reports.</p>';
    return;
  }

  // Group by report_type — take the latest of each type
  const grouped = {};
  (reports || []).forEach(r => {
    if (!grouped[r.report_type]) grouped[r.report_type] = r;
  });
  window._analyticsReports = grouped;

  const contentReport = grouped.content || null;
  const followersReport = grouped.followers || null;
  const visitorsReport = grouped.visitors || null;
  const instagramReport = grouped.instagram || null;
  const facebookReport = grouped.facebook || null;
  const instagramAudienceReport = grouped.instagram_audience || null;

  // Header meta shows DATA coverage, not upload-click time — uploaded_at lies
  // both ways (frozen stamps under fresh data: Example Materials; fresh re-upload of an
  // old file). Coverage is PER TAB: one global stamp showed LinkedIn's date
  // above Instagram's charts (and a FUTURE date at that — LinkedIn's weekly
  // buckets end on the coming Saturday). Capped at today: "data through"
  // cannot honestly exceed the calendar.
  const coverageOf = (...reps) => {
    const dates = reps.filter(Boolean)
      .map(r => r.data_through || String(r.uploaded_at || '').slice(0, 10))
      .filter(Boolean).sort();
    const todayIso = toISODateLocal();
    if (!dates.length) return null;
    const latest = dates[dates.length - 1];
    return latest > todayIso ? todayIso : latest;
  };
  window._analyticsCoverageByTab = {
    overview: coverageOf(...(reports || [])),
    linkedin: coverageOf(contentReport, followersReport, visitorsReport),
    instagram: coverageOf(instagramReport, instagramAudienceReport),
    facebook: coverageOf(facebookReport),
    community: coverageOf(grouped.community_pulse)
  };
  renderAnalyticsCoverageMeta('overview');
  renderUploadedFilesPanel(clientId).catch((e) => console.warn('Uploaded files list failed:', e));

  // Store content report as current for insights
  window._analyticsCurrentReport = contentReport;

  const instagramPanel = document.getElementById('analyticsTabInstagram');
  const communityReport = grouped.community_pulse || null;
  const communityPanel = document.getElementById('analyticsTabCommunity');
  const liOverviewSection = document.getElementById('liOverviewSection');

  // Platform tabs exist only when that platform has data; opening a
  // different client always starts back on the cross-platform Overview.
  const hasLinkedIn = Boolean(contentReport || followersReport || visitorsReport);
  const tabBar = document.getElementById('analyticsInnerTabs');
  const setTabVisible = (key, show) => {
    const b = tabBar?.querySelector(`[data-analytics-tab="${key}"]`);
    if (b) b.style.display = show ? '' : 'none';
  };
  setTabVisible('linkedin', hasLinkedIn);
  setTabVisible('instagram', Boolean(instagramReport));
  setTabVisible('facebook', Boolean(facebookReport));
  setTabVisible('community', Boolean(communityReport));
  wireAnalyticsInnerTabs();
  if (renderClientAnalyticsTab._lastClient !== clientId) {
    renderClientAnalyticsTab._lastClient = clientId;
    activateAnalyticsTab('overview');
  } else {
    const activeBtn = tabBar?.querySelector('.analytics-inner-tab.active');
    if (activeBtn && activeBtn.style.display === 'none') activateAnalyticsTab('overview');
  }

  if (!contentReport && !followersReport && !visitorsReport && !instagramReport
      && !facebookReport && !communityReport) {
    overviewPanel.innerHTML = `
      <div class="analytics-empty">
        <div class="analytics-empty-icon">📊</div>
        <p>No analytics reports uploaded yet.</p>
        ${canUploadAnalytics() ? '<p class="mini-meta">Upload LinkedIn (Content/Followers/Visitors) or Instagram (Meta) exports, or the community comms workbook, to see data.</p>' : ''}
      </div>`;
    if (liOverviewSection) liOverviewSection.innerHTML = '';
    if (audiencePanel) audiencePanel.innerHTML = '';
    if (postsPanel) postsPanel.innerHTML = '';
    if (instagramPanel) instagramPanel.innerHTML = '';
    document.getElementById('analyticsTabFacebook')?.replaceChildren();
    if (communityPanel) communityPanel.innerHTML = '';
    return;
  }

  // Cross-platform snapshot (the Overview tab's whole content)
  renderAnalyticsSnapshot(grouped);

  // Render Overview tab
  destroyAnalyticsCharts();
  renderAnalyticsOverview(contentReport, followersReport, visitorsReport);

  // Render Audience Intelligence tab
  renderAnalyticsAudience(followersReport, visitorsReport);

  // Render Post Performance tab
  renderAnalyticsPostPerformance(contentReport);

  // Render Instagram tab (Summary + Posts; Audience section appears when an
  // 'instagram_audience' report has been uploaded)
  renderAnalyticsInstagram(instagramReport, instagramAudienceReport);

  // Render Facebook tab (page-level daily metrics only — see renderFacebookTab)
  renderFacebookTab(facebookReport);

  // Render Community Pulse tab (newsletter/dispatch/survey sends + community)
  renderAnalyticsCommunity(communityReport);

  // Wire inner tab switching
  wireAnalyticsInnerTabs();
}

// Coverage stamp for the ACTIVE tab (see loader: per-tab, capped at today).
function renderAnalyticsCoverageMeta(tabKey) {
  const metaEl = document.getElementById('analyticsClientMeta');
  if (!metaEl) return;
  const iso = (window._analyticsCoverageByTab || {})[tabKey];
  if (!iso) { metaEl.textContent = ''; return; }
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) { metaEl.textContent = ''; return; }
  metaEl.style.whiteSpace = 'nowrap';
  metaEl.textContent = `Data through: ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}`;
}

// --- Inner Tab Switching ---
let _analyticsInnerTabsWired = false;
function activateAnalyticsTab(key) {
  const tabBar = document.getElementById('analyticsInnerTabs');
  if (!tabBar) return;
  const btn = tabBar.querySelector(`[data-analytics-tab="${key}"]`);
  if (!btn) return;
  tabBar.querySelectorAll('.analytics-inner-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('#client-analytics > .analytics-tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(
    key === 'overview' ? 'analyticsTabOverview' :
    key === 'linkedin' ? 'analyticsTabLinkedIn' :
    key === 'instagram' ? 'analyticsTabInstagram' :
    key === 'facebook' ? 'analyticsTabFacebook' :
    'analyticsTabCommunity'
  );
  if (!panel) return;
  panel.classList.add('active');
  renderAnalyticsCoverageMeta(key);
  // Charts created while their panel was display:none have zero height
  // (Chart.js only sizes on visible canvases) — deferred builders run on
  // first show of their tab.
  if (panel.dataset.chartsPending) {
    if (panel.id === 'analyticsTabInstagram') requestAnimationFrame(() => buildIgMetricCharts('instagram'));
    if (panel.id === 'analyticsTabFacebook') requestAnimationFrame(() => buildIgMetricCharts('facebook'));
    if (panel.id === 'analyticsTabLinkedIn') requestAnimationFrame(() => buildLinkedInCharts());
  }
}

function wireAnalyticsInnerTabs() {
  if (_analyticsInnerTabsWired) return;
  const tabBar = document.getElementById('analyticsInnerTabs');
  if (!tabBar) return;
  _analyticsInnerTabsWired = true;
  tabBar.addEventListener('click', (e) => {
    const tab = e.target.closest('.analytics-inner-tab');
    if (!tab) return;
    e.preventDefault();
    activateAnalyticsTab(tab.dataset.analyticsTab);
  });
}

// --- Overview Tab ---
// ── Cross-platform snapshot: the Overview tab ──
// One compact card per platform with data — headline numbers, WoW deltas,
// data freshness (data_through), and a jump into the platform tab. Depth
// lives in the platform tabs; this answers "what's happening, everywhere?".
function renderAnalyticsSnapshot(grouped) {
  const panel = document.getElementById('analyticsTabOverview');
  if (!panel) return;
  const fmt = (n) => fmtAnalytics(Number(n) || 0);

  const freshChip = (isoDate) => {
    if (!isoDate) return '<span class="chip pending">no coverage date</span>';
    // Cap at today: LinkedIn's weekly buckets end on a future Saturday, and
    // "data through 25 Jul" on the 24th is a claim the data can't make.
    const todayIso = toISODateLocal();
    if (String(isoDate).slice(0, 10) > todayIso) isoDate = todayIso;
    const d = new Date(String(isoDate).slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return '';
    const days = Math.floor((new Date() - d) / 86400000);
    const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    return days > 21
      ? `<span class="chip warn">⚠ data through ${label} · ${Math.floor(days / 7)} weeks old</span>`
      : `<span class="chip approved">data through ${label}</span>`;
  };
  const maxThrough = (...reports) => reports
    .map(r => r?.data_through || '').filter(Boolean).sort().pop() || null;
  const kpiCell = (label, value, arrow) =>
    `<div class="snap-kpi"><span class="snap-kpi-label">${escapeHtml(label)}</span><span class="snap-kpi-value">${value}${arrow || ''}</span></div>`;
  const card = (title, tabKey, freshIso, kpisHtml, note) => `
    <div class="panel snap-card">
      <div class="snap-card-head">
        <h3>${escapeHtml(title)}</h3>
        ${freshChip(freshIso)}
      </div>
      <div class="snap-kpis">${kpisHtml}</div>
      ${note ? `<p class="mini-meta">${note}</p>` : ''}
    </div>`;

  const cards = [];

  // LinkedIn — reuse the tested week-on-week KPI math
  const cr = grouped.content, fr = grouped.followers, vr = grouped.visitors;
  if (cr || fr || vr) {
    const { kpis, kpiPeriod, weekInProgress } = computeOverviewKpis(cr, fr, vr, toISODateLocal());
    cards.push(card('LinkedIn', 'linkedin', maxThrough(cr, fr, vr),
      kpis.map(k => kpiCell(k.label, k.value, k.arrow)).join(''), escapeHtml(kpiPeriod)));
  }

  // Instagram — WoW from daily metrics when present, else post-export totals
  const ig = grouped.instagram;
  if (ig) {
    const daily = Array.isArray(ig.metrics_data) ? ig.metrics_data : [];
    const igKpis = [];
    if (daily.length >= 14) {
      const wow = (key) => {
        const recent = daily.slice(-7).reduce((s, r) => s + (Number(r[key]) || 0), 0);
        const prev = daily.slice(-14, -7).reduce((s, r) => s + (Number(r[key]) || 0), 0);
        return { recent, arrow: trendArrow(recent, prev) };
      };
      [['views', 'Views'], ['reach', 'Reach'], ['content_interactions', 'Interactions'], ['follows', 'Follows']].forEach(([key, label]) => {
        if (daily.some(r => r[key] !== undefined)) {
          const w = wow(key);
          igKpis.push(kpiCell(label, fmt(w.recent), w.arrow));
        }
      });
    }
    if (!igKpis.length && ig.summary) {
      igKpis.push(kpiCell('Posts', fmt(ig.summary.total_posts)));
      igKpis.push(kpiCell('Views', fmt(ig.summary.total_views)));
      igKpis.push(kpiCell('Eng. rate', `${ig.summary.avg_engagement || '0.00'}%`));
    }
    cards.push(card('Instagram', 'instagram', ig.data_through,
      igKpis.join('') || '<p class="mini-meta">Data uploaded — open the tab for details.</p>',
      daily.length >= 14 ? 'Last 7 days · vs previous 7' : ''));
  }

  // Community Pulse — base size + the latest send's performance
  const cp = grouped.community_pulse;
  if (cp) {
    const s = cp.summary || {};
    const lastSend = (cp.metrics_data || [])[ (cp.metrics_data || []).length - 1 ];
    const cpKpis = [
      kpiCell('Subscribers', fmt(s.subscribers)),
      kpiCell('Forum', fmt(s.forum_members)),
      lastSend ? kpiCell('Last send open', `${((lastSend.open_rate || 0) * 100).toFixed(1)}%`) : '',
      lastSend ? kpiCell('Last send click', `${((lastSend.click_rate || 0) * 100).toFixed(1)}%`) : ''
    ].join('');
    cards.push(card('Community Pulse', 'community', cp.data_through, cpKpis,
      lastSend ? `Latest: ${escapeHtml(lastSend.name || '')} (${escapeHtml(lastSend.send_type || 'send')})` : ''));
  }

  panel.innerHTML = `<div class="snap-grid">${cards.join('')}</div>`;
}

function renderAnalyticsOverview(contentReport, followersReport, visitorsReport) {
  const panel = document.getElementById('liOverviewSection');
  if (!panel) return;

  const weekly = contentReport?.metrics_data || [];
  const followerDaily = followersReport?.metrics_data || [];
  const followerDemo = followersReport?.demographics_data || {};

  // KPI math is pure and lives in js/analytics.js (computeOverviewKpis, tested)
  // — complete weeks only; the comparison selector re-renders liCmpBody.
  const kpiHtml = `<div id="liCmpBody"></div>`;

  // ONE insight banner, and it lives inside the comparison section (renderLiCmp)
  // following the selected windows. The old fixed-window trio (Brand signal /
  // Weekly pulse / Monthly trend) was accretion: the comparison modes cover
  // their windows, and their one unique ingredient — audience fit — now rides
  // in the comparison payload. Four banners answering overlapping questions
  // was clutter pretending to be depth.
  const brandSignalHtml = '';

  // Charts placeholder canvases
  const chartsHtml = `<div class="analytics-charts-row">
    <div class="analytics-chart-card panel">
      <h4>Weekly Impressions</h4>
      <canvas id="chartWeeklyImpressions"></canvas>
    </div>
    <div class="analytics-chart-card panel">
      <h4>Engagement Rate %</h4>
      <canvas id="chartEngagementRate"></canvas>
    </div>
  </div>
  <div class="analytics-charts-row">
    <div class="analytics-chart-card panel">
      <h4>New Followers Weekly</h4>
      <canvas id="chartNewFollowers"></canvas>
    </div>
    <div class="analytics-chart-card panel">
      <h4>Audience Quality Snapshot</h4>
      ${buildAudienceQualitySnapshot(followerDemo)}
    </div>
  </div>`;

  panel.innerHTML = kpiHtml + brandSignalHtml + chartsHtml;
  renderLiCmp();

  // LinkedIn now lives in a non-default tab — hidden canvases stay 0-height
  // in the vendored Chart.js, so defer chart creation to tab-show (same
  // pattern as the Instagram trend charts).
  window._liChartData = { weekly, followerDaily };
  const liPanel = document.getElementById('analyticsTabLinkedIn');
  if (typeof Chart !== 'undefined') {
    if (liPanel && liPanel.classList.contains('active')) {
      renderOverviewCharts(weekly, followerDaily);
    } else if (liPanel) {
      liPanel.dataset.chartsPending = '1';
    }
  }
}

// Deferred LinkedIn chart builder — consumed by the tab-switch handler.

// ── Value labels on chart points (24 Jul 2026: "the engagement rate
// numbers should be on top of the graph"). The vendored Chart.js has no
// datalabels plugin and there is no build step, so this is a ~25-line inline
// plugin. Per-chart opt-in via options.plugins.valueLabels = { fmt } — and
// automatically silent above 16 points per dataset, where labels turn to soup
// (the 90-day Instagram lines keep tooltips instead).
if (typeof Chart !== 'undefined') {
  // Formatters are STRING KEYS, not functions: Chart.js treats any function
  // in options as a scriptable option and auto-invokes it with a context
  // object — fmtAnalytics(contextObject) threw and killed every chart created
  // after it. Strings pass through the option resolver untouched, and the
  // plugin reads chart.config.options (raw) rather than chart.options (proxy).
  const VALUE_LABEL_FMTS = {
    compact: (v) => fmtAnalytics(v),
    pct1: (v) => Number(v).toFixed(1) + '%',
    plusCompact: (v) => '+' + fmtAnalytics(v)
  };
  Chart.register({
    id: 'valueLabels',
    afterDatasetsDraw(chart) {
      const opt = chart.config && chart.config.options && chart.config.options.plugins
        && chart.config.options.plugins.valueLabels;
      if (!opt || opt.enabled === false) return;
      const { ctx } = chart;
      const fmt = VALUE_LABEL_FMTS[opt.fmt] || ((v) => v);
      chart.data.datasets.forEach((ds, di) => {
        if (opt.datasetIndex !== undefined && di !== opt.datasetIndex) return;
        const meta = chart.getDatasetMeta(di);
        if (!meta || meta.hidden || !meta.data || meta.data.length > 16) return;
        ctx.save();
        ctx.font = '600 10px Manrope, sans-serif';
        ctx.fillStyle = getChartThemeColors().text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        meta.data.forEach((pt, i) => {
          const v = Number(ds.data[i]);
          if (!isFinite(v) || v === 0) return; // zeros label as clutter
          const isHorizontal = chart.options.indexAxis === 'y';
          if (isHorizontal) {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(fmt(v), pt.x + 4, pt.y);
          } else {
            ctx.fillText(fmt(v), pt.x, pt.y - 4);
          }
        });
        ctx.restore();
      });
    }
  });
}

function buildLinkedInCharts() {
  const liPanel = document.getElementById('analyticsTabLinkedIn');
  if (!liPanel || typeof Chart === 'undefined') return;
  delete liPanel.dataset.chartsPending;
  const d = window._liChartData;
  if (d) renderOverviewCharts(d.weekly, d.followerDaily);
  const posts = window._liPostsForChart;
  if (posts && posts.length) renderContentTypeChart(posts);
}

function getChartThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    primary: style.getPropertyValue('--primary').trim() || '#bca4b6',
    primarySoft: 'rgba(188, 164, 182, 0.25)',
    good: style.getPropertyValue('--good').trim() || '#3a9d6a',
    text: style.getPropertyValue('--text').trim() || '#e8e6df',
    muted: style.getPropertyValue('--text-secondary').trim() || 'rgba(232, 230, 223, 0.55)',
    line: 'rgba(255, 255, 255, 0.08)',
    surface: style.getPropertyValue('--surface-quiet').trim() || '#2a2a28',
  };
}

function renderOverviewCharts(weekly, followerDaily) {
  const colors = getChartThemeColors();
  const chartFont = { family: "'Manrope', 'Avenir Next', sans-serif", size: 11 };
  const MAX_CHART_WEEKS = 10;
  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(30, 30, 28, 0.95)',
        titleFont: { family: chartFont.family, size: 12 },
        bodyFont: { family: chartFont.family, size: 12 },
        titleColor: '#fff',
        bodyColor: '#e8e6df',
        padding: 10,
        cornerRadius: 6,
        displayColors: false
      }
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: chartFont, color: colors.muted, maxRotation: 45 } },
      y: { grid: { color: colors.line }, ticks: { font: chartFont, color: colors.muted } }
    }
  };

  // Axis titles so a chart says what it's measuring (24 Jul 2026:
  // "your graphs don't have x axis, y axis, I don't know what I'm looking at")
  const axT = (text) => ({ display: true, text, color: colors.text, font: { ...chartFont, size: 11 } });

  // Limit weekly data to last N weeks
  const recentWeekly = weekly.slice(-MAX_CHART_WEEKS);

  // Weekly Impressions — area chart
  const imprCanvas = document.getElementById('chartWeeklyImpressions');
  if (imprCanvas && recentWeekly.length) {
    const ctx = imprCanvas.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: recentWeekly.map(w => weekLabelAnalytics(w.week)),
        datasets: [{
          data: recentWeekly.map(w => w['Impressions (organic)'] || 0),
          borderColor: colors.primary,
          backgroundColor: colors.primarySoft,
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 6,
          borderWidth: 2
        }]
      },
      options: {
        ...chartDefaults,
        plugins: { ...chartDefaults.plugins, valueLabels: { fmt: 'compact' }, tooltip: { ...chartDefaults.plugins.tooltip, callbacks: { label: ctx => fmtAnalytics(ctx.parsed.y) + ' impressions' } } },
        scales: { x: { ...chartDefaults.scales.x, title: axT('Week starting') }, y: { ...chartDefaults.scales.y, title: axT('Impressions'), beginAtZero: true, ticks: { ...chartDefaults.scales.y.ticks, callback: v => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v } } }
      }
    });
    _analyticsChartInstances.push(chart);
  }

  // Engagement Rate — bar chart
  const engCanvas = document.getElementById('chartEngagementRate');
  if (engCanvas && recentWeekly.length) {
    const ctx = engCanvas.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: recentWeekly.map(w => weekLabelAnalytics(w.week)),
        datasets: [{
          data: recentWeekly.map(w => Math.round(((w['Engagement rate (total)'] || 0) * 100) * 10) / 10),
          backgroundColor: colors.primary,
          borderRadius: 4,
          barPercentage: 0.6
        }]
      },
      options: {
        ...chartDefaults,
        plugins: { ...chartDefaults.plugins, valueLabels: { fmt: 'pct1' }, tooltip: { ...chartDefaults.plugins.tooltip, callbacks: { label: ctx => ctx.parsed.y.toFixed(1) + '% engagement' } } },
        scales: { x: { ...chartDefaults.scales.x, title: axT('Week starting') }, y: { ...chartDefaults.scales.y, title: axT('Engagement rate (%)'), beginAtZero: true, ticks: { ...chartDefaults.scales.y.ticks, callback: v => v + '%' } } }
      }
    });
    _analyticsChartInstances.push(chart);
  }

  // New Followers Weekly — aggregate daily to weekly, then area chart
  const followCanvas = document.getElementById('chartNewFollowers');
  if (followCanvas && followerDaily.length) {
    // Aggregate daily follower data to weekly buckets
    const weekMap = new Map();
    followerDaily.forEach(d => {
      // Handle both YYYY-MM-DD and MM/DD/YYYY date formats
      let ds = String(d.date || '').trim();
      const slashMatch = ds.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (slashMatch) ds = slashMatch[3] + '-' + slashMatch[1].padStart(2, '0') + '-' + slashMatch[2].padStart(2, '0');
      const dt = new Date(ds + 'T00:00:00');
      if (isNaN(dt.getTime())) return;
      const day = dt.getDay();
      const diff = day === 0 ? 6 : day - 1;
      const ws = new Date(dt);
      ws.setDate(dt.getDate() - diff);
      const wk = ws.toISOString().split('T')[0];
      weekMap.set(wk, (weekMap.get(wk) || 0) + (d.total || 0));
    });
    const weeklyFollowers = [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-MAX_CHART_WEEKS);

    const ctx = followCanvas.getContext('2d');
    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: weeklyFollowers.map(([wk]) => weekLabelAnalytics(wk)),
        datasets: [{
          data: weeklyFollowers.map(([, v]) => v),
          borderColor: colors.good,
          backgroundColor: 'rgba(58, 157, 106, 0.15)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 6,
          borderWidth: 2
        }]
      },
      options: {
        ...chartDefaults,
        plugins: { ...chartDefaults.plugins, valueLabels: { fmt: 'plusCompact' }, tooltip: { ...chartDefaults.plugins.tooltip, callbacks: { label: ctx => '+' + ctx.parsed.y + ' new followers' } } },
        scales: { x: { ...chartDefaults.scales.x, title: axT('Week starting') }, y: { ...chartDefaults.scales.y, title: axT('New followers'), beginAtZero: true } }
      }
    });
    _analyticsChartInstances.push(chart);
  }
}

function buildAudienceQualitySnapshot(demographics) {
  if (!demographics || !demographics.industry) {
    return '<p class="mini-meta">Upload a Followers report to see audience quality.</p>';
  }

  const persona = currentAnalyticsPersona();
  if (!persona) {
    return '<p class="mini-meta">No target persona defined for this client yet.</p>';
  }

  const industryTotal = demographics.industry.reduce((s, d) => s + d.count, 0) || 1;
  const targetIndustryCount = demographics.industry
    .filter(d => persona.industries.some(t => d.name.toLowerCase().includes(t.toLowerCase())))
    .reduce((s, d) => s + d.count, 0);
  const targetIndustryPct = ((targetIndustryCount / industryTotal) * 100).toFixed(1);

  const seniorityTotal = demographics.seniority?.reduce((s, d) => s + d.count, 0) || 1;
  const dmCount = (demographics.seniority || [])
    .filter(d => persona.decisionMakerSeniority.some(t => d.name.toLowerCase().includes(t.toLowerCase())))
    .reduce((s, d) => s + d.count, 0);
  const dmPct = ((dmCount / seniorityTotal) * 100).toFixed(1);

  const jfTotal = demographics.job_function?.reduce((s, d) => s + d.count, 0) || 1;
  const targetJfCount = (demographics.job_function || [])
    .filter(d => persona.jobFunctions.some(t => d.name.toLowerCase().includes(t.toLowerCase())))
    .reduce((s, d) => s + d.count, 0);
  const targetJfPct = ((targetJfCount / jfTotal) * 100).toFixed(1);

  const metrics = [
    { label: 'Target Industries', pct: targetIndustryPct, desc: persona.industriesLabel },
    { label: 'Decision-Makers', pct: dmPct, desc: persona.seniorityLabel },
    { label: 'Target Job Functions', pct: targetJfPct, desc: persona.jobFunctionsLabel }
  ];

  return `<div class="audience-quality-bars">
    ${metrics.map(m => `
      <div class="audience-quality-metric">
        <div class="audience-quality-header">
          <span class="audience-quality-label">${m.label}</span>
          <span class="audience-quality-pct">${m.pct}%</span>
        </div>
        <div class="audience-quality-bar-bg">
          <div class="audience-quality-bar-fill" style="width:${Math.min(Number(m.pct), 100)}%"></div>
        </div>
        <span class="mini-meta">${m.desc}</span>
      </div>
    `).join('')}
  </div>`;
}

// --- Audience Intelligence Tab ---
function renderAnalyticsAudience(followersReport, visitorsReport) {
  const panel = document.getElementById('analyticsTabAudience');
  if (!panel) return;

  if (!followersReport && !visitorsReport) {
    panel.innerHTML = '<div class="analytics-empty"><p>Upload Followers or Visitors reports to see audience intelligence.</p></div>';
    return;
  }

  // Followers/Visitors toggle
  const hasFollowers = !!followersReport;
  const hasVisitors = !!visitorsReport;
  const defaultView = hasFollowers ? 'followers' : 'visitors';

  let toggleHtml = '';
  if (hasFollowers && hasVisitors) {
    toggleHtml = `<div class="audience-toggle">
      <button class="audience-toggle-btn active" data-audience-view="followers" type="button">Followers</button>
      <button class="audience-toggle-btn" data-audience-view="visitors" type="button">Visitors</button>
    </div>`;
  }

  const legendPersona = currentAnalyticsPersona();
  // The target audience belongs to the AM leading this client — they (and
  // leadership) edit it right here, in plain fields, not in admin config.
  const clientRow = (state.clients || []).find(c => String(c.id) === String(analyticsCurrentClientId));
  const canEditPersona = isLeadershipRole()
    || (clientRow && clientRow.account_owner_employee_id === state.currentEmployeeId);
  const personaEditBtn = canEditPersona
    ? `<button class="ghost small" id="audiencePersonaEditBtn" type="button">${legendPersona ? 'Edit' : 'Set'} target audience</button>`
    : '';
  const targetLegend = legendPersona
    ? `<div class="audience-target-legend">
    <span class="audience-target-dot"></span>
    <span>Green rows = target persona (${escapeHtml(legendPersona.industriesLabel)})</span>
    ${personaEditBtn}
  </div>`
    : (personaEditBtn ? `<div class="audience-target-legend"><span class="mini-meta">No target audience set for this client yet.</span> ${personaEditBtn}</div>` : '');

  const joinList = (arr) => (Array.isArray(arr) ? arr.join(', ') : '');
  const personaFormHtml = canEditPersona ? `
    <div id="audiencePersonaForm" class="panel hidden"><div>
      <h3>Target audience — ${escapeHtml(clientRow?.name || 'this client')}</h3>
      <p class="mini-meta">Who is this client trying to reach? Comma-separated lists — used to highlight matching rows in the audience charts and to steer the AI insights.</p>
      <div class="form-grid">
        <label class="form-field"><span>Industries</span>
          <input type="text" id="apIndustries" placeholder="e.g. Pharmaceuticals, Biotechnology" value="${escapeHtml(joinList(legendPersona?.industries))}"></label>
        <label class="form-field"><span>Job functions</span>
          <input type="text" id="apJobFunctions" placeholder="e.g. Research, Engineering" value="${escapeHtml(joinList(legendPersona?.jobFunctions))}"></label>
        <label class="form-field"><span>Seniority levels</span>
          <input type="text" id="apSeniority" placeholder="e.g. Manager, Director, VP, CXO" value="${escapeHtml(joinList(legendPersona?.decisionMakerSeniority))}"></label>
      </div>
      <div class="action-row">
        <button class="primary" id="apSaveBtn" type="button">Save</button>
        <button class="ghost small" id="apCancelBtn" type="button">Cancel</button>
      </div>
      <p id="apNotice" class="mini-meta"></p>
    </div></div>` : '';

  panel.innerHTML = `${toggleHtml}${targetLegend}${personaFormHtml}
    <div id="audiencePanelsContainer"></div>`;

  if (canEditPersona) {
    const form = document.getElementById('audiencePersonaForm');
    document.getElementById('audiencePersonaEditBtn')?.addEventListener('click', () => form?.classList.toggle('hidden'));
    document.getElementById('apCancelBtn')?.addEventListener('click', () => form?.classList.add('hidden'));
    document.getElementById('apSaveBtn')?.addEventListener('click', () => saveClientAudiencePersona().catch(console.error));
  }

  renderAudiencePanels(defaultView);

  // Wire toggle
  const toggleBtns = panel.querySelectorAll('.audience-toggle-btn');
  toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      toggleBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderAudiencePanels(btn.dataset.audienceView);
    });
  });
}

async function saveClientAudiencePersona() {
  const notice = document.getElementById('apNotice');
  const split = (id) => (document.getElementById(id)?.value || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const industries = split('apIndustries');
  const jobFunctions = split('apJobFunctions');
  const seniority = split('apSeniority');
  const clientRow = (state.clients || []).find(c => String(c.id) === String(analyticsCurrentClientId));
  if (!clientRow || !state.supabase) return;

  const allEmpty = !industries.length && !jobFunctions.length && !seniority.length;
  const persona = allEmpty ? null : {
    industries,
    jobFunctions,
    decisionMakerSeniority: seniority,
    industriesLabel: industries.join(', '),
    jobFunctionsLabel: jobFunctions.join(', '),
    seniorityLabel: seniority.length > 1
      ? `${seniority[0]} – ${seniority[seniority.length - 1]}`
      : (seniority[0] || '')
  };
  if (allEmpty && !await appConfirm('Clear the target audience for this client? Charts go back to plain bars.', { title: 'Clear target audience', confirmLabel: 'Clear' })) return;

  if (notice) notice.textContent = 'Saving…';
  const { error } = await state.supabase.rpc('set_client_audience_persona', {
    p_client_id: clientRow.id,
    p_persona: persona
  });
  if (error) { if (notice) notice.textContent = 'Could not save: ' + error.message; return; }
  clientRow.audience_persona = persona;
  const reports = window._analyticsReports || {};
  renderAnalyticsAudience(reports.followers, reports.visitors);
}

function renderAudiencePanels(viewType) {
  const container = document.getElementById('audiencePanelsContainer');
  if (!container) return;

  const report = window._analyticsReports[viewType];
  if (!report || !report.demographics_data) {
    container.innerHTML = '<p class="mini-meta" style="padding:var(--space-4)">No demographic data available.</p>';
    return;
  }

  const demo = report.demographics_data;
  const countLabel = viewType === 'followers' ? 'followers' : 'views';
  const persona = currentAnalyticsPersona();

  container.innerHTML = `<div class="audience-panels-row">
    <div class="audience-panel panel">
      <h4>Job Function</h4>
      ${buildDemographicBars(demo.job_function || [], persona?.jobFunctions || [], countLabel)}
    </div>
    <div class="audience-panel panel">
      <h4>Industry</h4>
      ${buildDemographicBars(demo.industry || [], persona?.industries || [], countLabel)}
    </div>
    <div class="audience-panel panel">
      <h4>Seniority</h4>
      ${buildDemographicBars(demo.seniority || [], persona?.decisionMakerSeniority || [], countLabel)}
      ${persona ? buildDecisionMakerCallout(demo.seniority || [], persona) : ''}
    </div>
  </div>`;
}

function buildDemographicBars(data, targetList, countLabel) {
  if (!data.length) return '<p class="mini-meta">No data</p>';
  const maxCount = data[0]?.count || 1;
  const total = data.reduce((s, d) => s + d.count, 0) || 1;

  return `<div class="audience-bar-list">
    ${data.slice(0, 15).map(d => {
      const isTarget = targetList.some(t => d.name.toLowerCase().includes(t.toLowerCase()));
      const pct = ((d.count / total) * 100).toFixed(1);
      const barWidth = ((d.count / maxCount) * 100).toFixed(1);
      return `<div class="audience-bar-row${isTarget ? ' target' : ''}">
        <div class="audience-bar-label">
          ${isTarget ? '<span class="audience-target-dot"></span>' : ''}
          <span>${escapeHtml(d.name)}</span>
        </div>
        <div class="audience-bar-track">
          <div class="audience-bar-fill${isTarget ? ' target' : ''}" style="width:${barWidth}%"></div>
        </div>
        <span class="audience-bar-value">${pct}%</span>
      </div>`;
    }).join('')}
  </div>`;
}

function buildDecisionMakerCallout(seniorityData, persona) {
  const total = seniorityData.reduce((s, d) => s + d.count, 0) || 1;
  const dmCount = seniorityData
    .filter(d => persona.decisionMakerSeniority.some(t => d.name.toLowerCase().includes(t.toLowerCase())))
    .reduce((s, d) => s + d.count, 0);
  const dmPct = ((dmCount / total) * 100).toFixed(1);
  return `<div class="audience-callout">
    <span class="audience-callout-label">Decision-makers (${escapeHtml(persona.seniorityLabel)}):</span>
    <span class="audience-callout-value">${dmPct}%</span>
  </div>`;
}

// --- Post Performance Tab ---
function renderAnalyticsPostPerformance(contentReport) {
  const panel = document.getElementById('analyticsTabPosts');
  if (!panel) return;

  if (!contentReport || !contentReport.posts_data?.length) {
    panel.innerHTML = '<div class="analytics-empty"><p>Upload a Content report to see post performance.</p></div>';
    return;
  }

  const allPosts = contentReport.posts_data;

  // Check if posts have actual metrics (not all zeros)
  const hasPostMetrics = allPosts.some(p => (Number(p['Impressions']) || 0) > 0 || (Number(p['Clicks']) || 0) > 0);
  if (!hasPostMetrics) {
    panel.innerHTML = `<div class="analytics-empty"><p>Post-level metrics are not available in this export. LinkedIn's Content report sometimes excludes per-post impressions and clicks.</p>
      <p class="mini-meta" style="margin-top:8px">${allPosts.length} posts found, but all have zero metrics. Try re-exporting the Content report from LinkedIn.</p></div>`;
    return;
  }

  // Filter to last 2 weeks of posts by default
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const recentPosts = allPosts.filter(p => {
    const d = new Date(normalizeDateStr(p['Created date'] || p['Date'] || ''));
    return !isNaN(d) && d >= twoWeeksAgo;
  });
  const hasRecentPosts = recentPosts.length > 0 && recentPosts.some(p => (Number(p['Impressions']) || 0) > 0);
  let activePosts = hasRecentPosts ? recentPosts : allPosts;
  window._analyticsPostsData = activePosts;

  const periodNote = hasRecentPosts
    ? `<span class="mini-meta">Showing ${recentPosts.length} posts from last 2 weeks</span>`
    : `<span class="mini-meta">No posts in the last 2 weeks — showing all ${allPosts.length} posts</span>`;

  panel.innerHTML = `
    <div class="analytics-filter-row">
      <label>Sort by:</label>
      <select id="analyticsPostSort">
        <option value="Created date">Date</option>
        <option value="Engagement rate">Engagement Rate</option>
        <option value="Impressions">Impressions</option>
        <option value="Clicks">Clicks</option>
      </select>
      ${hasRecentPosts && allPosts.length > recentPosts.length ? `<button id="analyticsPostToggleAll" class="ghost small" type="button">Show all ${allPosts.length} posts</button>` : ''}
      ${periodNote}
    </div>
    <div id="analyticsPostTableContainer"></div>
    <div class="analytics-charts-row" id="postPerformanceCharts">
      <div class="analytics-chart-card panel">
        <h4>Avg Engagement by Content Type</h4>
        <canvas id="chartContentTypeEng"></canvas>
      </div>
      <div class="analytics-chart-card panel">
        <h4>What works for ${escapeHtml(getClientName())}</h4>
        <div id="patternCardsContainer"></div>
      </div>
    </div>`;

  renderPostTable(activePosts, 'Created date');

  // Wire sort dropdown
  const sortSelect = document.getElementById('analyticsPostSort');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      renderPostTable(activePosts, sortSelect.value);
    });
  }

  // Wire "show all" toggle
  const toggleBtn = document.getElementById('analyticsPostToggleAll');
  if (toggleBtn) {
    let showingAll = false;
    toggleBtn.addEventListener('click', () => {
      showingAll = !showingAll;
      activePosts = showingAll ? allPosts : recentPosts;
      window._analyticsPostsData = activePosts;
      toggleBtn.textContent = showingAll ? `Show last 2 weeks (${recentPosts.length})` : `Show all ${allPosts.length} posts`;
      const sortVal = sortSelect ? sortSelect.value : 'Created date';
      renderPostTable(activePosts, sortVal);
      renderContentTypeChart(activePosts);
      renderPatternCards(activePosts);
    });
  }

  // Render content type chart
  // Chart deferred until the LinkedIn tab is visible (hidden canvas = 0px)
  window._liPostsForChart = activePosts;
  const liPanelForChart = document.getElementById('analyticsTabLinkedIn');
  if (liPanelForChart && liPanelForChart.classList.contains('active')) {
    renderContentTypeChart(activePosts);
  } else if (liPanelForChart) {
    liPanelForChart.dataset.chartsPending = '1';
  }

  // Render pattern cards
  renderPatternCards(activePosts);
}

// --- Instagram tab ---
// Renders Summary + Post Performance for the Instagram (Meta) export.
// Audience Intelligence section appears only when an instagram_audience report
// has been uploaded (renderer stub for now; full demographics support is a
// follow-up when that export format is captured).
function renderAnalyticsInstagram(instagramReport, audienceReport) {
  const panel = document.getElementById('analyticsTabInstagram');
  if (!panel) return;

  if (!instagramReport) {
    panel.innerHTML = `
      <div class="analytics-empty">
        <div class="analytics-empty-icon">📷</div>
        <p>No Instagram report uploaded yet.</p>
        ${canUploadAnalytics() ? '<p class="mini-meta">Upload a post export from Meta Business Suite to see Instagram data.</p>' : ''}
      </div>`;
    return;
  }

  const s = instagramReport.summary || {};
  const posts = Array.isArray(instagramReport.posts_data) ? instagramReport.posts_data : [];

  const fmt = (n) => Number(n || 0).toLocaleString();
  const fmtDate = (iso) => {
    if (!iso) return '–';
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return String(iso);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const periodLabel = s.date_from && s.date_to
    ? `${fmtDate(s.date_from)} – ${fmtDate(s.date_to)}`
    : '';

  const accountHandle = s.account_username ? `@${s.account_username}` : '';
  const accountHeader = (s.account_name || accountHandle)
    ? `<div class="analytics-kpi-period"><strong>${escapeHtml(s.account_name || '')}</strong>${s.account_name && accountHandle ? ' · ' : ''}${escapeHtml(accountHandle)}${periodLabel ? ` · ${escapeHtml(periodLabel)}` : ''}</div>`
    : '';

  // Sort posts by views desc for default view; cap to top 100 for table size
  const sortedPosts = [...posts].sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
  const displayedPosts = sortedPosts.slice(0, 100);
  const truncatedNote = posts.length > 100
    ? `<p class="mini-meta" style="margin-top:8px">Showing top 100 of ${fmt(posts.length)} posts (by views).</p>`
    : '';

  const postRows = displayedPosts.map((p, i) => {
    const dateStr = p.date || (p.publish_time ? String(p.publish_time).slice(0, 10) : '');
    const descShort = String(p.description || '').replace(/\s+/g, ' ').slice(0, 70);
    const descCell = p.permalink
      ? `<a href="${escapeHtml(p.permalink)}" target="_blank" rel="noopener">${escapeHtml(descShort) || '(view post)'}${(p.description || '').length > 70 ? '…' : ''}</a>`
      : escapeHtml(descShort);
    return `<tr class="post-table-row${i === 0 ? ' top-post' : ''}">
      <td data-label="Date" class="mini-meta">${fmtDate(dateStr)}</td>
      <td data-label="Type"><span class="chip">${escapeHtml(p.post_type || 'Post')}</span></td>
      <td data-label="Post">${i === 0 ? '<span class="chip approved" style="font-size:0.65rem;padding:1px 6px;margin-right:4px">TOP</span>' : ''}${descCell}</td>
      <td data-label="Views" style="text-align:right">${fmt(p.views)}</td>
      <td data-label="Reach" style="text-align:right">${fmt(p.reach)}</td>
      <td data-label="Likes" style="text-align:right">${fmt(p.likes)}</td>
      <td data-label="Comments" style="text-align:right">${fmt(p.comments)}</td>
      <td data-label="Saves" style="text-align:right">${fmt(p.saves)}</td>
      <td data-label="Shares" style="text-align:right">${fmt(p.shares)}</td>
    </tr>`;
  }).join('');

  let audienceSection = '';
  if (audienceReport) {
    // Placeholder — full demographics rendering arrives when we capture an IG
    // audience export and know its schema.
    audienceSection = `
      <section class="panel" style="margin-top:var(--space-5)">
        <h3>Audience Intelligence</h3>
        <p class="mini-meta">Audience report on file — full breakdown rendering coming soon.</p>
      </section>`;
  }

  const hasPosts = posts.length > 0;
  const kpiSection = hasPosts ? `
    <div class="analytics-overview-kpi">
      <div class="analytics-kpi-card"><div class="analytics-kpi-label">Posts</div><div class="analytics-kpi-value">${fmt(s.total_posts)}</div></div>
      <div class="analytics-kpi-card"><div class="analytics-kpi-label">Views</div><div class="analytics-kpi-value">${fmt(s.total_views)}</div></div>
      <div class="analytics-kpi-card"><div class="analytics-kpi-label">Reach</div><div class="analytics-kpi-value">${fmt(s.total_reach)}</div></div>
      <div class="analytics-kpi-card"><div class="analytics-kpi-label">Likes</div><div class="analytics-kpi-value">${fmt(s.total_likes)}</div></div>
      <div class="analytics-kpi-card"><div class="analytics-kpi-label">Comments</div><div class="analytics-kpi-value">${fmt(s.total_comments)}</div></div>
      <div class="analytics-kpi-card"><div class="analytics-kpi-label">Engagement Rate</div><div class="analytics-kpi-value">${s.avg_engagement || '0.00'}%</div></div>
    </div>` : '';

  const postsSectionHtml = hasPosts ? `
    <section class="panel" style="margin-top:var(--space-5)">
      <h3>Post Performance</h3>
      <table class="analytics-post-table">
        <thead><tr>
          <th>Date</th><th>Type</th><th>Post</th>
          <th style="text-align:right">Views</th>
          <th style="text-align:right">Reach</th>
          <th style="text-align:right">Likes</th>
          <th style="text-align:right">Comments</th>
          <th style="text-align:right">Saves</th>
          <th style="text-align:right">Shares</th>
        </tr></thead>
        <tbody>${postRows}</tbody>
      </table>
      ${truncatedNote}
    </section>` : '';

  // Account Trends — daily metrics from the Insights CSV uploads, framed as a
  // COMPARISON (23 Jul 2026): every number answers "vs what?". The
  // section body re-renders on mode change without touching the rest of the
  // tab; renderIgTrends() owns it.
  const daily = Array.isArray(instagramReport.metrics_data) ? instagramReport.metrics_data : [];
  const metricKeys = [...new Set(daily.flatMap(r => Object.keys(r)))].filter(k => k !== 'date').sort();
  const trendsSection = metricKeys.length ? `
    <section style="margin-top:var(--space-5)">
      <h3 style="margin-bottom:var(--space-3)">Account Trends</h3>
      <div id="igTrendsBody"></div>
    </section>` : '';

  panel.innerHTML = `
    ${accountHeader}
    ${kpiSection}
    ${buildInsightsBanner('instagram', 'AI read on what the posts and reels say', 'Instagram insights')}
    ${trendsSection}
    ${postsSectionHtml}
    ${audienceSection}
  `;

  // Charts created while this panel is display:none end up 0-height (the
  // vendored Chart.js can't size hidden canvases, even on resize()) — so
  // create them only when the tab is actually visible, else defer to the
  // tab-switch handler via a pending flag.
  window._igMetricsDaily = daily;
  window._metricsDailyBySurface.instagram = daily;
  if (metricKeys.length) {
    renderIgTrends('instagram'); // builds the comparison DOM; charts wait for visibility
    if (panel.classList.contains('active')) buildIgMetricCharts('instagram');
    else panel.dataset.chartsPending = '1';
  } else {
    delete panel.dataset.chartsPending;
  }
}



// ── Uploaded files panel (Rhea's request, 29 Jul 2026) ──
// Lists the client's storage folder — the FULL upload history, not just the
// latest file per report type that survives on the client_analytics rows.
window._uploadedFilesShowAll = false;

async function renderUploadedFilesPanel(clientId) {
  const panel = document.getElementById('uploadedFilesPanel');
  const listEl = document.getElementById('uploadedFilesList');
  const countEl = document.getElementById('uploadedFilesCount');
  if (!panel || !listEl || !clientId) return;
  window._uploadedFilesShowAll = false;

  const { data: objects, error } = await state.supabase.storage
    .from('client-analytics')
    .list(clientId, { limit: 200 });
  if (error || !objects || !objects.length) { panel.style.display = 'none'; return; }

  // Newest first: the upload timestamp is the filename prefix.
  const files = objects
    .filter((o) => o.name && !o.name.endsWith('/'))
    .map((o) => ({ ...parseStoredUploadName(o.name), objectName: o.name, size: o.metadata?.size || 0 }))
    .sort((a, b) => String(b.objectName).localeCompare(String(a.objectName)));

  // Type + uploader are only knowable for files still referenced by a report
  // row (the upsert keeps one row per type). Older files get a neutral chip
  // and an em-dash — shown honestly rather than guessed.
  const TYPE_META = {
    content: ['LinkedIn', 'approved'], followers: ['LinkedIn', 'approved'], visitors: ['LinkedIn', 'approved'],
    instagram: ['Instagram', 'pending'], facebook: ['Facebook', 'info'],
    community_pulse: ['Community', 'info']
  };
  const byFileName = new Map();
  Object.values(window._analyticsReports || {}).forEach((r) => {
    if (r?.file_name) byFileName.set(r.file_name, r);
  });
  // The per-file log is the truth where it exists; the report-row match stays
  // as the fallback for everything uploaded before the log did (20 Sep 2026).
  const byObject = new Map();
  const logged = await state.supabase
    .from('client_analytics_uploads')
    .select('report_type, uploaded_by, object_name')
    .eq('client_id', clientId)
    .limit(500);
  (logged.data || []).forEach((r) => byObject.set(r.object_name, r));
  const empNameById = new Map((state.employeeDirectory || []).map((e) => [e.id, displayPersonName(e.full_name, '')]));

  panel.style.display = '';
  if (countEl) countEl.textContent = `\u00b7 ${files.length}`;

  const renderRows = () => {
    const shown = window._uploadedFilesShowAll ? files : files.slice(0, 4);
    const rows = shown.map((f) => {
      const report = byObject.get(f.objectName) || byFileName.get(f.displayName);
      const [typeLabel, chipClass] = report ? (TYPE_META[report.report_type] || ['File', '']) : ['File', ''];
      const by = report?.uploaded_by ? (empNameById.get(report.uploaded_by) || '\u2014') : '\u2014';
      const when = f.dateIso
        ? new Date(f.dateIso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
        : '\u2014';
      return `<tr>
        <td data-label="File" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(f.displayName)}">${escapeHtml(f.displayName)}</td>
        <td data-label="Type"><span class="chip ${chipClass}" style="font-size:0.65rem;">${escapeHtml(typeLabel)}</span></td>
        <td data-label="By" class="mini-meta">${escapeHtml(by)}</td>
        <td data-label="Uploaded" class="mini-meta">${escapeHtml(when)}</td>
        <td data-label="" style="text-align:right;"><button type="button" class="ghost small" data-download-upload="${escapeHtml(f.objectName)}">\u2b07</button></td>
      </tr>`;
    }).join('');
    const more = !window._uploadedFilesShowAll && files.length > 4
      ? `<tr><td colspan="5"><button type="button" class="ghost small" data-uploads-show-all>Show ${files.length - 4} older file${files.length - 4 > 1 ? 's' : ''}</button></td></tr>`
      : '';
    listEl.innerHTML = `<table class="m-card-table" style="font-size:13px;">
      <thead><tr><th>File</th><th>Type</th><th>By</th><th>Uploaded</th><th></th></tr></thead>
      <tbody>${rows}${more}</tbody></table>`;
  };
  renderRows();
  window._renderUploadedFileRows = renderRows;
}

document.getElementById('client-analytics')?.addEventListener('click', async (e) => {
  const toggle = e.target.closest('#uploadedFilesToggle');
  if (toggle) {
    const body = document.getElementById('uploadedFilesBody');
    const chev = document.getElementById('uploadedFilesChevron');
    const open = body.style.display === 'none';
    body.style.display = open ? '' : 'none';
    if (chev) chev.textContent = open ? '\u2039' : '\u203a';
    return;
  }
  const showAll = e.target.closest('[data-uploads-show-all]');
  if (showAll) {
    window._uploadedFilesShowAll = true;
    if (window._renderUploadedFileRows) window._renderUploadedFileRows();
    return;
  }
  const dl = e.target.closest('[data-download-upload]');
  if (dl) {
    // Short-lived signed link — access stays behind Colony login.
    const { data, error } = await state.supabase.storage
      .from('client-analytics')
      .createSignedUrl(`${analyticsCurrentClientId}/${dl.dataset.downloadUpload}`, 300);
    if (error || !data?.signedUrl) { appAlert('Could not create a download link: ' + (error?.message || 'unknown error')); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }
});

// ── LinkedIn comparison selector (complete weeks only; js/analytics.js math) ──
window._liCmp = window._liCmp || { mode: 'wow', aKey: '', bKey: '' };

function cmpTilesHtml(win, metricDefs) {
  // Same boxed tiles as the Overview snapshot (.snap-kpi) — one visual
  // language for KPIs everywhere, per Alex.
  const tiles = metricDefs.map(([key, label, kind]) => {
    const aRaw = Number((win.a.totals || {})[key]) || 0;
    const bRaw = Number((win.b.totals || {})[key]) || 0;
    let value, chip;
    if (kind === 'rate') {
      value = pctAnalytics(aRaw);
      chip = trendArrowPoints(aRaw, bRaw);
    } else {
      value = fmtAnalytics(Math.round(aRaw));
      chip = trendArrow(aRaw, bRaw);
    }
    const bShown = kind === 'rate' ? pctAnalytics(bRaw) : fmtAnalytics(Math.round(bRaw));
    // "was 784" — the header sentence names the baseline window once.
    return `<div class="snap-kpi">
      <span class="snap-kpi-label">${escapeHtml(label)}</span>
      <span class="snap-kpi-value">${value}${chip || ''}</span>
      <span class="mini-meta">was ${bShown}</span>
    </div>`;
  }).join('');
  return `<div class="snap-kpis">${tiles}</div>`;
}

function renderLiCmp() {
  const body = document.getElementById('liCmpBody');
  if (!body) return;
  const weekly = (window._analyticsReports || {}).content?.metrics_data || [];
  if (!weekly.length) { body.innerHTML = ''; return; }
  const todayIso = toISODateLocal();
  const cmp = window._liCmp;
  // Custom mode: seed the picks with real weeks. An empty state behind a
  // <select> is a lie — the browser DISPLAYS the first option while the app
  // holds '', so it looked selected but said "pick two weeks" (Vera's
  // bug: she changed A, never touched B, and nothing rendered).
  if (cmp.mode === 'custom' && weekly.length) {
    const valid = (k) => weekly.some(r => r.week === k);
    if (!valid(cmp.aKey)) cmp.aKey = weekly[weekly.length - 1].week;
    if (!valid(cmp.bKey)) cmp.bKey = weekly.length > 1 ? weekly[weekly.length - 2].week : cmp.aKey;
  }
  const MODES = [['wow', 'Last week vs previous'], ['wo4', 'vs 4-week average'], ['mom', 'Month vs month'], ['custom', 'Custom weeks']];
  const chips = MODES.map(([m, l]) =>
    `<button type="button" class="chip${cmp.mode === m ? ' approved' : ''}" data-li-cmp-mode="${m}">${l}</button>`).join(' ');
  const weekOpts = (sel) => weekly.slice().reverse().map(r =>
    `<option value="${escapeHtml(r.week)}"${r.week === sel ? ' selected' : ''}>${escapeHtml(weekRangeLabel(r.week))}</option>`).join('');
  const customSel = cmp.mode === 'custom' ? `
    <span class="mini-meta">A <select data-li-cmp-week="aKey" style="width:auto;display:inline-block">${weekOpts(cmp.aKey)}</select>
    vs B <select data-li-cmp-week="bKey" style="width:auto;display:inline-block">${weekOpts(cmp.bKey)}</select></span>` : '';

  const win = liComparisonWindows(weekly, cmp.mode, todayIso, cmp.aKey, cmp.bKey);
  const METRICS = [
    ['Impressions (organic)', 'Impressions', 'count'],
    ['Engagement rate (total)', 'Engagement Rate', 'rate'],
    ['Clicks (total)', 'Clicks', 'count'],
    ['Reactions (total)', 'Reactions', 'count'],
    ['Comments (total)', 'Comments', 'count'],
    ['Posts', 'Posts', 'count']
  ];
  const content = win
    ? `<div class="analytics-kpi-period"><strong>${escapeHtml(win.a.label)}</strong> vs ${escapeHtml(win.b.label)}</div>${cmpTilesHtml(win, METRICS)}${buildInsightsBanner('comparison-li', 'AI summary of this comparison', 'LinkedIn insights')}`
    : (cmp.mode === 'custom'
      ? '<p class="mini-meta">Pick two weeks to compare.</p>'
      : '<p class="mini-meta">Not enough complete weeks for this comparison yet.</p>');
  body.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px">${chips}${customSel}</div>${content}`;
}

// ── Community Pulse comparison (send-based: last vs previous send) ──
window._cpCmp = window._cpCmp || { mode: 'prev' };

function renderCpCmp() {
  const body = document.getElementById('cpCmpBody');
  if (!body) return;
  const sends = ((window._analyticsReports || {}).community_pulse?.metrics_data || []).slice()
    .sort((x, y) => String(x.date).localeCompare(String(y.date)));
  if (sends.length < 2) { body.innerHTML = ''; return; }
  const cmp = window._cpCmp;
  const last = sends[sends.length - 1];
  let base = sends[sends.length - 2];
  if (cmp.mode === 'type') {
    base = [...sends.slice(0, -1)].reverse().find(r => r.send_type === last.send_type) || null;
  }
  const MODES = [['prev', 'Last send vs previous'], ['type', `vs previous ${escapeHtml(last.send_type || 'same type')}`]];
  const chips = MODES.map(([m, l]) =>
    `<button type="button" class="chip${cmp.mode === m ? ' approved' : ''}" data-cp-cmp-mode="${m}">${l}</button>`).join(' ');
  let content;
  if (!base) {
    content = `<p class="mini-meta">No earlier ${escapeHtml(last.send_type || '')} send to compare against.</p>`;
  } else {
    const win = {
      a: { label: `"${last.name}" (${last.date})`, totals: last },
      b: { label: `"${base.name}" (${base.date})`, totals: base }
    };
    const METRICS = [
      ['delivered', 'Delivered', 'count'],
      ['open_rate', 'Open Rate', 'rate'],
      ['click_rate', 'Click Rate', 'rate'],
      ['unsubscribed', 'Unsubs', 'count']
    ];
    content = `<div class="analytics-kpi-period"><strong>${escapeHtml(win.a.label)}</strong> vs ${escapeHtml(win.b.label)}</div>${cmpTilesHtml(win, METRICS)}${buildInsightsBanner('comparison-cp', 'AI summary of this comparison', 'Community insights')}`;
  }
  body.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px">${chips}</div>${content}`;
}

document.getElementById('client-analytics')?.addEventListener('click', (e) => {
  const li = e.target.closest('[data-li-cmp-mode]');
  if (li) { window._liCmp.mode = li.dataset.liCmpMode; renderLiCmp(); return; }
  const cp = e.target.closest('[data-cp-cmp-mode]');
  if (cp) { window._cpCmp.mode = cp.dataset.cpCmpMode; renderCpCmp(); }
});
document.getElementById('client-analytics')?.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-li-cmp-week]');
  if (sel) { window._liCmp[sel.dataset.liCmpWeek] = sel.value; renderLiCmp(); }
});

// ── Instagram comparison state + rendering ──
// Facebook: page-level daily metrics only (10 Sep 2026). Meta's
// per-metric CSVs carry no page name and no posts, and Example Collective's post
// export came back with a header and zero rows — so a KPI header or a posts
// table here would be inventing numbers. Account Trends is the whole tab, and
// it is the same surface Instagram uses rather than a near-copy.
// No AI insights banner yet: the generator branches by report type and has no
// Facebook branch, so the button would fire a request shaped for another
// platform. Better an honest gap than a control that misbehaves.
function renderFacebookTab(facebookReport) {
  const panel = document.getElementById('analyticsTabFacebook');
  if (!panel) return;

  if (!facebookReport) {
    panel.innerHTML = `
      <div class="analytics-empty">
        <div class="analytics-empty-icon">📘</div>
        <p>No Facebook report uploaded yet.</p>
        ${canUploadAnalytics() ? '<p class="mini-meta">Upload the per-metric CSVs from Meta Business Suite — Follows, Visits, Link clicks, Content interactions, Viewers.</p>' : ''}
      </div>`;
    window._metricsDailyBySurface.facebook = [];
    return;
  }

  const daily = Array.isArray(facebookReport.metrics_data) ? facebookReport.metrics_data : [];
  const metricKeys = [...new Set(daily.flatMap(r => Object.keys(r)))].filter(k => k !== 'date').sort();
  window._metricsDailyBySurface.facebook = daily;

  if (!metricKeys.length) {
    panel.innerHTML = `
      <div class="analytics-empty">
        <div class="analytics-empty-icon">📘</div>
        <p>This Facebook report has no daily figures in it yet.</p>
      </div>`;
    delete panel.dataset.chartsPending;
    return;
  }

  const first = daily[0]?.date || '';
  const last = daily[daily.length - 1]?.date || '';
  panel.innerHTML = `
    <div class="screen-head-top" style="margin-bottom:var(--space-3)">
      <div>
        <h3 style="margin:0">Facebook page</h3>
        <p class="mini-meta" style="margin:2px 0 0">${escapeHtml(first)} – ${escapeHtml(last)} · ${daily.length} days</p>
      </div>
    </div>
    <section style="margin-top:var(--space-5)">
      <h3 style="margin-bottom:var(--space-3)">Page Trends</h3>
      <div id="fbTrendsBody"></div>
    </section>`;

  // Same visibility rule as Instagram: Chart.js cannot size a canvas inside a
  // display:none panel, so a hidden tab defers to the tab-switch handler.
  renderIgTrends('facebook');
  if (panel.classList.contains('active')) buildIgMetricCharts('facebook');
  else panel.dataset.chartsPending = '1';
}

// Modes: wow (last full week vs previous), wo4 (vs 4-week average),
// mom (last full month vs previous), custom (pick two weeks), all (history).
window._igCmp = window._igCmp || { mode: 'wow', customA: '', customB: '' };

// Instagram and Facebook produce the same daily-metric shape from the same
// Meta screen, so they get the same Account Trends surface rather than two
// half-matching copies. Everything below takes a surface key; Instagram stays
// the default so the existing callers (AI insights, export) read unchanged.
// _igCmp IS the instagram entry — same object, so its in-place mutations and
// every existing `window._igCmp.mode` reference keep working.
const METRIC_SURFACES = {
  instagram: { key: 'instagram', label: 'Instagram', panelId: 'analyticsTabInstagram', bodyId: 'igTrendsBody', chartPrefix: 'chartIgMetric_', cmpChartPrefix: 'chartIgCmp_' },
  facebook: { key: 'facebook', label: 'Facebook', panelId: 'analyticsTabFacebook', bodyId: 'fbTrendsBody', chartPrefix: 'chartFbMetric_', cmpChartPrefix: 'chartFbCmp_' }
};
window._metricsDailyBySurface = window._metricsDailyBySurface || {};
window._metricsCmpBySurface = window._metricsCmpBySurface || {};
window._metricsCmpBySurface.instagram = window._igCmp;
window._metricsCmpBySurface.facebook = window._metricsCmpBySurface.facebook
  || { mode: 'wow', customA: '', customB: '' };

function metricSurface(key) { return METRIC_SURFACES[key] || METRIC_SURFACES.instagram; }
function metricSurfaceDaily(key) { return window._metricsDailyBySurface[metricSurface(key).key] || []; }
function metricSurfaceCmp(key) { return window._metricsCmpBySurface[metricSurface(key).key]; }

function igActiveComparison(surfaceKey = 'instagram') {
  const daily = metricSurfaceDaily(surfaceKey);
  const cmp = metricSurfaceCmp(surfaceKey);
  if (cmp.mode === 'all') return null;
  if (cmp.mode === 'custom') {
    return (cmp.customA && cmp.customB) ? igCustomWeekWindows(daily, cmp.customA, cmp.customB) : null;
  }
  return igComparisonWindows(daily, cmp.mode);
}

function renderIgTrends(surfaceKey = 'instagram') {
  const surface = metricSurface(surfaceKey);
  const body = document.getElementById(surface.bodyId);
  const daily = metricSurfaceDaily(surface.key);
  if (!body || !daily.length) return;
  const cmp = metricSurfaceCmp(surface.key);
  const metricKeys = [...new Set(daily.flatMap(r => Object.keys(r)))].filter(k => k !== 'date').sort();
  const prettyMetric = (k) => k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const fmt = (n) => fmtAnalytics(Math.round(Number(n) || 0));

  const MODES = [
    ['wow', 'Last week vs previous'],
    ['wo4', 'vs 4-week average'],
    ['mom', 'Month vs month'],
    ['custom', 'Custom weeks'],
    ['all', 'All time']
  ];
  const chips = MODES.map(([m, label]) =>
    `<button type="button" class="chip${cmp.mode === m ? ' approved' : ''}" data-ig-cmp-mode="${m}" data-cmp-surface="${surface.key}">${label}</button>`).join(' ');
  const customInputs = cmp.mode === 'custom' ? `
    <span class="mini-meta" style="margin-left:8px">Pick any date in each week (snapped to Mon–Sun):
      A <input type="date" data-ig-cmp-date="customA" data-cmp-surface="${surface.key}" value="${escapeHtml(cmp.customA)}" style="width:auto;display:inline-block">
      vs B <input type="date" data-ig-cmp-date="customB" data-cmp-surface="${surface.key}" value="${escapeHtml(cmp.customB)}" style="width:auto;display:inline-block">
    </span>` : '';

  const win = igActiveComparison(surface.key);

  let content;
  if (cmp.mode === 'all' || (!win && cmp.mode !== 'custom')) {
    // Full-history charts (the old view). Also the honest fallback when a
    // preset can't be computed from the history on record.
    const insufficient = cmp.mode !== 'all'
      ? '<p class="mini-meta">Not enough history for this comparison yet — showing all time.</p>' : '';
    const cards = metricKeys.map(k => {
      const total = daily.reduce((s, r) => s + (Number(r[k]) || 0), 0);
      return `<div class="analytics-chart-card panel">
        <h4>${escapeHtml(prettyMetric(k))} <span class="mini-meta">· ${fmt(total)} total</span></h4>
        <canvas id="${surface.chartPrefix}${escapeHtml(k)}"></canvas>
      </div>`;
    });
    content = insufficient + Array.from({ length: Math.ceil(cards.length / 2) }, (_, i) =>
      `<div class="analytics-charts-row">${cards.slice(i * 2, i * 2 + 2).join('')}</div>`).join('');
  } else if (!win) {
    content = '<p class="mini-meta">Pick a date in each of the two weeks to compare.</p>';
  } else {
    const tiles = metricKeys.map(k => {
      const aVal = win.a.totals[k] || 0;
      const bVal = win.b.totals[k] || 0;
      const delta = pctDeltaLabel(aVal, bVal);
      const chip = delta
        ? `<span class="${aVal >= bVal ? 'trend-up' : 'trend-down'}">${aVal >= bVal ? '↑' : '↓'} ${delta.slice(1)}</span>`
        : (aVal > 0 && bVal === 0 ? '<span class="trend-up">new</span>' : '<span class="mini-meta">flat</span>');
      return `<div class="snap-kpi">
        <span class="snap-kpi-label">${escapeHtml(prettyMetric(k))}</span>
        <span class="snap-kpi-value">${fmt(aVal)} ${chip}</span>
        <span class="mini-meta">was ${fmt(bVal)}</span>
      </div>`;
    }).join('');
    const cards = metricKeys.map(k => `
      <div class="analytics-chart-card panel">
        <h4>${escapeHtml(prettyMetric(k))}</h4>
        <canvas id="${surface.cmpChartPrefix}${escapeHtml(k)}"></canvas>
      </div>`);
    content = `
      <p class="mini-meta" style="margin:4px 0 10px"><strong>${escapeHtml(win.a.label)}</strong> vs ${escapeHtml(win.b.label)}</p>
      <div class="snap-kpis">${tiles}</div>
      ${Array.from({ length: Math.ceil(cards.length / 2) }, (_, i) =>
        `<div class="analytics-charts-row">${cards.slice(i * 2, i * 2 + 2).join('')}</div>`).join('')}`;
  }

  body.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px">${chips}${customInputs}</div>${content}`;
}

// Delegated: comparison mode switches + custom week picks.
document.getElementById('client-analytics')?.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-ig-cmp-mode]');
  if (!chip) return;
  const key = chip.dataset.cmpSurface || 'instagram';
  metricSurfaceCmp(key).mode = chip.dataset.igCmpMode;
  renderIgTrends(key);
  buildIgMetricCharts(key);
});
document.getElementById('client-analytics')?.addEventListener('change', (e) => {
  const input = e.target.closest('[data-ig-cmp-date]');
  if (!input) return;
  const key = input.dataset.cmpSurface || 'instagram';
  metricSurfaceCmp(key)[input.dataset.igCmpDate] = input.value;
  renderIgTrends(key);
  buildIgMetricCharts(key);
});

// Builds whichever chart set the current comparison mode rendered: overlay
// charts (A solid, B ghost) for comparisons, full-history lines for All time.
// Mode switches re-render in place, so IG charts are tracked separately and
// destroyed before each rebuild (the global list only clears on screen load).
window._igChartInstances = window._igChartInstances || [];
window._metricChartsBySurface = window._metricChartsBySurface || {};
function buildIgMetricCharts(surfaceKey = 'instagram') {
  const surface = metricSurface(surfaceKey);
  const panel = document.getElementById(surface.panelId);
  const daily = metricSurfaceDaily(surface.key);
  if (!panel || !daily.length || typeof Chart === 'undefined') return;
  delete panel.dataset.chartsPending;
  // Tracked per surface: destroying Instagram's charts when Facebook rebuilds
  // would leave Instagram's canvases blank until its tab re-rendered.
  const live = window._metricChartsBySurface[surface.key] || [];
  live.forEach(c => { try { c.destroy(); } catch (e) { /* already gone */ } });
  window._metricChartsBySurface[surface.key] = [];
  if (surface.key === 'instagram') window._igChartInstances = window._metricChartsBySurface.instagram;

  const metricKeys = [...new Set(daily.flatMap(r => Object.keys(r)))].filter(k => k !== 'date').sort();
  const colors = getChartThemeColors();
  const chartFont = { family: "'Manrope', 'Avenir Next', sans-serif", size: 11 };
  const axT = (text) => ({ display: true, text, color: colors.text, font: chartFont });
  const prettyMetric = (k) => k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const baseOpts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { grid: { display: false }, ticks: { font: chartFont, color: colors.muted, maxTicksLimit: 8, maxRotation: 45 } },
      y: { grid: { color: colors.line }, ticks: { font: chartFont, color: colors.muted }, beginAtZero: true }
    }
  };
  // Every chart says what it measures on both axes.
  const optsFor = (xTitle, yTitle, extra) => ({ ...baseOpts, ...extra,
    scales: { x: { ...baseOpts.scales.x, title: axT(xTitle) }, y: { ...baseOpts.scales.y, title: axT(yTitle) } } });
  const track = (chart) => { window._metricChartsBySurface[surface.key].push(chart); _analyticsChartInstances.push(chart); };

  const win = igActiveComparison(surface.key);
  if (win) {
    // Overlay: align by day index. Weeks align Mon–Sun; months by day-of-month.
    const dayLabels = win.a.rows.map(r => {
      const d = new Date(String(r.date).slice(0, 10) + 'T00:00:00');
      return isNaN(d) ? String(r.date) : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' });
    });
    metricKeys.forEach(k => {
      const canvas = document.getElementById(`${surface.cmpChartPrefix}${k}`);
      if (!canvas) return;
      const aData = win.a.rows.map(r => Number(r[k]) || 0);
      // Average baselines have totals but no single week of rows — draw them as
      // a flat per-day reference line rather than pretending a daily shape.
      const bData = win.b.rows
        ? win.a.rows.map((_, i) => Number((win.b.rows[i] || {})[k]) || 0)
        : win.a.rows.map(() => (win.b.totals[k] || 0) / Math.max(1, win.a.rows.length));
      const chart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: dayLabels,
          datasets: [
            { label: win.a.label, data: aData, borderColor: colors.primary, backgroundColor: colors.primarySoft,
              fill: true, tension: 0.3, pointRadius: 2, pointHoverRadius: 5, borderWidth: 2 },
            { label: win.b.label, data: bData, borderColor: colors.muted, backgroundColor: 'transparent',
              fill: false, tension: 0.3, pointRadius: 0, pointHoverRadius: 4, borderWidth: 1.5, borderDash: [5, 4] }
          ]
        },
        options: optsFor('Day', prettyMetric(k), { plugins: { valueLabels: { fmt: 'compact', datasetIndex: 0 }, legend: { display: true, labels: { font: chartFont, color: colors.muted, boxWidth: 18 } } } })
      });
      track(chart);
    });
    return;
  }

  // All-time history (also the insufficient-history fallback)
  const recent = daily.slice(-90);
  const labels = recent.map(r => {
    const d = new Date(String(r.date).slice(0, 10) + 'T00:00:00');
    return isNaN(d) ? String(r.date) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  });
  metricKeys.forEach(k => {
    const canvas = document.getElementById(`${surface.chartPrefix}${k}`);
    if (!canvas) return;
    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: recent.map(r => Number(r[k]) || 0),
          borderColor: colors.primary,
          backgroundColor: colors.primarySoft,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          borderWidth: 2
        }]
      },
      options: optsFor('Date', prettyMetric(k), { plugins: { legend: { display: false } } })
    });
    track(chart);
  });
}

// --- Community Pulse tab ---
// Newsletter/dispatch/survey sends + subscriber and forum community data from
// the LeadConnector comms workbook (report_type 'community_pulse').
function renderAnalyticsCommunity(report) {
  const panel = document.getElementById('analyticsTabCommunity');
  if (!panel) return;

  if (!report) {
    panel.innerHTML = `
      <div class="analytics-empty">
        <div class="analytics-empty-icon">📬</div>
        <p>No community data uploaded yet.</p>
        ${canUploadAnalytics() ? '<p class="mini-meta">Upload the comms workbook (the one with the "NewslettersAll…" per-send stats sheet, subscriber list, and forum roster) to see newsletter and community analytics.</p>' : ''}
      </div>`;
    return;
  }

  const s = report.summary || {};
  const sends = Array.isArray(report.metrics_data) ? report.metrics_data : [];
  const demo = report.demographics_data || {};
  const fmt = (n) => Number(n || 0).toLocaleString();
  const pct = (f) => `${((f || 0) * 100).toFixed(1)}%`;
  const fmtDate = (iso) => {
    if (!iso) return '–';
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    return isNaN(d) ? String(iso) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  };
  const typeChip = (t) => {
    const cls = t === 'Dispatches' ? 'approved' : t === 'Survey' ? 'info' : 'pending';
    return `<span class="chip ${cls}">${escapeHtml(t || 'Send')}</span>`;
  };

  const periodLabel = s.date_from && s.date_to ? `${fmtDate(s.date_from)} – ${fmtDate(s.date_to)}` : '';

  const byTypeRows = Object.entries(s.by_type || {}).map(([t, v]) =>
    `<tr><td data-label="Type">${typeChip(t)}</td><td data-label="Sends" style="text-align:right">${v.sends}</td><td data-label="Open rate" style="text-align:right">${pct(v.open_rate)}</td><td data-label="Click rate" style="text-align:right">${pct(v.click_rate)}</td></tr>`
  ).join('');

  const sendRows = sends.slice().reverse().map(r => `<tr>
    <td data-label="Date" class="mini-meta">${fmtDate(r.date)}</td>
    <td data-label="Send">${escapeHtml(r.name || '')}</td>
    <td data-label="Type">${typeChip(r.send_type)}</td>
    <td data-label="Delivered" style="text-align:right">${fmt(r.delivered)}</td>
    <td data-label="Open rate" style="text-align:right">${pct(r.open_rate)}</td>
    <td data-label="Click rate" style="text-align:right">${pct(r.click_rate)}</td>
    <td data-label="Unsubs" style="text-align:right">${fmt(r.unsubscribed)}</td>
  </tr>`).join('');

  const segTable = (title, list) => (list && list.length) ? `
    <div class="analytics-chart-card panel">
      <h4>${escapeHtml(title)}</h4>
      <table class="m-card-table"><tbody>
        ${list.slice(0, 8).map(x => `<tr><td>${escapeHtml(x.name)}</td><td style="text-align:right">${fmt(x.count)}</td></tr>`).join('')}
      </tbody></table>
    </div>` : '';

  panel.innerHTML = `
    ${periodLabel ? `<div class="analytics-kpi-period">${escapeHtml(periodLabel)} · ${fmt(s.total_sends)} sends</div>` : ''}
    <div class="analytics-overview-kpi">
      <div class="analytics-kpi-card"><div class="analytics-kpi-label">Subscribers</div><div class="analytics-kpi-value">${fmt(s.subscribers)}</div></div>
      <div class="analytics-kpi-card"><div class="analytics-kpi-label">Forum Members</div><div class="analytics-kpi-value">${fmt(s.forum_members)}</div></div>
      <div class="analytics-kpi-card"><div class="analytics-kpi-label">Open Rate</div><div class="analytics-kpi-value">${pct(s.open_rate)}</div></div>
      <div class="analytics-kpi-card"><div class="analytics-kpi-label">Click Rate</div><div class="analytics-kpi-value">${pct(s.click_rate)}</div></div>
    </div>

    <div id="cpCmpBody" style="margin-top:var(--space-4)"></div>
    ${buildInsightsBanner('community_pulse', 'Movement lens: attention vs participation', 'Community pulse')}

    <section class="panel" style="margin-top:var(--space-5)">
      <h3>Performance by Send Type</h3>
      <table class="m-card-table">
        <thead><tr><th>Type</th><th style="text-align:right">Sends</th><th style="text-align:right">Open rate</th><th style="text-align:right">Click rate</th></tr></thead>
        <tbody>${byTypeRows}</tbody>
      </table>
    </section>

    <section class="panel" style="margin-top:var(--space-5)">
      <h3>Sends</h3>
      <table class="analytics-post-table">
        <thead><tr><th>Date</th><th>Send</th><th>Type</th><th style="text-align:right">Delivered</th><th style="text-align:right">Open rate</th><th style="text-align:right">Click rate</th><th style="text-align:right">Unsubs</th></tr></thead>
        <tbody>${sendRows}</tbody>
      </table>
    </section>

    <div class="analytics-charts-row" style="margin-top:var(--space-5)">
      ${segTable('Subscribers by Region', demo.subscribers?.by_region)}
      ${segTable('Forum: Domain of Work', demo.forum?.by_domain)}
    </div>
    <div class="analytics-charts-row">
      ${segTable('Subscribers by Country', demo.subscribers?.by_country)}
      ${segTable('Forum by Region', demo.forum?.by_region)}
    </div>
  `;
  renderCpCmp();
}

function getClientName() {
  const c = state.clients?.find(c => String(c.id) === String(analyticsCurrentClientId));
  return c?.name || 'this client';
}

function renderPostTable(posts, sortKey) {
  const container = document.getElementById('analyticsPostTableContainer');
  if (!container) return;

  let sorted;
  if (sortKey === 'Created date') {
    // Date sort — most recent first
    sorted = [...posts].sort((a, b) => {
      const da = new Date(normalizeDateStr(a['Created date'] || a['Date'] || ''));
      const db = new Date(normalizeDateStr(b['Created date'] || b['Date'] || ''));
      return (db.getTime() || 0) - (da.getTime() || 0);
    });
  } else {
    sorted = [...posts].sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));
  }
  const topPostIndex = 0; // first after sort = top

  window._analyticsSortedPosts = sorted; // for the per-post ✦ analysis buttons

  container.innerHTML = `<table class="analytics-post-table">
    <thead><tr>
      <th>Title</th><th>Date</th><th>Type</th><th style="text-align:right">Impressions</th>
      <th style="text-align:right">Clicks</th><th style="text-align:right">Eng. Rate</th><th></th>
    </tr></thead>
    <tbody>${sorted.map((p, i) => {
      const title = (p['Post title'] || '').substring(0, 60);
      const contentType = p['Content Type'] || 'Post';
      const engRate = Number(p['Engagement rate']) || 0;
      const engClass = engRate >= 0.20 ? 'eng-high' : engRate >= 0.10 ? 'eng-good' : engRate >= 0.07 ? 'eng-ok' : 'eng-low';
      const isTop = i === topPostIndex;
      const postDate = new Date(normalizeDateStr(p['Created date'] || p['Date'] || ''));
      const postDateStr = !isNaN(postDate) ? postDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '–';

      return `<tr class="post-table-row${isTop ? ' top-post' : ''}">
        <td data-label="Title">
          ${isTop ? '<span class="chip approved" style="font-size:0.65rem;padding:1px 6px;margin-right:4px">TOP</span>' : ''}
          ${p['Post link'] ? `<a href="${escapeHtml(p['Post link'])}" target="_blank" rel="noopener">${escapeHtml(title)}</a>` : escapeHtml(title)}
        </td>
        <td data-label="Date" class="mini-meta">${postDateStr}</td>
        <td data-label="Type"><span class="chip">${escapeHtml(contentType)}</span></td>
        <td data-label="Impressions" style="text-align:right">${fmtAnalytics(p['Impressions'] || 0)}</td>
        <td data-label="Clicks" style="text-align:right">${fmtAnalytics(p['Clicks'] || 0)}</td>
        <td data-label="Eng. Rate" style="text-align:right"><span class="${engClass}">${pctAnalytics(engRate)}</span></td>
        <td data-label="" style="text-align:right"><button class="ghost small post-insight-btn" type="button" data-post-index="${i}" title="AI analysis: this post vs ${escapeHtml(getClientName())}'s benchmarks">✦</button></td>
      </tr>
      <tr class="post-insight-row" id="post-insight-row-${i}" style="display:none">
        <td colspan="7"><div class="post-insight-cell" data-insights-label="post">
          <div class="post-insight-content insights-banner-content"></div>
        </div></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function renderContentTypeChart(posts) {
  const canvas = document.getElementById('chartContentTypeEng');
  if (!canvas || typeof Chart === 'undefined') return;

  // Group by content type
  const typeMap = new Map();
  posts.forEach(p => {
    // LinkedIn's export only tags 'Video'; images, text, carousels and
    // documents all arrive BLANK — the export cannot tell them apart, so the
    // bucket must not pretend otherwise.
    const ct = p['Content Type'] || 'Other (image/text/carousel)';
    if (!typeMap.has(ct)) typeMap.set(ct, { sum: 0, count: 0 });
    const entry = typeMap.get(ct);
    entry.sum += Number(p['Engagement rate']) || 0;
    entry.count++;
  });

  const types = [...typeMap.entries()].map(([name, data]) => ({
    name,
    avg: data.count > 0 ? (data.sum / data.count) * 100 : 0
  })).sort((a, b) => b.avg - a.avg);

  const colors = getChartThemeColors();
  const chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: types.map(t => t.name),
      datasets: [{
        data: types.map(t => t.avg.toFixed(1)),
        backgroundColor: types.map((_, i) => i === 0 ? colors.good : colors.primary),
        borderRadius: 4,
        barPercentage: 0.6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: { valueLabels: { fmt: (v) => v.toFixed(1) + '%' }, legend: { display: false } },
      scales: {
        x: { grid: { color: colors.line }, ticks: { callback: v => v + '%', color: colors.muted },
             title: { display: true, text: 'Avg engagement rate (%)', color: colors.muted } },
        y: { grid: { display: false }, ticks: { color: colors.text },
             title: { display: true, text: 'Post type', color: colors.muted } }
      }
    }
  });
  _analyticsChartInstances.push(chart);
}

function renderPatternCards(posts) {
  const container = document.getElementById('patternCardsContainer');
  if (!container || !posts.length) return;

  // Patterns from a handful of posts are noise dressed as insight ("Mondays
  // get more engagement" off 2 posts) — refuse below a minimum sample.
  const MIN_PATTERN_POSTS = 5;
  if (posts.length < MIN_PATTERN_POSTS) {
    container.innerHTML = `<p class="mini-meta">Pattern analysis needs at least ${MIN_PATTERN_POSTS} posts in view — only ${posts.length} right now. Switch to "Show all posts" or wait for more data.</p>`;
    return;
  }

  // Pattern 1: Best content type
  const typeMap = new Map();
  posts.forEach(p => {
    const ct = p['Content Type'] || 'Post';
    if (!typeMap.has(ct)) typeMap.set(ct, { engSum: 0, count: 0 });
    const e = typeMap.get(ct);
    e.engSum += Number(p['Engagement rate']) || 0;
    e.count++;
  });
  const bestType = [...typeMap.entries()]
    .map(([name, d]) => ({ name, avg: d.count ? d.engSum / d.count : 0, count: d.count }))
    .sort((a, b) => b.avg - a.avg)[0];

  // Pattern 2: Best posting day
  const dayMap = new Map();
  posts.forEach(p => {
    let cd = p['Created date'];
    if (!cd) return;
    if (typeof cd === 'number') cd = new Date((cd - 25569) * 86400 * 1000);
    else {
      const s = String(cd).trim();
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      cd = m ? new Date(m[3], m[1] - 1, m[2]) : new Date(s);
    }
    if (!(cd instanceof Date) || isNaN(cd.getTime())) return;
    const dayName = cd.toLocaleDateString('en-US', { weekday: 'long' });
    if (!dayMap.has(dayName)) dayMap.set(dayName, { engSum: 0, count: 0 });
    const e = dayMap.get(dayName);
    e.engSum += Number(p['Engagement rate']) || 0;
    e.count++;
  });
  const bestDay = [...dayMap.entries()]
    .map(([name, d]) => ({ name, avg: d.count ? d.engSum / d.count : 0, count: d.count }))
    .filter(d => d.count >= 2)
    .sort((a, b) => b.avg - a.avg)[0];

  // Pattern 3: High performer count
  const highPerformers = posts.filter(p => (Number(p['Engagement rate']) || 0) >= 0.10).length;
  const highPct = ((highPerformers / posts.length) * 100).toFixed(0);

  // Pattern 4: Consistency
  const avgEng = posts.reduce((s, p) => s + (Number(p['Engagement rate']) || 0), 0) / posts.length;

  const patterns = [
    { emoji: '🎬', label: `${bestType?.name || 'Posts'} perform best`, note: `${pctAnalytics(bestType?.avg || 0)} avg engagement across ${bestType?.count || 0} posts` },
    { emoji: '📅', label: bestDay ? `${bestDay.name}s get more engagement` : 'Post more consistently', note: bestDay ? `${pctAnalytics(bestDay.avg)} avg on ${bestDay.name}s (${bestDay.count} posts)` : 'Not enough data to determine best day' },
    { emoji: '🔥', label: `${highPct}% are high performers`, note: `${highPerformers} of ${posts.length} posts hit ≥10% engagement` },
    { emoji: '📊', label: `${pctAnalytics(avgEng)} overall engagement`, note: `Across ${posts.length} total posts in this period` },
  ];

  container.innerHTML = `<div class="pattern-cards">
    ${patterns.map(p => `<div class="pattern-card">
      <span class="pattern-emoji">${p.emoji}</span>
      <div class="pattern-label">${escapeHtml(p.label)}</div>
      <div class="pattern-note mini-meta">${escapeHtml(p.note)}</div>
    </div>`).join('')}
  </div>`;
}

// --- Insights banner (collapsible) ---
function buildInsightsBanner(type, previewText, label) {
  const id = `insights-banner-${type}`;
  return `<div class="insights-banner" id="${id}">
    <button class="insights-banner-trigger" type="button" data-insights-type="${type}">
      <span class="insights-banner-icon">✦</span>
      <span class="insights-banner-label">${escapeHtml(label || 'Insights')}</span>
      <span class="insights-banner-preview" id="${id}-preview">(${previewText || 'Click to generate analysis'})</span>
      <span class="insights-banner-chevron">›</span>
    </button>
    <div class="insights-banner-body" id="${id}-body" style="display:none">
      <div class="insights-banner-content" id="${id}-content"></div>
    </div>
  </div>`;
}


// Full report context inside the analysis window, for the AI prompts.
// The analyses should read EVERYTHING the uploaded reports can say — every
// post with full metrics, follower gains + demographics, visitor trends —
// not just aggregate weekly totals. Aggregates alone misdiagnose content-mix
// swings (real case: Example Collective's recruitment-post spike ending read as
// "reach collapsed", Jun 2026).
function buildInsightsContext(windowDays) {
  const reports = window._analyticsReports || {};
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const inWindow = (iso) => { const d = new Date(iso); return !isNaN(d) && d >= cutoff; };
  const topSeg = (list, n = 6) => (list || []).slice()
    .sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, n)
    .map(s => ({ name: s.name, count: s.count }));

  const cr = reports.content, fr = reports.followers, vr = reports.visitors;

  const posts = (cr?.posts_data || [])
    .map(p => ({
      date: normalizeDateStr(p['Created date'] || p['Date'] || ''),
      type: p['Post type'] || p['Content Type'] || '',
      title: String(p['Post title'] || '').replace(/\s+/g, ' ').trim().slice(0, 110),
      impressions: p['Impressions'] || 0,
      clicks: p['Clicks'] || 0,
      reactions: p['Likes'] || 0,
      comments: p['Comments'] || 0,
      reposts: p['Reposts'] || 0,
      engagementRate: p['Engagement rate'] || 0
    }))
    .filter(p => inWindow(p.date))
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, 80);

  const followerDaily = (fr?.metrics_data || []).filter(d => inWindow(d.date));
  const followers = fr ? {
    gainedInWindow: followerDaily.reduce((s, d) => s + (d.total || 0), 0),
    daily: followerDaily.map(d => ({ date: d.date, gained: d.total || 0 })),
    demographics: fr.demographics_data ? {
      jobFunctions: topSeg(fr.demographics_data.job_function),
      industries: topSeg(fr.demographics_data.industry),
      seniority: topSeg(fr.demographics_data.seniority),
      locations: topSeg(fr.demographics_data.location),
      companySize: topSeg(fr.demographics_data.company_size)
    } : null
  } : null;

  const visitorDaily = (vr?.visitor_metrics || []).filter(d => inWindow(d.date));
  const visitors = vr ? {
    uniqueVisitorsInWindow: visitorDaily.reduce((s, d) => s + (d.total_unique || 0), 0),
    daily: visitorDaily.map(d => ({ date: d.date, views: d.total_views || 0, unique: d.total_unique || 0 })),
    demographics: vr.demographics_data ? {
      jobFunctions: topSeg(vr.demographics_data.job_function),
      industries: topSeg(vr.demographics_data.industry),
      seniority: topSeg(vr.demographics_data.seniority)
    } : null
  } : null;

  return { posts, followers, visitors };
}

// Instagram payload: the full post export (top 80 by views) + summary.
function buildInstagramInsightsData() {
  const ig = (window._analyticsReports || {}).instagram;
  if (!ig) return null;
  return {
    summary: ig.summary || null,
    dailyMetrics: (ig.metrics_data || []).slice(-120),
    posts: (ig.posts_data || []).slice()
      .sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0))
      .slice(0, 80)
      .map(p => ({
        date: p.date || (p.publish_time ? String(p.publish_time).slice(0, 10) : ''),
        type: p.post_type || '',
        description: String(p.description || '').replace(/\s+/g, ' ').trim().slice(0, 110),
        views: p.views || 0,
        reach: p.reach || 0,
        likes: p.likes || 0,
        comments: p.comments || 0,
        saves: p.saves || 0,
        shares: p.shares || 0,
        follows: p.follows || 0,
        durationSec: p.duration_sec || 0
      }))
  };
}

// --- Insights API calls + click handling ---
// Cache is stored in DB: client_analytics.insights_cache (JSONB)
// Key format: `${type}-${viewMode}` or `post-${postIndex}-${viewMode}`
// New upload = new DB row = empty cache automatically

function getDbInsightCache(key, reportOverride) {
  const report = reportOverride || window._analyticsCurrentReport;
  if (!report || !report.insights_cache) return null;
  return report.insights_cache[key] || null;
}

async function setDbInsightCache(key, insights, reportOverride) {
  const report = reportOverride || window._analyticsCurrentReport;
  if (!report) return;
  // Update local object immediately
  if (!report.insights_cache) report.insights_cache = {};
  report.insights_cache[key] = insights;
  // Persist to DB (fire-and-forget — don't block UI)
  state.supabase
    .from('client_analytics')
    .update({ insights_cache: report.insights_cache })
    .eq('id', report.id)
    .then(({ error }) => { if (error) console.error('Failed to save insight cache:', error); });
}

async function fetchInsights(analysisType, data, clientName, extras) {
  const token = state.session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const payload = { analysisType, data, clientName };
  // Pass view mode and benchmarks when available
  if (extras) {
    if (extras.viewMode) payload.viewMode = extras.viewMode;
    if (extras.benchmarks) payload.benchmarks = extras.benchmarks;
  }

  const res = await fetch('/api/analyze-analytics', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// Delegated click handlers for insights (inside analytics screen)
const analyticsScreenEl = document.getElementById('client-analytics');
if (analyticsScreenEl) {
  analyticsScreenEl.addEventListener('click', async (e) => {
    // --- Per-post deep analysis (Post Performance tab) ---
    const postBtn = e.target.closest('.post-insight-btn');
    if (postBtn) {
      e.preventDefault();
      const idx = Number(postBtn.dataset.postIndex);
      const post = (window._analyticsSortedPosts || [])[idx];
      const row = document.getElementById(`post-insight-row-${idx}`);
      const cell = row?.querySelector('.post-insight-cell');
      if (!post || !row || !cell) return;
      if (row.style.display !== 'none') { row.style.display = 'none'; return; }
      row.style.display = '';

      // Stable per-post cache key: the post link's ID, else date + title stub
      const linkKey = String(post['Post link'] || '').split('/').filter(Boolean).pop() || '';
      const stableKey = linkKey || `${normalizeDateStr(post['Created date'] || '')}-${String(post['Post title'] || '').slice(0, 24)}`;
      const postCacheKey = `post-${stableKey}-organic-v1`;
      const contentEl = cell.querySelector('.post-insight-content');
      const showResult = (text) => {
        contentEl.innerHTML = formatInsightsText(text);
      };
      const postCached = getDbInsightCache(postCacheKey);
      if (postCached) { showResult(postCached); return; }

      contentEl.innerHTML = '<div class="insights-loading"><span class="insights-spinner"></span> Analyzing vs benchmarks...</div>';
      try {
        // Benchmarks: this client's posts of the same channel (Post type)
        const all = (window._analyticsReports?.content?.posts_data || [])
          .filter(p => (p['Post type'] || '') === (post['Post type'] || ''));
        const imprs = all.map(p => p['Impressions'] || 0);
        const totalImpr = imprs.reduce((s, v) => s + v, 0);
        const benchmarks = all.length ? {
          avgImpressions: totalImpr / all.length,
          avgEngRate: all.reduce((s, p) => s + (p['Engagement rate'] || 0), 0) / all.length,
          avgCTR: totalImpr > 0 ? ((all.reduce((s, p) => s + (p['Clicks'] || 0), 0) / totalImpr) * 100).toFixed(2) : '0.00',
          totalPosts: all.length,
          maxImpressions: Math.max(...imprs),
          minImpressions: Math.min(...imprs)
        } : null;
        const result = await fetchInsights('post', post, getClientName(), { viewMode: 'organic', benchmarks });
        await setDbInsightCache(postCacheKey, result.insights);
        showResult(result.insights);
      } catch (err) {
        console.error('Post insight error:', err);
        contentEl.innerHTML = `<div class="insights-error">Could not generate insights. ${escapeHtml(err.message)}</div>`;
      }
      return;
    }

    // --- Banner trigger click ---
    const trigger = e.target.closest('.insights-banner-trigger');
    if (trigger) {
      e.preventDefault();
      e.stopPropagation();
      const type = trigger.dataset.insightsType; // 'monthly' or 'weekly'
      const banner = trigger.closest('.insights-banner');
      const body = banner.querySelector('.insights-banner-body');
      const content = banner.querySelector('.insights-banner-content');
      const chevron = banner.querySelector('.insights-banner-chevron');

      // Toggle if already loaded
      if (body.style.display !== 'none') {
        body.style.display = 'none';
        chevron.textContent = '›';
        banner.classList.remove('open');
        return;
      }

      body.style.display = 'block';
      chevron.textContent = '‹';
      banner.classList.add('open');

      // Check DB-persisted cache. Version bumps force regeneration when the
      // payload gets richer: v4 weekly/monthly + v3 brand-signal = full report
      // context (all posts, followers, visitors); instagram v1 = new analysis.
      const vm = 'organic';
      // Bumped 23 Jul 2026: cached insights predate the skimmable-format contract
      const CACHE_VER = { weekly: 'v7', monthly: 'v7', 'brand-signal': 'v8', instagram: 'v6', community_pulse: 'v3', 'comparison-li': 'v2', 'comparison-cp': 'v1' };
      // Instagram insights are PER COMPARISON (the summary of what's on
      // screen, not a fixed whole-file retrospective) — so the active
      // comparison window is part of the cache key. Presets therefore cache
      // once per upload; changing the comparison generates for that view.
      const igCmpSuffix = type === 'instagram'
        ? `-${window._igCmp?.mode || 'all'}${(() => { const w = igActiveComparison(); return w ? `-${w.a.startIso}-${w.b.startIso || 'avg'}` : ''; })()}`
        : type === 'comparison-li'
        ? `-${window._liCmp?.mode}-${window._liCmp?.aKey || 'auto'}`
        : type === 'comparison-cp'
        ? `-${window._cpCmp?.mode}`
        : '';
      const cacheKey = `${type}-${vm}-${CACHE_VER[type] || 'v2'}${igCmpSuffix}`;
      // Instagram/community insights cache on their own report rows (there may
      // be no content report for e.g. IG-only clients like Example Records).
      const cacheReport = type === 'instagram' ? (window._analyticsReports || {}).instagram
        : (type === 'community_pulse' || type === 'comparison-cp') ? (window._analyticsReports || {}).community_pulse
        : type === 'comparison-li' ? (window._analyticsReports || {}).content
        : undefined;
      const cached = getDbInsightCache(cacheKey, cacheReport);
      if (cached) {
        content.innerHTML = formatInsightsText(cached);
        return;
      }

      // Fetch from API
      content.innerHTML = '<div class="insights-loading"><span class="insights-spinner"></span> Analyzing...</div>';
      try {
        const report = (window._analyticsCurrentReport);
        // Complete weeks only — an in-progress bucket vs a full one manufactures a collapse
        const weekly = trimInProgressWeek(report?.metrics_data || [], toISODateLocal());
        let analysisData;
        let clientName = '';

        // Get client name
        const clientRow = state.clients?.find(c => c.id === analyticsCurrentClientId);
        if (clientRow) clientName = clientRow.name || '';

        if (type === 'brand-signal') {
          // Build combined data — scoped to last 2 weeks only
          const reports = window._analyticsReports || {};
          const cr = reports.content;
          const fr = reports.followers;
          const vr = reports.visitors;

          // Content: last 2 weekly rows
          const contentWeekly = trimInProgressWeek(cr?.metrics_data || [], toISODateLocal());
          const last2Weeks = contentWeekly.slice(-2);
          // Posts: last 14 days only
          const allPosts = cr?.posts_data || [];
          const twoWeeksAgo = new Date();
          twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
          const recentPosts = allPosts.filter(p => {
            const d = new Date(normalizeDateStr(p['Created date'] || p['Date'] || ''));
            return !isNaN(d) && d >= twoWeeksAgo;
          });
          // Followers: last 14 daily rows
          const followerRecent = (fr?.metrics_data || []).slice(-14);
          // Visitors: last 14 daily rows
          const visitorRecent = (vr?.visitor_metrics || []).slice(-14);

          analysisData = {
            period: 'last 2 weeks',
            contentSummary: cr ? {
              totalImpressions: last2Weeks.reduce((s, w) => s + (w['Impressions (total)'] || 0), 0),
              avgEngagement: (() => { const rows = last2Weeks.filter(w => w['Engagement rate (total)'] > 0); return rows.length ? rows.reduce((s, w) => s + w['Engagement rate (total)'], 0) / rows.length : 0; })(),
              totalPosts: recentPosts.length,
              topPostImpressions: recentPosts.length ? Math.max(0, ...recentPosts.map(p => p['Impressions'] || 0)) : 0,
              // Percentages PRECOMPUTED — the model quotes, never derives.
              // Asked to divide, haiku picked the wrong denominator twice
              // (8,564/17,620 = "48.6%" instead of /26,184 = 32.7%), and an
              // instruction to divide by OLD didn't stop it.
              weekOverWeek: last2Weeks.length === 2 ? (() => {
                const impPrev = last2Weeks[0]['Impressions (total)'] || 0;
                const impNow = last2Weeks[1]['Impressions (total)'] || 0;
                const engPrev = last2Weeks[0]['Engagement rate (total)'] || 0;
                const engNow = last2Weeks[1]['Engagement rate (total)'] || 0;
                return {
                  impressionsDelta: impNow - impPrev,
                  impressionsPctChange: pctDeltaLabel(impNow, impPrev),
                  engagementDelta: engNow - engPrev,
                  engagementDeltaPoints: `${engNow >= engPrev ? '+' : '−'}${Math.abs((engNow - engPrev) * 100).toFixed(2)} points`
                };
              })() : null,
            } : null,
            followerSummary: followerRecent.length ? {
              newFollowers: followerRecent.reduce((s, d) => s + (d.total || 0), 0),
              days: followerRecent.length,
            } : null,
            visitorSummary: visitorRecent.length ? {
              totalVisits: visitorRecent.reduce((s, d) => s + (d.overview_unique || 0), 0),
              days: visitorRecent.length,
            } : null,
            followerDemographics: fr?.demographics_data || null,
            visitorDemographics: vr?.demographics_data || null,
          };
          // Brand signal reads the posts too — same content-mix blindness fix.
          analysisData.recentPostsDetail = buildInsightsContext(14).posts;
        } else if (type === 'instagram') {
          analysisData = buildInstagramInsightsData();
          if (!analysisData) throw new Error('No Instagram report loaded');
          // Attach the active comparison so the AI summarises WHAT'S ON SCREEN
          // — A vs B with the same windows the tiles show — instead of
          // narrating the whole file.
          const w = igActiveComparison();
          if (w) {
            const cmpPct = {};
            Object.keys(w.a.totals || {}).forEach((k) => {
              const p = pctDeltaLabel(w.a.totals[k], (w.b.totals || {})[k]);
              if (p) cmpPct[k] = p;
            });
            analysisData.comparison = {
              precomputedPct: cmpPct,
              mode: window._igCmp.mode,
              note: w.note || '',
              a: { label: w.a.label, startIso: w.a.startIso, endIso: w.a.endIso, totals: w.a.totals, daily: w.a.rows },
              b: { label: w.b.label, startIso: w.b.startIso, endIso: w.b.endIso, totals: w.b.totals, daily: w.b.rows }
            };
            // Post context scoped to the compared windows, not all time.
            const inWin = (d) => d && ((d >= (w.a.startIso || '') && d <= (w.a.endIso || '')) ||
              (w.b.startIso && d >= w.b.startIso && d <= w.b.endIso));
            analysisData.posts = (analysisData.posts || []).filter(p => inWin(String(p.date || '').slice(0, 10)));
          }
        } else if (type === 'comparison-li') {
          const reports = window._analyticsReports || {};
          const weeklyAll = reports.content?.metrics_data || [];
          const w = liComparisonWindows(weeklyAll, window._liCmp.mode, toISODateLocal(), window._liCmp.aKey, window._liCmp.bKey);
          if (!w) throw new Error('No comparison selected');
          // Audience fit (the one thing the retired Brand signal banner had):
          // demographics plus THIS client's target persona from config — the
          // old prompt hardcoded a pharma/biotech ICP and scored every client
          // against it, activism nonprofits included.
          const personas = getConfigMap('analytics_personas_by_client', ANALYTICS_PERSONAS_BY_CLIENT);
          const clientRowLi = state.clients?.find(c => c.id === analyticsCurrentClientId);
          const liPersona = clientRowLi?.audience_persona || personas[(clientRowLi?.name || '').toLowerCase()] || null;
          analysisData = { channel: 'LinkedIn', comparison: {
            aLabel: w.a.label, bLabel: w.b.label, note: w.note || '',
            aTotals: w.a.totals, bTotals: w.b.totals,
            precomputedDeltas: precomputeRowDeltas(w.b.totals, w.a.totals)
          }, audience: {
            followerDemographics: reports.followers?.demographics_data || null,
            visitorDemographics: reports.visitors?.demographics_data || null,
            targetPersona: liPersona
          } };
        } else if (type === 'comparison-cp') {
          const sends = ((window._analyticsReports || {}).community_pulse?.metrics_data || []).slice()
            .sort((x, y) => String(x.date).localeCompare(String(y.date)));
          if (sends.length < 2) throw new Error('Not enough sends to compare');
          const last = sends[sends.length - 1];
          const base = window._cpCmp.mode === 'type'
            ? [...sends.slice(0, -1)].reverse().find(r => r.send_type === last.send_type)
            : sends[sends.length - 2];
          if (!base) throw new Error('No earlier send of this type');
          analysisData = { channel: 'Newsletter & community', comparison: {
            aLabel: `"${last.name}" (${last.date})`, bLabel: `"${base.name}" (${base.date})`, note: '',
            aTotals: last, bTotals: base,
            precomputedDeltas: precomputeRowDeltas(base, last)
          } };
        } else if (type === 'community_pulse') {
          const rep = (window._analyticsReports || {}).community_pulse;
          if (!rep) throw new Error('No community pulse report loaded');
          analysisData = { summary: rep.summary || null, sends: rep.metrics_data || [], demographics: rep.demographics_data || null };
          const sends = analysisData.sends;
          if (sends.length >= 2) analysisData.precomputedDeltas = precomputeRowDeltas(sends[sends.length - 2], sends[sends.length - 1]);
        } else if (type === 'monthly') {
          const months = aggregateWeeklyToMonthly(weekly);
          analysisData = { months, ...buildInsightsContext(120) };
          if (months.length >= 2) analysisData.precomputedDeltas = precomputeRowDeltas(months[months.length - 2], months[months.length - 1]);
        } else {
          analysisData = { weeks: weekly, ...buildInsightsContext(35) };
          if (weekly.length >= 2) analysisData.precomputedDeltas = precomputeRowDeltas(weekly[weekly.length - 2], weekly[weekly.length - 1]);
        }

        const apiType = type.startsWith('comparison-') ? 'comparison' : type;
        const result = await fetchInsights(apiType, analysisData, clientName, { viewMode: vm });
        await setDbInsightCache(cacheKey, result.insights, cacheReport);
        content.innerHTML = formatInsightsText(result.insights);

        // Update preview text
        const preview = banner.querySelector('.insights-banner-preview');
        if (preview) {
          const firstLine = result.insights.split('\n').find(l => l.trim()) || '';
          preview.textContent = firstLine.substring(0, 80) + (firstLine.length > 80 ? '…' : '');
        }
      } catch (err) {
        console.error('Insights error:', err);
        content.innerHTML = `<div class="insights-error">Could not generate insights. ${escapeHtml(err.message)}</div>`;
      }
      return;
    }
  });
}

function formatInsightsText(text) {
  // Simple text formatting — convert bullet points and newlines to HTML
  return text
    .split('\n')
    .map(line => {
      line = line.trim();
      if (!line) return '';
      // Bold section headers: numbered ("1. Signal"), known section names from
      // the prompt contracts, or a short label line ending with ':'
      if (/^\d+\.\s/.test(line)
          || /^(Key Trends|Notable Changes|Recommendations|Performance|Suggestions|What moved|Likely why|Do next|Signal|Audience Fit|Next Week|Trend Read|Spike Days|Participation Pulse|Community Health|What the Network Wants|What Worked)/i.test(line)
          || (line.length < 40 && /:$/.test(line))) {
        return `<div class="insights-section-header">${escapeHtml(line)}</div>`;
      }
      if (line.startsWith('•') || line.startsWith('-')) {
        return `<div class="insights-bullet">${escapeHtml(line)}</div>`;
      }
      return `<div class="insights-line">${escapeHtml(line)}</div>`;
    })
    .join('');
}

// Store current report reference for insights
window._analyticsCurrentReport = null;

// =============================================
// END CLIENT ANALYTICS
// =============================================

function filterPlannerBySearch(query) {
  const q = (query || '').toLowerCase().trim();
  if (_plannerActiveView === 'people' && plannerPeopleView) {
    const persons = plannerPeopleView.querySelectorAll('.rp-person');
    const deptHeaders = plannerPeopleView.querySelectorAll('.rp-dept-header');
    const visibleDepts = new Set();
    persons.forEach(el => {
      const name = el.dataset.empName || '';
      const dept = el.dataset.empDept || '';
      const visible = !q || name.includes(q) || dept.includes(q);
      el.style.display = visible ? '' : 'none';
      if (visible) visibleDepts.add(dept);
    });
    deptHeaders.forEach(h => {
      const dept = (h.textContent || '').toLowerCase();
      h.style.display = (!q || visibleDepts.has(dept)) ? '' : 'none';
    });
  } else if (_plannerActiveView === 'clients' && plannerClientView) {
    const cards = plannerClientView.querySelectorAll('.rp-client-card');
    cards.forEach(el => {
      const name = el.dataset.clientName || '';
      const visible = !q || name.includes(q);
      el.style.display = visible ? '' : 'none';
    });
  }
}

// Person click → navigate to profile
document.addEventListener('click', (e) => {
  const nameEl = e.target.closest('.rp-person-name');
  if (nameEl?.dataset.empId) {
    navigateToScreen('employee-profile', { replace: false, empId: nameEl.dataset.empId });
  }
});

// View toggle
document.getElementById('plannerViewToggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.pvt-btn');
  if (!btn || btn.classList.contains('active')) return;
  const view = btn.dataset.view;
  _plannerActiveView = view;
  document.querySelectorAll('#plannerViewToggle .pvt-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  renderActivePlannerView();
  // Re-apply search filter
  if (matrixSearch?.value) filterPlannerBySearch(matrixSearch.value);
});

if (matrixSearch) {
  matrixSearch.addEventListener('input', () => {
    filterPlannerBySearch(matrixSearch.value);
  });
}

if (plannerMonth) {
  plannerMonth.addEventListener('change', () => {
    state._matrixSelectedWeekIndex = null; // reset to current week for new month
    loadTeamDashboardFromSupabase().catch((error) => {
      console.error(error);
      renderTeamDashboardEmpty(`Unable to load team dashboard: ${error.message}`);
      setTeamDashboardScopeNote(`Unable to load team dashboard: ${error.message}`, 'status warn');
    });
  });
}

function navigateWeek(delta) {
  if (state._matrixSelectedWeekIndex == null) return;
  state._matrixSelectedWeekIndex = Math.max(0, state._matrixSelectedWeekIndex + delta);
  loadTeamDashboardFromSupabase().catch((error) => {
    console.error(error);
  });
}

if (weekPrevBtn) weekPrevBtn.addEventListener('click', () => navigateWeek(-1));
if (weekNextBtn) weekNextBtn.addEventListener('click', () => navigateWeek(1));

populatePlannerMonthOptions();

if (addClientBtn) {
  addClientBtn.addEventListener('click', () => {
    if (!canAddClients()) return;
    const client = (newClientName?.value || '').trim();
    const type = newClientType?.value || 'retainer';
    const owner = isLeadershipRole() ? newClientOwner?.value || '' : currentClientOwnerFullName();
    if (!client) {
      setClientFormNotice('Enter a client name first.', 'status warn');
      return;
    }

    addClientBtn.disabled = true;
    const origClientBtnText = addClientBtn.textContent;
    addClientBtn.textContent = editingClientId ? 'Updating…' : 'Adding…';

    const run = async () => {
      if (editingClientId) {
        if (state.supabase && state.isAuthenticated && !String(editingClientId).startsWith('local-')) {
          await updateClientInSupabase({ clientId: editingClientId, client, type, owner });
          await loadClientsFromSupabase();
        } else {
          updateLocalClientById({ clientId: editingClientId, client, type, owner });
          renderClientRegistryTable();
        }
        setClientFormNotice(`Updated ${client}.`);
      } else {
        if (state.supabase && state.isAuthenticated) {
          await upsertClientToSupabase({ client, type, owner });
          await loadClientsFromSupabase();
        } else {
          addPortfolioRow({
            client,
            type,
            owner,
            status: 'Active'
          });
        }
        setClientFormNotice(`Added ${client}.`);
      }
      resetClientEditor();
    };
    run().catch((error) => {
      console.error(error);
      setClientFormNotice(`Unable to save client: ${error.message}`, 'status warn');
    }).finally(() => {
      addClientBtn.disabled = false;
      addClientBtn.textContent = origClientBtnText;
    });
  });
}

if (cancelClientEditBtn) {
  cancelClientEditBtn.addEventListener('click', () => {
    resetClientEditor();
    setClientFormNotice('Edit cancelled.');
  });
}

if (portfolioTableBody) {
  portfolioTableBody.addEventListener('click', (event) => {
    const actionBtn = event.target.closest('button[data-client-action]');
    if (!actionBtn) return;

    const action = actionBtn.dataset.clientAction;
    const clientId = actionBtn.dataset.clientId || '';

    if (action === 'analytics') {
      analyticsCurrentClientId = clientId;
      navigateToScreen('client-analytics');
      return;
    }

    if (action === 'scope-coverage' && canEditScopeCoverage()) {
      scopeCoverageCurrentClientId = clientId;
      navigateToScreen('client-scope-coverage');
      return;
    }

    if (action === 'edit' && canEditClients()) {
      startClientEdit(clientId);
      return;
    }

    const clientEntry = state.clients.find(c => String(c.id) === String(clientId));
    if (action === 'archive' && canArchiveClient(clientEntry)) {
      archiveClientById(clientId).catch((error) => {
        console.error(error);
        setClientFormNotice(`Unable to archive client: ${error.message}`, 'status warn');
      });
      return;
    }

    if (action === 'delete' && canDeleteClients()) {
      deleteClientById(clientId).catch((error) => {
        console.error(error);
        setClientFormNotice(`Unable to delete client: ${error.message}`, 'status warn');
      });
    }
  });

  const clientTable = portfolioTableBody.closest('table');
  if (clientTable) {
    clientTable.querySelector('thead')?.addEventListener('click', handleClientSortClick);
  }
}

const archivedClientsBody = document.getElementById('archivedClientsBody');
if (archivedClientsBody) {
  archivedClientsBody.addEventListener('click', (event) => {
    const actionBtn = event.target.closest('button[data-client-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.clientAction;
    const clientId = actionBtn.dataset.clientId || '';
    const archivedEntry = state.clients.find(c => String(c.id) === String(clientId));
    if (action === 'unarchive' && canArchiveClient(archivedEntry)) {
      unarchiveClientById(clientId).catch((error) => {
        console.error(error);
        setClientFormNotice(`Unable to restore client: ${error.message}`, 'status warn');
      });
    }
  });
}

const profileMetaLine = document.getElementById('profileMetaLine');
const profileStatCards = document.getElementById('profileStatCards');
const profileProjectsBody = document.getElementById('profileProjectsBody');
const profileDailyTasksBody = document.getElementById('profileDailyTasksBody');
const profileTeamSelect = document.getElementById('profileTeamSelect');
const profileEmploymentType = document.getElementById('profileEmploymentType');
const profileAccessLevel = document.getElementById('profileAccessLevel');
const profileManagerSelect = document.getElementById('profileManagerSelect');
const profileNameInput = document.getElementById('profileNameInput');
const profileEmailInput = document.getElementById('profileEmailInput');
const profileCapacityInput = document.getElementById('profileCapacityInput');
const profileBirthday = document.getElementById('profileBirthday');
const profileCity = document.getElementById('profileCity');
profileCity?.addEventListener('change', () => renderCityTimezoneHint(profileCity.value));
const profileEmergencyName = document.getElementById('profileEmergencyName');
const profileEmergencyPhone = document.getElementById('profileEmergencyPhone');
const profilePeriod = document.getElementById('profilePeriod');
const profileWeekFilterWrap = document.getElementById('profileWeekFilterWrap');
const profileWeekFilter = document.getElementById('profileWeekFilter');
const profilePeriodMeta = document.getElementById('profilePeriodMeta');
const saveProfileBtn = document.getElementById('saveProfileBtn');
const profileSaveNotice = document.getElementById('profileSaveNotice');

function setProfileSaveNotice(message = '', className = 'mini-meta') {
  if (!profileSaveNotice) return;
  profileSaveNotice.className = className;
  profileSaveNotice.textContent = message;
}

function selectedDirectoryEmployeeByName(name = state.currentEmployee) {
  const targetName = String(name || '').trim();
  if (!targetName) return null;
  return lookupActiveEmployeeByFullName(targetName);
}

function parseCapacityPercentInput(value) {
  const normalized = String(value || '')
    .replace('%', '')
    .trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function refreshProfileUtilizationSummary() {
  if (!profileStatCards) return;
  const profile = selectedEmployeeRecord();
  const lastEdit = profile.lastAllocationEdit || '--';

  // Snapshot existing leave values before re-render (they're populated async)
  const prevPl = document.getElementById('profileLeavePl');
  const prevCl = document.getElementById('profileLeaveCl');
  const prevSl = document.getElementById('profileLeaveSl');
  const plVal = prevPl ? prevPl.textContent : '--';
  const clVal = prevCl ? prevCl.textContent : '--';
  const slVal = prevSl ? prevSl.textContent : '--';
  const plNeg = prevPl ? prevPl.classList.contains('leave-negative') : false;
  const clNeg = prevCl ? prevCl.classList.contains('leave-negative') : false;
  const slNeg = prevSl ? prevSl.classList.contains('leave-negative') : false;

  const cards = [
    { label: 'Week Utilization', value: `${profile.utilization.week}%` },
    { label: 'Month Utilization', value: `${profile.utilization.month}%` },
    { label: 'Last Allocation Edit', value: lastEdit, id: 'profileLastAllocationEdit' }
  ];

  const leaveCards = isLeadershipRole() ? [
    { label: 'PL Remaining', value: plVal, id: 'profileLeavePl' },
    { label: 'CL Remaining', value: clVal, id: 'profileLeaveCl' },
    { label: 'SL Remaining', value: slVal, id: 'profileLeaveSl' }
  ] : [];

  profileStatCards.innerHTML = [...cards, ...leaveCards].map(c => `
    <div class="profile-stat-card${leaveCards.includes(c) ? ' leadership-only' : ''}">
      <span class="profile-stat-label">${c.label}</span>
      <span class="profile-stat-value"${c.id ? ` id="${c.id}"` : ''}>${c.value}</span>
    </div>
  `).join('');

  // Restore leave-negative classes
  if (plNeg) document.getElementById('profileLeavePl')?.classList.add('leave-negative');
  if (clNeg) document.getElementById('profileLeaveCl')?.classList.add('leave-negative');
  if (slNeg) document.getElementById('profileLeaveSl')?.classList.add('leave-negative');
}

function aggregateProjectAllocations(lines = [], denominator = 1) {
  const divisor = Math.max(1, Number(denominator) || 1);
  const projectTotals = new Map();
  lines.forEach((line) => {
    const project = String(line.project || '').trim();
    if (!project || normalizeClientNameKey(project) === 'internal') return;
    const allocation = Number.isFinite(Number(line.allocationPercent)) ? Number(line.allocationPercent) : 0;
    projectTotals.set(project, (projectTotals.get(project) || 0) + allocation);
  });

  return [...projectTotals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, total]) => ({
      project,
      allocation: formatPercent(total / divisor)
    }));
}

function buildAllocationWeekBuckets(allocationRows = []) {
  const weekBuckets = new Map();

  allocationRows.forEach((row) => {
    const weekStartIso = String(row.period_start || '').trim();
    if (!weekStartIso) return;
    const weekKey = weekIdentifierFromIsoDate(weekStartIso);
    if (!weekKey) return;

    if (!weekBuckets.has(weekKey)) {
      weekBuckets.set(weekKey, {
        key: weekKey,
        weekStartIso,
        lines: [],
        lastUpdated: null
      });
    }

    const bucket = weekBuckets.get(weekKey);
    const projectName = String(row.project?.name || row.client || '').trim();
    if (projectName && !isGarbageProjectName(projectName)) {
      bucket.lines.push({
        project: projectName,
        allocationPercent: Number.isFinite(Number(row.allocation_percent)) ? Number(row.allocation_percent) : 0
      });
    }

    if (row.updated_at && (!bucket.lastUpdated || new Date(row.updated_at) > new Date(bucket.lastUpdated))) {
      bucket.lastUpdated = row.updated_at;
    }
  });

  return [...weekBuckets.values()].sort((a, b) => String(b.weekStartIso).localeCompare(String(a.weekStartIso)));
}

function monthWindowFromWeekStart(weekStartIso) {
  const baseDate = parseIsoDateLocal(weekStartIso) || new Date();
  const monthStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
  const monthEnd = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0);
  return {
    monthStartIso: toISODateLocal(monthStart),
    monthEndIso: toISODateLocal(monthEnd),
    monthLabel: new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' }).format(monthStart)
  };
}

function renderProfileWeekFilterOptions() {
  if (!profileWeekFilter) return;

  profileWeekFilter.innerHTML = '';
  if (!state.profileWeekOptions.length) {
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = 'No week data';
    profileWeekFilter.appendChild(emptyOption);
    profileWeekFilter.disabled = true;
    return;
  }

  state.profileWeekOptions.forEach((optionData) => {
    const option = document.createElement('option');
    option.value = optionData.key;
    option.textContent = optionData.label;
    profileWeekFilter.appendChild(option);
  });

  const hasCurrent = [...profileWeekFilter.options].some((opt) => opt.value === state.profileWeekKey);
  if (!hasCurrent) {
    state.profileWeekKey = state.profileWeekOptions[0].key;
  }
  profileWeekFilter.value = state.profileWeekKey;
  profileWeekFilter.disabled = false;
}

function applySelectedEmployeeAllocationSnapshot(allocationRows = []) {
  const profile = selectedEmployeeRecord();
  const weekBuckets = buildAllocationWeekBuckets(allocationRows);

  state.profileWeekOptions = weekBuckets.map((bucket) => ({
    key: bucket.key,
    weekStartIso: bucket.weekStartIso,
    label: formatWeekIdentifierLabel(bucket.weekStartIso)
  }));

  if (state.profileWeekKey && !state.profileWeekOptions.some((optionData) => optionData.key === state.profileWeekKey)) {
    state.profileWeekKey = '';
  }
  if (!state.profileWeekKey && state.profileWeekOptions.length) {
    state.profileWeekKey = state.profileWeekOptions[0].key;
  }

  const selectedWeekBucket = weekBuckets.find((bucket) => bucket.key === state.profileWeekKey) || null;
  const latestUpdatedAt = allocationRows
    .map((row) => row.updated_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

  profile.lastAllocationEdit = latestUpdatedAt ? formatTimestamp(latestUpdatedAt) : '';

  if (!selectedWeekBucket) {
    profile.utilization.week = 0;
    profile.utilization.month = 0;
    profile.projects.week = [];
    profile.projects.month = [];
    renderProfileWeekFilterOptions();
    refreshProfileUtilizationSummary();
    renderProfileProjects();
    renderPeopleDirectory();
    return;
  }

  const weekTotal = selectedWeekBucket.lines.reduce((sum, line) => sum + (Number(line.allocationPercent) || 0), 0);
  const weekProjects = aggregateProjectAllocations(selectedWeekBucket.lines, 1).map((entry) => ({
    ...entry,
    period: formatWeekIdentifierLabel(selectedWeekBucket.weekStartIso)
  }));

  const monthWindow = monthWindowFromWeekStart(selectedWeekBucket.weekStartIso);
  const monthBuckets = weekBuckets.filter(
    (bucket) => bucket.weekStartIso >= monthWindow.monthStartIso && bucket.weekStartIso <= monthWindow.monthEndIso
  );
  const monthTotals = monthBuckets.map((bucket) =>
    bucket.lines.reduce((sum, line) => sum + (Number(line.allocationPercent) || 0), 0)
  );
  const monthUtilAverage = monthTotals.length
    ? monthTotals.reduce((sum, value) => sum + value, 0) / monthTotals.length
    : weekTotal;
  const monthPeriodTag = monthWindow.monthLabel;
  const monthProjects = aggregateProjectAllocations(
    monthBuckets.flatMap((bucket) => bucket.lines),
    monthBuckets.length || 1
  ).map((entry) => ({
    ...entry,
    period: monthPeriodTag
  }));

  profile.utilization.week = Math.min(100, Math.round(weekTotal));
  profile.utilization.month = Math.min(100, Math.round(monthUtilAverage));
  profile.projects.week = weekProjects;
  profile.projects.month = monthProjects;

  renderProfileWeekFilterOptions();
  refreshProfileUtilizationSummary();
  renderProfileProjects();
  renderPeopleDirectory();
}

async function loadProfileAllocationHistoryFromSupabase(targetEmployeeId = getSelectedProfileEmployeeId()) {
  if (!targetEmployeeId) {
    state.profileAllocationRows = [];
    applySelectedEmployeeAllocationSnapshot([]);
    return;
  }

  if (!state.supabase || !state.isAuthenticated) {
    const fallbackRows = (state.weeklyAllocations || []).map((row) => ({
      period_start: getCurrentWeekStartIso(),
      allocation_percent: row.allocation_percent,
      updated_at: row.updated_at,
      project: row.project || { name: row.client || '' }
    }));
    state.profileAllocationRows = fallbackRows;
    applySelectedEmployeeAllocationSnapshot(fallbackRows);
    return;
  }

  const historyStart = mondayWeekStartDate();
  historyStart.setDate(historyStart.getDate() - 7 * 26);
  const historyStartIso = toISODateLocal(historyStart);

  const response = await state.supabase
    .from('allocations')
    .select(`
      id,
      employee_id,
      period_type,
      period_start,
      allocation_percent,
      updated_at,
      project:projects!allocations_project_id_fkey (
        id,
        name
      )
    `)
    .eq('employee_id', targetEmployeeId)
    .eq('period_type', 'week')
    .gte('period_start', historyStartIso)
    .order('period_start', { ascending: false })
    .order('updated_at', { ascending: false });

  if (response.error) {
    console.error(response.error);
    state.profileAllocationRows = [];
    applySelectedEmployeeAllocationSnapshot([]);
    return;
  }

  state.profileAllocationRows = response.data || [];
  applySelectedEmployeeAllocationSnapshot(state.profileAllocationRows);
}

// The real department list, straight from the table — never a hardcoded set.
// The dropdown used to be six literal <option>s in index.html, which silently
// dropped Finance (a real team with a real person in it): on load the picker
// fell back to AM, and one Save then moved that person's team for good.
state.departmentOptions = [];

async function loadDepartmentOptions() {
  if (!state.supabase || !state.isAuthenticated) return;
  const res = await state.supabase.from('departments').select('id, name, sort_order');
  if (res.error) throw res.error;
  state.departmentOptions = (res.data || []).slice().sort((a, b) =>
    (a.sort_order ?? 999) - (b.sort_order ?? 999) || String(a.name).localeCompare(String(b.name)));
  renderTeamSelectOptions();
}

function departmentByExactName(name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  return state.departmentOptions.find((d) => String(d.name).trim().toLowerCase() === wanted) || null;
}

// `currentName` is the employee's stored team. If it somehow isn't in the list
// it gets appended rather than dropped — a picker that can't show the current
// value is how a save silently reassigns someone.
function renderTeamSelectOptions(currentName = '') {
  if (!profileTeamSelect) return;
  // Fall back to whatever options are already in the markup if the fetch has
  // not landed (or failed) — better a stale list than a one-item picker.
  const names = state.departmentOptions.length
    ? state.departmentOptions.map((d) => d.name)
    : [...profileTeamSelect.options].map((o) => o.value);
  const current = String(currentName || '').trim();
  if (current && !names.some((n) => n.toLowerCase() === current.toLowerCase())) names.push(current);
  if (!names.length) return;
  const previous = profileTeamSelect.value;
  profileTeamSelect.innerHTML = names
    .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  const keep = current || previous;
  if (keep && names.some((n) => n === keep)) profileTeamSelect.value = keep;
}

async function resolveDepartmentIdByName(teamName, fallbackDepartmentId = null) {
  // Exact name first: normalizeTeamName is a DISPLAY normalizer (it folds
  // 'Leadership' into AM), so normalizing before the lookup resolved real
  // teams to the wrong department id.
  const exact = departmentByExactName(teamName);
  if (exact) return exact.id;

  const selected = normalizeTeamName(teamName);
  if (!selected) return fallbackDepartmentId;

  const localMatch = state.employeeDirectory.find(
    (entry) => normalizeTeamName(entry.department?.name, '') === selected && entry.department?.id
  );
  if (localMatch?.department?.id) return localMatch.department.id;

  if (!state.supabase || !state.isAuthenticated) return fallbackDepartmentId;
  const candidates = teamLookupCandidates(selected);
  const departmentResult = await state.supabase.from('departments').select('id, name').in('name', candidates);
  if (departmentResult.error) throw departmentResult.error;
  const matched = (departmentResult.data || []).find((row) => normalizeTeamName(row.name, '') === selected);
  return matched?.id || departmentResult.data?.[0]?.id || fallbackDepartmentId;
}

async function saveCurrentProfile() {
  if (!state.supabase || !state.isAuthenticated) {
    setProfileSaveNotice('Sign in first to save profile details.', 'status error');
    return;
  }

  const originalName = state.currentEmployee;
  const selectedDirectoryEmployee = selectedDirectoryEmployeeByName(originalName);
  const targetEmployeeId = selectedDirectoryEmployee?.id || state.currentEmployeeId;
  if (!targetEmployeeId) {
    setProfileSaveNotice('Could not resolve employee record to save.', 'status error');
    return;
  }

  const canSave = canEditEmployee(selectedDirectoryEmployee || { id: targetEmployeeId, email: state.session?.user?.email });
  if (!canSave) {
    setProfileSaveNotice('You can only edit your own profile or your reportees.', 'status error');
    return;
  }

  const updatedNameInput = String(profileNameInput?.value || '').trim();
  const canonicalName = String(profileNameInput?.dataset.canonicalName || originalName || '').trim();
  const canonicalDisplayName = displayPersonName(canonicalName, 'Employee');
  const updatedName = updatedNameInput === canonicalDisplayName ? canonicalName : updatedNameInput;
  if (!updatedName) {
    setProfileSaveNotice('Full name is required.', 'status error');
    return;
  }
  if (updatedName.length > 25) {
    setProfileSaveNotice('Name must be 25 characters or less.', 'status error');
    return;
  }

  // A name that IS a department stays as typed; only unknown/legacy values
  // get normalized (that path still folds the old AM spelling).
  const rawSelectedTeam = String(profileTeamSelect?.value || '').trim();
  const selectedTeam = departmentByExactName(rawSelectedTeam)
    ? rawSelectedTeam
    : normalizeTeamName(rawSelectedTeam || TEAM_AM, TEAM_AM);
  // All three values are real now — coercing anything not 'fractional' to
  // 'full-time' would silently demote a consultant on every profile save.
  const selectedEmploymentType = EMPLOYMENT_TYPES.includes(profileEmploymentType?.value)
    ? profileEmploymentType.value
    : 'full-time';
  const selectedAccessLevel = normalizeAccessLevel(
    profileAccessLevel?.value || selectedDirectoryEmployee?.access_level || state.employeeProfile?.access_level || 'employee'
  );
  // Team, employment type and capacity are trigger-guarded columns
  // (trg_block_employee_self_escalation): for non-leadership the DB silently
  // reverts them, so sending them made the form LIE — an employee could pick a
  // new team, see "saved", and nothing happened (the same defect onboarding's
  // department had). The controls are leadership-only in the markup; the save
  // now matches, sending those fields only when the editor can actually land
  // them.
  const canEditGuarded = isLeadershipRole();

  let parsedCapacity = null;
  let departmentId = null;
  if (canEditGuarded) {
    parsedCapacity = parseCapacityPercentInput(profileCapacityInput?.value);
    if (parsedCapacity === null || parsedCapacity <= 0 || parsedCapacity > 100) {
      setProfileSaveNotice('Capacity must be a number from 1 to 100.', 'status error');
      return;
    }

    departmentId = selectedDirectoryEmployee?.department?.id || null;
    const storedTeamName = String(selectedDirectoryEmployee?.department?.name || '').trim();
    const teamUnchanged = storedTeamName.toLowerCase() === selectedTeam.toLowerCase()
      || normalizeTeamName(storedTeamName, '') === normalizeTeamName(selectedTeam, '');
    if (!departmentId || !teamUnchanged) {
      try {
        departmentId = await resolveDepartmentIdByName(selectedTeam, departmentId);
      } catch (error) {
        setProfileSaveNotice(`Unable to resolve team: ${error.message}`, 'status error');
        return;
      }
    }
    if (!departmentId) {
      setProfileSaveNotice('Department mapping missing. Select a valid team.', 'status error');
      return;
    }
  }

  const birthdayValue = profileBirthday?.value || null;
  const cityValue = profileCity?.value?.trim() || null;
  // The picker is empty either because they never set a city, or because we
  // couldn't place the one they had. Both cases get asked, not guessed: saving
  // null here would wipe a stored city and silently default their timezone.
  if (profileCity && !cityValue) {
    setProfileSaveNotice('Pick your home city — it sets the timezone Colony emails you in.', 'status error');
    return;
  }
  const emergNameValue = profileEmergencyName?.value?.trim() || null;
  const emergPhoneValue = profileEmergencyPhone?.value?.trim() || null;
  const updatePayload = {
    full_name: updatedName,
    date_of_birth: birthdayValue,
    current_city: cityValue,
    // Derived at write time, stored as its own column — never computed on read.
    // A legacy off-list city resolves to the default rather than blocking the save.
    timezone: timezoneForCity(cityValue),
  };
  if (profilePrivateDetailsFor === targetEmployeeId) {
    updatePayload.emergency_contact_name = emergNameValue;
    updatePayload.emergency_contact_phone = emergPhoneValue;
    updatePayload.personal_address = document.getElementById('profileAddress')?.value?.trim() || null;
  }
  if (canEditGuarded) {
    updatePayload.job_title = document.getElementById('profileJobTitle')?.value?.trim() || null;
    updatePayload.department_id = departmentId;
    updatePayload.employment_type = selectedEmploymentType;
    updatePayload.capacity_percent = parsedCapacity;
  }
  if (canManageAccessRoles()) {
    updatePayload.access_level = selectedAccessLevel;
    updatePayload.role_title =
      selectedAccessLevel === 'admin' ? 'Admin' : selectedAccessLevel === 'leadership' ? 'Leadership' : 'Employee';
  }
  if (profileManagerSelect) {
    updatePayload.direct_manager_email = profileManagerSelect.value || null;
  }

  setProfileSaveNotice('Saving profile...', 'mini-meta');

  {
    updatePayload.updated_at = new Date().toISOString();
    const updateResult = await state.supabase.from('employees').update(updatePayload).eq('id', targetEmployeeId);
    if (updateResult.error) {
      setProfileSaveNotice(`Unable to save profile: ${updateResult.error.message}`, 'status error');
      return;
    }
  }

  const existingStore = employeeStore[originalName];
  if (existingStore && updatedName !== originalName) {
    employeeStore[updatedName] = existingStore;
    delete employeeStore[originalName];
  }
  const updatedStore = ensureEmployeeRecord(updatedName);
  updatedStore.team = normalizeTeamName(selectedTeam, TEAM_AM);
  updatedStore.employmentType = selectedEmploymentType;
  updatedStore.accessLevel = canManageAccessRoles()
    ? selectedAccessLevel
    : normalizeAccessLevel(selectedDirectoryEmployee?.access_level || updatedStore.accessLevel || state.role || 'employee');
  updatedStore.capacityPercent = parsedCapacity;
  updatedStore.email = selectedDirectoryEmployee?.email || updatedStore.email;

  await loadEmployeeDirectoryFromSupabase();
  if (targetEmployeeId === state.currentEmployeeId) {
    const ownRow = lookupActiveEmployee(state.currentEmployeeId);
    if (ownRow) {
      state.employeeProfile = {
        ...(state.employeeProfile || {}),
        ...ownRow
      };
      state.role = normalizeAccessLevel(ownRow.access_level || state.role);
    }
  }

  setSelectedEmployee(updatedName);
  updateSidebarIdentityLabels();
  applyRoleAccess();
  setProfileSaveNotice('Profile saved.', 'status');
}

function selectedEmployeeRecord() {
  const targetName = state.currentEmployee || state.employeeProfile?.full_name || DEFAULT_EMPLOYEE;
  return ensureEmployeeRecord(targetName);
}

// <optgroup>ed city options. Returns { html, value, unmatched }:
//  * value     — what to set the <select> to: the CANONICAL city, so an alias
//                like "gurgaon" lands on Gurugram instead of looking broken
//  * unmatched — the stored string when nothing matched it at all
//
// An unmatched city is neither guessed at nor silently kept. A <select> coerces
// to its first option when its value has no match, so doing nothing would
// relocate people to Ahmedabad the next time they saved their profile — and
// quietly keeping the old string just hides that we can't place them. Instead
// the picker sits on an empty prompt and the save is blocked until they choose.
// Their stored city stays untouched in the DB until they do.
function cityOptionsHtml(selectedCity) {
  const current = String(selectedCity || '').trim();
  const entry = cityEntryFor(current);
  const groups = [...new Set(CITY_OPTIONS.map((o) => o.group))];
  const parts = [];
  if (!entry) parts.push('<option value="">Select your city…</option>');
  groups.forEach((group) => {
    const opts = CITY_OPTIONS.filter((o) => o.group === group)
      .map((o) => `<option value="${escapeHtml(o.city)}">${escapeHtml(o.city)}</option>`)
      .join('');
    parts.push(`<optgroup label="${escapeHtml(group)}">${opts}</optgroup>`);
  });
  return { html: parts.join(''), value: entry ? entry.city : '', unmatched: current && !entry ? current : '' };
}

// Show the derived zone next to the picker, so the timezone is never a hidden
// consequence of a city choice — and ASK rather than assume when the stored
// value can't be placed.
function renderCityTimezoneHint(city, unmatched = '') {
  const hint = document.getElementById('profileCityTzHint');
  if (!hint) return;
  const value = String(city || '').trim();
  if (!value && unmatched) {
    hint.className = 'status warn';
    hint.textContent = `We couldn't match your saved city ("${unmatched}") — please pick the closest one.`;
    return;
  }
  hint.className = 'mini-meta';
  hint.textContent = value ? `Timezone: ${timezoneForCity(value)}` : '';
}

function renderProfileProjects() {
  if (!profileProjectsBody) return;
  const profile = selectedEmployeeRecord();
  const period = profilePeriod?.value || 'month';
  const projects = profile.projects[period] || [];
  const selectedWeekOption = state.profileWeekOptions.find((optionData) => optionData.key === state.profileWeekKey) || null;

  if (profileWeekFilterWrap) {
    profileWeekFilterWrap.classList.toggle('hidden', !state.profileWeekOptions.length);
  }
  if (profilePeriodMeta) {
    profilePeriodMeta.textContent = '';
  }

  profileProjectsBody.innerHTML = '';
  if (!projects.length) {
    const emptyRow = document.createElement('tr');
    const periodLabel = period === 'week' ? 'selected week' : 'selected month';
    emptyRow.innerHTML = `<td colspan="3">No allocation lines for the ${periodLabel}.</td>`;
    profileProjectsBody.appendChild(emptyRow);
    return;
  }

  projects.forEach((item) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td data-label="Project">${escapeHtml(item.project || '--')}</td>
      <td data-label="Allocation">${escapeHtml(item.allocation || '0%')}</td>
      <td data-label="Period">${escapeHtml(item.period || '--')}</td>
    `;
    profileProjectsBody.appendChild(row);
  });

  const totalPercent = projects.reduce((sum, item) => sum + percentNumberFromText(item.allocation), 0);
  const totalRow = document.createElement('tr');
  totalRow.innerHTML = `
    <td data-label="Project"><strong>Total</strong></td>
    <td data-label="Allocation"><strong>${escapeHtml(formatPercentRaw(totalPercent))}</strong></td>
    <td data-label="Period"></td>
  `;
  profileProjectsBody.appendChild(totalRow);
}

function renderProfileDailyTasks() {
  if (!profileDailyTasksBody) return;

  const selectedEmployeeId = getEmployeeIdByName(state.currentEmployee) || state.currentEmployeeId;
  const todayIso = toISODateLocal();
  const rows = selectedEmployeeId
    ? tasksForDate(selectedEmployeeId, todayIso).filter((t) => t.status !== 'archived')
    : [];

  profileDailyTasksBody.innerHTML = '';
  if (!rows.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="3">No tasks yet.</td>';
    profileDailyTasksBody.appendChild(row);
    return;
  }

  rows.forEach((task) => {
    const statusMeta = getDailyTaskStatusMeta(task.status);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td data-label="Task">${task.recurring_task_id ? '<span class="recur-mark" title="Repeats monthly">\u21bb</span> ' : ''}${taskTitleHtml(task)}</td>
      <td data-label="Client">${escapeHtml(task.notes || '--')}</td>
      <td data-label="Status"><span class="chip ${statusMeta.className}">${statusMeta.label}</span></td>
    `;
    profileDailyTasksBody.appendChild(row);
  });
}

// Which employee's private details the profile form currently holds; the save
// writes address/emergency contact only when this matches its target.
let profilePrivateDetailsFor = null;
async function fillProfilePrivateDetails(employeeId, isSelf) {
  profilePrivateDetailsFor = null;
  const fields = [
    [profileEmergencyName, 'emergency_contact_name'],
    [profileEmergencyPhone, 'emergency_contact_phone'],
    [document.getElementById('profileAddress'), 'personal_address']
  ];
  fields.forEach(([el]) => { if (el) el.value = ''; });
  if (!employeeId || !(isSelf || isLeadershipRole())) return;
  const details = await loadEmployeePrivateDetails(employeeId);
  // The person on screen may have changed while this was in flight.
  const onScreenId = getEmployeeIdByName(state.currentEmployee) || state.currentEmployeeId;
  if (!details || onScreenId !== employeeId) return;
  fields.forEach(([el, key]) => { if (el) el.value = details[key] || ''; });
  profilePrivateDetailsFor = employeeId;
}

function setSelectedEmployee(name) {
  const previousEmployee = state.currentEmployee;
  const fallbackName = state.employeeProfile?.full_name || DEFAULT_EMPLOYEE;
  const targetName = String(name || '').trim() || fallbackName;
  const employeeChanged = targetName !== previousEmployee;
  state.currentEmployee = targetName;
  if (employeeChanged) {
    state.profileAllocationRows = [];
    state.profileWeekOptions = [];
    state.profileWeekKey = '';
    renderProfileWeekFilterOptions();
  }
  const profile = ensureEmployeeRecord(targetName);
  const selectedEmployeeId = getEmployeeIdByName(targetName);
  const selectedDirectoryEmployee =
    selectedDirectoryEmployeeByName(targetName) ||
    lookupActiveEmployee(selectedEmployeeId);

  if (isLeadershipRole() && selectedEmployeeId) {
    state.taskViewEmployeeId = selectedEmployeeId;
    state.allocationViewEmployeeId = selectedEmployeeId;
    if (taskEmployeeFilter) {
      taskEmployeeFilter.value = selectedEmployeeId;
    }
    if (allocEmployeeFilter) {
      allocEmployeeFilter.value = selectedEmployeeId;
    }
  }

  const isSelf = !selectedEmployeeId || selectedEmployeeId === state.currentEmployeeId;
  const profileEyebrow = document.getElementById('profileEyebrow');
  const profileMainHeading = document.getElementById('profileMainHeading');
  if (profileEyebrow) profileEyebrow.textContent = isSelf ? 'Self View' : 'Employee Profile';
  if (profileMainHeading) profileMainHeading.textContent = isSelf ? 'My Profile' : displayPersonName(state.currentEmployee, 'Employee');
  if (profileMetaLine) {
    const typeLabel = employmentTypeLabel(profile.employmentType);
    const leaveLabel = profile.leaveTrackingEnabled === false ? 'Leave Excluded' : 'Leave Enabled';
    const cityValue = selectedDirectoryEmployee?.current_city || '';
    const cityPill = cityValue ? `<span class="dot">&middot;</span><span class="profile-location-pill">📍 ${escapeHtml(cityValue)}</span>` : '';
    const titleLead = selectedDirectoryEmployee?.job_title ? `<span>${escapeHtml(selectedDirectoryEmployee.job_title)}</span><span class="dot">&middot;</span>` : '';
    profileMetaLine.innerHTML = `${titleLead}<span>${escapeHtml(profile.team)}</span><span class="dot">&middot;</span><span>${escapeHtml(typeLabel)}</span><span class="dot">&middot;</span><span>${escapeHtml(leaveLabel)}</span>${cityPill}`;
  }
  refreshProfileUtilizationSummary();

  if (profileTeamSelect) {
    // The stored department name, not profile.team — the latter is normalized
    // for display ('Leadership' reads as AM), which is fine on a directory row
    // and wrong in an editor that writes what it shows.
    const storedTeam = selectedDirectoryEmployee?.department?.name || profile.team || '';
    renderTeamSelectOptions(storedTeam);
    if (storedTeam) profileTeamSelect.value = storedTeam;
  }
  if (profileEmploymentType) profileEmploymentType.value = profile.employmentType;
  if (profileAccessLevel) {
    const selectedAccessLevel = normalizeAccessLevel(
      selectedDirectoryEmployee?.access_level || profile.accessLevel || state.employeeProfile?.access_level || 'employee'
    );
    profileAccessLevel.value = selectedAccessLevel;
  }
  if (profileManagerSelect) {
    // Populate with leadership + admin employees
    const managerOptions = state.employeeDirectory
      .filter(e => e.access_level === 'leadership' || e.access_level === 'admin')
      .map(e => ({ email: normalizeEmail(e.email), name: displayPersonName(e.full_name, e.email) }));
    profileManagerSelect.innerHTML = '<option value="">— Auto (by team) —</option>' +
      managerOptions.map(m => `<option value="${escapeHtml(m.email)}">${escapeHtml(m.name)}</option>`).join('');
    const currentManager = normalizeEmail(selectedDirectoryEmployee?.direct_manager_email || '');
    profileManagerSelect.value = currentManager || '';
  }
  if (profileNameInput) {
    profileNameInput.dataset.canonicalName = state.currentEmployee;
    profileNameInput.value = displayPersonName(state.currentEmployee, 'Employee');
  }
  if (profileEmailInput) {
    profileEmailInput.value =
      selectedDirectoryEmployee?.email ||
      profile.email ||
      state.employeeProfile?.email ||
      normalizeEmail(state.session?.user?.email || '');
  }
  if (profileCapacityInput) {
    const capacity = Number.isFinite(Number(selectedDirectoryEmployee?.capacity_percent))
      ? Number(selectedDirectoryEmployee.capacity_percent)
      : Number(profile.capacityPercent);
    profileCapacityInput.value = Number.isFinite(capacity) ? String(capacity) : '100';
  }
  if (profileBirthday) {
    profileBirthday.value = selectedDirectoryEmployee?.date_of_birth || '';
  }
  if (profileCity) {
    const cityOpts = cityOptionsHtml(selectedDirectoryEmployee?.current_city);
    profileCity.innerHTML = cityOpts.html;
    profileCity.value = cityOpts.value;
    renderCityTimezoneHint(cityOpts.value, cityOpts.unmatched);
  }
  // Address (seeded from the hire since 15 Sep 2026) and emergency contact are
  // not in the directory row: they load per person from
  // employee_private_details, which answers only for yourself or for
  // leadership. Until they arrive the save leaves them out (see saveProfile),
  // so a quick save can never blank them. Before 21 Sep these boxes were
  // filled from the directory, which never carried the emergency contact, so
  // every profile save wrote it back as empty.
  fillProfilePrivateDetails(selectedEmployeeId || state.currentEmployeeId, isSelf);
  const profileJobTitleEl = document.getElementById('profileJobTitle');
  if (profileJobTitleEl) {
    profileJobTitleEl.value = selectedDirectoryEmployee?.job_title || '';
    profileJobTitleEl.readOnly = !isLeadershipRole();
  }
  if (saveProfileBtn) {
    const canSave = state.isAuthenticated && canEditEmployee(selectedDirectoryEmployee || { id: selectedEmployeeId, email: state.session?.user?.email });
    saveProfileBtn.disabled = !canSave;
  }
  // Address/personal data: visible to own profile or leadership
  const personalDataBlock = document.getElementById('personalDataBlock');
  if (personalDataBlock) {
    const viewingOwnForAddress = selectedEmployeeId
      ? selectedEmployeeId === state.currentEmployeeId
      : targetName === (state.employeeProfile?.full_name || '');
    const canSeePersonalData = isLeadershipRole() || viewingOwnForAddress;
    personalDataBlock.classList.toggle('hidden', !canSeePersonalData);
  }

  setProfileSaveNotice('', 'mini-meta');
  loadProfileLeaveSummary(selectedEmployeeId).catch((err) => console.error('Profile leave summary:', err));
  renderProfileProjects();
  renderDailyTaskViews();
  loadWeeklyAllocationsFromSupabase().catch((error) => {
    console.error(error);
    setAllocationPolicyNote(`Unable to load weekly allocation: ${error.message}`);
  });
  applyFractionalVisibility();
  scrollCanvasToTop();
}

async function loadProfileLeaveSummary(employeeId) {
  const plEl = document.getElementById('profileLeavePl');
  const clEl = document.getElementById('profileLeaveCl');
  const slEl = document.getElementById('profileLeaveSl');
  if (!plEl) return;
  const effectiveId = employeeId || state.currentEmployeeId;
  if (!isLeadershipRole() || !effectiveId || !state.supabase) {
    if (plEl) plEl.textContent = '--';
    if (clEl) clEl.textContent = '--';
    if (slEl) slEl.textContent = '--';
    return;
  }
  const response = await state.supabase.rpc('get_leave_cycle_summary_for_employee', {
    p_employee_id: effectiveId,
    p_as_of_date: toISODateLocal()
  });
  if (response.error) {
    if (profileLeaveSummaryNotice) {
      profileLeaveSummaryNotice.textContent = `Unable to load: ${response.error.message}`;
      profileLeaveSummaryNotice.className = 'status warn';
    }
    return;
  }
  const summary = response.data || {};
  const pl = summary.pl || { remaining: 0 };
  const cl = summary.cl || { remaining: 0 };
  const sl = summary.sl || { remaining: 0 };
  // Cascade: negative PL/CL overflow into SL
  let plRem = pl.remaining, clRem = cl.remaining, slRem = sl.remaining;
  if (plRem < 0) { slRem += plRem; plRem = 0; }
  if (clRem < 0) { slRem += clRem; clRem = 0; }
  if (plEl) {
    plEl.textContent = leaveDayText(plRem);
    plEl.classList.toggle('leave-negative', plRem < 0);
  }
  if (clEl) {
    clEl.textContent = leaveDayText(clRem);
    clEl.classList.toggle('leave-negative', clRem < 0);
  }
  if (slEl) {
    slEl.textContent = leaveDayText(slRem);
    slEl.classList.toggle('leave-negative', slRem < 0);
  }
  if (profileLeaveSummaryNotice) {
    profileLeaveSummaryNotice.textContent = summary.leave_tracking_enabled === false
      ? 'Leave tracking is not enabled for this employee.'
      : `Cycle: ${summary.cycle_label || 'Apr-Mar'}`;
    profileLeaveSummaryNotice.className = 'mini-meta';
  }
}

function applyFractionalVisibility() {
  const profile = selectedEmployeeRecord();
  const isFractional = employmentIsScoped(profile.employmentType);
  const leaveTrackingDisabled = profile.leaveTrackingEnabled === false;
  const employeeOnlyMode = state.role === 'employee';

  const leaveNavButton = document.getElementById('leaveNavButton');
  const leaveCenterContent = document.getElementById('leaveCenterContent');
  const fractionalLeaveNotice = document.getElementById('fractionalLeaveNotice');

  if (employeeOnlyMode && (isFractional || leaveTrackingDisabled)) {
    leaveNavButton?.classList.add('hidden');
    leaveCenterContent?.classList.add('hidden');
    fractionalLeaveNotice?.classList.remove('hidden');

    const noticeTitle = fractionalLeaveNotice?.querySelector('h3');
    const noticeBody = fractionalLeaveNotice?.querySelector('p');
    if (leaveTrackingDisabled) {
      if (noticeTitle) noticeTitle.textContent = 'Leave Workflow Disabled';
      if (noticeBody) noticeBody.textContent = 'Finance leaves are excluded from Agency Colony v1. Leave and holiday modules stay hidden in employee view.';
    } else {
      if (noticeTitle) noticeTitle.textContent = 'Leave/Holiday Access Hidden';
      if (noticeBody) noticeBody.textContent = 'This employee is marked as fractional, so leave policy and leave workflow are not available.';
    }

    if (getActiveScreenId() === 'leave-center') {
      activateScreen('daily-tasklist');
    }
  } else {
    leaveNavButton?.classList.remove('hidden');
    leaveCenterContent?.classList.remove('hidden');
    fractionalLeaveNotice?.classList.add('hidden');
  }
}

if (profileTeamSelect) {
  profileTeamSelect.addEventListener('change', (event) => {
    const value = normalizeTeamName(event.target.value, TEAM_AM);
    const profile = selectedEmployeeRecord();
    profile.team = value;
    setSelectedEmployee(state.currentEmployee);
    setProfileSaveNotice('Unsaved changes. Click Save Profile.', 'status warn');
  });
}

if (profileEmploymentType) {
  profileEmploymentType.addEventListener('change', (event) => {
    const value = event.target.value;
    const profile = selectedEmployeeRecord();
    profile.employmentType = value;
    setSelectedEmployee(state.currentEmployee);
    setProfileSaveNotice('Unsaved changes. Click Save Profile.', 'status warn');
  });
}

if (profileAccessLevel) {
  profileAccessLevel.addEventListener('change', () => {
    setProfileSaveNotice('Unsaved changes. Click Save Profile.', 'status warn');
  });
}

if (profileManagerSelect) {
  profileManagerSelect.addEventListener('change', () => {
    setProfileSaveNotice('Unsaved changes. Click Save Profile.', 'status warn');
  });
}

document.querySelectorAll('.collapsible-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = btn.closest('.collapsible-panel');
    if (!panel) return;
    const isCollapsed = panel.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!isCollapsed));
  });
});

if (profileNameInput) {
  profileNameInput.addEventListener('input', () => {
    setProfileSaveNotice('Unsaved changes. Click Save Profile.', 'status warn');
  });
}

if (profileCapacityInput) {
  profileCapacityInput.addEventListener('input', () => {
    setProfileSaveNotice('Unsaved changes. Click Save Profile.', 'status warn');
  });
}

if (profilePeriod) {
  profilePeriod.addEventListener('change', renderProfileProjects);
}

if (profileWeekFilter) {
  profileWeekFilter.addEventListener('change', () => {
    state.profileWeekKey = profileWeekFilter.value || '';
    applySelectedEmployeeAllocationSnapshot(state.profileAllocationRows || []);
  });
}

if (saveProfileBtn) {
  saveProfileBtn.addEventListener('click', () => {
    saveCurrentProfile().catch((error) => {
      console.error(error);
      setProfileSaveNotice(`Unable to save profile: ${error.message}`, 'status error');
    });
  });
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('.employee-link');
  if (!link) return;
  const target = link.dataset.employee;
  if (!target) return;
  if (!isLeadershipRole() && target !== state.currentEmployee) return;
  setSelectedEmployee(target);
  navigateToScreen('employee-profile');
});

/* ── Invoice System ─────────────────────────────────────────────── */
state.invoices = [];
state.invoicePendingFiles = [];

// Invoice Center (viewer-only checklist)
const invoiceTeamChecklist = document.getElementById('invoiceTeamChecklist');
const invoiceFilterMonth = document.getElementById('invoiceFilterMonth');
const invoiceNavButton = document.getElementById('invoiceNavButton');

// Profile invoice upload
const profileInvoicePanel = document.getElementById('profileInvoicePanel');
const profileInvoiceDropzone = document.getElementById('profileInvoiceDropzone');
const profileInvoiceFileInput = document.getElementById('profileInvoiceFileInput');
const profileInvoiceFileLabel = document.getElementById('profileInvoiceFileLabel');
const profileInvoiceType = document.getElementById('profileInvoiceType');
const profileInvoiceMonth = document.getElementById('profileInvoiceMonth');
const profileInvoiceUploadBtn = document.getElementById('profileInvoiceUploadBtn');
const profileInvoiceNotice = document.getElementById('profileInvoiceNotice');
const profileInvoiceStatus = document.getElementById('profileInvoiceStatus');
const profileInvoiceHistory = document.getElementById('profileInvoiceHistory');

function setProfileInvoiceNotice(msg, className) {
  if (!profileInvoiceNotice) return;
  profileInvoiceNotice.textContent = msg;
  profileInvoiceNotice.className = className || 'mini-meta';
}

function currentInvoiceMonth() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

function formatInvoiceMonth(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[parseInt(m, 10) - 1] + ' ' + y;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function applyInvoiceVisibility() {
  const viewer = isInvoiceViewer();
  if (invoiceNavButton) {
    invoiceNavButton.classList.toggle('hidden', !viewer);
  }
  const invoiceScreen = document.getElementById('invoice-center');
  if (invoiceScreen) {
    invoiceScreen.classList.toggle('hidden', !viewer);
  }
}

function applyDealFlowVisibility() {
  const canView = isDealFlowViewer();
  const dealNav = document.getElementById('dealFlowNavButton');
  if (dealNav) dealNav.classList.toggle('hidden', !canView);
  const dealScreen = document.getElementById('bd-pipeline');
  if (dealScreen) dealScreen.classList.toggle('hidden', !canView);
}

// Briefs are GA-team-only (29 Jul 2026): reviewers + leadership always;
// other employees only if they are allocated to the brief's client (12 Sep
// 2026) or have a deliverable assigned (checked via an RLS-scoped head-count —
// RLS is the boundary, this just hides the tab).
function applyBriefsVisibility() {
  if (isPartnerRole()) return; // partner branch owns partner nav
  const briefsNav = document.getElementById('briefsNavButton');
  const briefsScreen = document.getElementById('briefs-pipeline');
  const show = (visible) => {
    if (briefsNav) briefsNav.classList.toggle('hidden', !visible);
    if (briefsScreen) briefsScreen.classList.toggle('hidden', !visible);
  };
  if (isBriefReviewer()) { show(true); return; }
  show(false);
  if (!state.supabase || !state.currentEmployeeId) return;
  state.supabase.from('briefs').select('id', { count: 'exact', head: true })
    .then(({ count, error }) => { if (!error && (count || 0) > 0) show(true); })
    .catch(() => {});
}

// Invoice Center password gate — one unlock per session
const INVOICE_PIN_HASH = 'aa645668ba1018e0a7fe1d84993cb3be3f9d01e0ee4ed959b6bc97845e340439';
let invoiceUnlocked = false;

async function hashPin(pin) {
  const encoded = new TextEncoder().encode(pin);
  const buffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkInvoiceAccess() {
  if (invoiceUnlocked) return true;
  const pin = await appPrompt('Enter the Invoice Center PIN to continue.', {
    title: 'Invoice Center',
    type: 'password',
    placeholder: 'PIN',
    okLabel: 'Unlock'
  });
  if (!pin) return false;
  const hash = await hashPin(pin.trim());
  if (hash === INVOICE_PIN_HASH) {
    invoiceUnlocked = true;
    return true;
  }
  await appAlert('Incorrect PIN.', { title: 'Invoice Center' });
  return false;
}

async function loadInvoices() {
  if (!state.supabase || !state.isAuthenticated) {
    state.invoices = [];
    renderInvoiceChecklist();
    renderProfileInvoicePanel();
    return;
  }

  applyInvoiceVisibility();

  const response = await state.supabase
    .from('invoices')
    .select('id, employee_id, invoice_month, invoice_type, file_name, file_path, file_size_bytes, uploaded_at, notes, employee:employees!invoices_employee_id_fkey(full_name)')
    .order('uploaded_at', { ascending: false });

  if (response.error) {
    console.error('Invoice load error:', response.error);
    return;
  }

  state.invoices = (response.data || []).map(inv => ({
    ...inv,
    employee_name: inv.employee?.full_name || 'Unknown'
  }));

  if (invoiceFilterMonth && !invoiceFilterMonth.value) {
    invoiceFilterMonth.value = currentInvoiceMonth();
  }

  renderInvoiceChecklist();
  renderProfileInvoicePanel();
}

// ── Invoice Center: viewer-only team checklist ──

function renderInvoiceChecklist() {
  if (!invoiceTeamChecklist || !isInvoiceViewer()) return;

  const filterMonth = invoiceFilterMonth?.value || currentInvoiceMonth();
  const employees = state.employeeDirectory
    .filter(e => e.department?.leave_tracking_enabled !== false)
    .filter(e => !getInvoiceExcludedEmails().includes(normalizeEmail(e.email || '')))
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

  const monthInvoices = state.invoices.filter(inv => inv.invoice_month === filterMonth);
  const uploadsByEmp = {};
  monthInvoices.forEach(inv => {
    if (!uploadsByEmp[inv.employee_id]) uploadsByEmp[inv.employee_id] = { invoices: [], reimbursements: [] };
    if (inv.invoice_type === 'reimbursement') {
      uploadsByEmp[inv.employee_id].reimbursements.push(inv);
    } else {
      uploadsByEmp[inv.employee_id].invoices.push(inv);
    }
  });

  const submitted = employees.filter(e => uploadsByEmp[e.id]?.invoices.length).length;
  const reimbursementCount = employees.filter(e => uploadsByEmp[e.id]?.reimbursements.length).length;

  function renderFileButtons(files, emptyLabel) {
    if (!files.length) return `<span class="mini-meta">${emptyLabel}</span>`;
    return files.map(inv => `<button class="ghost invoice-download-btn" data-path="${escapeHtml(inv.file_path)}" type="button" title="${escapeHtml(inv.file_name)}">${escapeHtml(inv.file_name.length > 18 ? inv.file_name.slice(0, 15) + '...' : inv.file_name)}</button>`).join('');
  }

  invoiceTeamChecklist.innerHTML =
    `<p class="mini-meta" style="margin-bottom:var(--space-3)">${submitted} of ${employees.length} invoices submitted${reimbursementCount ? `, ${reimbursementCount} reimbursement${reimbursementCount > 1 ? 's' : ''}` : ''} for ${formatInvoiceMonth(filterMonth)}</p>` +
    `<div class="invoice-checklist-header">
      <span class="invoice-checklist-name">Name</span>
      <span class="invoice-checklist-col">Invoice</span>
      <span class="invoice-checklist-col">Reimbursement</span>
    </div>` +
    employees.map(emp => {
      const empData = uploadsByEmp[emp.id] || { invoices: [], reimbursements: [] };
      const hasInvoice = empData.invoices.length > 0;
      return `<div class="invoice-checklist-row">
        <span class="invoice-checklist-name ${hasInvoice ? 'submitted' : ''}">${escapeHtml(emp.full_name || 'Unknown')}</span>
        <div class="invoice-checklist-col">${renderFileButtons(empData.invoices, '—')}</div>
        <div class="invoice-checklist-col">${renderFileButtons(empData.reimbursements, '—')}</div>
      </div>`;
    }).join('');
}

// ── Profile: invoice upload panel ──

function renderProfileInvoicePanel() {
  if (!profileInvoicePanel) return;

  // Only show on own profile for non-finance, non-excluded employees
  const isOwnProfile = state.selectedEmployeeId === state.currentEmployeeId || !state.selectedEmployeeId;
  const finance = isFinanceUser();
  const excludedFromInvoice = getInvoiceExcludedEmails().includes(normalizeEmail(state.session?.user?.email || ''));
  if (!isOwnProfile || finance || excludedFromInvoice || !state.isAuthenticated) {
    profileInvoicePanel.style.display = 'none';
    return;
  }
  profileInvoicePanel.style.display = '';

  if (profileInvoiceMonth && !profileInvoiceMonth.value) {
    profileInvoiceMonth.value = currentInvoiceMonth();
  }

  const empId = state.currentEmployeeId;
  const myInvoices = state.invoices.filter(inv => inv.employee_id === empId);

  // Current month status
  const curMonth = currentInvoiceMonth();
  const thisMonthUploads = myInvoices.filter(inv => inv.invoice_month === curMonth);
  if (profileInvoiceStatus) {
    if (thisMonthUploads.length) {
      profileInvoiceStatus.textContent = `${thisMonthUploads.length} file${thisMonthUploads.length > 1 ? 's' : ''} uploaded for ${formatInvoiceMonth(curMonth)}`;
      profileInvoiceStatus.classList.remove('warn');
      profileInvoiceStatus.classList.add('status');
    } else {
      profileInvoiceStatus.textContent = `No invoice uploaded for ${formatInvoiceMonth(curMonth)} yet`;
      profileInvoiceStatus.classList.remove('status');
      profileInvoiceStatus.classList.add('warn');
    }
  }

  // Upload history
  if (profileInvoiceHistory) {
    if (!myInvoices.length) {
      profileInvoiceHistory.innerHTML = '';
    } else {
      const sorted = [...myInvoices].sort((a, b) => b.invoice_month.localeCompare(a.invoice_month) || new Date(b.uploaded_at) - new Date(a.uploaded_at));
      profileInvoiceHistory.innerHTML = sorted.map(inv => renderInvoiceRow(inv)).join('');
    }
  }
}

function renderInvoiceRow(inv) {
  const dateStr = new Date(inv.uploaded_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const sizeStr = formatFileSize(inv.file_size_bytes);
  const typeLabel = inv.invoice_type === 'reimbursement' ? 'Reimbursement' : 'Invoice';
  return `<div class="invoice-row">
    <span class="invoice-row-name">${escapeHtml(inv.file_name)}</span>
    <span class="invoice-row-meta">${typeLabel}</span>
    <span class="invoice-row-meta">${formatInvoiceMonth(inv.invoice_month)}</span>
    <span class="invoice-row-meta">${dateStr}</span>
    <span class="invoice-row-meta">${sizeStr}</span>
    <span class="invoice-row-actions">
      <button class="ghost invoice-download-btn" data-path="${escapeHtml(inv.file_path)}" type="button">Download</button>
      <button class="ghost invoice-delete-btn" data-id="${inv.id}" data-path="${escapeHtml(inv.file_path)}" type="button" style="color:var(--bad)">Delete</button>
    </span>
  </div>`;
}

function renderInvoiceCard(inv, showDelete) {
  const uploaded = new Date(inv.uploaded_at);
  const dateStr = uploaded.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const sizeStr = formatFileSize(inv.file_size_bytes);
  const nameLabel = showDelete ? '' : `<strong>${escapeHtml(inv.employee_name)}</strong> &middot; `;
  const typeLabel = inv.invoice_type === 'reimbursement' ? 'Reimbursement &middot; ' : '';
  const notesHtml = inv.notes ? ` &middot; ${escapeHtml(inv.notes)}` : '';

  return `<div class="invoice-card">
    <div class="invoice-info">
      <div class="invoice-file-name">${escapeHtml(inv.file_name)}</div>
      <div class="invoice-meta">${nameLabel}${typeLabel}${dateStr}${sizeStr ? ' &middot; ' + sizeStr : ''}${notesHtml}</div>
    </div>
    <div class="invoice-actions">
      <button class="ghost invoice-download-btn" data-path="${escapeHtml(inv.file_path)}" type="button">Download</button>
      ${showDelete ? `<button class="ghost invoice-delete-btn" data-id="${inv.id}" data-path="${escapeHtml(inv.file_path)}" type="button" style="color:var(--bad)">Delete</button>` : ''}
    </div>
  </div>`;
}

function handleInvoiceFileSelect(files) {
  const MAX_SIZE = 10 * 1024 * 1024;
  const allowed = ['.pdf','.png','.jpg','.jpeg','.doc','.docx','.xls','.xlsx'];

  for (const file of files) {
    if (file.size > MAX_SIZE) {
      setProfileInvoiceNotice(`${file.name} exceeds 10 MB limit.`, 'mini-meta status error');
      continue;
    }
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      setProfileInvoiceNotice(`${file.name}: unsupported file type.`, 'mini-meta status error');
      continue;
    }
    state.invoicePendingFiles.push(file);
  }
  renderPendingInvoiceFiles();
}

function renderPendingInvoiceFiles() {
  if (!state.invoicePendingFiles.length) {
    if (profileInvoiceFileLabel) profileInvoiceFileLabel.textContent = 'Choose file';
    if (profileInvoiceUploadBtn) profileInvoiceUploadBtn.disabled = true;
    return;
  }
  if (profileInvoiceUploadBtn) profileInvoiceUploadBtn.disabled = false;
  const names = state.invoicePendingFiles.map(f => f.name);
  if (profileInvoiceFileLabel) {
    profileInvoiceFileLabel.textContent = names.length === 1 ? names[0] : `${names.length} files`;
  }
}

async function uploadProfileInvoices() {
  if (!state.invoicePendingFiles.length) return;
  const month = profileInvoiceMonth?.value;
  if (!month) {
    setProfileInvoiceNotice('Please select a month.', 'mini-meta status error');
    return;
  }
  const invoiceType = profileInvoiceType?.value || 'invoice';

  const empId = state.currentEmployeeId;
  if (!empId) {
    setProfileInvoiceNotice('Employee profile not loaded.', 'mini-meta status error');
    return;
  }

  if (profileInvoiceUploadBtn) profileInvoiceUploadBtn.disabled = true;
  setProfileInvoiceNotice('Uploading...', 'mini-meta');

  let uploaded = 0;

  for (const file of state.invoicePendingFiles) {
    const filePath = `${empId}/${month}/${Date.now()}_${file.name}`;

    const { error: storageError } = await state.supabase.storage
      .from('invoices')
      .upload(filePath, file, { upsert: false });

    if (storageError) {
      console.error('Storage upload error:', storageError);
      setProfileInvoiceNotice(`Upload failed for ${file.name}: ${storageError.message}`, 'mini-meta status error');
      continue;
    }

    const { error: dbError } = await state.supabase
      .from('invoices')
      .insert({
        employee_id: empId,
        invoice_month: month,
        invoice_type: invoiceType,
        file_name: file.name,
        file_path: filePath,
        file_size_bytes: file.size
      });

    if (dbError) {
      console.error('Invoice DB insert error:', dbError);
      setProfileInvoiceNotice(`Saved file but failed to record ${file.name}: ${dbError.message}`, 'mini-meta status error');
      continue;
    }
    uploaded++;
  }

  state.invoicePendingFiles = [];
  renderPendingInvoiceFiles();
  if (uploaded > 0) {
    setProfileInvoiceNotice(`${uploaded} file${uploaded > 1 ? 's' : ''} uploaded successfully.`, 'mini-meta status');
  }
  loadInvoices().catch(console.error);
}

async function downloadInvoice(filePath) {
  const { data, error } = await state.supabase.storage
    .from('invoices')
    .createSignedUrl(filePath, 300);

  if (error) {
    console.error('Download URL error:', error);
    return;
  }
  window.open(data.signedUrl, '_blank');
}

async function deleteInvoice(invoiceId, filePath) {
  if (!await appConfirm('Delete this invoice? This cannot be undone.', { title: 'Delete invoice', confirmLabel: 'Delete', danger: true })) return;

  const { error: storageErr } = await state.supabase.storage
    .from('invoices')
    .remove([filePath]);

  if (storageErr) console.error('Storage delete error:', storageErr);

  const { error: dbErr } = await state.supabase
    .from('invoices')
    .delete()
    .eq('id', invoiceId);

  if (dbErr) {
    console.error('Invoice delete error:', dbErr);
    return;
  }

  loadInvoices().catch(console.error);
}

// Profile invoice upload events
if (profileInvoiceFileInput) {
  profileInvoiceFileInput.addEventListener('change', () => {
    if (profileInvoiceFileInput.files.length) {
      handleInvoiceFileSelect(profileInvoiceFileInput.files);
      profileInvoiceFileInput.value = '';
    }
  });
}

if (profileInvoiceUploadBtn) {
  profileInvoiceUploadBtn.addEventListener('click', () => {
    uploadProfileInvoices().catch(console.error);
  });
}

// Download & delete delegation (global)
document.addEventListener('click', (e) => {
  const dlBtn = e.target.closest('.invoice-download-btn');
  if (dlBtn) {
    downloadInvoice(dlBtn.dataset.path).catch(console.error);
    return;
  }
  const delBtn = e.target.closest('.invoice-delete-btn');
  if (delBtn) {
    deleteInvoice(delBtn.dataset.id, delBtn.dataset.path).catch(console.error);
  }
});

// Invoice Center filter
if (invoiceFilterMonth) {
  invoiceFilterMonth.addEventListener('change', () => renderInvoiceChecklist());
}

// ══════════════════════════════════════════════════════════════════════
// ── Deal Flow / BD Pipeline ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

const DEAL_STAGES = [
  { key: 'qualified', label: 'Qualifying', prob: '20%' },
  { key: 'discovery', label: 'Discovery', prob: '50%' },
  { key: 'proposal', label: 'Proposal', prob: '70%' },
  { key: 'negotiated', label: 'Negotiating', prob: '90%' },
  { key: 'contracted', label: 'Contracted', prob: '100%' },
  { key: 'stalled', label: 'Stalled', prob: '0%' },
  { key: 'closedlost', label: 'Lost', prob: '0%' },
];
const DEAL_OPEN_STAGES = ['qualified', 'discovery', 'proposal', 'negotiated'];
const DEAL_STAGE_LABEL = Object.fromEntries(DEAL_STAGES.map(s => [s.key, s.label]));

// DOM refs
const dealBoard = document.getElementById('dealBoard');
const dealListBody = document.getElementById('dealListBody');
const dealListHead = document.getElementById('dealListHead');
const dealListWrap = document.getElementById('dealListWrap');
const dealSectionBody = document.getElementById('dealSectionBody');
const dealSectionHead = document.getElementById('dealSectionHead');
const dealSectionTableWrap = document.getElementById('dealSectionTableWrap');
const dealStatsBar = document.getElementById('dealStatsBar');
const dealSectionTabs = document.getElementById('dealSectionTabs');
const dealFilters = document.getElementById('dealFilters');
const dealFilterPoc = document.getElementById('dealFilterPoc');
const dealSearchInput = document.getElementById('dealSearchInput');
const dealCompanySelect = document.getElementById('dealCompanySelect');

// Returns deals filtered by selected company
function getCompanyDeals() {
  return state.deals.filter(d => (d.company || 'Your Agency') === state.dealCompany);
}
const dealViewBoard = document.getElementById('dealViewBoard');
const dealViewList = document.getElementById('dealViewList');
const dealAddBtn = document.getElementById('dealAddBtn');
const dealDetailPanel = document.getElementById('dealDetailPanel');
const dealDetailInner = document.getElementById('dealDetailInner');
const dealDetailBackdrop = document.getElementById('dealDetailBackdrop');

let dealSortCol = 'deal_name';
let dealSortAsc = true;

// ── Load deals ──
async function loadDealsFromSupabase() {
  if (!state.supabase || !state.isAuthenticated) return;
  const { data, error } = await state.supabase
    .from('deals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) {
    console.error('Failed to load deals:', error.message);
    return;
  }
  state.deals = data || [];
  renderDealFlow();
}

// ── Master render ──
function renderDealFlow() {
  renderDealStats();
  renderDealPocFilter();
  const filter = state.dealFilter;
  const isOpen = filter === 'open';

  // Hide section tabs — stats bar is the nav now
  if (dealSectionTabs) dealSectionTabs.style.display = 'none';

  // Show/hide board vs list — force list for non-open filters (stalled/contracted/lost have no Kanban columns)
  const canShowBoard = isOpen || filter === 'overdue';
  const showBoard = canShowBoard && state.dealView === 'board';
  if (dealBoard) dealBoard.style.display = showBoard ? '' : 'none';
  if (dealListWrap) dealListWrap.style.display = showBoard ? 'none' : '';
  if (dealSectionTableWrap) dealSectionTableWrap.style.display = 'none';
  if (dealFilters) dealFilters.style.display = '';

  // View toggle always visible, highlight selected
  if (dealViewBoard) {
    dealViewBoard.classList.toggle('active', state.dealView === 'board');
  }
  if (dealViewList) {
    dealViewList.classList.toggle('active', state.dealView === 'list');
  }

  const filtered = isOpen ? getFilteredHotDeals() : getFilteredDealsByFilter(filter);
  if (showBoard) {
    renderDealBoard(filtered);
  } else if (filter === 'active' || filter === 'archived') {
    renderContractedListView(filtered, filter);
  } else {
    renderDealListView(filtered);
  }
}

function getFilteredHotDeals() {
  let deals = getCompanyDeals().filter(d => DEAL_OPEN_STAGES.includes(d.stage));
  if (state.dealFilterPoc) {
    deals = deals.filter(d => d.poc_employee_id === state.dealFilterPoc);
  }
  if (state.dealSearch) {
    const q = state.dealSearch.toLowerCase();
    deals = deals.filter(d => d.deal_name.toLowerCase().includes(q));
  }
  return deals;
}

function getFilteredDealsByFilter(filter) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const companyDeals = getCompanyDeals();
  const hot = companyDeals.filter(d => DEAL_OPEN_STAGES.includes(d.stage));

  let deals;
  switch (filter) {
    case 'overdue':
      deals = hot.filter(d => d.deadline && d.deadline < todayStr); break;
    case 'stalled':
      deals = companyDeals.filter(d => d.stage === 'stalled'); break;
    case 'active':
    case 'archived':
      deals = companyDeals.filter(d => d.stage === 'contracted').sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')); break;
    case 'lost':
      deals = companyDeals.filter(d => d.stage === 'closedlost').sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')); break;
    default:
      deals = hot;
  }
  // Apply POC and search filters
  if (state.dealFilterPoc) {
    deals = deals.filter(d => d.poc_employee_id === state.dealFilterPoc);
  }
  if (state.dealSearch) {
    const q = state.dealSearch.toLowerCase();
    deals = deals.filter(d => d.deal_name && d.deal_name.toLowerCase().includes(q));
  }
  return deals;
}

// ── Stats bar ──
function renderDealStats() {
  if (!dealStatsBar) return;
  const companyDeals = getCompanyDeals();
  const hot = companyDeals.filter(d => DEAL_OPEN_STAGES.includes(d.stage));
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  const overdue = hot.filter(d => d.deadline && d.deadline < todayStr).length;
  const stalledDeals = companyDeals.filter(d => d.stage === 'stalled');
  const stalled = stalledDeals.length;
  const stalledHasFollowup = stalledDeals.some(d => d.deadline);
  const { active: activeContracted, archived: archivedContracted } = partitionContractedDeals(companyDeals);
  const lost = companyDeals.filter(d => d.stage === 'closedlost').length;

  // Color logic: Open = always yellow, Stalled = red if follow-up date exists, Contracted = green
  const openClass = ' deal-stat-warn';
  const stalledClass = stalledHasFollowup ? ' deal-stat-bad' : '';
  const contractedClass = ' deal-stat-good';

  const f = state.dealFilter;
  dealStatsBar.innerHTML = `
    <div class="deal-stat deal-stat-link${f === 'open' ? ' deal-stat-active' : ''}${openClass}" data-filter="open"><span class="deal-stat-num">${hot.length}</span><span class="deal-stat-label">Open Deals</span></div>
    <div class="deal-stat deal-stat-link${f === 'overdue' ? ' deal-stat-active' : ''}${overdue ? ' deal-stat-bad' : ''}" data-filter="overdue"><span class="deal-stat-num">${overdue}</span><span class="deal-stat-label">Overdue</span></div>
    <div class="deal-stat deal-stat-link${f === 'stalled' ? ' deal-stat-active' : ''}${stalledClass}" data-filter="stalled"><span class="deal-stat-num">${stalled}</span><span class="deal-stat-label">Stalled</span></div>
    <div class="deal-stat deal-stat-link${f === 'active' ? ' deal-stat-active' : ''}${contractedClass}" data-filter="active"><span class="deal-stat-num">${activeContracted.length}</span><span class="deal-stat-label">Active</span></div>
    <div class="deal-stat deal-stat-link${f === 'lost' ? ' deal-stat-active' : ''}" data-filter="lost"><span class="deal-stat-num">${lost}</span><span class="deal-stat-label">Lost</span></div>
    <div class="deal-stat deal-stat-link${f === 'archived' ? ' deal-stat-active' : ''}" data-filter="archived"><span class="deal-stat-num">${archivedContracted.length}</span><span class="deal-stat-label">Archived</span></div>
  `;
}

// ── POC filter ──
const DEAL_POC_EMAILS = ['admin@youragency.com']; // POCs reassigned to Alex only (14 Jun)

function getDealPocEmployees() {
  return state.employeeDirectory.filter(e => DEAL_POC_EMAILS.includes(normalizeEmail(e.email)));
}

function renderDealPocFilter() {
  if (!dealFilterPoc) return;
  // Only show POCs who actually have deals assigned
  const assignedPocIds = [...new Set(getCompanyDeals().filter(d => d.poc_employee_id).map(d => d.poc_employee_id))];
  const pocEmps = state.employeeDirectory.filter(e => assignedPocIds.includes(e.id));
  let html = '<option value="">All POCs</option>';
  pocEmps.forEach(emp => {
    html += `<option value="${emp.id}"${state.dealFilterPoc === emp.id ? ' selected' : ''}>${escapeHtml(emp.full_name)}</option>`;
  });
  dealFilterPoc.innerHTML = html;
}

// ── Deal value helpers ──
function dealAmountInINR(deal) {
  if (!deal.amount) return 0;
  const amt = parseFloat(deal.amount);
  if (isNaN(amt)) return 0;
  const inr = deal.currency === 'USD' ? amt * 90 : amt;
  return deal.engagement_type === 'Retainer' ? inr * 6 : inr;
}

function formatLakhs(inr) {
  if (!inr) return '—';
  const lakhs = inr / 100000;
  if (lakhs >= 100) return Math.round(lakhs).toLocaleString('en-IN') + 'L';
  if (lakhs >= 10) return lakhs.toFixed(1).replace(/\.0$/, '') + 'L';
  return lakhs.toFixed(2).replace(/\.?0+$/, '') + 'L';
}

function totalDealsInLakhs(deals) {
  const total = deals.reduce((sum, d) => sum + dealAmountInINR(d), 0);
  return total ? formatLakhs(total) : '';
}

// ── Board view (Kanban) ──
const BOARD_SORT_OPTIONS = [
  { key: 'deadline', label: 'Deadline' },
  { key: 'updated_at', label: 'Modified' },
  { key: 'amount', label: 'Amount' },
];
// Per-column sort state: { stageKey: 'deadline' | 'updated_at' | 'amount' }
const boardColumnSort = {};

function sortDealsForBoard(deals, sortKey) {
  return [...deals].sort((a, b) => {
    if (sortKey === 'deadline') {
      // Deals with deadline first (soonest on top), no deadline at bottom
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline.localeCompare(b.deadline);
    } else if (sortKey === 'amount') {
      return dealAmountInINR(b) - dealAmountInINR(a);
    } else {
      // updated_at — most recent first
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    }
  });
}

function renderDealBoard(deals) {
  if (!dealBoard) return;
  let html = '';
  DEAL_OPEN_STAGES.forEach(stageKey => {
    const sortKey = boardColumnSort[stageKey] || 'deadline';
    const stageDeals = sortDealsForBoard(deals.filter(d => d.stage === stageKey), sortKey);
    const label = DEAL_STAGE_LABEL[stageKey];
    const value = totalDealsInLakhs(stageDeals);
    const sortLabel = BOARD_SORT_OPTIONS.find(o => o.key === sortKey)?.label || 'Deadline';
    html += `<div class="deal-col" data-stage="${stageKey}">
      <div class="deal-col-header">
        <span class="deal-col-title">${label}</span>
        <span class="deal-col-count">${value}</span>
        <button class="deal-col-sort-btn" data-stage="${stageKey}" title="Sort by">${sortLabel} ▾</button>
      </div>
      <div class="deal-col-body" data-stage="${stageKey}">`;
    stageDeals.forEach(d => { html += renderDealCard(d); });
    html += `</div></div>`;
  });
  dealBoard.innerHTML = html;
  initDealDragAndDrop();

  // Sort button click handlers
  dealBoard.querySelectorAll('.deal-col-sort-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const stage = btn.dataset.stage;
      const currentSort = boardColumnSort[stage] || 'deadline';
      const currentIdx = BOARD_SORT_OPTIONS.findIndex(o => o.key === currentSort);
      const nextIdx = (currentIdx + 1) % BOARD_SORT_OPTIONS.length;
      boardColumnSort[stage] = BOARD_SORT_OPTIONS[nextIdx].key;
      renderDealBoard(deals);
    });
  });
}

function renderDealCard(deal) {
  const deadlineClass = getDealDeadlineClass(deal.deadline);
  const deadlineLabel = deal.deadline ? formatDealDate(deal.deadline) : '';
  const engBadge = deal.engagement_type ? `<span class="deal-badge deal-badge-${deal.engagement_type.toLowerCase()}">${escapeHtml(deal.engagement_type)}</span>` : '';

  return `<div class="deal-card" draggable="true" data-deal-id="${deal.id}">
    <div class="deal-card-top">
      <span class="deal-card-name">${escapeHtml(deal.deal_name)}</span>
    </div>
    <div class="deal-card-bottom">
      ${engBadge || '<span></span>'}
      ${deadlineLabel ? `<span class="deal-card-deadline ${deadlineClass}">${deadlineLabel}</span>` : ''}
    </div>
  </div>`;
}

// "Due soon" counts WORKING days, not calendar days (24 Aug 2026):
// a deadline five days out over a long weekend is far closer than it looks,
// and the old calendar count let weekends and holidays eat the warning window.
const DEAL_DUE_SOON_WORKING_DAYS = 5;

function getDealDeadlineClass(deadline) {
  if (!deadline) return '';
  const todayStr = toISODateLocal();
  if (deadline < todayStr) return 'deal-overdue';
  const left = workingDaysBetween(todayStr, deadline, holidayDates());
  if (left !== null && left <= DEAL_DUE_SOON_WORKING_DAYS) return 'deal-due-soon';
  return '';
}

function formatDealDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// ── Drag and drop ──
function initDealDragAndDrop() {
  if (!dealBoard) return;
  const cards = dealBoard.querySelectorAll('.deal-card');
  const cols = dealBoard.querySelectorAll('.deal-col-body');

  cards.forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.dealId);
      card.classList.add('deal-card-dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('deal-card-dragging');
      cols.forEach(c => c.classList.remove('deal-col-drop-target'));
    });
  });

  cols.forEach(col => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('deal-col-drop-target');
    });
    col.addEventListener('dragleave', () => {
      col.classList.remove('deal-col-drop-target');
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('deal-col-drop-target');
      const dealId = e.dataTransfer.getData('text/plain');
      const newStage = col.dataset.stage;
      if (!dealId || !newStage) return;
      await updateDealStage(dealId, newStage);
    });
  });
}

async function updateDealStage(dealId, newStage) {
  const deal = state.deals.find(d => d.id === dealId);
  if (!deal || deal.stage === newStage) return;
  const oldStage = deal.stage;

  // If moving to a closing stage, confirm
  if (newStage === 'contracted' || newStage === 'closedlost' || newStage === 'stalled') {
    const label = DEAL_STAGE_LABEL[newStage];
    if (!await appConfirm(`Move "${deal.deal_name}" to ${label}?`)) return;
  }

  const { error } = await state.supabase
    .from('deals')
    .update({ stage: newStage })
    .eq('id', dealId);
  if (error) {
    console.error('Stage update failed:', error.message);
    return;
  }

  // Log stage change
  const histInsert = await state.supabase.from('deal_stage_history').insert({
    deal_id: dealId,
    stage: newStage,
    changed_by: state.currentEmployeeId
  });
  if (histInsert.error) console.error('Stage history insert failed:', histInsert.error.message);

  // Close previous stage history entry
  const { data: prevEntries } = await state.supabase
    .from('deal_stage_history')
    .select('id')
    .eq('deal_id', dealId)
    .eq('stage', oldStage)
    .is('exited_at', null);
  if (prevEntries?.length) {
    const exitRes = await state.supabase
      .from('deal_stage_history')
      .update({ exited_at: new Date().toISOString() })
      .in('id', prevEntries.map(e => e.id));
    if (exitRes.error) console.error('Stage history exit failed:', exitRes.error.message);
  }

  await loadDealsFromSupabase();

  // If contracted, offer to link/create client
  if (newStage === 'contracted') {
    offerClientLinking(deal);
  }
}

async function offerClientLinking(deal) {
  const action = await appChoice(`"${deal.deal_name}" is now Closed Won! Add it to the client registry?`, {
    title: 'Deal won 🎉',
    choices: [
      { label: 'Create a new client entry', value: 'new', variant: 'primary' },
      { label: 'Link to an existing client', value: 'link' }
    ],
    cancelLabel: 'Skip for now'
  });
  if (action === 'new') {
    createClientFromDeal(deal);
  } else if (action === 'link') {
    linkDealToExistingClient(deal);
  }
}

async function createClientFromDeal(deal) {
  const { data, error } = await state.supabase
    .from('clients')
    .insert({ name: deal.deal_name, account_owner_employee_id: deal.poc_employee_id, is_active: true })
    .select()
    .single();
  if (error) {
    console.error('Failed to create client:', error.message);
    await appAlert('Failed to create client: ' + error.message, { title: 'Deal Flow' });
    return;
  }
  const linkRes = await state.supabase.from('deals').update({ client_id: data.id }).eq('id', deal.id);
  if (linkRes.error) { await appAlert('Client created but failed to link deal: ' + linkRes.error.message, { title: 'Deal Flow' }); }
  else { await appAlert(`Client "${deal.deal_name}" created and linked!`, { title: 'Deal Flow' }); }
  await loadDealsFromSupabase();
}

async function linkDealToExistingClient(deal) {
  const activeClients = state.clients.filter(c => c.is_active);
  const chosenId = await appChoice('Choose the client to link this deal to:', {
    title: 'Link deal to client',
    choices: activeClients.map(c => ({ label: c.name, value: c.id }))
  });
  if (!chosenId) return;
  const match = activeClients.find(c => c.id === chosenId);
  if (!match) return;
  const linkRes2 = await state.supabase.from('deals').update({ client_id: match.id }).eq('id', deal.id);
  if (linkRes2.error) { await appAlert('Failed to link deal: ' + linkRes2.error.message, { title: 'Deal Flow' }); }
  else { await appAlert(`Deal linked to "${match.name}"!`, { title: 'Deal Flow' }); }
  await loadDealsFromSupabase();
}

// ── List view ──
function renderDealListView(deals) {
  if (!dealListHead || !dealListBody) return;
  const cols = [
    { key: 'deal_name', label: 'Deal' },
    { key: 'stage', label: 'Stage' },
    { key: 'poc', label: 'POC' },
    { key: 'next_steps', label: 'Next Steps' },
    { key: 'deadline', label: 'Deadline' },
    { key: 'engagement_type', label: 'Type' },
    { key: 'business_model', label: 'Model' },
    { key: 'updated_at', label: 'Updated' },
  ];
  dealListHead.innerHTML = '<tr>' + cols.map(c =>
    `<th class="deal-th${dealSortCol === c.key ? ' sorted' : ''}" data-col="${c.key}">${c.label}${dealSortCol === c.key ? (dealSortAsc ? ' ↑' : ' ↓') : ''}</th>`
  ).join('') + '</tr>';

  const sorted = [...deals].sort((a, b) => {
    let va = a[dealSortCol] || '';
    let vb = b[dealSortCol] || '';
    if (dealSortCol === 'poc') {
      const ea = lookupEmployee(a.poc_employee_id);
      const eb = lookupEmployee(b.poc_employee_id);
      va = ea?.full_name || '';
      vb = eb?.full_name || '';
    }
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return dealSortAsc ? -1 : 1;
    if (va > vb) return dealSortAsc ? 1 : -1;
    return 0;
  });

  dealListBody.innerHTML = sorted.map(d => {
    const poc = lookupEmployee(d.poc_employee_id);
    const deadlineClass = getDealDeadlineClass(d.deadline);
    return `<tr class="deal-list-row" data-deal-id="${d.id}">
      <td class="deal-td-name">${escapeHtml(d.deal_name)}</td>
      <td><span class="deal-stage-pill deal-stage-${d.stage}">${escapeHtml(DEAL_STAGE_LABEL[d.stage] || d.stage)}</span></td>
      <td>${poc ? escapeHtml(poc.full_name) : '—'}</td>
      <td class="deal-td-next">${d.next_steps ? escapeHtml(d.next_steps).slice(0, 50) : ''}</td>
      <td class="${deadlineClass}">${d.deadline ? formatDealDate(d.deadline) : ''}</td>
      <td>${escapeHtml(d.engagement_type || '')}</td>
      <td>${escapeHtml(d.business_model || '')}</td>
      <td>${d.updated_at ? formatDealDate(d.updated_at.slice(0, 10)) : ''}</td>
    </tr>`;
  }).join('');
}

// ── Contracted list with Active / Archived grouping ──
// Partition contracted deals into active (linked to a live client) vs archived
// (no active-client link) + archived clients that have no deal row. Shared by
// the Active/Archived stat cards and views so counts always match what's shown.
function partitionContractedDeals(deals) {
  const EXCLUDED_CLIENTS_LC = ['internal', 'misc', 'pitches/bd'];
  const allClients = (state.clients || []).filter(c => !EXCLUDED_CLIENTS_LC.includes(c.name.toLowerCase()));
  const activeClientIds = new Set(allClients.filter(c => c.is_active).map(c => c.id));
  const contracted = (deals || []).filter(d => d.stage === 'contracted');
  const active = contracted.filter(d => d.client_id && activeClientIds.has(d.client_id));
  const archivedDeals = contracted.filter(d => !d.client_id || !activeClientIds.has(d.client_id));
  const dealClientIds = new Set(contracted.map(d => d.client_id).filter(Boolean));
  const archivedClientsWithoutDeals = allClients
    .filter(c => !c.is_active && !dealClientIds.has(c.id))
    .map(c => ({ deal_name: c.name, engagement_type: c.type, business_model: '', updated_at: c.updated_at, _isClientOnly: true }));
  return { active, archived: [...archivedDeals, ...archivedClientsWithoutDeals] };
}

// which = 'active' | 'archived'
function renderContractedListView(deals, which) {
  if (!dealListHead || !dealListBody) return;
  const { active, archived } = partitionContractedDeals(deals);
  const list = which === 'archived' ? archived : active;
  const cols = ['Deal', 'POC', 'Type', 'Model', 'Updated'];
  dealListHead.innerHTML = '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>';

  function rowsHtml(list) {
    return list.map(d => {
      const poc = lookupEmployee(d.poc_employee_id);
      return `<tr class="deal-list-row" data-deal-id="${d.id}">
        <td class="deal-td-name">${escapeHtml(d.deal_name)}</td>
        <td>${poc ? escapeHtml(poc.full_name) : '—'}</td>
        <td>${escapeHtml(d.engagement_type || '')}</td>
        <td>${escapeHtml(d.business_model || '')}</td>
        <td>${d.updated_at ? formatDealDate(d.updated_at.slice(0, 10)) : ''}</td>
      </tr>`;
    }).join('');
  }

  const emptyMsg = which === 'archived' ? 'No archived clients' : 'No active clients';
  dealListBody.innerHTML = list.length
    ? rowsHtml(list)
    : `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--text-2)">${emptyMsg}</td></tr>`;
}

// ── Section tables (Active / Cold / Completed) ──
// (renderDealSectionTable removed — it fed the hidden dealSectionTableWrap and read the dropped section column.)

// ── Deal detail panel ──
function openDealDetail(dealId) {
  const deal = state.deals.find(d => d.id === dealId);
  if (!deal || !dealDetailPanel || !dealDetailInner) return;
  const canEdit = isLeadershipRole() || isDealFlowViewer() || deal.poc_employee_id === state.currentEmployeeId;
  const canDelete = isLeadershipRole() || isDealFlowViewer();

  const poc = lookupEmployee(deal.poc_employee_id);
  const client = deal.client_id ? state.clients.find(c => c.id === deal.client_id) : null;
  const stageOptions = DEAL_STAGES.map(s => `<option value="${s.key}"${deal.stage === s.key ? ' selected' : ''}>${s.label}</option>`).join('');
  const pocOptions = '<option value="">—</option>' + getDealPocEmployees().map(e => `<option value="${e.id}"${deal.poc_employee_id === e.id ? ' selected' : ''}>${escapeHtml(e.full_name)}</option>`).join('');
  const clientOptions = '<option value="">— None —</option>' + state.clients.filter(c => c.is_active).map(c => `<option value="${c.id}"${deal.client_id === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');

  const readonlyAttr = canEdit ? '' : ' disabled';

  dealDetailInner.innerHTML = `
    <div class="deal-detail-header">
      <h3 class="deal-detail-title">${escapeHtml(deal.deal_name)}</h3>
      <button class="ghost deal-detail-close" type="button">✕</button>
    </div>
    <div class="deal-detail-form">
      <label>Deal Name</label>
      <input type="text" class="deal-field" data-field="deal_name" value="${escapeHtml(deal.deal_name)}"${readonlyAttr} />

      <div class="deal-detail-row">
        <div class="deal-detail-half">
          <label>Stage</label>
          <select class="deal-field" data-field="stage"${readonlyAttr}>${stageOptions}</select>
        </div>
        <div class="deal-detail-half">
          <label>POC</label>
          <select class="deal-field" data-field="poc_employee_id"${readonlyAttr}>${pocOptions}</select>
        </div>
      </div>

      <label>Next Steps</label>
      <input type="text" class="deal-field" data-field="next_steps" value="${escapeHtml(deal.next_steps || '')}"${readonlyAttr} />

      <div class="deal-detail-row">
        <div class="deal-detail-half">
          <label>Next Deadline</label>
          <input type="date" class="deal-field" data-field="deadline" value="${deal.deadline || ''}"${readonlyAttr} />
        </div>
        <div class="deal-detail-half">
          <label>Amount</label>
          <div class="deal-amount-row">
            <select class="deal-field deal-currency-select" data-field="currency"${readonlyAttr}>
              <option value="INR"${deal.currency === 'INR' || !deal.currency ? ' selected' : ''}>₹</option>
              <option value="USD"${deal.currency === 'USD' ? ' selected' : ''}>$</option>
            </select>
            <input type="text" inputmode="numeric" class="deal-field deal-amount-input" data-field="amount" value="${deal.amount ? Number(deal.amount).toLocaleString('en-IN') : ''}"${readonlyAttr} />
          </div>
        </div>
      </div>

      <label>Notes</label>
      <textarea class="deal-field" data-field="notes" rows="2"${readonlyAttr}>${escapeHtml(deal.notes || '')}</textarea>

      <div class="deal-detail-row">
        <div class="deal-detail-half">
          <label>Engagement Type</label>
          <select class="deal-field" data-field="engagement_type"${readonlyAttr}>
            <option value="">—</option>
            <option value="Retainer"${deal.engagement_type === 'Retainer' ? ' selected' : ''}>Retainer</option>
            <option value="Project"${deal.engagement_type === 'Project' ? ' selected' : ''}>Project</option>
          </select>
        </div>
        <div class="deal-detail-half">
          <label>Business Model</label>
          <select class="deal-field" data-field="business_model"${readonlyAttr}>
            <option value="">—</option>
            <option value="B2B"${deal.business_model === 'B2B' ? ' selected' : ''}>B2B</option>
            <option value="B2C"${deal.business_model === 'B2C' ? ' selected' : ''}>B2C</option>
          </select>
        </div>
      </div>

      <div class="deal-detail-row">
        <div class="deal-detail-half">
          <label>Linked Client</label>
          <select class="deal-field" data-field="client_id"${readonlyAttr}>${clientOptions}</select>
        </div>
        <div class="deal-detail-half">
          <label>Brand</label>
          <select class="deal-field" data-field="company"${readonlyAttr}>
            <option value="Your Agency"${(deal.company || 'Your Agency') === 'Your Agency' ? ' selected' : ''}>Your Agency</option>
            <option value="Varta"${deal.company === 'Varta' ? ' selected' : ''}>Varta</option>
          </select>
        </div>
      </div>

      ${deal.stage === 'contracted' ? `
      <label>Termination Type</label>
      <select class="deal-field" data-field="termination_type"${readonlyAttr}>
        <option value="">— Active —</option>
        <option value="Active"${deal.termination_type === 'Active' ? ' selected' : ''}>Active</option>
        <option value="Good Termination"${deal.termination_type === 'Good Termination' ? ' selected' : ''}>Good Termination</option>
        <option value="Bad Termination"${deal.termination_type === 'Bad Termination' ? ' selected' : ''}>Bad Termination</option>
      </select>` : ''}

      ${canEdit ? '<button class="primary deal-save-btn" type="button">Save Changes</button>' : ''}
      <div class="deal-detail-actions">
        ${canDelete ? `<button class="ghost small deal-delete-btn" data-deal-id="${deal.id}" type="button">Delete</button>` : ''}
      </div>
    </div>

    <div class="deal-activity-log">
      <h4>Activity</h4>
      <div id="dealActivityLog">Loading…</div>
    </div>
  `;

  dealDetailPanel.classList.add('open');
  dealDetailPanel.dataset.dealId = dealId;
  document.body.classList.add('deal-panel-open');
  loadDealActivity(dealId);

  // Make date inputs open calendar on click anywhere in the field
  dealDetailInner.querySelectorAll('input[type="date"]').forEach(inp => {
    inp.addEventListener('click', () => { try { inp.showPicker(); } catch(e) {} });
  });

  // Format amount with commas on blur
  const amountInput = dealDetailInner.querySelector('.deal-amount-input');
  if (amountInput) {
    amountInput.addEventListener('blur', () => {
      const raw = parseFloat(amountInput.value.replace(/,/g, ''));
      if (!isNaN(raw)) amountInput.value = raw.toLocaleString('en-IN');
    });
    amountInput.addEventListener('focus', () => {
      amountInput.value = amountInput.value.replace(/,/g, '');
    });
  }
}

function closeDealDetail() {
  if (dealDetailPanel) {
    dealDetailPanel.classList.remove('open');
    delete dealDetailPanel.dataset.dealId;
  }
  document.body.classList.remove('deal-panel-open');
}

async function loadDealActivity(dealId) {
  const logEl = document.getElementById('dealActivityLog');
  if (!logEl) return;
  const { data, error } = await state.supabase
    .from('deal_stage_history')
    .select('*')
    .eq('deal_id', dealId)
    .order('entered_at', { ascending: false });
  if (error || !data?.length) {
    logEl.innerHTML = '<p class="muted">No activity yet.</p>';
    return;
  }
  logEl.innerHTML = data.map(entry => {
    const emp = lookupEmployee(entry.changed_by);
    const who = emp ? escapeHtml(emp.full_name) : 'System';
    const when = new Date(entry.entered_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const stageLabel = DEAL_STAGE_LABEL[entry.stage] || entry.stage;
    return `<div class="deal-activity-entry">
      <span>${who} moved to <strong>${escapeHtml(stageLabel)}</strong></span>
      <span class="deal-activity-meta">${when}</span>
    </div>`;
  }).join('');
}

async function saveDealFromPanel() {
  const dealId = dealDetailPanel?.dataset.dealId;
  if (!dealId) return;
  const fields = dealDetailInner.querySelectorAll('.deal-field');
  const updates = {};
  fields.forEach(f => {
    const key = f.dataset.field;
    let val = f.value.trim();
    if (val === '' || val === '—') val = null;
    if (key === 'amount' && val !== null) val = parseFloat(val.replace(/,/g, ''));
    updates[key] = val;
  });

  // Check if stage changed for history logging
  const deal = state.deals.find(d => d.id === dealId);
  const stageChanged = deal && updates.stage && updates.stage !== deal.stage;
  const oldStage = deal?.stage;

  // Contracted deals MUST have a linked client — offer to create one
  if (updates.stage === 'contracted' && !updates.client_id) {
    const create = await appConfirm(`No linked client. Create "${deal.deal_name}" as a new client?`);
    if (!create) return;
    const ownerId = deal.poc_employee_id || state.currentEmployeeId || null;
    const { data: newClient, error: clientErr } = await state.supabase
      .from('clients')
      .insert({ name: deal.deal_name, account_owner_employee_id: ownerId, is_active: true })
      .select().single();
    if (clientErr) {
      appAlert('Failed to create client: ' + clientErr.message);
      return;
    }
    // Create default project so team can allocate to this client
    const engType = (deal.engagement_type || '').toLowerCase() === 'retainer' ? 'retainer' : 'project';
    await state.supabase.from('projects').insert({
      client_id: newClient.id,
      name: deal.deal_name,
      engagement_type: engType,
      status: 'active',
      owner_employee_id: ownerId
    });
    updates.client_id = newClient.id;
    await loadClientsFromSupabase();
  }

  const { error } = await state.supabase.from('deals').update(updates).eq('id', dealId);
  if (error) {
    console.error('Deal save failed:', error.message);
    appAlert('Save failed: ' + error.message);
    return;
  }

  if (stageChanged) {
    if (updates.stage === 'contracted') {
      notifyClientStatusChange('deal_contracted', { dealId });
    }
    await state.supabase.from('deal_stage_history').insert({
      deal_id: dealId,
      stage: updates.stage,
      changed_by: state.currentEmployeeId
    });
    if (oldStage) {
      const { data: prev } = await state.supabase
        .from('deal_stage_history')
        .select('id')
        .eq('deal_id', dealId)
        .eq('stage', oldStage)
        .is('exited_at', null);
      if (prev?.length) {
        await state.supabase
          .from('deal_stage_history')
          .update({ exited_at: new Date().toISOString() })
          .in('id', prev.map(e => e.id));
      }
    }
  }

  closeDealDetail();
  await loadDealsFromSupabase();
}

// ── New deal ──
function openNewDealForm() {
  if (!dealDetailPanel || !dealDetailInner) return;
  // The POC is always Alex (DEAL_POC_EMAILS has exactly one entry), so the
  // blank default made every new deal ask a question with one possible answer
  // (9 Sep 2026). First eligible POC is preselected; the "—" option only
  // survives when there is nobody to preselect, so a deal cannot silently be
  // created with no owner. If a second POC is ever added the first is still the
  // default and the dropdown becomes a real choice again.
  const pocEmployees = getDealPocEmployees();
  const pocOptions = (pocEmployees.length ? '' : '<option value="">—</option>')
    + pocEmployees.map((e, i) => `<option value="${e.id}"${i === 0 ? ' selected' : ''}>${escapeHtml(e.full_name)}</option>`).join('');

  dealDetailInner.innerHTML = `
    <div class="deal-detail-header">
      <h3 class="deal-detail-title">New Deal</h3>
      <button class="ghost deal-detail-close" type="button">✕</button>
    </div>
    <div class="deal-detail-form">
      <label>Deal Name *</label>
      <input type="text" id="newDealName" />

      <div class="deal-detail-row">
        <div class="deal-detail-half">
          <label>Stage</label>
          <select id="newDealStage">
            ${DEAL_OPEN_STAGES.map(s => `<option value="${s}">${DEAL_STAGE_LABEL[s]}</option>`).join('')}
          </select>
        </div>
        <div class="deal-detail-half">
          <label>POC</label>
          <select id="newDealPoc">${pocOptions}</select>
        </div>
      </div>

      <label>Next Steps</label>
      <input type="text" id="newDealNextSteps" />

      <div class="deal-detail-row">
        <div class="deal-detail-half">
          <label>Next Deadline</label>
          <input type="date" id="newDealDeadline" />
        </div>
        <div class="deal-detail-half">
          <label>Engagement Type</label>
          <select id="newDealEngType">
            <option value="">—</option>
            <option value="Retainer">Retainer</option>
            <option value="Project">Project</option>
          </select>
        </div>
      </div>

      <div class="deal-detail-row">
        <div class="deal-detail-half">
          <label>Amount</label>
          <div class="deal-amount-input-wrap">
            <select id="newDealCurrency" class="deal-currency-select"><option value="INR">₹</option><option value="USD">$</option></select>
            <input type="text" id="newDealAmount" placeholder="0" inputmode="numeric" />
          </div>
        </div>
        <div class="deal-detail-half">
          <label>Business Model</label>
          <select id="newDealBizModel">
            <option value="">—</option>
            <option value="B2B">B2B</option>
            <option value="B2C">B2C</option>
          </select>
        </div>
      </div>

      <button class="primary" id="newDealSaveBtn" type="button">Create Deal</button>
    </div>
  `;

  dealDetailPanel.classList.add('open');
  dealDetailPanel.dataset.dealId = '';
  document.body.classList.add('deal-panel-open');

  document.getElementById('newDealSaveBtn')?.addEventListener('click', createNewDeal);

  // Make date input open calendar on click anywhere in the field
  dealDetailInner.querySelectorAll('input[type="date"]').forEach(inp => {
    inp.addEventListener('click', () => { try { inp.showPicker(); } catch(e) {} });
  });
}

async function createNewDeal() {
  const name = document.getElementById('newDealName')?.value.trim();
  if (!name) { appAlert('Deal name is required.'); return; }

  const stage = document.getElementById('newDealStage')?.value || 'qualified';
  const poc = document.getElementById('newDealPoc')?.value || null;
  const nextSteps = document.getElementById('newDealNextSteps')?.value.trim() || null;
  const deadline = document.getElementById('newDealDeadline')?.value || null;
  const engType = document.getElementById('newDealEngType')?.value || null;
  const bizModel = document.getElementById('newDealBizModel')?.value || null;
  const amountRaw = document.getElementById('newDealAmount')?.value.replace(/,/g, '').trim();
  const amount = amountRaw ? parseFloat(amountRaw) : null;
  const currency = document.getElementById('newDealCurrency')?.value || 'INR';

  try {
    const { data, error } = await state.supabase
      .from('deals')
      .insert({
        deal_name: name,
        stage: stage,
        poc_employee_id: poc,
        next_steps: nextSteps,
        deadline: deadline,
        engagement_type: engType,
        business_model: bizModel,
        amount: amount,
        currency: currency,
        section: 'hot',
        company: state.dealCompany
      })
      .select()
      .single();

    if (error) {
      console.error('Create deal failed:', error.message);
      appAlert('Failed to create deal: ' + error.message);
      return;
    }

    // Log initial stage
    const histRes = await state.supabase.from('deal_stage_history').insert({
      deal_id: data.id,
      stage: stage,
      changed_by: state.currentEmployeeId
    });
    if (histRes.error) console.warn('Stage history insert failed:', histRes.error.message);

    closeDealDetail();
    await loadDealsFromSupabase();
  } catch (err) {
    console.error('Create deal error:', err);
    appAlert('Failed to create deal: ' + err.message);
  }
}

// ── Delete deal ──
async function deleteDeal(dealId) {
  if (!await appConfirm('Delete this deal permanently?', { title: 'Delete deal', confirmLabel: 'Delete', danger: true })) return;
  const { error } = await state.supabase.from('deals').delete().eq('id', dealId);
  if (error) {
    console.error('Delete failed:', error.message);
    return;
  }
  closeDealDetail();
  await loadDealsFromSupabase();
}

// ── Revive cold deal ──
async function reviveDeal(dealId) {
  const stage = await appChoice('Which stage should this deal move to?', {
    title: 'Revive deal',
    choices: DEAL_OPEN_STAGES.map(s => ({ label: DEAL_STAGE_LABEL[s] || s, value: s }))
  });
  if (!stage || !DEAL_OPEN_STAGES.includes(stage)) return;
  const { error } = await state.supabase.from('deals').update({ stage, section: 'hot' }).eq('id', dealId);
  if (error) {
    console.error('Revive failed:', error.message);
    return;
  }
  const reviveHist = await state.supabase.from('deal_stage_history').insert({
    deal_id: dealId,
    stage,
    changed_by: state.currentEmployeeId
  });
  if (reviveHist.error) console.error('Revive stage history failed:', reviveHist.error.message);
  await loadDealsFromSupabase();
}

// ── Event handlers ──

// Stats bar filter clicks
if (dealStatsBar) {
  dealStatsBar.addEventListener('click', (e) => {
    const stat = e.target.closest('.deal-stat-link');
    if (!stat) return;
    state.dealFilter = stat.dataset.filter;
    renderDealFlow();
  });
}

// View toggle
if (dealViewBoard) {
  dealViewBoard.addEventListener('click', () => {
    state.dealView = 'board';
    dealViewBoard.classList.add('active');
    dealViewList?.classList.remove('active');
    renderDealFlow();
  });
}
if (dealViewList) {
  dealViewList.addEventListener('click', () => {
    state.dealView = 'list';
    dealViewList.classList.add('active');
    dealViewBoard?.classList.remove('active');
    renderDealFlow();
  });
}

// Company switcher
if (dealCompanySelect) {
  dealCompanySelect.addEventListener('change', () => {
    state.dealCompany = dealCompanySelect.value;
    state.dealFilter = 'open'; // reset to default view on company switch
    renderDealFlow();
  });
}

// POC filter
if (dealFilterPoc) {
  dealFilterPoc.addEventListener('change', () => {
    state.dealFilterPoc = dealFilterPoc.value;
    renderDealFlow();
  });
}

// Search
if (dealSearchInput) {
  dealSearchInput.addEventListener('input', () => {
    state.dealSearch = dealSearchInput.value;
    renderDealFlow();
  });
}

// Add button
if (dealAddBtn) {
  dealAddBtn.addEventListener('click', () => openNewDealForm());
}

// Close panel when clicking the backdrop (outside the inner panel)
document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('deal-panel-open')) return;
  if (dealDetailInner && !dealDetailInner.contains(e.target) && !e.target.closest('.deal-card, .deal-list-row, .deal-revive-btn, #dealAddBtn')) {
    closeDealDetail();
  }
});

// Delegated clicks on board, list, detail panel
document.addEventListener('click', (e) => {
  // Deal card click (open detail)
  const card = e.target.closest('.deal-card');
  if (card && !e.target.closest('[draggable]')?.classList.contains('deal-card-dragging')) {
    const dealId = card.dataset.dealId;
    if (dealId) openDealDetail(dealId);
    return;
  }

  // Deal list row click
  const row = e.target.closest('.deal-list-row');
  if (row && row.dataset.dealId) {
    openDealDetail(row.dataset.dealId);
    return;
  }

  // Close detail panel
  if (e.target.closest('.deal-detail-close')) {
    closeDealDetail();
    return;
  }

  // Save deal
  if (e.target.closest('.deal-save-btn')) {
    saveDealFromPanel().catch(console.error);
    return;
  }

  // Delete deal
  const delBtn = e.target.closest('.deal-delete-btn');
  if (delBtn) {
    deleteDeal(delBtn.dataset.dealId).catch(console.error);
    return;
  }

  // Revive cold deal
  const reviveBtn = e.target.closest('.deal-revive-btn');
  if (reviveBtn) {
    reviveDeal(reviveBtn.dataset.dealId).catch(console.error);
    return;
  }

  // Sort headers in list view
  const th = e.target.closest('.deal-th');
  if (th) {
    const col = th.dataset.col;
    if (dealSortCol === col) {
      dealSortAsc = !dealSortAsc;
    } else {
      dealSortCol = col;
      dealSortAsc = true;
    }
    renderDealFlow();
  }
});

// ── End Deal Flow ──────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════
// ── Executive Dashboard ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

async function loadExecutiveDashboard() {
  if (!state.supabase || !state.isAuthenticated || !isLeadershipRole()) return;

  const todayIso = toISODateLocal();
  const weekStart = getCurrentWeekStartIso();
  const twoWeeksOut = toISODateLocal(new Date(Date.now() + 14 * 86400000));

  // Ensure base state is loaded
  const ensureLoads = [];
  if (!state.employeeDirectory.length) ensureLoads.push(loadEmployeeDirectoryFromSupabase());
  if (!state.clients.length) ensureLoads.push(loadClientsFromSupabase());
  if (!state.deals.length) ensureLoads.push(loadDealsFromSupabase());
  if (ensureLoads.length) await Promise.all(ensureLoads);

  // Parallel dashboard-specific queries
  const [allocResult, leaveResult, tasksResult, onboardingResult] = await Promise.all([
    state.supabase
      .from('allocations')
      .select(`
        employee_id,
        allocation_percent,
        project:projects!allocations_project_id_fkey (
          name,
          client:clients!projects_client_id_fkey ( name )
        )
      `)
      .eq('period_type', 'week')
      .eq('period_start', weekStart)
      .limit(2000),

    state.supabase
      .from('leave_requests')
      .select(`
        id, employee_id, leave_type, start_date, end_date, status,
        employee:employees!leave_requests_employee_id_fkey ( full_name )
      `)
      .eq('status', 'approved')
      .lte('start_date', twoWeeksOut)
      .gte('end_date', todayIso)
      .limit(2000),

    state.supabase
      .from('daily_tasks')
      .select('employee_id, status')
      .eq('task_date', todayIso)
      .neq('status', 'archived')
      .limit(2000),

    state.supabase
      .from('onboarding_checklists')
      .select(`
        id, employee_id, status, created_at,
        items:onboarding_checklist_items ( phase, is_completed )
      `)
      .eq('status', 'active')
      .limit(2000)
  ]);

  // Agency-level view: exclude client-scoped people. They aren't reassignable
  // bandwidth, so counting them as heads dragged AVG UTILIZATION down and
  // inflated "available" with capacity nobody can actually draw on.
  const activeEmployees = state.employeeDirectory.filter(e =>
    e.is_active
    && !getHiddenEmployeeEmails().includes(normalizeEmail(e.email))
    && !isCapacityExcluded(e));
  const allocations = allocResult.data || [];
  const leaveRows = leaveResult.data || [];
  const todayTasks = tasksResult.data || [];
  const activeOnboarding = (onboardingResult.data || []).map(ob => {
    const emp = activeEmployees.find(e => e.id === ob.employee_id);
    return { ...ob, employee: emp || null };
  });

  // Build per-employee allocation map
  const allocByEmployee = new Map();
  allocations.forEach(a => {
    const entry = allocByEmployee.get(a.employee_id) || { total: 0, clients: [] };
    entry.total += (a.allocation_percent || 0);
    const clientName = a.project?.client?.name;
    if (clientName && normalizeClientNameKey(clientName) !== 'internal' && !entry.clients.includes(clientName)) entry.clients.push(clientName);
    allocByEmployee.set(a.employee_id, entry);
  });

  renderExecKpis(activeEmployees, allocByEmployee, state.clients, state.deals, activeOnboarding);
  renderExecAllocation(activeEmployees, allocByEmployee);
  renderExecPipeline(state.deals);
  renderExecWhosOut(leaveRows, todayIso);
  renderExecActivity(activeEmployees, todayTasks, leaveRows, todayIso);
  renderExecClients(state.clients, allocations);
  renderExecOnboarding(activeOnboarding);
}

// ── KPI Cards ──

function renderExecKpis(employees, allocByEmployee, clients, deals, onboarding) {
  const grid = document.getElementById('execKpiGrid');
  if (!grid) return;

  const onboardingCount = onboarding.length;
  const activeClients = clients.filter(c => c.is_active);
  const openDeals = deals.filter(d => DEAL_OPEN_STAGES.includes(d.stage));

  // Utilization
  let totalAlloc = 0, allocCount = 0, overloaded = 0, available = 0;
  employees.forEach(e => {
    const alloc = allocByEmployee.get(e.id)?.total || 0;
    totalAlloc += alloc;
    allocCount++;
    if (alloc > 100) overloaded++;
    else if (alloc < 70) available++;
  });
  const avgUtil = allocCount ? Math.round(totalAlloc / allocCount) : 0;

  // Client breakdown
  const typeCount = {};
  activeClients.forEach(c => {
    const type = c.type || 'project';
    typeCount[type] = (typeCount[type] || 0) + 1;
  });
  const clientContext = Object.entries(typeCount).map(([t, n]) => `${n} ${t}`).join(' · ');

  // Pipeline — most advanced stage
  const stageOrder = ['negotiated', 'proposal', 'discovery', 'qualified'];
  let topStage = '';
  for (const s of stageOrder) {
    const c = openDeals.filter(d => d.stage === s).length;
    if (c) { topStage = `${c} ${DEAL_STAGE_LABEL[s] || s}`.toLowerCase(); break; }
  }

  const cards = [
    { label: 'TEAM', value: employees.length, context: onboardingCount ? `${onboardingCount} onboarding` : '' },
    { label: 'AVG UTILIZATION', value: avgUtil + '%', context: `${overloaded} overloaded · ${available} available` },
    { label: 'ACTIVE CLIENTS', value: activeClients.length, context: clientContext },
    { label: 'PIPELINE', value: openDeals.length, context: topStage },
  ];

  grid.innerHTML = cards.map(c => `
    <div class="kpi-card">
      <p>${c.label}</p>
      <h3>${c.value}</h3>
      <small>${c.context}</small>
    </div>
  `).join('');
}

// ── Team Allocation Card ──

function renderExecAllocation(employees, allocByEmployee) {
  const list = document.getElementById('execAllocList');
  const toggle = document.getElementById('execAllocToggle');
  if (!list) return;

  const rows = employees.map(e => ({
    name: displayPersonName(e.full_name, 'Employee'),
    dept: normalizeTeamName(e.department?.name || '', ''),
    alloc: allocByEmployee.get(e.id)?.total || 0,
    clients: allocByEmployee.get(e.id)?.clients || [],
  }));

  // Group by department, sort departments by highest allocation, within each dept sort by alloc desc
  const deptMap = new Map();
  rows.forEach(r => {
    if (!deptMap.has(r.dept)) deptMap.set(r.dept, []);
    deptMap.get(r.dept).push(r);
  });
  deptMap.forEach(members => members.sort((a, b) => b.alloc - a.alloc));
  const deptOrder = [...deptMap.entries()].sort((a, b) => {
    const maxA = Math.max(...a[1].map(r => r.alloc));
    const maxB = Math.max(...b[1].map(r => r.alloc));
    return maxB - maxA;
  });

  let html = '';
  deptOrder.forEach(([dept, members]) => {
    html += `<div class="exec-alloc-group">`;
    html += `<div class="exec-alloc-dept">${escapeHtml(dept || 'Other')}</div>`;
    html += members.map(r => {
      const pct = Math.min(r.alloc, 120);
      const color = r.alloc > 100 ? 'var(--bad)' : r.alloc >= 90 ? 'var(--warn)' : 'var(--good)';
      return `
        <div class="exec-alloc-row">
          <span class="exec-alloc-name">${escapeHtml(r.name)}</span>
          <div class="audience-bar" style="flex:1">
            <div class="audience-bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="exec-alloc-pct" style="color:${color}">${r.alloc}%</span>
          <span class="exec-clients-mini">${escapeHtml(r.clients.join(', '))}</span>
        </div>`;
    }).join('');
    html += `</div>`;
  });
  list.innerHTML = html;

  if (toggle) {
    toggle.style.display = 'none';
  }
}

// ── Pipeline Card ──

function renderExecPipeline(deals) {
  const card = document.getElementById('execPipelineCard');
  if (!card) return;

  const openDeals = deals.filter(d => DEAL_OPEN_STAGES.includes(d.stage));
  const stageCounts = {};
  DEAL_OPEN_STAGES.forEach(s => { stageCounts[s] = 0; });
  openDeals.forEach(d => { stageCounts[d.stage] = (stageCounts[d.stage] || 0) + 1; });

  const stageBoxes = DEAL_OPEN_STAGES.map(s => {
    const count = stageCounts[s];
    const muted = count === 0 ? ' style="opacity:0.35"' : '';
    return `<div class="exec-stage-box"${muted}>
      <div class="exec-stage-count">${count}</div>
      <div class="exec-stage-label">${escapeHtml(DEAL_STAGE_LABEL[s] || s)}</div>
    </div>`;
  }).join('');

  const dealRows = openDeals.sort((a, b) => {
    return DEAL_OPEN_STAGES.indexOf(b.stage) - DEAL_OPEN_STAGES.indexOf(a.stage);
  }).slice(0, 8).map(d => {
    const days = Math.floor((Date.now() - new Date(d.created_at).getTime()) / 86400000);
    const amt = d.amount ? (d.currency === 'USD' ? '$' : '₹') + Number(d.amount).toLocaleString('en-IN') : '';
    return `<div class="exec-deal-row">
      <span>${escapeHtml(d.deal_name || d.company || '—')}</span>
      <span>${amt}</span>
      <span class="chip info">${escapeHtml(DEAL_STAGE_LABEL[d.stage] || d.stage)}</span>
      <span class="exec-deal-days">${days}d</span>
    </div>`;
  }).join('');

  card.innerHTML = `
    <div class="exec-card-header"><h3>Pipeline</h3><small style="color:rgba(var(--text-rgb),0.4)">From Deal Flow</small></div>
    <div class="exec-stage-grid">${stageBoxes}</div>
    ${dealRows || '<p style="color:rgba(var(--text-rgb),0.4);font-size:0.8rem">No open deals</p>'}
  `;
}

// ── Who's Out Card ──

function renderExecWhosOut(leaveRows, todayIso) {
  const card = document.getElementById('execWhosOutCard');
  if (!card) return;

  const today = new Date(todayIso);
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay() || 7));
  const weekEndIso = toISODateLocal(weekEnd);

  const current = leaveRows.filter(l => l.start_date <= todayIso && l.end_date >= todayIso);
  const upcoming = leaveRows.filter(l => l.start_date > todayIso);

  function leaveTypeClass(t) {
    if (t === 'PL') return 'good';
    if (t === 'SL') return 'warn';
    return 'info';
  }

  function initials(name) {
    return (name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  function renderLeaveRow(l, muted) {
    const name = displayPersonName(l.employee?.full_name || '', '—');
    const cls = muted ? ' exec-muted' : '';
    return `<div class="exec-activity-row${cls}">
      <div class="exec-initials">${initials(l.employee?.full_name || '')}</div>
      <span style="flex:1">${escapeHtml(name)}</span>
      <span style="font-size:0.75rem;color:rgba(var(--text-rgb),0.5)">${formatDateForLabel(l.start_date)} – ${formatDateForLabel(l.end_date)}</span>
      <span class="chip ${leaveTypeClass(l.leave_type)}">${l.leave_type}</span>
    </div>`;
  }

  const currentHtml = current.length
    ? `<div style="margin-bottom:var(--space-2)"><small style="font-weight:600;color:rgba(var(--text-rgb),0.5)">This week</small>${current.map(l => renderLeaveRow(l, false)).join('')}</div>`
    : '';
  const upcomingHtml = upcoming.length
    ? `<div><small style="font-weight:600;color:rgba(var(--text-rgb),0.5)">Coming up</small>${upcoming.map(l => renderLeaveRow(l, true)).join('')}</div>`
    : '';

  card.innerHTML = `
    <div class="exec-card-header"><h3>Who's Out</h3><small style="color:rgba(var(--text-rgb),0.4)">From My Leave</small></div>
    ${currentHtml || upcomingHtml
      ? currentHtml + upcomingHtml
      : '<p style="color:rgba(var(--text-rgb),0.4);font-size:0.8rem">No one\'s out</p>'}
  `;
}

// ── Today's Activity Card ──

function renderExecActivity(employees, todayTasks, leaveRows, todayIso) {
  const card = document.getElementById('execActivityCard');
  if (!card) return;

  const tasksByEmployee = new Map();
  todayTasks.forEach(t => {
    tasksByEmployee.set(t.employee_id, (tasksByEmployee.get(t.employee_id) || 0) + 1);
  });

  const onLeaveIds = new Set();
  leaveRows.forEach(l => {
    if (l.start_date <= todayIso && l.end_date >= todayIso) onLeaveIds.add(l.employee_id);
  });

  const rows = employees.map(e => {
    const tasks = tasksByEmployee.get(e.id) || 0;
    const onLeave = onLeaveIds.has(e.id);
    let status, icon, sortKey;
    if (tasks > 0) {
      status = `${tasks} task${tasks > 1 ? 's' : ''}`;
      icon = '<span style="color:var(--good)">✓</span>';
      sortKey = 0;
    } else if (onLeave) {
      status = 'On leave';
      icon = '<span style="color:var(--warn)">◑</span>';
      sortKey = 1;
    } else {
      status = 'No tasks';
      icon = '<span style="color:rgba(var(--text-rgb),0.25)">–</span>';
      sortKey = 2;
    }
    return { name: displayPersonName(e.full_name, 'Employee'), status, icon, sortKey };
  }).sort((a, b) => a.sortKey - b.sortKey);

  card.innerHTML = `
    <div class="exec-card-header"><h3>Today's Activity</h3><small style="color:rgba(var(--text-rgb),0.4)">Tasks logged in My Work</small></div>
    ${rows.map(r => `<div class="exec-activity-row">
      <span class="exec-activity-icon">${r.icon}</span>
      <span style="flex:1">${escapeHtml(r.name)}</span>
      <span style="font-size:0.75rem;color:rgba(var(--text-rgb),0.5)">${r.status}</span>
    </div>`).join('')}
  `;
}

// ── Clients Card ──

function renderExecClients(clients, allocations) {
  const card = document.getElementById('execClientsCard');
  if (!card) return;

  const activeClients = clients.filter(c => c.is_active);

  // Count team members per client from allocations
  const teamByClient = new Map();
  allocations.forEach(a => {
    const clientName = a.project?.client?.name;
    if (!clientName) return;
    const set = teamByClient.get(clientName) || new Set();
    set.add(a.employee_id);
    teamByClient.set(clientName, set);
  });

  const rows = activeClients.map(c => {
    const team = teamByClient.get(c.name)?.size || 0;
    const type = c.type || 'project';
    return { name: c.name, team, type };
  }).sort((a, b) => b.team - a.team);

  card.innerHTML = `
    <div class="exec-card-header"><h3>Clients</h3><small style="color:rgba(var(--text-rgb),0.4)">Active engagements</small></div>
    ${rows.length ? rows.map(r => `<div class="exec-activity-row">
      <span style="flex:1;font-weight:500">${escapeHtml(r.name)}</span>
      <span style="font-size:0.75rem;color:rgba(var(--text-rgb),0.5)">${r.team} member${r.team !== 1 ? 's' : ''}</span>
      <span class="chip info">${r.type}</span>
    </div>`).join('') : '<p style="color:rgba(var(--text-rgb),0.4);font-size:0.8rem">No active clients</p>'}
  `;
}

// ── Onboarding Card ──

function renderExecOnboarding(activeOnboarding) {
  const card = document.getElementById('execOnboardingCard');
  if (!card) return;

  const badge = activeOnboarding.length
    ? `<span class="chip info" style="margin-left:8px">${activeOnboarding.length} active</span>`
    : '';

  if (!activeOnboarding.length) {
    card.innerHTML = `
      <div class="exec-card-header"><h3>Onboarding${badge}</h3><small style="color:rgba(var(--text-rgb),0.4)">From Team Directory</small></div>
      <p style="color:rgba(var(--text-rgb),0.4);font-size:0.8rem">No active onboarding</p>
    `;
    return;
  }

  const phases = ['pre_joining', 'day_one', 'week_one', 'month_one'];
  const phaseLabels = { pre_joining: 'Pre-Joining', day_one: 'Day 1', week_one: 'Week 1', month_one: 'Month 1' };

  const entries = activeOnboarding.map(ob => {
    const items = ob.items || [];
    const total = items.length;
    const done = items.filter(i => i.is_completed).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const name = displayPersonName(ob.employee?.full_name || '', '—');
    const dept = ob.employee?.department?.name || '';

    const phaseBreak = phases.map(p => {
      const phaseItems = items.filter(i => i.phase === p);
      const pDone = phaseItems.filter(i => i.is_completed).length;
      return phaseItems.length ? `${phaseLabels[p]}: ${pDone}/${phaseItems.length}` : '';
    }).filter(Boolean).join(' · ');

    return `<div style="padding:6px 0;border-top:1px solid rgba(var(--text-rgb),0.06)">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span style="font-weight:500">${escapeHtml(name)}</span>
        <span style="font-size:0.75rem;color:rgba(var(--text-rgb),0.5)">${escapeHtml(dept)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <div class="audience-bar" style="flex:1;height:8px">
          <div class="audience-bar-fill" style="width:${pct}%;background:var(--primary)"></div>
        </div>
        <span style="font-size:0.75rem;font-weight:600">${done}/${total}</span>
      </div>
      <div style="font-size:0.68rem;color:rgba(var(--text-rgb),0.4);margin-top:2px">${phaseBreak}</div>
    </div>`;
  }).join('');

  card.innerHTML = `
    <div class="exec-card-header"><h3>Onboarding${badge}</h3><small style="color:rgba(var(--text-rgb),0.4)">From Team Directory</small></div>
    ${entries}
  `;
}

// ── End Executive Dashboard ─────────────────────────────────────────────

setAuthenticatedNavigation(false);
/* =========================================================================
   ONBOARDING SYSTEM
   ========================================================================= */

// ---- State ----
state.onboardingChecklists = [];   // active checklists (leadership view)
state.policyDocuments = [];        // policy docs from DB
let _policyQuillEditor = null;     // Quill instance for admin editor
let _editingPolicyId = null;       // currently editing policy doc ID

// ---- Notify leadership about new employee ----

// ---- Policy Documents: load, render, edit (Admin Settings) ----

async function loadPolicyDocuments() {
  if (!state.supabase) return;
  const { data, error } = await state.supabase
    .from('policy_documents')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) { console.error('Failed to load policy docs:', error); return; }
  state.policyDocuments = data || [];
  renderPolicyDocsList();

  // Show panel for admin
  const panel = document.getElementById('policyDocumentsPanel');
  if (panel && isSuperadminUser()) panel.style.display = '';
}

function renderPolicyDocsList() {
  const container = document.getElementById('policyDocsList');
  if (!container) return;
  container.innerHTML = '';
  state.policyDocuments.forEach(doc => {
    const updatedBy = doc.last_updated_by_employee_id
      ? lookupEmployeeName(doc.last_updated_by_employee_id, 'Unknown')
      : '--';
    const updatedDate = doc.updated_at ? new Date(doc.updated_at).toLocaleDateString('en-IN') : '--';
    const row = document.createElement('div');
    row.className = 'policy-doc-row';
    row.innerHTML = `
      <div>
        <span class="policy-doc-title">${escapeHtml(doc.title)}</span>
        <span class="policy-doc-meta">v${escapeHtml(doc.version)} &middot; Updated ${updatedDate} by ${escapeHtml(updatedBy)}</span>
      </div>
      <button class="ghost small" type="button">Edit</button>
    `;
    row.addEventListener('click', () => openPolicyEditor(doc.id));
    container.appendChild(row);
  });
}

function openPolicyEditor(docId) {
  const doc = state.policyDocuments.find(d => d.id === docId);
  if (!doc) return;
  _editingPolicyId = docId;

  const wrap = document.getElementById('policyEditorWrap');
  const historyWrap = document.getElementById('policyHistoryWrap');
  const titleEl = document.getElementById('policyEditorTitle');
  const metaEl = document.getElementById('policyEditorMeta');
  if (historyWrap) historyWrap.style.display = 'none';
  if (wrap) wrap.style.display = '';
  if (titleEl) titleEl.textContent = doc.title;
  if (metaEl) metaEl.textContent = `Version ${doc.version}`;

  // Initialize Quill if not done
  const editorContainer = document.getElementById('policyEditorContainer');
  if (!_policyQuillEditor && typeof Quill !== 'undefined') {
    _policyQuillEditor = new Quill(editorContainer, {
      theme: 'snow',
      modules: {
        toolbar: [
          [{ header: [2, 3, false] }],
          ['bold', 'italic', 'underline'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link'],
          ['clean']
        ]
      }
    });
  }
  if (_policyQuillEditor) {
    _policyQuillEditor.root.innerHTML = doc.content_html || '';
  }

  document.getElementById('policyEditorNotice').textContent = '';
}

document.getElementById('savePolicyBtn')?.addEventListener('click', async () => {
  if (!_editingPolicyId || !_policyQuillEditor) return;
  const doc = state.policyDocuments.find(d => d.id === _editingPolicyId);
  if (!doc) return;

  const newHtml = _policyQuillEditor.root.innerHTML;
  const oldVersion = doc.version || '1';
  // Bump version: increment last number
  const versionParts = oldVersion.split('.');
  const lastNum = parseInt(versionParts[versionParts.length - 1] || '0', 10);
  versionParts[versionParts.length - 1] = String(lastNum + 1);
  const newVersion = versionParts.join('.');

  const noticeEl = document.getElementById('policyEditorNotice');
  noticeEl.textContent = 'Saving...';

  // Save old version to history
  const { error: histErr } = await state.supabase.from('policy_document_versions').insert({
    policy_document_id: _editingPolicyId,
    version: oldVersion,
    content_html: doc.content_html,
    updated_by_employee_id: doc.last_updated_by_employee_id
  });
  if (histErr) console.warn('Failed to save version history:', histErr);

  // Update current document
  const { error } = await state.supabase.from('policy_documents').update({
    content_html: newHtml,
    version: newVersion,
    last_updated_by_employee_id: state.currentEmployeeId,
    updated_at: new Date().toISOString()
  }).eq('id', _editingPolicyId);

  if (error) {
    noticeEl.textContent = `Save failed: ${error.message}`;
    noticeEl.className = 'status error';
    return;
  }

  noticeEl.textContent = `Saved as version ${newVersion}.`;
  noticeEl.className = 'mini-meta';
  await loadPolicyDocuments();
  mirrorPolicyToDrive(doc.policy_key, noticeEl).catch(console.error);
});

document.getElementById('cancelPolicyBtn')?.addEventListener('click', () => {
  document.getElementById('policyEditorWrap').style.display = 'none';
  _editingPolicyId = null;
});

document.getElementById('viewPolicyHistoryBtn')?.addEventListener('click', async () => {
  if (!_editingPolicyId) return;
  const wrap = document.getElementById('policyHistoryWrap');
  const list = document.getElementById('policyHistoryList');
  const editorWrap = document.getElementById('policyEditorWrap');
  if (editorWrap) editorWrap.style.display = 'none';
  if (wrap) wrap.style.display = '';

  list.innerHTML = '<p class="mini-meta">Loading...</p>';
  const { data, error } = await state.supabase
    .from('policy_document_versions')
    .select('*')
    .eq('policy_document_id', _editingPolicyId)
    .order('created_at', { ascending: false });

  if (error || !data?.length) {
    list.innerHTML = '<p class="mini-meta">No version history yet.</p>';
    return;
  }

  list.innerHTML = '';
  data.forEach(v => {
    const who = v.updated_by_employee_id
      ? lookupEmployeeName(v.updated_by_employee_id)
      : '--';
    const when = new Date(v.created_at).toLocaleString('en-IN');
    const entry = document.createElement('div');
    entry.className = 'policy-history-entry';
    entry.innerHTML = `
      <div class="policy-history-meta">v${escapeHtml(v.version)} &middot; ${escapeHtml(when)} by ${escapeHtml(who)}</div>
      <div class="policy-history-preview">${v.content_html || ''}</div>
    `;
    list.appendChild(entry);
  });
});

document.getElementById('closePolicyHistoryBtn')?.addEventListener('click', () => {
  document.getElementById('policyHistoryWrap').style.display = 'none';
  if (_editingPolicyId) openPolicyEditor(_editingPolicyId);
});

// ---- Policy Full Page Screen ----

let _policyPageQuill = null;
let _policyPageDoc = null;

async function loadPolicyPage() {
  const policyKey = 'remote_working_policy';
  const contentEl = document.getElementById('policyPageContent');
  const titleEl = document.getElementById('policyPageTitle');
  const versionEl = document.getElementById('policyPageVersion');
  const updatedEl = document.getElementById('policyPageUpdated');
  const editBtn = document.getElementById('policyEditBtn');
  const editorWrap = document.getElementById('policyPageEditorWrap');
  const historyWrap = document.getElementById('policyVersionHistory');

  // Hide edit mode
  if (editorWrap) editorWrap.style.display = 'none';
  if (contentEl) contentEl.style.display = '';

  // Fetch policy
  let doc = state.policyDocuments.find(d => d.policy_key === policyKey);
  if (!doc && state.supabase) {
    const { data } = await state.supabase.from('policy_documents').select('*').eq('policy_key', policyKey).single();
    doc = data;
  }
  _policyPageDoc = doc;

  if (!doc) {
    if (contentEl) contentEl.innerHTML = '<p>Policy document not found.</p>';
    return;
  }

  if (titleEl) titleEl.textContent = doc.title;
  if (versionEl) versionEl.textContent = 'v' + doc.version;
  if (updatedEl) {
    const d = new Date(doc.updated_at);
    updatedEl.textContent = 'Last updated: ' + d.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  if (contentEl) {
    // Strip leading H1 from content to avoid duplicating the page header
    const tmp = document.createElement('div');
    tmp.innerHTML = doc.content_html || '<p>No content yet.</p>';
    const firstH1 = tmp.querySelector('h1:first-child');
    if (firstH1) firstH1.remove();
    // Strip leading "Last updated" line (already shown in page header)
    const firstEl = tmp.firstElementChild;
    if (firstEl && /^last\s+updated/i.test(firstEl.textContent.trim())) firstEl.remove();
    contentEl.innerHTML = tmp.innerHTML;
  }

  // Show edit button for admin and leadership
  const isAdmin = state.accessLevel === 'admin' || isLeadershipRole();
  if (editBtn) editBtn.style.display = isAdmin ? '' : 'none';
  const driveBtn = document.getElementById('policyDriveSyncBtn');
  if (driveBtn) driveBtn.style.display = isAdmin && state.runtimeConfig?.driveMirror ? '' : 'none';
  if (isAdmin) showPolicyDriveLink(doc.policy_key).catch(() => {});

  // Show version history for admin
  if (historyWrap) {
    historyWrap.style.display = isAdmin ? '' : 'none';
    if (isAdmin) loadPolicyVersionHistory(doc.id);
  }
}

// The Drive copy's link, from the mirror table (leadership can read it).
async function showPolicyDriveLink(policyKey) {
  const link = document.getElementById('policyDriveLink');
  if (!link || !state.supabase) return;
  const { data } = await state.supabase.from('drive_mirror').select('web_view_link').eq('key', `policy:${policyKey}`).maybeSingle();
  link.href = data?.web_view_link || '#';
  link.style.display = data?.web_view_link ? '' : 'none';
}

// Push the page to Drive. After every save, and on demand from the button.
async function mirrorPolicyToDrive(policyKey, noticeEl) {
  if (!state.runtimeConfig?.driveMirror || !state.session?.access_token) return;
  if (noticeEl) noticeEl.textContent = 'Copying to Drive…';
  let out = {}; let ok = false;
  try {
    const res = await fetch('/api/drive-mirror', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session.access_token}` }, body: JSON.stringify({ kind: 'policy', policyKey }) });
    out = await res.json().catch(() => ({})); ok = res.ok;
  } catch (e) { out = { error: e.message }; }
  if (noticeEl) noticeEl.textContent = ok ? '✓ Copied to Drive.' : `Saved in Colony, but the Drive copy failed: ${out.error || 'unknown error'}`;
  await showPolicyDriveLink(policyKey);
}
document.getElementById('policyDriveSyncBtn')?.addEventListener('click', () => {
  if (_policyPageDoc) mirrorPolicyToDrive(_policyPageDoc.policy_key, document.getElementById('policyPageUpdated')).catch(console.error);
});

async function loadPolicyVersionHistory(policyDocId) {
  const listEl = document.getElementById('policyVersionList');
  if (!listEl || !state.supabase) return;

  const { data: versions } = await state.supabase
    .from('policy_document_versions')
    .select('*')
    .eq('policy_document_id', policyDocId)
    .order('created_at', { ascending: false });

  if (!versions?.length) {
    listEl.innerHTML = '<p class="mini-meta">No previous versions yet.</p>';
    return;
  }

  listEl.innerHTML = versions.map(v => {
    const d = new Date(v.created_at);
    const dateStr = d.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
    return `<details class="policy-version-entry">
      <summary>v${escapeHtml(v.version)} — ${dateStr}</summary>
      <div class="policy-version-content">${v.content_html || ''}</div>
    </details>`;
  }).join('');
}

function enterPolicyEditMode() {
  const contentEl = document.getElementById('policyPageContent');
  const editorWrap = document.getElementById('policyPageEditorWrap');
  const editBtn = document.getElementById('policyEditBtn');
  if (!editorWrap || !_policyPageDoc) return;

  contentEl.style.display = 'none';
  editorWrap.style.display = '';
  if (editBtn) editBtn.style.display = 'none';

  // Initialize Quill if needed
  if (!_policyPageQuill && typeof Quill !== 'undefined') {
    document.getElementById('policyPageEditorContainer').innerHTML = '';
    _policyPageQuill = new Quill('#policyPageEditorContainer', {
      theme: 'snow',
      modules: { toolbar: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        [{ indent: '-1' }, { indent: '+1' }],
        ['link'],
        ['clean']
      ]}
    });
  }

  if (_policyPageQuill) {
    _policyPageQuill.root.innerHTML = _policyPageDoc.content_html || '';
  }

  document.getElementById('policyPageEditorNotice').textContent = '';
}

function exitPolicyEditMode() {
  const contentEl = document.getElementById('policyPageContent');
  const editorWrap = document.getElementById('policyPageEditorWrap');
  const editBtn = document.getElementById('policyEditBtn');

  if (editorWrap) editorWrap.style.display = 'none';
  if (contentEl) contentEl.style.display = '';
  if (editBtn) editBtn.style.display = '';
}

async function savePolicyAsNewVersion() {
  if (!_policyPageQuill || !_policyPageDoc || !state.supabase) return;

  const notice = document.getElementById('policyPageEditorNotice');
  const btn = document.getElementById('policyPageSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const newHtml = _policyPageQuill.root.innerHTML;
  const oldVersion = _policyPageDoc.version || '2.0';

  // Bump version: parse as float, increment by 0.1
  const vNum = parseFloat(oldVersion);
  const newVersion = (isNaN(vNum) ? 2.1 : Math.round((vNum + 0.1) * 10) / 10).toString();

  // Archive current version
  await state.supabase.from('policy_document_versions').insert({
    policy_document_id: _policyPageDoc.id,
    version: oldVersion,
    content_html: _policyPageDoc.content_html,
    updated_by_employee_id: state.currentEmployeeId
  });

  // Update current document
  const { error } = await state.supabase.from('policy_documents').update({
    content_html: newHtml,
    version: newVersion,
    last_updated_by_employee_id: state.currentEmployeeId,
    updated_at: new Date().toISOString()
  }).eq('id', _policyPageDoc.id);

  btn.disabled = false;
  btn.textContent = 'Save as New Version';

  if (error) {
    notice.textContent = 'Save failed: ' + error.message;
    return;
  }

  // Refresh
  _policyPageDoc.content_html = newHtml;
  _policyPageDoc.version = newVersion;
  _policyPageDoc.updated_at = new Date().toISOString();

  // Update cache
  const idx = state.policyDocuments.findIndex(d => d.id === _policyPageDoc.id);
  if (idx >= 0) state.policyDocuments[idx] = { ..._policyPageDoc };

  exitPolicyEditMode();
  loadPolicyPage();
  notice.textContent = '';
  mirrorPolicyToDrive(_policyPageDoc.policy_key, document.getElementById('policyPageUpdated')).catch(console.error);
}

document.getElementById('policyEditBtn')?.addEventListener('click', enterPolicyEditMode);
document.getElementById('policyPageCancelBtn')?.addEventListener('click', exitPolicyEditMode);
document.getElementById('policyPageSaveBtn')?.addEventListener('click', savePolicyAsNewVersion);

// ---- Onboarding Welcome Overlay (new hire first-login) ----

async function initOnboardingOverlay() {
  const overlay = document.getElementById('onboardingOverlay');
  if (!overlay) return;

  // Load policy docs for the overlay
  if (!state.policyDocuments.length) {
    const { data } = await state.supabase.from('policy_documents').select('*').order('created_at');
    state.policyDocuments = data || [];
  }

  // Show the overlay
  overlay.style.display = '';
  // Hide normal UI
  document.querySelector('.app-shell').style.display = 'none';

  // Detect returning user vs new hire
  const profile = state.employeeProfile;
  const firstName = (profile?.full_name || '').split(' ')[0] || 'there';
  const isReturning = !!(profile?.direct_manager_email || profile?.current_city || profile?.date_of_birth);
  const welcomeEl = document.getElementById('onboardingWelcomeName');
  const introEl = document.querySelector('[data-step="welcome"] .onboarding-intro');
  const doneIntroEl = document.querySelector('[data-step="done"] .onboarding-intro');
  if (isReturning) {
    if (welcomeEl) welcomeEl.textContent = `Quick Profile Check, ${firstName}`;
    if (introEl) introEl.textContent = "Let\u2019s make sure your info is up to date. Review your details, fill in anything missing, and re-read the remote working policy.";
    if (doneIntroEl) doneIntroEl.textContent = "Your profile is up to date. Thanks for keeping your info current!";
  } else {
    if (welcomeEl) welcomeEl.textContent = `Welcome to the Colony, ${firstName}!`;
  }

  // Populate profile form dropdowns
  populateOnboardingProfileForm();

  // Resume from last incomplete step
  const hasProfile = profile?.direct_manager_email && profile?.department?.name && profile?.current_city && profile?.date_of_birth && profile?.emergency_contact_name && profile?.emergency_contact_phone;

  // Check if remote working policy was acknowledged (in this cycle)
  const { data: acks } = await state.supabase
    .from('policy_acknowledgments')
    .select('policy_key')
    .eq('employee_id', state.currentEmployeeId)
    .eq('policy_key', 'remote_working_policy');
  const hasAckedPolicy = acks?.length > 0;

  let startStep = 'welcome';
  if (hasProfile && hasAckedPolicy) {
    // Both profile and policy done — jump to final step
    startStep = 'done';
  } else if (hasProfile && !hasAckedPolicy) {
    // Profile done but policy not yet re-acknowledged — go to policy
    const remoteDoc = state.policyDocuments.find(d => d.policy_key === 'remote_working_policy');
    const remoteContentEl = document.getElementById('onbPolicyRemoteContent');
    if (remoteContentEl) remoteContentEl.innerHTML = remoteDoc?.content_html || '<p>Policy content is being prepared.</p>';
    startStep = 'policy-remote';
  }
  // Otherwise start from welcome → profile

  showOnboardingStep(startStep);
}

function showOnboardingStep(step) {
  const overlay = document.getElementById('onboardingOverlay');
  if (!overlay) return;
  overlay.querySelectorAll('.onboarding-step').forEach(el => {
    el.style.display = el.dataset.step === step ? '' : 'none';
  });
  // Scroll to top
  overlay.querySelector('.onboarding-overlay-inner')?.scrollTo(0, 0);
}

function populateOnboardingProfileForm() {
  // Manager dropdown
  const managerSelect = document.getElementById('onbProfileManager');
  if (managerSelect) {
    managerSelect.innerHTML = '<option value="">Select your manager</option>';
    state.employeeDirectory.forEach(e => {
      if (e.id === state.currentEmployeeId) return;
      const opt = document.createElement('option');
      opt.value = e.email;
      opt.textContent = displayPersonName(e.full_name, 'Employee');
      managerSelect.appendChild(opt);
    });
  }

  // Team dropdown — the delivery teams only (ONBOARDING_DEPARTMENTS), not every
  // department that happens to exist: Leadership, Finance and Strategy are not
  // self-selectable. Starts on a placeholder so the required-field check can
  // catch someone who skipped it, rather than silently taking whatever sorted
  // first.
  const deptSelect = document.getElementById('onbProfileDept');
  if (deptSelect) {
    deptSelect.innerHTML = '<option value="">Select your team</option>';
    ONBOARDING_DEPARTMENTS.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      deptSelect.appendChild(opt);
    });
  }

  const onbCity = document.getElementById('onbProfileCity');
  const onbCityOpts = cityOptionsHtml(state.employeeProfile?.current_city);
  if (onbCity) {
    onbCity.innerHTML = onbCityOpts.html;
    onbCity.value = onbCityOpts.value; // canonical, or '' when we can't place them
  }

  // Pre-fill from existing profile data
  const profile = state.employeeProfile;
  if (profile?.full_name) document.getElementById('onbProfileFullName').value = profile.full_name;
  if (profile?.direct_manager_email && managerSelect) managerSelect.value = profile.direct_manager_email;
  if (profile?.department?.name && deptSelect) deptSelect.value = profile.department.name;
  if (profile?.date_of_birth) document.getElementById('onbProfileBirthday').value = profile.date_of_birth;
  if (profile?.emergency_contact_name) document.getElementById('onbProfileEmergencyName').value = profile.emergency_contact_name;
  if (profile?.emergency_contact_phone) {
    // Stored as "+CC number" — split back into the two fields.
    const m = String(profile.emergency_contact_phone).match(/^(\+\d{1,4})\s*(.*)$/);
    const codeEl = document.getElementById('onbProfileEmergencyCode');
    const numEl = document.getElementById('onbProfileEmergencyNumber');
    if (m && codeEl && [...codeEl.options].some(o => o.value === m[1])) {
      codeEl.value = m[1];
      if (numEl) numEl.value = m[2];
    } else if (numEl) {
      numEl.value = profile.emergency_contact_phone;
    }
  }
}

// Step navigation: Welcome -> Profile
document.querySelector('[data-goto="profile"]')?.addEventListener('click', () => showOnboardingStep('profile'));

// Step: Save Profile
document.getElementById('onbProfileSaveBtn')?.addEventListener('click', async () => {
  const fullName = document.getElementById('onbProfileFullName')?.value?.trim().replace(/\s+/g, ' ');
  const manager = document.getElementById('onbProfileManager')?.value;
  const dept = document.getElementById('onbProfileDept')?.value;
  const employmentType = document.getElementById('onbProfileEmploymentType')?.value;
  const city = document.getElementById('onbProfileCity')?.value?.trim();
  const birthday = document.getElementById('onbProfileBirthday')?.value;
  const emergName = document.getElementById('onbProfileEmergencyName')?.value?.trim();
  const emergCode = document.getElementById('onbProfileEmergencyCode')?.value || '';
  const emergNumber = (document.getElementById('onbProfileEmergencyNumber')?.value || '').replace(/[\s-]/g, '');
  const errorEl = document.getElementById('onbProfileError');

  // Validate mandatory (manager optional for leadership/admin)
  const managerRequired = !isLeadershipRole();
  if ((managerRequired && !manager) || !fullName || !dept || !employmentType || !city || !birthday || !emergName || !emergNumber) {
    errorEl.textContent = 'Please fill in all required fields.';
    errorEl.style.display = '';
    return;
  }
  if (fullName.split(' ').length < 2) {
    errorEl.textContent = 'Please enter your full name — first and last.';
    errorEl.style.display = '';
    return;
  }
  if (!/^\d{6,14}$/.test(emergNumber)) {
    errorEl.textContent = 'Emergency contact number should be 6–14 digits (without the country code).';
    errorEl.style.display = '';
    return;
  }
  const emergPhone = `${emergCode} ${emergNumber}`;
  errorEl.style.display = 'none';

  let deptId = null;
  try {
    deptId = await resolveDepartmentIdByName(dept, null);
  } catch (e) { deptId = null; }
  if (!deptId) {
    errorEl.textContent = 'Could not resolve that team. Try another.';
    errorEl.style.display = '';
    return;
  }

  const btn = document.getElementById('onbProfileSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  // Goes through submit_onboarding_profile rather than a direct update: team and
  // employment type are DECLARATIONS awaiting an approver, and the columns
  // carrying them are guarded against self-writes (a project-based person who
  // could clear their own setup_pending would fall through to "unscoped" and
  // see every client). The RPC validates the caller, writes only their own row,
  // and can only ever SET setup_pending — clearing it is activation's job.
  // This also fixes the long-standing silent discard of the team choice: the
  // old direct update wrote department_id, which the self-escalation trigger
  // reverted, so a new joiner picked a team and nothing happened.
  const { error } = await state.supabase.rpc('submit_onboarding_profile', {
    p_full_name: fullName,
    p_direct_manager_email: manager || null,
    p_requested_department_id: deptId,
    p_employment_type: employmentType,
    p_current_city: city,
    p_timezone: timezoneForCity(city),
    p_date_of_birth: birthday,
    p_emergency_contact_name: emergName,
    p_emergency_contact_phone: emergPhone
  });

  if (error) {
    errorEl.textContent = `Save failed: ${error.message}`;
    errorEl.style.display = '';
    btn.disabled = false;
    btn.textContent = 'Save & Continue';
    return;
  }

  // Reflect the confirmed name immediately (sidebar, greetings) — the DB is
  // already updated; without this the old JWT-derived name shows until reload.
  if (state.employeeProfile) {
    state.employeeProfile.full_name = fullName;
    upsertEmployeeInStore(state.employeeProfile);
    updateSidebarIdentityLabels();
  }

  // Ping the approvers. Best-effort on purpose: the durable record is
  // setup_pending, which the Awaiting Setup panel and the bell both compute
  // from, so a failed email delays a nudge — it never loses the work.
  try {
    const token = state.session?.access_token;
    if (token) {
      await fetch('/.netlify/functions/setup-approval-notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}'
      });
    }
  } catch (notifyError) {
    console.warn('Setup approval notify failed:', notifyError);
  }

  // Auto-check the "Profile completed" item on the onboarding checklist
  await autoCheckOnboardingItem('profile_completed');

  btn.textContent = 'Save & Continue';
  btn.disabled = false;

  // Load and show remote working policy
  const remoteDoc = state.policyDocuments.find(d => d.policy_key === 'remote_working_policy');
  const remoteContentEl = document.getElementById('onbPolicyRemoteContent');
  if (remoteContentEl) remoteContentEl.innerHTML = remoteDoc?.content_html || '<p>Policy content is being prepared.</p>';

  showOnboardingStep('policy-remote');
});

// Step: Got it — Remote Working Policy (includes leave policy)
document.getElementById('onbPolicyRemoteGotIt')?.addEventListener('click', async () => {
  try {
    const doc = state.policyDocuments.find(d => d.policy_key === 'remote_working_policy');
    // Record acknowledgment
    await state.supabase.from('policy_acknowledgments').upsert({
      employee_id: state.currentEmployeeId,
      policy_key: 'remote_working_policy',
      policy_version: doc?.version || '1',
      acknowledged_at: new Date().toISOString()
    }, { onConflict: 'employee_id,policy_key' });

    await autoCheckOnboardingItem('policy_remote_working_policy');

    showOnboardingStep('done');
  } catch (err) {
    console.error('Failed to acknowledge remote working policy:', err);
  }
});

// Step: Enter Colony
document.getElementById('onbDoneBtn')?.addEventListener('click', async () => {
  // Belt-and-braces: Ruby finished onboarding with a single-word name and no
  // emergency contact (5 Aug) — whatever path let that happen, completing
  // onboarding must be impossible with an incomplete profile. Re-read the DB
  // row (not local state) and bounce back to the profile step if gaps remain.
  const [{ data: freshProfile }, privateDetails] = await Promise.all([
    state.supabase
      .from('employees')
      .select('full_name, date_of_birth, current_city')
      .eq('id', state.currentEmployeeId)
      .single(),
    loadEmployeePrivateDetails(state.currentEmployeeId)
  ]);
  const p = { ...(freshProfile || {}), ...(privateDetails || {}) };
  const nameOk = String(p.full_name || '').trim().split(/\s+/).length >= 2;
  if (!nameOk || !p.date_of_birth || !p.current_city || !p.emergency_contact_name || !p.emergency_contact_phone) {
    appAlert('A few profile details are missing — one more look before you enter Colony.');
    if (state.employeeProfile) Object.assign(state.employeeProfile, p);
    showOnboardingStep('profile');
    return;
  }

  // Mark onboarding_completed
  const onbResult = await state.supabase.from('employees').update({
    onboarding_completed: true,
    updated_at: new Date().toISOString()
  }).eq('id', state.currentEmployeeId);

  if (onbResult.error) {
    console.error('Failed to mark onboarding complete:', onbResult.error);
    appAlert('Unable to save your onboarding status. Please try again or contact your manager.');
    return;
  }

  if (state.employeeProfile) state.employeeProfile.onboarding_completed = true;

  // Check if all checklist items are done → mark checklist as completed
  await maybeCompleteChecklist();

  // Hide overlay, show normal UI
  document.getElementById('onboardingOverlay').style.display = 'none';
  document.querySelector('.app-shell').style.display = '';

  // Reload data and navigate
  await loadEmployeeDirectoryFromSupabase();
  navigateToScreen(defaultHomeScreen(), { replace: true });
});

// ---- Auto-check onboarding item by auto_key ----

async function autoCheckOnboardingItem(autoKey) {
  if (!state.supabase || !state.currentEmployeeId) return;

  // Find the active checklist for this employee
  const { data: checklists } = await state.supabase
    .from('onboarding_checklists')
    .select('id')
    .eq('employee_id', state.currentEmployeeId)
    .eq('status', 'active')
    .limit(1);

  if (!checklists?.length) return;
  const checklistId = checklists[0].id;

  // Find the auto item
  const { data: items } = await state.supabase
    .from('onboarding_checklist_items')
    .select('id')
    .eq('checklist_id', checklistId)
    .eq('auto_key', autoKey)
    .eq('is_completed', false)
    .limit(1);

  if (!items?.length) return;

  await state.supabase.from('onboarding_checklist_items').update({
    is_completed: true,
    completed_at: new Date().toISOString(),
    completed_by_employee_id: state.currentEmployeeId
  }).eq('id', items[0].id);
}

async function maybeCompleteChecklist() {
  if (!state.supabase || !state.currentEmployeeId) return;
  const { data: checklists } = await state.supabase
    .from('onboarding_checklists')
    .select('id')
    .eq('employee_id', state.currentEmployeeId)
    .eq('status', 'active')
    .limit(1);
  if (!checklists?.length) return;

  const { data: remaining } = await state.supabase
    .from('onboarding_checklist_items')
    .select('id')
    .eq('checklist_id', checklists[0].id)
    .eq('is_completed', false)
    .limit(1);

  if (!remaining?.length) {
    await state.supabase.from('onboarding_checklists').update({
      status: 'completed',
      updated_at: new Date().toISOString()
    }).eq('id', checklists[0].id);
  }
}

// ---- Sidebar Onboarding Badge ----

async function loadOnboardingBadge() {
  if (!state.supabase || !isLeadershipRole()) return;
  const { data, error } = await state.supabase
    .from('onboarding_checklists')
    .select('id, employee_id')
    .eq('status', 'active');

  if (error) { console.error('Onboarding badge load error:', error); return; }
  const count = data?.length || 0;

  // Same signal, per person: the sidebar dot says "someone is mid-onboarding",
  // the directory dot says who (24 Aug 2026). Without it the sidebar dot
  // was unattributable — it looked wrong when nobody in the list was marked.
  const ids = new Set((data || []).map((r) => r.employee_id).filter(Boolean));
  const changed = ids.size !== (state.onboardingEmployeeIds?.size || 0)
    || [...ids].some((id) => !state.onboardingEmployeeIds?.has(id));
  state.onboardingEmployeeIds = ids;
  if (changed && typeof renderPeopleDirectory === 'function') renderPeopleDirectory();

  // Update sidebar badge
  const navBtn = document.querySelector('[data-screen="people-directory"]');
  if (!navBtn) return;
  const existingBadge = navBtn.querySelector('.sidebar-onboarding-badge');
  if (count > 0 && !existingBadge) {
    const badge = document.createElement('span');
    badge.className = 'sidebar-onboarding-badge';
    badge.title = `${count} active onboarding${count > 1 ? 's' : ''}`;
    navBtn.appendChild(badge);
  } else if (count === 0 && existingBadge) {
    existingBadge.remove();
  }
}

// ---- Onboarding Checklist in Employee Profile ----

async function loadOnboardingChecklist(employeeId) {
  if (!state.supabase || !isLeadershipRole()) return null;
  const { data: checklists } = await state.supabase
    .from('onboarding_checklists')
    .select('id, status, created_at')
    .eq('employee_id', employeeId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (!checklists?.length) return null;
  const checklist = checklists[0];

  const { data: items } = await state.supabase
    .from('onboarding_checklist_items')
    .select('*')
    .eq('checklist_id', checklist.id)
    .order('phase')
    .order('sort_order');

  return { ...checklist, items: items || [] };
}

function renderOnboardingChecklist(checklist, container) {
  if (!checklist || !container) return;
  container.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'panel onboarding-checklist-panel';

  const statusLabel = checklist.status === 'completed' ? ' (Completed)' : '';
  panel.innerHTML = `<h3>Onboarding Checklist${statusLabel}</h3>`;

  const phases = [
    { key: 'pre_joining', label: 'Pre-Joining' },
    { key: 'day_one', label: 'Day 1' },
    { key: 'week_one', label: 'Week 1' },
    { key: 'month_one', label: 'Month 1' }
  ];

  phases.forEach(phase => {
    const phaseItems = checklist.items.filter(i => i.phase === phase.key);
    if (!phaseItems.length) return;

    const group = document.createElement('div');
    group.className = 'onboarding-phase-group';
    group.innerHTML = `<div class="onboarding-phase-label">${phase.label}</div>`;

    phaseItems.forEach(item => {
      const completedBy = item.completed_by_employee_id
        ? (lookupEmployee(item.completed_by_employee_id)?.full_name || '').split(' ')[0]
        : '';
      const completedDate = item.completed_at ? new Date(item.completed_at).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }) : '';
      const metaText = item.is_completed ? `${completedBy} — ${completedDate}` : (item.is_auto ? 'Auto' : '');

      const row = document.createElement('div');
      row.className = 'onboarding-item';
      row.innerHTML = `
        <input type="checkbox" ${item.is_completed ? 'checked' : ''} ${item.is_auto && !item.is_completed ? 'disabled' : ''} data-item-id="${item.id}" data-checklist-id="${checklist.id}" />
        <span class="onboarding-item-title ${item.is_completed ? 'completed' : ''}">${escapeHtml(item.title)}${item.is_auto && !item.is_completed ? ' <span class="onboarding-item-auto">(auto-completed by new hire)</span>' : ''}</span>
        <span class="onboarding-item-meta">${escapeHtml(metaText)}</span>
      `;
      group.appendChild(row);
    });
    panel.appendChild(group);
  });

  container.appendChild(panel);

  // Delegate checkbox clicks
  panel.addEventListener('change', async (e) => {
    const checkbox = e.target.closest('input[type="checkbox"][data-item-id]');
    if (!checkbox) return;
    const itemId = checkbox.dataset.itemId;
    const checklistId = checkbox.dataset.checklistId;
    const isChecked = checkbox.checked;

    try {
      await state.supabase.from('onboarding_checklist_items').update({
        is_completed: isChecked,
        completed_at: isChecked ? new Date().toISOString() : null,
        completed_by_employee_id: isChecked ? state.currentEmployeeId : null
      }).eq('id', itemId);

      // Check if all items done → mark checklist completed
      const { data: remaining } = await state.supabase
        .from('onboarding_checklist_items')
        .select('id')
        .eq('checklist_id', checklistId)
        .eq('is_completed', false)
        .limit(1);

      if (!remaining?.length) {
        await state.supabase.from('onboarding_checklists').update({
          status: 'completed',
          updated_at: new Date().toISOString()
        }).eq('id', checklistId);
        // Clear onboarding flag on employee
        const empId = checklist.employee_id || state.employeeDirectory.find(e => {
          // find from checklist items context
          return true;
        })?.id;
      }

      // Refresh the employee directory to update tags/badges
      await loadEmployeeDirectoryFromSupabase();
      loadOnboardingBadge().catch(console.error);
    } catch (err) {
      console.error('Failed to update onboarding checklist item:', err);
      checkbox.checked = !isChecked; // revert on failure
    }
  });
}

// ---- Auto-spawn checklist on employee creation ----

async function spawnOnboardingForEmployee(employeeId) {
  if (!state.supabase) return;
  // Check if active checklist already exists
  const { data: existing } = await state.supabase
    .from('onboarding_checklists')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('status', 'active')
    .limit(1);
  if (existing?.length) return; // already has one

  const { data, error } = await state.supabase.rpc('spawn_onboarding_checklist', { p_employee_id: employeeId });
  if (error) console.error('Failed to spawn onboarding checklist:', error);
  return data;
}

// ---- Hook: Auto-spawn on employee creation ----
// We need to patch the existing "add employee" flow to also spawn a checklist.
// Find and wrap the employee creation handler.

const _origLoadEmployeeDirectory = loadEmployeeDirectoryFromSupabase;

// ---- Employee Profile: inject checklist if onboarding ----

// We hook into the profile screen rendering by watching for when it becomes active.
const _profileScreen = document.getElementById('employee-profile');
if (_profileScreen) {
  const observer = new MutationObserver(async () => {
    if (!_profileScreen.classList.contains('active') || !isLeadershipRole()) return;
    // Find the profile employee
    const profileHeading = document.getElementById('profileMainHeading');
    const profileName = profileHeading?.textContent?.replace('My Profile', '').trim() || state.currentEmployee;
    const employee = (state.employeeDirectory || []).find(e =>
      displayPersonName(e.full_name, 'Employee') === profileName || e.full_name === profileName
    ) || (profileName === 'My Profile' ? state.employeeProfile : null);

    if (!employee) return;

    // Check if there's an onboarding checklist for this employee
    let checklistContainer = document.getElementById('onboardingChecklistContainer');
    if (!checklistContainer) {
      checklistContainer = document.createElement('div');
      checklistContainer.id = 'onboardingChecklistContainer';
      // Insert before the first panel in the profile screen
      const firstPanel = _profileScreen.querySelector('.panel');
      if (firstPanel) _profileScreen.querySelector('.screen-head')?.after(checklistContainer);
    }

    if (employee.onboarding_completed === false) {
      const checklist = await loadOnboardingChecklist(employee.id);
      if (checklist) {
        checklist.employee_id = employee.id;
        renderOnboardingChecklist(checklist, checklistContainer);
      } else {
        checklistContainer.innerHTML = '';
      }
    } else {
      checklistContainer.innerHTML = '';
    }
  });
  observer.observe(_profileScreen, { attributes: true, attributeFilter: ['class'] });
}

// =========================================================================
// END ONBOARDING SYSTEM
// =========================================================================

updateSidebarIdentityLabels();
updateAllLastEditLabels();
setSelectedEmployee(DEFAULT_EMPLOYEE);
applyRoleAccess();
applyFractionalVisibility();
renderClientOwnerOptions();
resetClientEditor();
setClientFormNotice('');
initializeScreenHistory();

// Set footer version from git tag (version.js sets APP_VERSION at build time)
(function setFooterVersion() {
  const el = document.getElementById('footerVersion');
  if (el) el.textContent = productName(location.hostname) + ' ' + (window.APP_VERSION || 'dev') + ' \u00A9 2026';
})();

// Load changelog for home feed
fetch('changelog.json').then(r => r.json()).then(data => { APP_UPDATES = data; }).catch(() => {});

// ── Deploy watcher ──
// Colony is an SPA with hash routing: a tab can live for DAYS without a real
// page load, running code from whenever it was opened — Alex was told a fix
// had shipped and couldn't see it. Worse, version.js itself is cached
// immutable for a year on an unversioned URL, so even checking
// window.APP_VERSION lies. The ?cb= query makes each poll a unique URL,
// bypassing both browser and CDN caches (same trick the deploy-verify curl
// uses). On version change: a small refresh bar, never a forced reload —
// someone may be mid-edit in a form.
(function watchForNewDeploys() {
  const current = window.APP_VERSION;
  if (!current || current === 'dev') return;
  const check = async () => {
    try {
      const txt = await (await fetch(`version.js?cb=${Date.now()}`, { cache: 'no-store' })).text();
      const m = txt.match(/'([^']+)'/);
      if (m && m[1] !== current && !document.getElementById('deployRefreshBar')) {
        const bar = document.createElement('div');
        bar.id = 'deployRefreshBar';
        bar.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9999;background:var(--text,#333);color:var(--bg,#fff);padding:10px 18px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,0.25);display:flex;gap:12px;align-items:center;font-size:14px;';
        // Fires on whichever host the viewer is on, so this said "Colony has
        // been updated" to clients after every deploy.
        bar.innerHTML = `<span>${escapeHtml(productName(location.hostname))} has been updated.</span><button type="button" style="all:unset;cursor:pointer;font-weight:700;text-decoration:underline;">Refresh</button>`;
        bar.querySelector('button').addEventListener('click', () => location.reload());
        document.body.appendChild(bar);
      }
    } catch (e) { /* offline etc — try again next tick */ }
  };
  setInterval(check, 5 * 60 * 1000);
  setTimeout(check, 20 * 1000); // catch a deploy that landed while loading
})();

initializeSupabaseAuth().catch((error) => {
  console.error(error);
  setLoginStatus(`Supabase initialization failed: ${error.message}`, 'status error');
});

// ══════════════════════════════════════════════════════════════════
// Brief pipeline (the client Brief Tracking) — partner surface + internal board
// ══════════════════════════════════════════════════════════════════

let briefsCache = [];
let briefDeliverablesCache = [];
let briefPartnersById = {};
// One SLA, not two (24 Aug 2026): the internal and client turnaround are
// the same number. Splitting a deliverable between writer and designer is the
// creative team's business, not the tracker's — so app.deliverable_sla and its
// per-discipline rows are gone, and everything reads app.client_sla.
let activeBriefId = null;
let briefEditingId = null;

function briefById(id) { return briefsCache.find(b => b.id === id) || null; }

// Fire-and-forget email per the Section 7 notification matrix. Server decides
// recipients; failures only warn — the state change already happened.
function notifyBriefEvent(briefEvent, briefId, extra = {}) {
  const token = state.session?.access_token;
  if (!token || !briefId) return;
  fetch('/.netlify/functions/brief-notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ event: briefEvent, briefId, ...extra })
  }).catch((err) => console.warn('Brief notify failed:', err));
}
function briefDeliverablesFor(briefId) { return briefDeliverablesCache.filter(d => d.brief_id === briefId); }

// Accepts a brief row OR a bare status string — history rows and deliverables
// pass the latter, and those are never paused.
function briefStatusChip(input) {
  const brief = (input && typeof input === 'object') ? input : null;
  const status = brief ? brief.status : input;
  if (brief && isBriefPaused(brief)) {
    return `<span class="brief-status-chip st-on_pause" title="${escapeHtml(briefPauseDetail(brief))}">On pause</span>`;
  }
  const label = BRIEF_STATUS_LABEL[status] || status;
  return `<span class="brief-status-chip st-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function briefDateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function briefSubmitterName(brief) {
  if (brief.submitted_by_partner_id) {
    return briefPartnersById[brief.submitted_by_partner_id]?.full_name || 'Partner';
  }
  if (brief.submitted_by_employee_id) return getEmployeeNameById(brief.submitted_by_employee_id);
  return '';
}

async function loadBriefsData() {
  if (!state.supabase) return;
  const [briefsRes, delivRes, partnersRes] = await Promise.all([
    state.supabase.from('briefs').select('*').order('created_at', { ascending: false }),
    state.supabase.from('brief_deliverables').select('*').order('created_at', { ascending: true }),
    state.supabase.from('partners').select('id, full_name, email, org, partner_role')
  ]);
  if (briefsRes.error) throw briefsRes.error;
  briefsCache = briefsRes.data || [];
  briefDeliverablesCache = delivRes.data || [];
  briefPartnersById = {};
  (partnersRes.data || []).forEach(p => { briefPartnersById[p.id] = p; });
}

// ── Partner surface ──────────────────────────────────────────────

// Client-facing SLA (app.client_sla) and the holiday calendar, both readable by
// partners since 24 Aug 2026. the client is quoted turnaround in WORKING days, so they
// cannot check a date without knowing which days Your Agency is closed.
// Keyed org → deliverable_type → row. The SLA is per client since 17 Sep
// 2026: a partner's RLS returns only their org, employees get every org, so
// always look up by the org of the brief (or the partner) in hand.
let clientSlaByOrg = {};
let holidayCache = [];

function slaForOrg(org) {
  return clientSlaByOrg[org] || {};
}

async function loadSlaAndHolidays() {
  if (!state.supabase) return;
  const [slaRes, holRes] = await Promise.all([
    state.supabase.from('client_sla').select('*'),
    state.supabase.from('public_holidays').select('holiday_date, name').order('holiday_date')
  ]);
  clientSlaByOrg = {};
  (slaRes.data || []).forEach((r) => {
    (clientSlaByOrg[r.org] = clientSlaByOrg[r.org] || {})[r.deliverable_type] = r;
  });
  holidayCache = (holRes.data || []).map((r) => ({ date: r.holiday_date, name: r.name }));
}

// Safe to call before the holiday fetch lands: an empty list simply means
// weekends are still skipped and holidays are not yet known.
function holidayDates() { return (holidayCache || []).map((h) => h.date); }

// IST is the agency clock the SLA's 2 PM cut-off is written against, so ask for
// the hour in IST rather than the viewer's zone — the client sits in five timezones.
function currentIstHour() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false
  }).format(new Date()));
}

function renderPartnerHolidayNote() {
  const el = document.getElementById('partnerHolidayNote');
  if (!el) return;
  const next = nextHoliday(toISODateLocal(), holidayCache);
  if (!next) { el.classList.add('hidden'); return; }
  const d = new Date(next.date + 'T00:00:00Z');
  const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  el.classList.remove('hidden');
  el.innerHTML = `Your Agency's next public holiday is <strong>${escapeHtml(label)}</strong> (${escapeHtml(next.name)}).`;
}

// Sign-in awaits this before dismissing the splash, then opens partner-home —
// and activating that screen calls it again, so every client sign-in fetched
// briefs, deliverables, partners, SLA and holidays twice (~1.3s, measured 17
// Sep 2026). A call made while one is running, or within 2s of one finishing,
// reuses it; navigating back later still refreshes.
let partnerDataLoad = null;
let partnerDataLoadedAt = 0;
function loadPartnerData() {
  if (partnerDataLoad) return partnerDataLoad;
  if (Date.now() - partnerDataLoadedAt < 2000) {
    renderPartnerHome();
    renderPartnerHolidayNote();
    return Promise.resolve();
  }
  partnerDataLoad = (async () => {
    try {
      await Promise.all([loadBriefsData(), loadSlaAndHolidays()]);
      partnerDataLoadedAt = Date.now();
      renderPartnerHome();
      renderPartnerHolidayNote();
    } finally {
      partnerDataLoad = null;
    }
  })();
  return partnerDataLoad;
}

function renderPartnerHome() {
  applyStaffOnCircleReadOnly();
  const list = document.getElementById('partnerBriefList');
  const empty = document.getElementById('partnerBriefEmpty');
  const greeting = document.getElementById('partnerGreeting');
  if (!list || !empty) return;
  if (greeting && state.partnerProfile) {
    greeting.textContent = `${displayPersonName(state.partnerProfile.full_name, 'Partner')} — ${state.partnerProfile.org}`;
  }
  const rows = [...briefsCache].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  empty.classList.toggle('hidden', rows.length > 0);
  // Attention strip: briefs bounced back for more info, and fresh deliveries.
  // Everyone in the org now SEES every request, so the attention strip has to
  // separate "yours to act on" from "your team's, for information". Telling
  // someone to edit and resubmit a brief they cannot write to would be an
  // instruction they can only fail (Mira Holt's visibility ask, 10 Sep 2026).
  const isMine = (b) => b.submitted_by_partner_id === state.partnerProfile?.id;
  const isCoordinator = state.partnerProfile?.partner_role === 'coordinator';
  const canActOn = (b) => isMine(b) || isCoordinator;
  const needsInfo = rows.filter(b => b.status === 'pending_info' && canActOn(b));
  const delivered = rows.filter(b => b.status === 'delivered');
  const awaitingApproval = isCoordinator
    ? rows.filter(b => b.status === 'submitted' && b.request_type === 'brief')
    : [];
  const attention = [
    ...awaitingApproval.map(b => `<div class="brief-quick-card" data-open-brief="${b.id}">
      <span style="flex:1;">📨 “${escapeHtml(b.title)}” is waiting for your approval to go to Your Agency</span>
    </div>`),
    ...needsInfo.map(b => `<div class="brief-quick-card" data-open-brief="${b.id}">
      <span style="flex:1;">⚠️ The Your Agency team needs more info on “${escapeHtml(b.title)}” — open it to edit &amp; resubmit</span>
    </div>`),
    ...delivered.map(b => `<div class="brief-quick-card" data-open-brief="${b.id}" style="background:rgba(80,170,110,0.12);">
      <span style="flex:1;">✅ “${escapeHtml(b.title)}” has been delivered — open to download</span>
    </div>`)
  ].join('');
  list.innerHTML = (attention ? `<div class="brief-quick-lane">${attention}</div>` : '') + rows.map(b => {
    const typeBadge = b.request_type === 'notify_only'
      ? '<span class="brief-status-chip">Quick note</span>' : '';
    const deliv = briefDeliverablesFor(b.id);
    const done = deliv.filter(d => d.status === 'delivered').length;
    const progress = deliv.length ? ` · ${done}/${deliv.length} deliverables done` : '';
    return `<div class="feed-card" data-open-brief="${b.id}" style="cursor:pointer;">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:640;">${escapeHtml(b.title)}</div>
        <div class="mini-meta">${escapeHtml(briefDateLabel(b.created_at))} · ${escapeHtml(briefRequesterLine(b, briefSubmitterName(b)))}${progress}</div>
      </div>
      <div>${typeBadge} ${briefStatusChip(b)}</div>
    </div>`;
  }).join('');
}

// Turnaround guidance on the request form, straight from the signed SLA —
// Rhea asked for it because the client was picking deadlines blind (24 Aug 2026).
// The suggestion is the SLOWEST selected deliverable, since the request lands
// as one delivery, and it is only ever a suggestion: the field stays theirs.
function renderSlaHint() {
  const box = document.getElementById('bfSlaHint');
  if (!box) return;
  const types = [...document.querySelectorAll('[data-bf-deliv]:checked')].map((el) => el.value);
  if (!types.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  const today = toISODateLocal();
  const hols = holidayDates();
  // The request form is partner-only (inserts stamp partnerProfile.org).
  const slaByType = slaForOrg(state.partnerProfile?.org);
  const lines = types.map((t) => {
    const sla = slaByType[t];
    const label = BRIEF_DELIVERABLE_OPTIONS.find((o) => o.type === t)?.label || t;
    if (!sla) return `<li>${escapeHtml(label)} — timeline confirmed at briefing</li>`;
    const scope = sla.in_scope ? '' : ' <em>(outside current scope — we\u2019ll confirm on review)</em>';
    return `<li>${escapeHtml(label)} — <strong>${escapeHtml(formatSlaDays(sla))}</strong>${scope}</li>`;
  });

  const suggested = suggestedDeadline(types, slaByType, today, currentIstHour(), hols);
  let footer = '';
  if (suggested) {
    const d = new Date(suggested + 'T00:00:00Z');
    const nice = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    // Just the date and the button. The holiday note and the working-day
    // explainer were both dropped (3 Sep 2026) — the suggestion already
    // accounts for holidays, weekends and the 2 PM cutoff, so spelling out the
    // arithmetic only crowded the form.
    footer = `<p class="mini-meta" style="margin-top:8px;">Earliest realistic deadline: <strong>${escapeHtml(nice)}</strong>`
      + `<button type="button" class="ghost small" id="bfUseSuggested" style="margin-left:8px;">Use this date</button></p>`;
  }
  box.classList.remove('hidden');
  box.innerHTML = `<p class="mini-meta" style="margin:0 0 4px;">Agreed turnaround for what you\u2019ve selected:</p><ul class="mini-meta" style="margin:0;padding-left:18px;">${lines.join('')}</ul>${footer}`;
  document.getElementById('bfUseSuggested')?.addEventListener('click', () => {
    const el = document.getElementById('bfDeadline');
    if (el && suggested) el.value = suggested;
  });
}

// The approver is picked from the client's own stakeholder map
// (app.org_contacts), not typed (3 Sep 2026): free text produced names
// nobody could route to or chase. RLS already scopes that table to the
// partner's own org, so a partner sees exactly their people. "Someone else"
// keeps a one-off approver possible without reopening the field to typos.
const BRIEF_APPROVER_OTHER = '__other';

function briefApproverValue() {
  const sel = document.getElementById('bfApprover');
  if (!sel) return '';
  return sel.value === BRIEF_APPROVER_OTHER
    ? (document.getElementById('bfApproverOther')?.value || '').trim()
    : sel.value;
}

// Show the free-text box only while "Someone else" is the selection. Kept
// separate from setBriefApproverValue: the change handler must NOT round-trip
// through that, because choosing "Someone else" means the text box is still
// empty, and re-applying an empty value would bounce the select straight back
// to the placeholder — making that option impossible to pick.
function syncBriefApproverOther() {
  const sel = document.getElementById('bfApprover');
  document.getElementById('bfApproverOther')
    ?.classList.toggle('hidden', !sel || sel.value !== BRIEF_APPROVER_OTHER);
}

function setBriefApproverValue(name) {
  const sel = document.getElementById('bfApprover');
  const other = document.getElementById('bfApproverOther');
  if (!sel) return;
  const listed = [...sel.options].some((o) => o.value && o.value !== BRIEF_APPROVER_OTHER && o.value === name);
  // A name from before this dropdown existed (or a contact since removed) must
  // survive an edit-and-resubmit rather than silently blanking.
  if (name && !listed) {
    // Assigning a value with no matching <option> is a silent no-op, so make
    // sure the escape hatch exists before leaning on it.
    if (![...sel.options].some((o) => o.value === BRIEF_APPROVER_OTHER)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${BRIEF_APPROVER_OTHER}">Someone else…</option>`);
    }
    sel.value = BRIEF_APPROVER_OTHER;
    if (other) other.value = name;
  } else {
    sel.value = name || '';
    if (other) other.value = '';
  }
  syncBriefApproverOther();
}

function renderBriefApproverOptions() {
  const sel = document.getElementById('bfApprover');
  if (!sel) return;
  const keep = briefApproverValue();   // read BEFORE the options are replaced
  sel.innerHTML = '<option value="">Select approver</option>'
    + orgContactsCache
      .filter((c) => c.full_name)
      .map((c) => `<option value="${escapeHtml(c.full_name)}">${escapeHtml(c.team_role ? `${c.full_name} — ${c.team_role}` : c.full_name)}</option>`).join('')
    + `<option value="${BRIEF_APPROVER_OTHER}">Someone else…</option>`;
  setBriefApproverValue(keep);
}

// "Raising this for someone else" — Mira Holt, 10 Sep 2026. Adam briefed a
// poster in Slack because that is where he was; retyping it made the brief look
// like Rhea's and lost the person to go back to. Same shape as the approver
// dropdown, including its trap: the change handler must only toggle visibility,
// never re-apply the value, or "Someone else" bounces straight back.
const BRIEF_ON_BEHALF_OTHER = '__other';

function briefOnBehalfValue() {
  const sel = document.getElementById('bfOnBehalf');
  if (!sel || !sel.value) return { name: '', email: '' };
  if (sel.value === BRIEF_ON_BEHALF_OTHER) {
    return {
      name: (document.getElementById('bfOnBehalfOther')?.value || '').trim(),
      email: (document.getElementById('bfOnBehalfEmail')?.value || '').trim()
    };
  }
  // A listed contact carries their own email; asking for it again would just
  // invite a typo next to a record we already hold.
  const contact = orgContactsCache.find((c) => c.full_name === sel.value);
  return { name: sel.value, email: (contact?.email || '').trim() };
}

function syncBriefOnBehalfOther() {
  const sel = document.getElementById('bfOnBehalf');
  const other = sel && sel.value === BRIEF_ON_BEHALF_OTHER;
  document.getElementById('bfOnBehalfOther')?.classList.toggle('hidden', !other);
  document.getElementById('bfOnBehalfEmail')?.classList.toggle('hidden', !other);
}

function setBriefOnBehalfValue(name, email) {
  const sel = document.getElementById('bfOnBehalf');
  const other = document.getElementById('bfOnBehalfOther');
  const mail = document.getElementById('bfOnBehalfEmail');
  if (!sel) return;
  const listed = [...sel.options].some((o) => o.value && o.value !== BRIEF_ON_BEHALF_OTHER && o.value === name);
  if (name && !listed) {
    // Assigning a value with no matching <option> is a silent no-op, so make
    // sure the escape hatch exists before leaning on it.
    if (![...sel.options].some((o) => o.value === BRIEF_ON_BEHALF_OTHER)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${BRIEF_ON_BEHALF_OTHER}">Someone else…</option>`);
    }
    sel.value = BRIEF_ON_BEHALF_OTHER;
    if (other) other.value = name;
    if (mail) mail.value = email || '';
  } else {
    sel.value = name || '';
    if (other) other.value = '';
    if (mail) mail.value = '';
  }
  syncBriefOnBehalfOther();
}

function renderBriefOnBehalfOptions() {
  const sel = document.getElementById('bfOnBehalf');
  if (!sel) return;
  const keep = briefOnBehalfValue();   // read BEFORE the options are replaced
  sel.innerHTML = '<option value="">No — this is my own request</option>'
    + orgContactsCache
      .filter((c) => c.full_name)
      .map((c) => `<option value="${escapeHtml(c.full_name)}">${escapeHtml(c.team_role ? `${c.full_name} — ${c.team_role}` : c.full_name)}</option>`).join('')
    + `<option value="${BRIEF_ON_BEHALF_OTHER}">Someone else…</option>`;
  setBriefOnBehalfValue(keep.name, keep.email);
}

function renderBriefFormOptions() {
  const delivWrap = document.getElementById('bfDeliverables');
  const platWrap = document.getElementById('bfPlatforms');
  const approverSel = document.getElementById('bfApprover');
  if (approverSel && !approverSel.dataset.built) {
    approverSel.dataset.built = '1';
    approverSel.addEventListener('change', syncBriefApproverOther);
    // The panel that normally loads these contacts is not on this screen.
    if (!orgContactsCache.length) loadOrgContacts().catch(console.error);
  }
  const onBehalfSel = document.getElementById('bfOnBehalf');
  if (onBehalfSel && !onBehalfSel.dataset.built) {
    onBehalfSel.dataset.built = '1';
    onBehalfSel.addEventListener('change', syncBriefOnBehalfOther);
    if (!orgContactsCache.length) loadOrgContacts().catch(console.error);
  }
  renderBriefApproverOptions();
  renderBriefOnBehalfOptions();
  if (delivWrap && !delivWrap.dataset.built) {
    delivWrap.innerHTML = BRIEF_DELIVERABLE_OPTIONS.map(o =>
      `<label><input type="checkbox" value="${escapeHtml(o.type)}" data-bf-deliv> ${escapeHtml(o.label)}</label>`).join('');
    delivWrap.dataset.built = '1';
    delivWrap.addEventListener('change', renderSlaHint);
  }
  if (platWrap && !platWrap.dataset.built) {
    platWrap.innerHTML = BRIEF_PLATFORM_OPTIONS.map(p =>
      `<label><input type="checkbox" value="${escapeHtml(p)}" data-bf-plat> ${escapeHtml(p)}</label>`).join('');
    platWrap.dataset.built = '1';
  }
}

function setBriefFormNotice(message = '', className = 'mini-meta') {
  const el = document.getElementById('briefFormNotice');
  if (el) { el.textContent = message; el.className = className; }
}

function applyBriefFormTypeVisibility() {
  const type = document.getElementById('bfRequestType')?.value || 'brief';
  document.getElementById('bfFullFields')?.classList.toggle('hidden', type !== 'brief');
  document.getElementById('bfNotifyFieldWrap')?.classList.toggle('hidden', type === 'brief');
}

function applyBriefFormPriorityVisibility() {
  const p = document.getElementById('bfPriority')?.value || 'P2';
  document.getElementById('bfUrgencyWrap')?.classList.toggle('hidden', p !== 'P0' && p !== 'P1');
}

function resetBriefForm(prefill = null) {
  renderBriefFormOptions();
  briefEditingId = prefill?.id || null;
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  setVal('bfRequestType', prefill?.request_type || 'brief');
  setVal('bfTitle', prefill?.title);
  setVal('bfObjective', prefill?.objective);
  setVal('bfKeyMessage', prefill?.key_message);
  setVal('bfAudience', prefill?.audience);
  setVal('bfContent', prefill?.request_type === 'notify_only' ? '' : prefill?.content_text);
  setVal('bfNotifyMessage', prefill?.request_type === 'notify_only' ? prefill?.content_text : '');
  setVal('bfKeyDates', prefill?.key_dates);
  setVal('bfLinks', prefill?.links);
  setVal('bfPartnersTag', prefill?.partners_to_tag);
  setVal('bfCredits', prefill?.media_credits);
  setVal('bfPublishDate', prefill?.preferred_publish_date);
  setVal('bfDeadline', prefill?.deadline);
  setBriefApproverValue(prefill?.approver_name || '');
  setBriefOnBehalfValue(prefill?.on_behalf_of_name || '', prefill?.on_behalf_of_email || '');
  setVal('bfPriority', prefill?.priority || 'P2');
  setVal('bfUrgencyReason', prefill?.urgency_reason);
  setVal('bfNotes', prefill?.notes);
  const filesEl = document.getElementById('bfFiles');
  if (filesEl) filesEl.value = '';
  document.querySelectorAll('[data-bf-deliv]').forEach(cb => { cb.checked = (prefill?.requested_deliverables || []).includes(cb.value); });
  document.querySelectorAll('[data-bf-plat]').forEach(cb => { cb.checked = (prefill?.platforms || []).includes(cb.value); });
  document.querySelectorAll('#briefFormGrid .field-missing').forEach(n => n.classList.remove('field-missing'));
  setBriefFormNotice('');
  applyBriefFormTypeVisibility();
  applyBriefFormPriorityVisibility();
}

function collectBriefForm() {
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const type = val('bfRequestType') || 'brief';
  return {
    request_type: type,
    title: val('bfTitle'),
    objective: val('bfObjective'),
    key_message: val('bfKeyMessage'),
    audience: val('bfAudience'),
    platforms: [...document.querySelectorAll('[data-bf-plat]:checked')].map(cb => cb.value),
    requested_deliverables: [...document.querySelectorAll('[data-bf-deliv]:checked')].map(cb => cb.value),
    content_text: type === 'notify_only' ? val('bfNotifyMessage') : val('bfContent'),
    key_dates: val('bfKeyDates'),
    links: val('bfLinks'),
    partners_to_tag: val('bfPartnersTag'),
    media_credits: val('bfCredits'),
    preferred_publish_date: val('bfPublishDate') || null,
    deadline: val('bfDeadline') || null,
    approver_name: briefApproverValue(),
    // Null, not '': the check constraint reads a blank name as absent, and an
    // empty string here would store a name nobody typed.
    on_behalf_of_name: briefOnBehalfValue().name || null,
    on_behalf_of_email: (briefOnBehalfValue().name && briefOnBehalfValue().email) || null,
    priority: val('bfPriority') || 'P2',
    urgency_reason: val('bfUrgencyReason'),
    notes: val('bfNotes')
  };
}

const BRIEF_FIELD_WRAP_IDS = {
  title: 'bfTitle', objective: 'bfObjective', key_message: 'bfKeyMessage',
  audience: 'bfAudience', key_dates: 'bfKeyDates', approver_name: 'bfApprover',
  platforms: 'bfPlatforms', requested_deliverables: 'bfDeliverables',
  deadline: 'bfDeadline', content_text: 'bfNotifyMessage'
};

function markBriefFormMissing(missing, requestType = 'brief') {
  document.querySelectorAll('#briefFormGrid .field-missing').forEach(n => n.classList.remove('field-missing'));
  missing.forEach(({ key }) => {
    // content_text lives in two inputs: the notify message vs the brief's copy field
    const id = (key === 'content_text' && requestType === 'brief') ? 'bfContent' : BRIEF_FIELD_WRAP_IDS[key];
    const el = document.getElementById(id);
    el?.closest('.form-field')?.classList.add('field-missing');
  });
}

async function submitPartnerBrief() {
  if (!state.supabase || !state.partnerProfile) return;
  const brief = collectBriefForm();
  const missing = briefMissingFields(brief);
  if ((brief.priority === 'P0' || brief.priority === 'P1') && !brief.urgency_reason) {
    missing.push({ key: 'urgency_reason', label: 'Reason for urgency' });
    document.getElementById('bfUrgencyWrap')?.classList.add('field-missing');
  }
  markBriefFormMissing(missing, brief.request_type);
  if (missing.length) {
    setBriefFormNotice(`Missing: ${missing.map(m => m.label).join(', ')}`, 'mini-meta warn');
    return;
  }
  setBriefFormNotice('Submitting…');
  // v2 the client gate: a submitter's brief starts at 'submitted' (with Grace);
  // a coordinator's own brief goes straight to Your Agency. The DB trigger
  // enforces this server-side regardless of what we send.
  const isCoordinator = state.partnerProfile?.partner_role === 'coordinator';
  const editingOld = briefEditingId ? briefById(briefEditingId) : null;
  const targetStatus = brief.request_type !== 'brief' ? 'submitted'
    : briefEditingId
      ? ((editingOld?.status === 'pending_info' || isCoordinator) ? 'ready_for_review' : 'submitted')
      : (isCoordinator ? 'ready_for_review' : 'submitted');
  let briefId = briefEditingId;
  if (briefEditingId) {
    const { data, error } = await state.supabase.from('briefs')
      .update({ ...brief, status: targetStatus })
      .eq('id', briefEditingId).select();
    if (error) { setBriefFormNotice('Could not update: ' + error.message, 'mini-meta warn'); return; }
    if (!data || !data.length) { setBriefFormNotice('Nothing updated (is the brief locked?).', 'mini-meta warn'); return; }
    if (targetStatus === 'ready_for_review' && editingOld?.status === 'pending_info') {
      notifyBriefEvent('ga_approved', briefEditingId);
    }
  } else {
    const { data, error } = await state.supabase.from('briefs')
      .insert({
        ...brief,
        status: targetStatus,
        org: state.partnerProfile.org,
        submitted_by_partner_id: state.partnerProfile.id
      }).select();
    if (error) { setBriefFormNotice('Could not submit: ' + error.message, 'mini-meta warn'); return; }
    briefId = data?.[0]?.id;
    // Submitter → Grace gets the approval ask; coordinator's own brief is
    // already client-approved, so Your Agency gets pinged directly.
    notifyBriefEvent(isCoordinator ? 'ga_approved' : 'submitted', briefId);
  }
  // Attachments → briefs/<id>/ga/
  const filesEl = document.getElementById('bfFiles');
  const files = [...(filesEl?.files || [])];
  for (const file of files) {
    const path = `${briefId}/ga/${Date.now()}_${file.name}`;
    const { error: upErr } = await state.supabase.storage.from('briefs').upload(path, file);
    if (upErr) setBriefFormNotice(`Upload failed for ${file.name}: ${upErr.message}`, 'mini-meta warn');
  }
  briefEditingId = null;
  await loadBriefsData();
  if (state.partnerProfile) {
    openPartnerBriefDetail(briefId);
  } else {
    renderBriefBoard();
  }
}

function openPartnerBriefDetail(briefId) {
  activeBriefId = briefId;
  navigateToScreen('partner-brief-detail');
  renderPartnerBriefDetail().catch(console.error);
}

function briefSummaryRows(brief) {
  const delivLabels = (brief.requested_deliverables || []).map(t =>
    BRIEF_DELIVERABLE_OPTIONS.find(o => o.type === t)?.label || t);
  const rows = [
    ['Type', brief.request_type === 'notify_only' ? 'Quick notification' : 'Creative brief'],
    ['Priority', BRIEF_PRIORITY_META[brief.priority]?.label || brief.priority],
    ['Urgency reason', brief.urgency_reason],
    ['Objective', brief.objective],
    ['Key message', brief.key_message],
    ['Audience', brief.audience],
    ['Deliverables', delivLabels.join(', ')],
    ['Platforms', (brief.platforms || []).join(', ')],
    ['Content / copy', brief.content_text],
    ['Key dates', brief.key_dates],
    ['Links', brief.links],
    ['Partners to tag', brief.partners_to_tag],
    ['Media credits', brief.media_credits],
    ['Preferred publish', brief.preferred_publish_date],
    ['Deadline', brief.deadline],
    ['Approver', brief.approver_name],
    ['Notes', brief.notes],
    ['Submitted by', briefSubmitterName(brief)],
    // Only appears when someone logged it for another person — the row the
    // team needs to know who to go back to with a question.
    ['Raised for', briefOnBehalfDetail(brief)]
  ];
  return rows.filter(([, v]) => v && String(v).trim() !== '');
}

function renderBriefSummaryHtml(brief) {
  return `<dl class="brief-summary-grid">${briefSummaryRows(brief)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${linkifyProse(String(v))}</dd>`).join('')}</dl>`;
}

async function loadBriefHistory(briefId) {
  const { data } = await state.supabase.from('brief_status_history')
    .select('status, entered_at, exited_at')
    .eq('brief_id', briefId).order('entered_at', { ascending: true });
  return data || [];
}

function renderBriefTimelineHtml(history) {
  if (!history.length) return '<p class="mini-meta">No history yet.</p>';
  return `<div class="brief-timeline">${history.map(h => {
    const when = new Date(h.entered_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="brief-timeline-row"><span class="when">${escapeHtml(when)}</span>${briefStatusChip(h.status)}</div>`;
  }).join('')}</div>`;
}

function renderBriefDeliverablesReadonlyHtml(briefId) {
  const rows = briefDeliverablesFor(briefId);
  if (!rows.length) return '';
  return rows.map(d => {
    const label = d.title || BRIEF_DELIVERABLE_OPTIONS.find(o => o.type === d.deliverable_type)?.label || d.deliverable_type || 'Deliverable';
    const overdue = deliverableIsOverdue(d) ? ' <span class="overdue">overdue</span>' : '';
    const driveLink = (d.delivery_url && d.status === 'delivered')
      ? ` <a href="${escapeHtml(d.delivery_url)}" target="_blank" rel="noopener" class="ghost small" style="text-decoration:none;">Open in Drive ↗</a>`
      : '';
    return `<div class="brief-deliv-row"><span style="flex:1;">${escapeHtml(label)}${d.discipline ? ` <span class="mini-meta">(${escapeHtml(d.discipline)})</span>` : ''}</span>${briefStatusChip(d.status)}${overdue}${driveLink}</div>`;
  }).join('');
}

async function listBriefFiles(briefId, includeDelivered) {
  const out = [];
  const folders = ['ga'];
  if (includeDelivered) folders.push('delivered');
  for (const folder of folders) {
    const { data } = await state.supabase.storage.from('briefs').list(`${briefId}/${folder}`, { limit: 100 });
    (data || []).forEach(f => { if (f.name) out.push({ folder, name: f.name, path: `${briefId}/${folder}/${f.name}` }); });
  }
  return out;
}

function renderBriefFilesHtml(files) {
  if (!files.length) return '<p class="mini-meta">No files yet.</p>';
  return files.map(f => `<div class="brief-deliv-row">
    <span style="flex:1;">${f.folder === 'delivered' ? '📦 ' : ''}${escapeHtml(f.name.replace(/^\d+_/, ''))}</span>
    <button class="ghost small" data-brief-file="${escapeHtml(f.path)}" type="button">Download</button>
  </div>`).join('');
}

async function openBriefFile(path) {
  const { data, error } = await state.supabase.storage.from('briefs').createSignedUrl(path, 300);
  if (error || !data?.signedUrl) return;
  window.open(data.signedUrl, '_blank', 'noopener');
}

async function loadBriefComments(briefId) {
  const { data } = await state.supabase.from('brief_comments')
    .select('*').eq('brief_id', briefId).order('created_at', { ascending: true });
  return data || [];
}

function renderBriefCommentsHtml(comments) {
  if (!comments.length) return '<p class="mini-meta">No comments yet.</p>';
  return comments.map(c => {
    const who = c.author_name || (c.author_partner_id ? (briefPartnersById[c.author_partner_id]?.full_name || 'Partner') : getEmployeeNameById(c.author_employee_id));
    const when = new Date(c.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const internal = c.visibility === 'internal';
    return `<div class="brief-comment${internal ? ' internal' : ''}">
      <div class="who">${escapeHtml(who)} · ${escapeHtml(when)}${internal ? ' · internal' : ''}</div>
      <div class="body">${linkifyProse(unwrapHardBreaks(c.body))}</div>
    </div>`;
  }).join('');
}

async function renderPartnerBriefDetail() {
  const brief = briefById(activeBriefId);
  if (!brief) return;
  const titleEl = document.getElementById('pbdTitle');
  const statusLine = document.getElementById('pbdStatusLine');
  if (titleEl) titleEl.textContent = brief.title;
  if (statusLine) statusLine.innerHTML = `${briefStatusChip(brief)} · submitted ${escapeHtml(briefDateLabel(brief.created_at))}`;
  // Staff on Circle read the client's brief but act on it only from Colony.
  // Without this, `partnerProfile?.partner_role !== 'client_viewer'` is true
  // for a reviewer (no partner profile at all), so the edit bar, the revision
  // button and the upload box all showed on clients.youragency.com (audit 17 Sep).
  const staffView = Boolean(state.staffOnCircle) && !state.partnerProfile;
  const editable = !staffView && ['submitted', 'pending_info'].includes(brief.status)
    && state.partnerProfile?.partner_role !== 'client_viewer';
  document.getElementById('pbdEditBar')?.classList.toggle('hidden', !editable);
  const approveBtn = document.getElementById('pbdApproveBtn');
  if (approveBtn) {
    approveBtn.classList.toggle('hidden',
      !(brief.status === 'submitted' && state.partnerProfile?.partner_role === 'coordinator'));
  }
  const revisionBtn = document.getElementById('pbdRevisionBtn');
  if (revisionBtn) {
    revisionBtn.classList.toggle('hidden',
      !(!staffView && brief.status === 'delivered' && state.partnerProfile?.partner_role !== 'client_viewer'));
  }
  ['pbdUploadInput', 'pbdCommentInput'].forEach((id) => {
    document.getElementById(id)?.closest('.action-row')?.classList.toggle('hidden', staffView);
  });
  const summaryEl = document.getElementById('pbdSummary');
  if (summaryEl) summaryEl.innerHTML = renderBriefSummaryHtml(brief);
  const delivEl = document.getElementById('pbdDeliverables');
  if (delivEl) delivEl.innerHTML = renderBriefDeliverablesReadonlyHtml(brief.id);
  const [history, comments, files] = await Promise.all([
    loadBriefHistory(brief.id),
    loadBriefComments(brief.id),
    listBriefFiles(brief.id, ['delivered', 'completed'].includes(brief.status))
  ]);
  const tlEl = document.getElementById('pbdTimeline');
  if (tlEl) tlEl.innerHTML = renderBriefTimelineHtml(history);
  const cEl = document.getElementById('pbdComments');
  if (cEl) cEl.innerHTML = renderBriefCommentsHtml(comments);
  const fEl = document.getElementById('pbdFiles');
  if (fEl) fEl.innerHTML = renderBriefFilesHtml(files);
}

async function submitPartnerComment() {
  const input = document.getElementById('pbdCommentInput');
  const notice = document.getElementById('pbdCommentNotice');
  const body = (input?.value || '').trim();
  if (!body || !activeBriefId || !state.partnerProfile) return;
  const { error } = await state.supabase.from('brief_comments').insert({
    brief_id: activeBriefId,
    body,
    visibility: 'shared',
    author_partner_id: state.partnerProfile.id,
    author_name: state.partnerProfile.full_name
  });
  if (error) { if (notice) notice.textContent = 'Could not send: ' + error.message; return; }
  if (input) input.value = '';
  if (notice) notice.textContent = '';
  renderPartnerBriefDetail().catch(console.error);
}

async function uploadPartnerBriefFiles() {
  const input = document.getElementById('pbdUploadInput');
  const notice = document.getElementById('pbdFilesNotice');
  const files = [...(input?.files || [])];
  if (!files.length || !activeBriefId || !state.partnerProfile) return;
  if (notice) notice.textContent = 'Uploading…';
  for (const file of files) {
    const path = `${activeBriefId}/ga/${Date.now()}_${file.name}`;
    const { error } = await state.supabase.storage.from('briefs').upload(path, file);
    if (error) { if (notice) notice.textContent = `Failed for ${file.name}: ${error.message}`; return; }
  }
  if (input) input.value = '';
  if (notice) notice.textContent = '✓ Uploaded.';
  renderPartnerBriefDetail().catch(console.error);
}

// ── Internal board ───────────────────────────────────────────────

async function loadBriefsBoard() {
  await Promise.all([loadBriefsData(), loadSlaAndHolidays()]);
  renderBriefBoard();
  // Partner management lives here, with the account leads (brief reviewers).
  const partnersPanel = document.getElementById('partnersAdminPanel');
  if (partnersPanel) {
    const canManage = isBriefReviewer();
    partnersPanel.classList.toggle('hidden', !canManage);
    if (canManage) loadPartnersAdmin().catch(console.error);
  }
  // the client stakeholder map (shared with partners; node returns home from the
  // partner slot if an employee session follows a partner one).
  placeOrgContactsPanel('internal');
  loadOrgContacts().catch(console.error);
}

function renderBriefBoard() {
  const board = document.getElementById('briefBoard');
  const quickLane = document.getElementById('briefQuickLane');
  const meta = document.getElementById('briefBoardMeta');
  const waitingBanner = document.getElementById('briefWaitingBanner');
  if (!board) return;
  const assignedOnly = document.getElementById('briefAssignedToMe')?.checked;
  const myId = state.currentEmployeeId;
  // Briefs a partner has sent but the client has not approved are not ours yet. They
  // stay off the board rather than sitting in a column inviting someone to
  // start — the count below keeps them visible without making them actionable.
  const awaitingClient = briefsCache.filter(briefAwaitsClientApproval);
  const fullBriefs = briefsCache.filter(b => b.request_type === 'brief')
    .filter(b => !briefAwaitsClientApproval(b))
    .filter(b => !assignedOnly || briefDeliverablesFor(b.id).some(d => d.assignee_employee_id === myId));
  const quick = briefsCache.filter(b => b.request_type === 'notify_only' && b.status !== 'closed');

  if (quickLane) {
    quickLane.innerHTML = quick.length ? `<div class="brief-quick-lane">
      <p class="feed-section-heading">Quick requests</p>
      ${quick.map(b => `<div class="brief-quick-card" data-open-brief-drawer="${b.id}">
        <span style="flex:1;">${escapeHtml(b.title)} <span class="mini-meta">· ${escapeHtml(briefRequesterLine(b, briefSubmitterName(b)))} · ${escapeHtml(briefDateLabel(b.created_at))}</span></span>
        ${briefStatusChip(b)}
      </div>`).join('')}
    </div>` : '';
  }

  // This used to be one line of grey small print, which is exactly why Alice's
  // brief sat unapproved for 36 hours with a Friday deadline. Each one now gets
  // its own row saying how long it has waited and how much runway is left, and
  // the whole block turns red when any deadline is inside three working days.
  const waits = awaitingClient
    .map(b => briefApprovalWait(b, istToday(), holidayDates()))
    .filter(Boolean)
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.due || '9999').localeCompare(b.due || '9999'));
  const anyUrgent = waits.some(w => w.urgent);
  const waitingHtml = waits.length ? `<div class="brief-waiting-banner${anyUrgent ? ' brief-waiting-banner-urgent' : ''}">
      <p class="brief-waiting-title">
        ${waits.length === 1 ? 'A brief is' : `${waits.length} briefs are`} waiting on the client to approve
        ${anyUrgent ? '<span class="brief-waiting-flag">Deadline at risk</span>' : ''}
      </p>
      ${waits.map(w => `<div class="brief-waiting-row${w.urgent ? ' is-urgent' : ''}" data-open-brief-drawer="${w.id}">
        <span class="brief-waiting-name">${escapeHtml(w.title)}</span>
        <span class="brief-waiting-detail">${escapeHtml(briefApprovalWaitLabel(w))}</span>
      </div>`).join('')}
      <p class="brief-waiting-foot">We cannot start on these until their coordinator approves them.
        Colony chases them by email every working morning.</p>
    </div>` : '';
  if (waitingBanner) waitingBanner.innerHTML = waitingHtml;
  let html = '';
  BRIEF_BOARD_COLUMNS.forEach(status => {
    // Paused work leaves its stage column so nobody counts it as in flight.
    const cards = fullBriefs.filter(b => briefBoardColumn(b) === status);
    // An empty pause column is noise on a board that usually has none.
    if (status === BRIEF_PAUSED_COLUMN && !cards.length) return;
    html += `<div class="deal-col" data-brief-status="${status}">
      <div class="deal-col-header">
        <span class="deal-col-title">${escapeHtml(status === BRIEF_PAUSED_COLUMN ? 'On pause' : BRIEF_STATUS_LABEL[status])}</span>
        <span class="deal-col-count">${cards.length}</span>
      </div>
      <div class="deal-col-body">`;
    cards.forEach(b => {
      const urgent = (b.priority === 'P0' || b.priority === 'P1')
        ? `<span class="deal-badge deal-badge-project">${escapeHtml(b.priority)}</span>` : '';
      const deadlineClass = getDealDeadlineClass(b.deadline);
      const deadlineLabel = b.deadline ? formatDealDate(b.deadline) : '';
      const deliv = briefDeliverablesFor(b.id);
      const overdueCount = deliv.filter(d => deliverableIsOverdue(d)).length;
      html += `<div class="deal-card" data-open-brief-drawer="${b.id}">
        <div class="deal-card-top"><span class="deal-card-name">${escapeHtml(b.title)}</span>${urgent}</div>
        <div class="deal-card-bottom">
          <span class="mini-meta">${escapeHtml(briefRequesterLine(b, briefSubmitterName(b)))}</span>
          ${overdueCount ? `<span class="deal-card-deadline deal-overdue">${overdueCount} overdue</span>` : ''}
          ${deadlineLabel ? `<span class="deal-card-deadline ${deadlineClass}">${deadlineLabel}</span>` : ''}
        </div>
      </div>`;
    });
    html += `</div></div>`;
  });
  board.innerHTML = html;
  if (meta) meta.textContent = `${fullBriefs.length} brief${fullBriefs.length === 1 ? '' : 's'}${quick.length ? ` · ${quick.length} quick request${quick.length === 1 ? '' : 's'}` : ''}`;
}

const BRIEF_ACTION_LABEL = {
  pending_info: 'Request changes',
  ready_for_review: 'Mark client-approved',
  in_creative: 'Start creative',
  delivered: 'Mark delivered',
  under_revision: 'Send for revision',
  completed: 'Complete',
  submitted: 'Back to submitted',
  acknowledged: 'Acknowledge',
  closed: 'Close'
};
// Transitions only reviewers/leadership may perform (UX gate; internal trust in DB).
const BRIEF_REVIEWER_ACTIONS = ['in_creative', 'completed', 'ready_for_review', 'under_revision'];

async function updateBriefStatus(briefId, toStatus) {
  const brief = briefById(briefId);
  if (!brief || !isValidBriefTransition(brief.status, toStatus, brief.request_type)) return;
  const fromStatus = brief.status;
  const patch = { status: toStatus };
  if (toStatus === 'in_creative') {
    // Entering creative freezes the client edits (guard is stage-bound); stamp who/when.
    patch.locked_at = new Date().toISOString();
    patch.locked_by_employee_id = state.currentEmployeeId;
  }
  const { data, error } = await state.supabase.from('briefs').update(patch).eq('id', briefId).select();
  if (error || !data?.length) { console.error('Brief status update failed', error); return; }
  // Notification matrix (v2): each handoff pings whoever's turn is next.
  if (toStatus === 'pending_info') notifyBriefEvent('changes_requested', briefId);
  else if (toStatus === 'ready_for_review') notifyBriefEvent('ga_approved', briefId);
  else if (toStatus === 'delivered') notifyBriefEvent('delivered', briefId);
  else if (toStatus === 'under_revision') notifyBriefEvent('revision_requested', briefId);
  // Starting creative: start the SLA clock on queued deliverables.
  if (toStatus === 'in_creative') {
    const now = new Date().toISOString();
    for (const d of briefDeliverablesFor(briefId).filter(x => !x.started_at)) {
      await state.supabase.from('brief_deliverables').update({
        started_at: now,
        status: d.status === 'queued' ? 'in_progress' : d.status,
        due_at: deliverableDueAt(now, d.sla_days, brief.priority)
      }).eq('id', d.id);
    }
  }
  await loadBriefsData();
  renderBriefBoard();
  renderBriefDrawer(briefId).catch(console.error);
}

function closeBriefDrawer() {
  const drawer = document.getElementById('briefDrawer');
  if (drawer) { drawer.className = 'hidden'; drawer.innerHTML = ''; }
  activeBriefId = null;
}

async function renderBriefDrawer(briefId) {
  const drawer = document.getElementById('briefDrawer');
  const brief = briefById(briefId);
  if (!drawer || !brief) return;
  activeBriefId = briefId;
  const reviewer = isBriefReviewer();
  const transitions = (brief.request_type === 'notify_only'
    ? { submitted: ['acknowledged', 'closed'], acknowledged: ['closed'], closed: [] }
    : null);
  const allowedTargets = (isBriefPaused(brief) ? [] : (transitions
    ? (transitions[brief.status] || [])
    : (BRIEF_TRANSITIONS.brief[brief.status] || [])))
    .filter(t => reviewer || !BRIEF_REVIEWER_ACTIONS.includes(t));

  const [history, comments, files] = await Promise.all([
    loadBriefHistory(briefId), loadBriefComments(briefId), listBriefFiles(briefId, true)
  ]);
  const { data: creativeRows } = await state.supabase.from('creative_briefs').select('*').eq('brief_id', briefId);
  const creative = creativeRows?.[0] || null;
  const delivRows = briefDeliverablesFor(briefId);
  const employeeOptions = state.employeeDirectory
    .map(e => `<option value="${e.id}">${escapeHtml(displayPersonName(e.full_name, 'Employee'))}</option>`).join('');
  const slaOptions = Object.values(slaForOrg(brief.org))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(s => {
      const days = Number.isFinite(s.max_days) ? ` (${formatSlaDays(s)})` : ' (scoped per project)';
      return `<option value="${escapeHtml(s.deliverable_type)}">${escapeHtml(s.label)}${escapeHtml(days)}</option>`;
    }).join('');
  const suggested = (brief.requested_deliverables || [])
    .map(t => BRIEF_DELIVERABLE_OPTIONS.find(o => o.type === t)?.label || t).join(', ');

  drawer.className = '';
  drawer.innerHTML = `
    <div class="brief-drawer-backdrop" data-close-brief-drawer></div>
    <div class="brief-drawer">
      <div class="drawer-head">
        <div>
          <h2 style="margin:0;">${escapeHtml(brief.title)}</h2>
          <p class="mini-meta" style="margin:4px 0 0;">${briefStatusChip(brief)} · ${escapeHtml(BRIEF_PRIORITY_META[brief.priority]?.short || brief.priority)} · ${escapeHtml(briefRequesterLine(brief, briefSubmitterName(brief)))} · ${escapeHtml(briefDateLabel(brief.created_at))}</p>
        </div>
        <button class="ghost small" data-close-brief-drawer type="button">✕ Close</button>
      </div>
      <div class="action-row" style="margin-top:12px;flex-wrap:wrap;">
        ${allowedTargets.map(t => `<button class="ghost small" data-brief-action="${t}" type="button">${escapeHtml(BRIEF_ACTION_LABEL[t] || t)}</button>`).join('')}
        ${reviewer && canPauseBrief(brief) ? '<button class="ghost small" data-brief-pause type="button">Pause</button>' : ''}
        ${reviewer && isBriefPaused(brief) ? `<button class="ghost small" data-brief-resume type="button">Resume ${escapeHtml(BRIEF_STATUS_LABEL[brief.status] || brief.status)}</button>` : ''}
        ${isBriefPaused(brief) ? `<span class="mini-meta" style="align-self:center;">${escapeHtml(briefPauseDetail(brief))}</span>` : ''}
      </div>
      <h3>Brief summary</h3>
      ${renderBriefSummaryHtml(brief)}
      ${brief.request_type === 'brief' ? `
      <h3>Creative brief <span class="mini-meta">(internal)</span></h3>
      <div class="form-grid">
        <label class="form-field"><span>Internal notes</span>
          <textarea id="bdCreativeNotes" rows="3">${escapeHtml(creative?.internal_notes || '')}</textarea></label>
        <label class="form-field"><span>Internal deadline</span>
          <input type="date" id="bdCreativeDeadline" value="${escapeHtml(creative?.internal_deadline || '')}"></label>
        <div class="action-row"><button class="ghost small" id="bdSaveCreativeBtn" type="button">Save creative brief</button></div>
      </div>
      <h3>Deliverables</h3>
      ${suggested ? `<p class="mini-meta">Requested by the client: ${escapeHtml(suggested)}</p>` : ''}
      <div id="bdDeliverableRows">
        ${delivRows.map(d => {
          const label = d.title || BRIEF_DELIVERABLE_OPTIONS.find(o => o.type === d.deliverable_type)?.label || d.deliverable_type || 'Deliverable';
          const due = d.due_at ? `due ${briefDateLabel(d.due_at)}` : '';
          const overdue = deliverableIsOverdue(d) ? ' <span class="overdue">OVERDUE</span>' : '';
          return `<div class="brief-deliv-row" data-deliv-id="${d.id}">
            <span style="flex:1;min-width:140px;">${escapeHtml(label)} <span class="mini-meta">${escapeHtml(d.discipline || '')} ${due}</span>${overdue}</span>
            <select data-deliv-status style="width:auto;">
              ${['queued','in_progress','in_review','ready_to_share','delivered'].map(s => `<option value="${s}"${d.status === s ? ' selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}
            </select>
            <select data-deliv-assignee style="width:auto;">
              <option value="">Unassigned</option>${employeeOptions}
            </select>
            <input type="url" data-deliv-url placeholder="Google Drive link" value="${escapeHtml(d.delivery_url || '')}" style="flex:1;min-width:160px;">
          </div>`;
        }).join('') || '<p class="mini-meta">None yet — add from the requested list below.</p>'}
      </div>
      <div class="action-row" style="flex-wrap:wrap;">
        <select id="bdNewDelivSla" style="width:auto;"><option value="">Add deliverable…</option>${slaOptions}</select>
        <button class="ghost small" id="bdAddDelivBtn" type="button">Add</button>
      </div>` : ''}
      <h3>Files</h3>
      <div id="bdFiles">${renderBriefFilesHtml(files)}</div>
      <div class="action-row" style="flex-wrap:wrap;">
        <input type="file" id="bdUploadInput" multiple style="width:auto;">
        <select id="bdUploadFolder" style="width:auto;">
          <option value="ga">Working file (the client can see)</option>
          <option value="delivered">Deliverable (visible to the client once Delivered)</option>
        </select>
        <button class="ghost small" id="bdUploadBtn" type="button">Upload</button>
      </div>
      <h3>Comments</h3>
      <div id="bdComments">${renderBriefCommentsHtml(comments)}</div>
      <div class="action-row" style="flex-wrap:wrap;">
        <textarea id="bdCommentInput" rows="2" placeholder="Write a comment…" style="flex:1;min-width:200px;"></textarea>
        <select id="bdCommentVisibility" style="width:auto;">
          <option value="shared">Shared with the client</option>
          <option value="internal">Internal only</option>
        </select>
        <button class="primary" id="bdCommentBtn" type="button">Send</button>
      </div>
      <h3>Timeline</h3>
      ${renderBriefTimelineHtml(history)}
    </div>`;

  // set current assignee selections
  delivRows.forEach(d => {
    const sel = drawer.querySelector(`[data-deliv-id="${d.id}"] [data-deliv-assignee]`);
    if (sel) sel.value = d.assignee_employee_id || '';
  });
}

async function bdSaveCreativeBrief() {
  const notes = document.getElementById('bdCreativeNotes')?.value || '';
  const deadline = document.getElementById('bdCreativeDeadline')?.value || null;
  if (!activeBriefId) return;
  await state.supabase.from('creative_briefs').upsert({
    brief_id: activeBriefId,
    internal_notes: notes,
    internal_deadline: deadline,
    created_by: state.currentEmployeeId
  }, { onConflict: 'brief_id' });
  renderBriefDrawer(activeBriefId).catch(console.error);
}

async function bdAddDeliverable() {
  const type = document.getElementById('bdNewDelivSla')?.value;
  const brief = briefById(activeBriefId);
  const sla = slaForOrg(brief?.org)[type];
  if (!sla || !activeBriefId) return;
  // The client-facing turnaround IS the internal one. Ranges commit to the
  // slower end — it is the date the client was given.
  const slaDays = Number.isFinite(sla.max_days) ? sla.max_days : null;
  const patch = {
    brief_id: activeBriefId,
    deliverable_type: sla.deliverable_type,
    title: sla.label,
    sla_days: slaDays
  };
  // If creative already started, start this one's clock immediately.
  if (brief && brief.status === 'in_creative') {
    const now = new Date().toISOString();
    patch.started_at = now;
    patch.status = 'in_progress';
    patch.due_at = deliverableDueAt(now, slaDays, brief.priority, holidayDates());
  }
  await state.supabase.from('brief_deliverables').insert(patch);
  await loadBriefsData();
  renderBriefBoard();
  renderBriefDrawer(activeBriefId).catch(console.error);
}

async function bdUpdateDeliverable(delivId, patch) {
  if (patch.status === 'delivered') patch.delivered_at = new Date().toISOString();
  await state.supabase.from('brief_deliverables').update(patch).eq('id', delivId);
  const deliv = briefDeliverablesCache.find(d => d.id === delivId);
  if (deliv) {
    if (patch.assignee_employee_id) {
      notifyBriefEvent('deliverable_assigned', deliv.brief_id, { assigneeEmployeeId: patch.assignee_employee_id });
    }
    if (patch.status === 'ready_to_share') {
      notifyBriefEvent('deliverable_ready', deliv.brief_id);
    }
  }
  await loadBriefsData();
  renderBriefBoard();
  if (activeBriefId) renderBriefDrawer(activeBriefId).catch(console.error);
}

async function bdSubmitComment() {
  const input = document.getElementById('bdCommentInput');
  const visibility = document.getElementById('bdCommentVisibility')?.value || 'shared';
  const body = (input?.value || '').trim();
  if (!body || !activeBriefId) return;
  await state.supabase.from('brief_comments').insert({
    brief_id: activeBriefId,
    body,
    visibility,
    author_employee_id: state.currentEmployeeId,
    author_name: state.employeeProfile?.full_name || 'Your Agency'
  });
  renderBriefDrawer(activeBriefId).catch(console.error);
}

async function bdUploadFiles() {
  const input = document.getElementById('bdUploadInput');
  const folder = document.getElementById('bdUploadFolder')?.value || 'ga';
  const files = [...(input?.files || [])];
  if (!files.length || !activeBriefId) return;
  for (const file of files) {
    await state.supabase.storage.from('briefs').upload(`${activeBriefId}/${folder}/${Date.now()}_${file.name}`, file);
  }
  renderBriefDrawer(activeBriefId).catch(console.error);
}

// ── Wiring ───────────────────────────────────────────────────────

document.getElementById('newBriefBtn')?.addEventListener('click', () => {
  resetBriefForm();
  navigateToScreen('partner-brief-form');
});
document.getElementById('briefFormBackBtn')?.addEventListener('click', () => navigateToScreen('partner-home'));
document.getElementById('pbdBackBtn')?.addEventListener('click', () => navigateToScreen('partner-home'));
document.getElementById('bfRequestType')?.addEventListener('change', applyBriefFormTypeVisibility);
document.getElementById('bfPriority')?.addEventListener('change', applyBriefFormPriorityVisibility);
document.getElementById('submitBriefBtn')?.addEventListener('click', () => submitPartnerBrief().catch(console.error));
document.getElementById('pbdCommentBtn')?.addEventListener('click', () => submitPartnerComment().catch(console.error));
document.getElementById('pbdUploadBtn')?.addEventListener('click', () => uploadPartnerBriefFiles().catch(console.error));
document.getElementById('pbdEditBtn')?.addEventListener('click', () => {
  const brief = briefById(activeBriefId);
  if (!brief) return;
  resetBriefForm(brief);
  navigateToScreen('partner-brief-form');
});
document.getElementById('pbdApproveBtn')?.addEventListener('click', async () => {
  const brief = briefById(activeBriefId);
  if (!brief || brief.status !== 'submitted' || !state.partnerProfile) return;
  const { data, error } = await state.supabase.from('briefs')
    .update({ status: 'ready_for_review' }).eq('id', brief.id).select();
  if (error || !data?.length) { console.error(error); return; }
  brief.status = 'ready_for_review';
  notifyBriefEvent('ga_approved', brief.id);
  renderPartnerBriefDetail().catch(console.error);
});
document.getElementById('pbdRevisionBtn')?.addEventListener('click', async () => {
  const brief = briefById(activeBriefId);
  if (!brief || brief.status !== 'delivered' || !state.partnerProfile) return;
  if (!await appConfirm('Send this back to Your Agency for revision? Describe what needs changing in a comment.', { title: 'Request revision', confirmLabel: 'Request revision' })) return;
  const { data, error } = await state.supabase.from('briefs')
    .update({ status: 'under_revision' }).eq('id', brief.id).select();
  if (error || !data?.length) { console.error(error); return; }
  brief.status = 'under_revision';
  notifyBriefEvent('revision_requested', brief.id);
  renderPartnerBriefDetail().catch(console.error);
  document.getElementById('pbdCommentInput')?.focus();
});
document.getElementById('partnerBriefList')?.addEventListener('click', (e) => {
  const card = e.target.closest('[data-open-brief]');
  if (card) openPartnerBriefDetail(card.dataset.openBrief);
});
document.getElementById('briefAssignedToMe')?.addEventListener('change', renderBriefBoard);

const briefsScreenEl = document.getElementById('briefs-pipeline');
briefsScreenEl?.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open-brief-drawer]');
  if (opener) { renderBriefDrawer(opener.dataset.openBriefDrawer).catch(console.error); return; }
  if (e.target.closest('[data-close-brief-drawer]')) { closeBriefDrawer(); return; }
  const action = e.target.closest('[data-brief-action]');
  if (action && activeBriefId) { updateBriefStatus(activeBriefId, action.dataset.briefAction).catch(console.error); return; }
  if (e.target.closest('[data-brief-pause]') && activeBriefId) { pauseBrief(activeBriefId).catch(console.error); return; }
  if (e.target.closest('[data-brief-resume]') && activeBriefId) { resumeBrief(activeBriefId).catch(console.error); return; }
  const file = e.target.closest('[data-brief-file]');
  if (file) { openBriefFile(file.dataset.briefFile).catch(console.error); return; }
  if (e.target.id === 'bdSaveCreativeBtn') { bdSaveCreativeBrief().catch(console.error); return; }
  if (e.target.id === 'bdAddDelivBtn') { bdAddDeliverable().catch(console.error); return; }
  if (e.target.id === 'bdCommentBtn') { bdSubmitComment().catch(console.error); return; }
  if (e.target.id === 'bdUploadBtn') { bdUploadFiles().catch(console.error); return; }
});
// ── Pause / resume ───────────────────────────────────────────────────────
// The status column is never touched: it holds the stage the brief returns
// to, which is the whole reason pause is a flag and not a status.
async function pauseBrief(briefId) {
  const brief = briefById(briefId);
  if (!canPauseBrief(brief)) return;
  const why = await appPrompt('Why is this paused? (optional)', {
    title: 'Pause brief', okLabel: 'Pause', placeholder: 'e.g. on hold from client'
  });
  if (why === null) return;   // cancelled — an empty string is a valid reason
  const { data, error } = await state.supabase.from('briefs').update({
    paused_at: new Date().toISOString(),
    pause_reason: why.trim() || null,
    paused_by: state.currentEmployeeId
  }).eq('id', briefId).select();
  if (error || !data?.length) { console.error('Brief pause failed', error); return; }
  await loadBriefsData();
  renderBriefBoard();
  renderBriefDrawer(briefId).catch(console.error);
}

async function resumeBrief(briefId) {
  const brief = briefById(briefId);
  if (!isBriefPaused(brief)) return;
  const stage = BRIEF_STATUS_LABEL[brief.status] || brief.status;
  if (!await appConfirm(`Put this back into ${stage}?`, { title: 'Resume brief', confirmLabel: 'Resume' })) return;
  const { data, error } = await state.supabase.from('briefs')
    .update({ paused_at: null, pause_reason: null, paused_by: null })
    .eq('id', briefId).select();
  if (error || !data?.length) { console.error('Brief resume failed', error); return; }
  await loadBriefsData();
  renderBriefBoard();
  renderBriefDrawer(briefId).catch(console.error);
}

briefsScreenEl?.addEventListener('change', (e) => {
  const row = e.target.closest('[data-deliv-id]');
  if (!row) return;
  if (e.target.matches('[data-deliv-status]')) {
    bdUpdateDeliverable(row.dataset.delivId, { status: e.target.value }).catch(console.error);
  } else if (e.target.matches('[data-deliv-assignee]')) {
    bdUpdateDeliverable(row.dataset.delivId, { assignee_employee_id: e.target.value || null }).catch(console.error);
  } else if (e.target.matches('[data-deliv-url]')) {
    bdUpdateDeliverable(row.dataset.delivId, { delivery_url: e.target.value.trim() || null }).catch(console.error);
  }
});
// Partner detail: file downloads
document.getElementById('pbdFiles')?.addEventListener('click', (e) => {
  const file = e.target.closest('[data-brief-file]');
  if (file) openBriefFile(file.dataset.briefFile).catch(console.error);
});

// ══════════════════════════════════════════════════════════════════
// Hiring pipeline — candidate checklist + crew panel (Team Directory)
// ══════════════════════════════════════════════════════════════════

let hiresCache = [];

function notifyHireEvent(hireEvent, hireId) {
  const token = state.session?.access_token;
  if (!token || !hireId) return;
  fetch('/.netlify/functions/hire-notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ event: hireEvent, hireId })
  }).catch((err) => console.warn('Hire notify failed:', err));
}

// ── Candidate surface ────────────────────────────────────────────

function setHireFormNotice(message = '', className = 'mini-meta') {
  const el = document.getElementById('hireFormNotice');
  if (el) { el.textContent = message; el.className = className; }
}

async function listHireSlips(hireId) {
  const { data } = await state.supabase.storage.from('hires').list(`${hireId}/slips`, { limit: 30 });
  return (data || []).filter(f => f.name).map(f => ({ name: f.name, path: `${hireId}/slips/${f.name}` }));
}

async function renderHireChecklist() {
  const hire = state.hireProfile;
  if (!hire) return;
  const greeting = document.getElementById('hireGreeting');
  const statusLine = document.getElementById('hireStatusLine');
  const formPanel = document.getElementById('hireFormPanel');
  const donePanel = document.getElementById('hireDonePanel');
  if (greeting) greeting.textContent = `Welcome to Your Agency, ${displayPersonName(hire.full_name, 'there').split(' ')[0]}`;

  const editable = ['invited', 'details_submitted'].includes(hire.stage);
  if (formPanel) formPanel.classList.toggle('hidden', !editable);
  if (donePanel) donePanel.classList.toggle('hidden', editable);

  if (editable) {
    if (statusLine) {
      statusLine.textContent = hire.stage === 'invited'
        ? 'One form and you\'re done — the team takes it from there.'
        : 'Details received ✓ — you can still edit them until our team picks this up.';
    }
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
    setVal('hfFullName', hire.full_name);
    setVal('hfDob', hire.date_of_birth);
    setVal('hfPhone', hire.phone);
    setVal('hfPan', hire.pan);
    setVal('hfAddress', hire.address);
    setVal('hfBankName', hire.bank_account_name);
    setVal('hfBankNumber', hire.bank_account_number);
    setVal('hfIfsc', hire.bank_ifsc);
    setVal('hfStartDate', hire.start_date);
    setVal('hfPermanentAddress', hire.permanent_address);
    setVal('hfSlipsNote', hire.salary_slips_note);
    setVal('hfTaxRegime', hire.tax_regime);
    setVal('hfTaxDecl', hire.tax_declarations_note);
    const noSlipsEl = document.getElementById('hfNoSlips');
    if (noSlipsEl) noSlipsEl.checked = hire.no_salary_slips === true;
    document.getElementById('hfTaxDeclWrap')?.classList.toggle('hidden', hire.tax_regime !== 'old');
    const slipsLabel = document.getElementById('hfSlipsLabel');
    if (slipsLabel) slipsLabel.innerHTML = `Salary slips — ${escapeHtml(fiscalYearStartLabel(toISODateLocal()))} to now`;
    const listEl = document.getElementById('hfSlipsList');
    if (listEl) {
      const slips = await listHireSlips(hire.id).catch(() => []);
      listEl.innerHTML = slips.length
        ? slips.map(s => `<p class="mini-meta">📎 ${escapeHtml(s.name.replace(/^\d+_/, ''))}</p>`).join('')
        : '';
    }
  } else if (statusLine && donePanel) {
    const doneText = document.getElementById('hireDoneText');
    const stageCopy = {
      contract_uploaded: 'Your contract is being prepared and reviewed.',
      reviewed: 'Your contract is with Your Agency for signature.',
      signed: 'Contract signed — payroll setup is underway.',
      payroll_done: 'All done! You\'ll hear from the team about your first day and your Your Agency account.',
      cancelled: 'This process was closed. Contact your Your Agency point person with any questions.'
    };
    statusLine.textContent = '';
    if (doneText) doneText.textContent = stageCopy[hire.stage] || 'The Your Agency team is on it — we\'ll email you at each step.';
    await renderHireSwitchCard(hire, doneText);
  }
}

// Once the hire's @youragency.com account exists, the Gmail they are signed in
// with is the wrong door — and "All done!" above used to let them stop there
// (10 Sep 2026). The RPC is scoped to the caller's own hire row.
async function renderHireSwitchCard(hire, doneText) {
  const card = document.getElementById('hireSwitchCard');
  if (!card || !state.supabase) return;
  let status = null;
  try {
    const { data } = await state.supabase.rpc('hire_work_account_status');
    status = Array.isArray(data) ? data[0] : data;
  } catch (e) { status = null; }
  const prompt = hireSignInPrompt(hire, status);
  card.classList.toggle('hidden', !prompt);
  if (!prompt) return;
  const title = document.getElementById('hireSwitchTitle');
  const text = document.getElementById('hireSwitchText');
  if (prompt.kind === 'joined') {
    // Nothing else to read: the only correct action is to leave.
    if (doneText) doneText.textContent = '';
    if (title) title.textContent = 'You already have an Your Agency account — this is the wrong sign-in.';
    if (text) text.textContent = `Everything from here on lives under ${prompt.workEmail}. Sign out and sign back in with that account, not this Gmail.`;
  } else {
    if (title) title.textContent = `Your account is ready: ${prompt.workEmail}`;
    if (text) text.textContent = `From now on, sign in to Colony with ${prompt.workEmail}, not this Gmail. Your temporary password comes from your Your Agency point person by email; if you have not received it, ask them. First sign-in creates your profile and opens the onboarding form.`;
  }
}

// Sign out, then straight back to Google's account picker with the youragency
// domain hinted — one click, no "now go to the login page" instruction.
document.getElementById('hireSwitchAccountBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('hireSwitchAccountBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing out…'; }
  try { await state.supabase?.auth.signOut(); } catch (e) { /* proceed to sign-in regardless */ }
  await startGoogleSignIn('signin');
});

async function submitHireDetails() {
  const hire = state.hireProfile;
  if (!hire || !state.supabase) return;
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const details = {
    full_name: val('hfFullName').replace(/\s+/g, ' '),
    date_of_birth: val('hfDob') || null,
    phone: val('hfPhone'),
    pan: val('hfPan').toUpperCase(),
    address: val('hfAddress'),
    permanent_address: document.getElementById('hfSameAddress')?.checked
      ? val('hfAddress')
      : val('hfPermanentAddress'),
    bank_account_name: val('hfBankName'),
    bank_account_number: val('hfBankNumber').replace(/\s/g, ''),
    bank_ifsc: val('hfIfsc').toUpperCase(),
    start_date: val('hfStartDate') || null,
    salary_slips_note: val('hfSlipsNote'),
    no_salary_slips: document.getElementById('hfNoSlips')?.checked === true,
    tax_regime: val('hfTaxRegime'),
    tax_declarations_note: val('hfTaxDecl')
  };
  const files = [...(document.getElementById('hfSlips')?.files || [])];
  const existingSlips = await listHireSlips(hire.id).catch(() => []);
  const hasSlips = files.length > 0 || existingSlips.length > 0;

  const missing = hireMissingDetails(details, hasSlips);
  if (missing.length) {
    setHireFormNotice(`Missing: ${missing.map(m => m.label).join(', ')}`, 'mini-meta warn');
    return;
  }
  if (!isValidPan(details.pan)) {
    setHireFormNotice('That PAN doesn\'t look right — format is ABCDE1234F.', 'mini-meta warn');
    return;
  }
  if (!isValidIfsc(details.bank_ifsc)) {
    setHireFormNotice('That IFSC doesn\'t look right — format is HDFC0000123.', 'mini-meta warn');
    return;
  }

  setHireFormNotice('Saving…');
  for (const file of files) {
    const path = `${hire.id}/slips/${Date.now()}_${file.name}`;
    const { error: upErr } = await state.supabase.storage.from('hires').upload(path, file);
    if (upErr) { setHireFormNotice(`Upload failed for ${file.name}: ${upErr.message}`, 'mini-meta warn'); return; }
  }
  const wasFirstSubmit = state.hireProfile.stage === 'invited';
  const { error } = await state.supabase.rpc('submit_hire_details', {
    p_full_name: details.full_name,
    p_date_of_birth: details.date_of_birth,
    p_pan: details.pan,
    p_address: details.address,
    p_bank_account_name: details.bank_account_name,
    p_bank_account_number: details.bank_account_number,
    p_bank_ifsc: details.bank_ifsc,
    p_salary_slips_note: details.salary_slips_note,
    p_no_salary_slips: details.no_salary_slips,
    p_start_date: details.start_date,
    p_permanent_address: details.permanent_address,
    p_tax_regime: details.tax_regime,
    p_tax_declarations_note: details.tax_declarations_note
  });
  if (error) { setHireFormNotice('Could not save: ' + error.message, 'mini-meta warn'); return; }
  Object.assign(state.hireProfile, details, { stage: 'details_submitted' });
  const slipsInput = document.getElementById('hfSlips');
  if (slipsInput) slipsInput.value = '';
  if (wasFirstSubmit) notifyHireEvent('details_submitted', hire.id);
  setHireFormNotice('✓ Saved. The Your Agency team has been notified.');
  renderHireChecklist().catch(console.error);
}

document.getElementById('hireSubmitBtn')?.addEventListener('click', () => submitHireDetails().catch(console.error));
// "Same as current" is the common case; mirroring saves retyping and stops the
// two addresses drifting apart.
function syncPermanentAddress() {
  const same = document.getElementById('hfSameAddress')?.checked;
  const perm = document.getElementById('hfPermanentAddress');
  if (!perm) return;
  perm.disabled = Boolean(same);
  if (same) perm.value = document.getElementById('hfAddress')?.value || '';
}
document.getElementById('hfSameAddress')?.addEventListener('change', syncPermanentAddress);
document.getElementById('hfAddress')?.addEventListener('input', () => {
  if (document.getElementById('hfSameAddress')?.checked) syncPermanentAddress();
});

document.getElementById('hfTaxRegime')?.addEventListener('change', (e) => {
  document.getElementById('hfTaxDeclWrap')?.classList.toggle('hidden', e.target.value !== 'old');
});

// ── Crew panel (Team Directory / hiring-only screen) ─────────────

// Proof a hire actually signed in. Matched on name because the two records
// share no key: a hire is keyed by personal Gmail, an employee by their work
// address (same bridge app.hire_type_for_new_employee uses).
function hireHasEmployeeRow(hire) {
  const name = String(hire?.full_name || '').trim().toLowerCase();
  if (!name) return false;
  return (state.employeeDirectory || []).some(
    (e) => String(e.full_name || '').trim().toLowerCase() === name
  );
}

function setHiringNotice(message = '', className = 'mini-meta') {
  const el = document.getElementById('hiringNotice');
  if (el) { el.textContent = message; el.className = className; }
}

// Status for ONE hire, rendered in that hire's own row. #hiringNotice sits
// above the whole list, under the "Start hire" form, so "Contract uploaded"
// for the fifth row appeared nowhere near it (8 Sep 2026).
// `busy` adds the animated ellipsis: an upload gives no other sign it started.
function setHireRowStatus(hireId, message = '', { busy = false, warn = false } = {}) {
  const el = document.querySelector(`[data-hire-status="${hireId}"]`);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('is-busy', Boolean(message) && busy);
  el.classList.toggle('warn', Boolean(message) && warn);
}

// The checklist on a hire card. Pure rows from hireChecklist(); this only
// draws them. "activated" is an employee row that is no longer setup_pending.
function renderHireChecklistHtml(h) {
  const rows = renderHireChecklistHtml.rowsFor(h);
  const mark = (st) => st === 'done' ? '✓' : st === 'current' ? '●' : st === 'cancelled' ? '×' : '○';
  return `<ol class="hire-checklist">${rows.map((r) => `<li class="${r.state}">
      <span class="hc-mark">${mark(r.state)}</span>
      <span class="hc-owner">${escapeHtml(HIRE_OWNER_LABEL[r.owner] || r.owner)}</span>
      <span><span class="hc-label">${escapeHtml(r.label)}</span>${r.detail ? `<span class="hc-detail">${escapeHtml(r.detail)}</span>` : ''}</span>
    </li>`).join('')}</ol>`;
}

// Rows for a hire, with the two facts the stage cannot tell: whether the
// youragency account has been used (an employee row exists) and whether that
// row has been activated.
renderHireChecklistHtml.rowsFor = function (h) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  const emp = (state.employeeDirectory || []).find((e) => (h.work_email && norm(e.email) === norm(h.work_email)) || norm(e.full_name) === norm(h.full_name));
  return hireChecklist(h, offerTermsByHireId[h.id] || {}, { hasEmployeeRow: Boolean(emp), activated: Boolean(emp && emp.setup_pending === false) });
};

// The open-hire form follows the type: CTC for employees, a monthly fee for
// anyone who invoices, and a client picker only for fractionals.
function syncNewHireForm() {
  const type = document.getElementById('nhType')?.value || 'full-time';
  const spec = hireCompensationSpec(type);
  const label = document.getElementById('nhCompLabel');
  const input = document.getElementById('nhComp');
  if (label) label.textContent = spec.label;
  if (input) input.placeholder = spec.placeholder;
  const wrap = document.getElementById('nhClientsWrap');
  const box = document.getElementById('nhClients');
  if (wrap) wrap.classList.toggle('hidden', type !== 'fractional');
  if (box && !box.children.length) box.innerHTML = clientCheckboxes([], 'nh');
}

// Tick-any client list, shared by the open form and the offer-terms editor.
function clientCheckboxes(selectedIds, ns) {
  const chosen = new Set((selectedIds || []).map(String));
  return (state.clients || []).filter((c) => c.is_active !== false)
    .map((c) => `<label><input type="checkbox" value="${escapeHtml(c.id)}" data-client-pick="${ns}"${chosen.has(String(c.id)) ? ' checked' : ''}> ${escapeHtml(c.name)}</label>`).join('');
}
document.getElementById('nhType')?.addEventListener('change', syncNewHireForm);

async function loadHiringPanel() {
  const panel = document.getElementById('hiringPanel');
  if (!panel || !state.supabase) return;
  const crew = state.hiringOnlyMode || isHiringCrew();
  panel.classList.toggle('hidden', !crew);
  if (!crew) return;
  const reportsTo = document.getElementById('nhReportsTo');
  if (reportsTo) { const keep = reportsTo.value; reportsTo.innerHTML = `<option value="">— Select —</option>${reportsToOptions(keep)}`; }
  const [hiresRes, termsRes] = await Promise.all([
    state.supabase.from('hires').select('*').order('created_at', { ascending: false }),
    // Crew-only table: a candidate or ordinary employee simply gets nothing.
    state.supabase.from('hire_offer_terms').select('*')
  ]);
  const { data, error } = hiresRes;
  if (error) { setHiringNotice('Could not load hires: ' + error.message, 'mini-meta warn'); return; }
  hiresCache = data || [];
  offerTermsByHireId = {};
  (termsRes.data || []).forEach((t) => { offerTermsByHireId[t.hire_id] = t; });
  // Only setup approvers create hires.
  // Leadership opens hires now, not only setup approvers (11 Sep 2026).
  document.getElementById('hiringCreateBar')?.classList.toggle('hidden', !(state.hiringOnlyMode ? false : (isSetupApprover() || isLeadershipRole())));
  syncNewHireForm();
  renderHiringList();
}

// Offer terms, keyed by hire. Separate from hiresCache because they live in a
// separate, crew-only table (compensation must stay off the candidate's row).
let offerTermsByHireId = {};

function hireStageChip(stage) {
  return `<span class="brief-status-chip">${escapeHtml(HIRE_STAGE_LABEL[stage] || stage)}</span>`;
}

// The terms Your Agency agrees at offer, which Legal needs to draft the agreement
// (Leo's checklist, 24 Aug 2026). We fill these — the candidate never sees
// them, and the CTC breakup deliberately is not here: Blake works it out per
// hire and it travels in the stage email.
// "Reports to": who the hire will report to, picked from leadership rather
// than typed (25 Aug 2026; renamed from "hiring manager" 11 Sep — only
// Alex or Nadia ever hire, so the useful fact is the reporting line). The
// column is still hire_offer_terms.hiring_manager_email. A stored value not in
// the list is kept as an option so nothing is silently dropped; a hiring-only
// session has no directory, so it falls back to a plain field.
function reportsToOptions(currentEmail) {
  const current = normalizeEmail(currentEmail || '');
  const people = (state.employeeDirectory || [])
    .filter((e) => e.is_active !== false && e.email)
    .filter((e) => ['leadership', 'admin'].includes(normalizeAccessLevel(e.access_level)))
    .filter((e) => !getHiddenEmployeeEmails().includes(normalizeEmail(e.email)))
    .map((e) => ({ email: normalizeEmail(e.email), name: displayPersonName(e.full_name, 'Employee') }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (current && !people.some((p) => p.email === current)) {
    people.push({ email: current, name: `${currentEmail} (no longer listed)` });
  }
  return people.map((p) =>
    `<option value="${escapeHtml(p.email)}"${p.email === current ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
}
function reportsToField(currentEmail) {
  const options = reportsToOptions(currentEmail);
  if (!options) {
    return `<input type="email" data-ot="hiring_manager_email" value="${escapeHtml(currentEmail || '')}" placeholder="name@youragency.com">`;
  }
  return `<select data-ot="hiring_manager_email"><option value="">— Select —</option>${options}</select>`;
}

function renderOfferTermsEditor(h) {
  const t = offerTermsByHireId[h.id] || {};
  const deptOptions = (state.departmentOptions || []).map((d) =>
    `<option value="${escapeHtml(d.name)}"${t.department === d.name ? ' selected' : ''}>${escapeHtml(d.name)}</option>`).join('');
  const notice = Number(t.notice_period_days) || '';
  // Save sits in the HEADING row, not at the bottom: six stacked full-width
  // fields pushed it past the fold and it looked like there was no way to save
  // at all (25 Aug 2026). The grid is two-column on any reasonable width
  // for the same reason — the form should fit on screen.
  return `
    <div class="offer-terms" data-offer-terms="${h.id}">
      <div class="offer-terms-head">
        <p class="hire-list-heading" style="margin:0;">Offer terms — for the employment agreement</p>
        <span class="mini-meta" data-offer-terms-notice="${h.id}"></span>
        <button class="ghost small" data-save-offer-terms="${h.id}" type="button">Save offer terms</button>
      </div>
      <div class="form-grid offer-terms-grid">
        <label class="form-field"><span>Designation</span>
          <input type="text" data-ot="designation" value="${escapeHtml(t.designation || '')}" placeholder="e.g. Copywriter"></label>
        <label class="form-field"><span>Department</span>
          <select data-ot="department"><option value="">— Select —</option>${deptOptions}</select></label>
        ${h.hire_type === 'full-time'
          ? `<label class="form-field"><span>CTC (annual, ₹)</span>
          <input type="number" data-ot="ctc_annual" min="0" step="1000" value="${t.ctc_annual != null ? escapeHtml(String(t.ctc_annual)) : ''}" placeholder="e.g. 1200000"></label>`
          : `<label class="form-field"><span>Monthly fee (₹)</span>
          <input type="number" data-ot="monthly_fee" min="0" step="1000" value="${t.monthly_fee != null ? escapeHtml(String(t.monthly_fee)) : ''}" placeholder="e.g. 60000"></label>`}
        <label class="form-field"><span>Notice period</span>
          <select data-ot="notice_period_days">
            <option value="">— Select —</option>
            <option value="30"${notice === 30 ? ' selected' : ''}>30 days</option>
            <option value="60"${notice === 60 ? ' selected' : ''}>60 days</option>
          </select></label>
        <label class="form-field"><span>Reports to</span>
          ${reportsToField(t.hiring_manager_email)}</label>
        <!-- Start date lives on the hire, not on offer terms, but it belongs in
             this form: dates move, and it was only editable by the candidate
             (25 Aug 2026). Saved back to app.hires. -->
        <label class="form-field"><span>Start date</span>
          <input type="date" data-ot-hire="start_date" value="${escapeHtml(h.start_date || '')}"></label>
      </div>
      <label class="form-field" style="margin-top:12px;"><span>Scope of work</span>
        <textarea data-ot="scope_of_work" rows="3" placeholder="What this role covers — goes into the agreement.">${escapeHtml(t.scope_of_work || '')}</textarea></label>
      ${h.hire_type === 'fractional' ? `<div class="form-field" style="margin-top:12px;"><span>Clients they cover <span class="mini-meta">(add more any time — this is what activation scopes them to)</span></span>
        <div class="check-grid" data-ot-clients="${h.id}">${clientCheckboxes(t.scoped_client_ids || [], 'ot')}</div></div>` : ''}
    </div>`;
}

async function saveOfferTerms(hireId) {
  const wrap = document.querySelector(`[data-offer-terms="${hireId}"]`);
  const notice = document.querySelector(`[data-offer-terms-notice="${hireId}"]`);
  if (!wrap || !state.supabase) return;
  const val = (name) => wrap.querySelector(`[data-ot="${name}"]`)?.value?.trim() || '';
  const payload = {
    hire_id: hireId,
    designation: val('designation') || null,
    department: val('department') || null,
    ctc_annual: val('ctc_annual') ? Number(val('ctc_annual')) : null,
    notice_period_days: val('notice_period_days') ? Number(val('notice_period_days')) : null,
    scope_of_work: val('scope_of_work') || null,
    hiring_manager_email: val('hiring_manager_email') || null,
    updated_by_employee_id: state.currentEmployeeId || null
  };
  // Monthly fee sits in the same editor for people who invoice; the CTC field
  // is what the form shows for employees. Whichever is absent stays as it was.
  const feeEl = wrap.querySelector('[data-ot="monthly_fee"]');
  if (feeEl) payload.monthly_fee = feeEl.value ? Number(feeEl.value) : null;
  const clientBox = wrap.querySelector(`[data-ot-clients="${hireId}"]`);
  if (clientBox) payload.scoped_client_ids = [...clientBox.querySelectorAll('input:checked')].map((cb) => cb.value);
  if (notice) notice.textContent = 'Saving…';
  const { error } = await state.supabase.from('hire_offer_terms').upsert(payload, { onConflict: 'hire_id' });
  if (error) { if (notice) notice.textContent = 'Could not save: ' + error.message; return; }
  offerTermsByHireId[hireId] = { ...(offerTermsByHireId[hireId] || {}), ...payload };

  // Start date is a column on app.hires, so it saves separately.
  const startDate = wrap.querySelector('[data-ot-hire="start_date"]')?.value || null;
  const hire = hiresCache.find((x) => x.id === hireId);
  if (hire && (hire.start_date || null) !== startDate) {
    const { error: hireErr } = await state.supabase.from('hires').update({ start_date: startDate }).eq('id', hireId);
    if (hireErr) { if (notice) notice.textContent = 'Terms saved, but start date failed: ' + hireErr.message; return; }
    hire.start_date = startDate;
    renderHiringList();
    // Re-rendering replaces this drawer, so reopen it and report there.
    const detail = document.querySelector(`[data-hire-detail="${hireId}"]`);
    detail?.classList.remove('hidden');
    const freshNotice = document.querySelector(`[data-offer-terms-notice="${hireId}"]`);
    if (freshNotice) freshNotice.textContent = '✓ Saved';
    return;
  }
  if (notice) notice.textContent = '✓ Saved';
}

async function renderHiringList() {
  const listEl = document.getElementById('hiringList');
  if (!listEl) return;
  const showDone = document.getElementById('hiringShowDone')?.checked;
  // "Done" means the checklist is done, not that payroll is: a hire at
  // payroll_done with no account yet, or not signed in, or not activated, is
  // the one most in need of showing (Asha sat there for three days).
  const isFinished = (h) => {
    if (h.stage === 'cancelled') return true;
    return renderHireChecklistHtml.rowsFor(h).every((r) => r.state === 'done');
  };
  const rows = hiresCache.filter(h => showDone || !isFinished(h));
  if (!rows.length) {
    // No empty-state copy: the create row above already says what this is for.
    listEl.innerHTML = '';
    return;
  }
  const isApprover = !state.hiringOnlyMode && isSetupApprover();
  const mySignerTurn = isSuperadminUser();
  listEl.innerHTML = rows.map(h => {
    const details = [
      ['Type', HIRE_TYPE_LABEL[h.hire_type] || h.hire_type],
      ['Start date', h.start_date],
      ['Personal email', h.personal_email],
      ['Mobile', h.phone],
      ['DOB', h.date_of_birth],
      ['PAN', h.pan],
      ['Address', h.address],
      ['Bank', h.bank_account_name ? `${h.bank_account_name} · ${h.bank_account_number} · ${h.bank_ifsc}` : ''],
      ['Slips', h.no_salary_slips ? 'Candidate did not have salary slips' : ''],
      ['Slips note', h.salary_slips_note],
      ['Tax regime', h.tax_regime ? (h.tax_regime === 'old' ? 'Old' : 'New') : ''],
      ['HRA/80C/80D', h.tax_declarations_note]
    ].filter(([, v]) => v && String(v).trim() !== '');
    // Everything for one person on one line: stage, the step they are waiting
    // on, Details, then Cancel last (24 Aug 2026 — he asked for Cancel
    // beside Details rather than on its own row). Cancel keeps its red
    // treatment and stays last, so it is never adjacent to the button someone
    // actually came here to click.
    const actions = [];
    if (h.stage === 'details_submitted') {
      actions.push(`<label class="ghost small" style="cursor:pointer;">Upload contract draft<input type="file" data-hire-contract="${h.id}" accept=".pdf,.doc,.docx" style="display:none;"></label>`);
    }
    if (h.stage === 'contract_uploaded' && isApprover) {
      actions.push(`<button class="ghost small" data-hire-action="reviewed" data-hire-id="${h.id}" type="button">Approve draft</button>`);
      actions.push(`<button class="ghost small" data-hire-action="details_submitted" data-hire-id="${h.id}" type="button">Send back</button>`);
    }
    // Legal can correct a draft at ANY point before signature. Previously the
    // upload control existed only at 'details_submitted', so a typo spotted
    // after approval had no route back at all — not even for an approver
    // (Maya's contract, 25 Aug 2026). Replacing an APPROVED draft returns it
    // to review: the thing that was approved no longer exists.
    const viaPapersign = Boolean(state.runtimeConfig?.papersign);
    const terms = offerTermsByHireId[h.id] || {};
    if (viaPapersign) {
      // Contracts through Papersign (11 Sep 2026): draft from the template,
      // Leo reviews it there, an approver sends it, the webhook files it.
      if (h.stage === 'details_submitted' && !terms.papersign_draft_id) {
        actions.push(`<button class="ghost small" data-hire-ps-draft="${h.id}" type="button">Draft agreement in Papersign</button>`);
      }
      if (terms.papersign_draft_id && !terms.papersign_sent_at) {
        actions.push(`<a class="ghost small" href="https://paperform.co/sign" target="_blank" rel="noopener">Review draft ↗</a>`);
        if (isApprover) actions.push(`<button class="ghost small" data-hire-ps-send="${h.id}" type="button">Approve &amp; send for signing</button>`);
      }
      if (terms.papersign_sent_at && !terms.papersign_completed_at) {
        actions.push(`<span class="mini-meta">Out for signature since ${escapeHtml(briefDateLabel(terms.papersign_sent_at))}</span>`);
      }
    } else {
      if (['contract_uploaded', 'reviewed'].includes(h.stage)) {
        actions.push(`<label class="ghost small" style="cursor:pointer;">Replace draft<input type="file" data-hire-contract="${h.id}" accept=".pdf,.doc,.docx" style="display:none;"></label>`);
      }
      if (h.stage === 'reviewed' && mySignerTurn) {
        actions.push(`<label class="ghost small" style="cursor:pointer;">Upload signed contract<input type="file" data-hire-signed="${h.id}" accept=".pdf" style="display:none;"></label>`);
      }
    }
    if (h.stage === 'signed') {
      actions.push(`<button class="ghost small" data-hire-action="payroll_done" data-hire-id="${h.id}" type="button">Payroll started ✓</button>`);
    }
    // Payroll done is not the end: they cannot appear in Colony until their
    // @youragency.com account exists, and nothing else in the app asks for it.
    const workspace = hireWorkspaceState(h, hireHasEmployeeRow(h));
    const checklistHtml = renderHireChecklistHtml(h);
    if (workspace === 'needed' && isApprover) {
      actions.push(`<button class="ghost small" data-hire-workspace="${h.id}" type="button">${state.runtimeConfig?.workspaceProvisioning ? 'Create' : 'Request'} @youragency.com account</button>`);
    }
    const canCancel = isApprover && !['payroll_done', 'cancelled'].includes(h.stage);
    return `<div class="hire-row" data-hire-row="${h.id}">
      <div class="hire-row-head">
        <span class="hire-row-name">${escapeHtml(h.full_name)}</span>
        ${hireStageChip(h.stage)}
        ${actions.join('')}
        <span class="hire-row-now">${(() => { const cur = renderHireChecklistHtml.rowsFor(h).find((r) => r.state === 'current'); return cur ? `now: <b>${escapeHtml(cur.label)}</b> · ${escapeHtml(HIRE_OWNER_LABEL[cur.owner] || cur.owner)}` : ''; })()}</span>
        <button class="ghost small" data-hire-checklist-toggle="${h.id}" type="button">Checklist</button>
        <button class="ghost small" data-hire-toggle="${h.id}" type="button">Details</button>
        ${canCancel ? `<button class="ghost small danger-text" data-hire-action="cancelled" data-hire-id="${h.id}" type="button">Cancel</button>` : ''}
        ${isApprover && canSkipHireStage(h.stage) ? `<button class="ghost small" data-hire-skip="${h.id}" type="button" title="This step happened outside Colony">Skip</button>` : ''}
        <span class="hire-row-status mini-meta" data-hire-status="${h.id}"></span>
      </div>
      <!-- Collapsed by default (11 Sep 2026): the header says what is
           happening now; the full checklist is one click away. -->
      <div class="hidden" data-hire-checklist="${h.id}">
        ${(h.skipped_stages || []).length ? `<p class="mini-meta hire-skipped-note">Skipped (done outside Colony): ${escapeHtml(skippedHireStageLabels(h).join(', '))}</p>` : ''}
        ${workspace === 'needed' ? '<p class="mini-meta hire-next-step">Waiting on their @youragency.com account — they cannot sign in until it exists.</p>' : ''}
        ${checklistHtml}
        ${workspace === 'requested' ? `<p class="mini-meta hire-next-step">Account requested ${escapeHtml(briefDateLabel(h.workspace_requested_at))} — waiting for their first sign-in.</p>` : ''}
      </div>
      <div class="hidden" data-hire-detail="${h.id}">
        <dl class="brief-summary-grid">${details.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
        ${renderOfferTermsEditor(h)}
        <div data-hire-files="${h.id}"><p class="mini-meta">Loading files…</p></div>
      </div>
    </div>`;
  }).join('');

  // A heading so the list reads as a list of people, not as stray text under
  // the form — 'Maya Rao' on its own did not announce itself as a name.
  listEl.innerHTML = `<p class="hire-list-heading">${showDone ? 'Hires' : 'Active hires'}</p>` + listEl.innerHTML;
}

async function renderHireFiles(hireId) {
  const wrap = document.querySelector(`[data-hire-files="${hireId}"]`);
  if (!wrap) return;
  const out = [];
  for (const folder of ['slips', 'contract']) {
    const { data } = await state.supabase.storage.from('hires').list(`${hireId}/${folder}`, { limit: 30 });
    (data || []).filter(f => f.name).forEach(f => out.push({ folder, name: f.name, path: `${hireId}/${folder}/${f.name}` }));
  }
  // Uploads are timestamped rather than overwritten, so a replaced draft leaves
  // the old one sitting beside it. Newest first, and say plainly which one is
  // live — an ambiguous folder is how the wrong PDF gets signed.
  const stamp = (f) => Number((f.name.match(/^(\d+)_/) || [])[1] || 0);
  out.sort((a, b) => stamp(b) - stamp(a));
  const newestDraft = out.find((f) => f.folder === 'contract' && /_draft_/.test(f.name));
  const newestSigned = out.find((f) => f.folder === 'contract' && /_signed_/.test(f.name));
  const tagFor = (f) => {
    if (f === newestSigned) return '<span class="brief-status-chip">Signed</span>';
    if (f === newestDraft) return '<span class="brief-status-chip">Current draft</span>';
    if (f.folder === 'contract') return '<span class="mini-meta">superseded</span>';
    return '';
  };
  wrap.innerHTML = out.length
    ? out.map(f => `<div class="brief-deliv-row"><span style="flex:1;">${f.folder === 'contract' ? '📄' : '📎'} ${escapeHtml(f.name.replace(/^\d+_(draft|signed)_/, '').replace(/^\d+_/, ''))}</span>${tagFor(f)}<button class="ghost small" data-hire-file="${escapeHtml(f.path)}" type="button">Download</button></div>`).join('')
    : '<p class="mini-meta">No files yet.</p>';
}

async function startHire() {
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const full_name = val('nhName');
  const personal_email = normalizeEmail(val('nhEmail'));
  const start_date = val('nhStartDate') || null;
  const hire_type = val('nhType') || 'full-time';
  const compensation = Number(val('nhComp')) || 0;
  const scope_of_work = val('nhScope');
  const scopedClients = [...document.querySelectorAll('#nhClients input:checked')].map((o) => o.value).filter(Boolean);
  const notice_period_days = Number(val('nhNotice')) || 0;
  const reports_to = normalizeEmail(val('nhReportsTo'));
  const designation = val('nhDesignation');
  if (!full_name || !personal_email.includes('@')) {
    setHiringNotice('Enter the candidate\'s name and personal email.', 'mini-meta warn');
    return;
  }
  // Everything the rest of the checklist works from is set here, once
  // (11 Sep 2026): the date activation fires on, the number Finance
  // and Legal use, and the scope Leo writes into the agreement.
  if (!start_date) { setHiringNotice('Set the start date — activation happens on it.', 'mini-meta warn'); return; }
  if (!compensation) { setHiringNotice(`Enter the ${hireCompensationSpec(hire_type).label.toLowerCase()} — Finance and Legal work from it.`, 'mini-meta warn'); return; }
  if (!scope_of_work) { setHiringNotice('Write a line of scope — it goes into the agreement.', 'mini-meta warn'); return; }
  if (![30, 60].includes(notice_period_days)) { setHiringNotice('Pick the notice period — 30 or 60 days.', 'mini-meta warn'); return; }
  if (!reports_to) { setHiringNotice('Pick who they report to — it becomes their manager in Colony.', 'mini-meta warn'); return; }
  if (!designation) { setHiringNotice('Give the role a designation — it goes into the agreement and onto their profile.', 'mini-meta warn'); return; }
  if (personal_email.endsWith(ANT_DOMAIN)) {
    setHiringNotice('Use their personal email — the youragency.com account comes later.', 'mini-meta warn');
    return;
  }
  setHiringNotice('Creating…');
  const { data, error } = await state.supabase.from('hires')
    .insert({ full_name, personal_email, start_date, hire_type, created_by: state.currentEmployeeId })
    .select();
  if (error) { setHiringNotice('Could not create: ' + error.message, 'mini-meta warn'); return; }
  // Offer terms are a crew-only table; the candidate never sees them.
  const spec = hireCompensationSpec(hire_type);
  const terms = { hire_id: data[0].id, [spec.key]: compensation, scope_of_work, notice_period_days, hiring_manager_email: reports_to, designation, scoped_client_ids: scopedClients, updated_by_employee_id: state.currentEmployeeId || null };
  const { error: termsErr } = await state.supabase.from('hire_offer_terms').upsert(terms, { onConflict: 'hire_id' });
  if (termsErr) { setHiringNotice(`${full_name} created, but the terms did not save: ${termsErr.message}`, 'mini-meta warn'); }
  ['nhName', 'nhEmail', 'nhStartDate', 'nhComp', 'nhScope', 'nhNotice', 'nhReportsTo', 'nhDesignation'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.querySelectorAll('#nhClients input:checked').forEach((cb) => { cb.checked = false; });
  notifyHireEvent('invited', data?.[0]?.id);
  setHiringNotice(`✓ ${full_name} invited — they've been emailed instructions.`);
  await loadHiringPanel();
}

async function updateHireStage(hireId, toStage) {
  const hire = hiresCache.find(h => h.id === hireId);
  if (!hire || !isValidHireTransition(hire.stage, toStage)) return;
  if (toStage === 'cancelled' && !await appConfirm(`Cancel the hire for ${hire.full_name}?`, { title: 'Cancel hire', confirmLabel: 'Cancel hire', danger: true })) return;
  const { data, error } = await state.supabase.from('hires').update({ stage: toStage }).eq('id', hireId).select();
  if (error || !data?.length) { setHiringNotice('Could not update: ' + (error?.message || 'permission?'), 'mini-meta warn'); return; }
  if (toStage !== 'cancelled') notifyHireEvent(toStage, hireId);
  await loadHiringPanel();
}

async function uploadHireContract(hireId, file, signed) {
  if (!file) return;
  const hire = hiresCache.find(h => h.id === hireId);
  if (!hire) return;
  // Status goes on the row, not the panel header, and animates: a file upload
  // otherwise gives no sign at all that anything started (8 Sep 2026).
  setHireRowStatus(hireId, `Uploading ${file.name}`, { busy: true });
  const prefix = signed ? 'signed' : 'draft';
  const path = `${hireId}/contract/${Date.now()}_${prefix}_${file.name}`;
  const { error } = await state.supabase.storage.from('hires').upload(path, file);
  if (error) { setHireRowStatus(hireId, 'Upload failed: ' + error.message, { warn: true }); return; }

  if (signed) {
    await updateHireStage(hireId, 'signed');
    setHireRowStatus(hireId, '✓ Signed contract uploaded — finance notified.');
    return;
  }
  // A replacement draft always needs review again, whether it is arriving for
  // the first time, replacing an unreviewed draft, or replacing one already
  // approved. Same-stage replacement is not a transition, so update directly.
  if (hire.stage === 'contract_uploaded') {
    await state.supabase.from('hires').update({ updated_at: new Date().toISOString() }).eq('id', hireId);
    notifyHireEvent('contract_uploaded', hireId);
    await loadHiringPanel();
    setHireRowStatus(hireId, '✓ New draft uploaded — review requested again.');
    return;
  }
  const wasApproved = hire.stage === 'reviewed';
  await updateHireStage(hireId, 'contract_uploaded');
  setHireRowStatus(hireId, wasApproved
    ? '✓ New draft uploaded — back to review, since the approved version changed.'
    : '✓ Contract uploaded — sent for review.');
}

// Skip a stage whose work happened outside Colony. It advances ONE stage along
// a transition the flow already allows, and records the stage as skipped —
// walking a hire forward silently would assert that a contract was drafted and
// reviewed here when no document exists, which is a worse record than an
// obviously incomplete one.
//
// Mostly no stage email: they describe work that did not happen ("the contract
// draft is uploaded and waiting for review"), so sending one would put the
// untruth in an inbox as well as the database. The exception is a stage that
// announces where you have ARRIVED and hands the next person a real job —
// see SKIP_STILL_NOTIFIES.
async function skipHireStage(hireId) {
  const hire = hiresCache.find(h => h.id === hireId);
  const toStage = hire && nextHireStage(hire.stage);
  if (!hire || !toStage) return;
  const from = HIRE_STAGE_LABEL[hire.stage] || hire.stage;
  const to = HIRE_STAGE_LABEL[toStage] || toStage;
  if (!await appConfirm(
    `Skip "${from}" for ${hire.full_name}? Use this when it was handled outside Colony. It moves to "${to}", records the step as skipped, and sends no email.`,
    { title: 'Skip this step', confirmLabel: 'Skip' }
  )) return;
  setHireRowStatus(hireId, `Skipping ${from}`, { busy: true });
  const skipped = Array.from(new Set([...(hire.skipped_stages || []), hire.stage]));
  const { data, error } = await state.supabase.from('hires')
    .update({ stage: toStage, skipped_stages: skipped }).eq('id', hireId).select();
  if (error || !data?.length) {
    setHireRowStatus(hireId, 'Could not skip: ' + (error?.message || 'permission?'), { warn: true });
    return;
  }
  // Arriving at signed or payroll_done still tells whoever must act next.
  if (skipShouldNotify(toStage)) notifyHireEvent(toStage, hireId);
  await loadHiringPanel();
  setHireRowStatus(hireId, `✓ ${from} skipped — now at ${to}.`
    + (skipShouldNotify(toStage) ? ' Finance notified.' : ''));
}

// Opens the reseller request in whatever mail client the user has, prefilled.
// Deliberately NOT sent by Colony: the reply carries a plaintext password, and
// that exchange belongs in a human's inbox, not in an automated path.
async function requestWorkspaceAccount(hireId) {
  const hire = hiresCache.find(h => h.id === hireId);
  if (!hire) return;
  // When the service account is configured, Colony creates the account itself
  // (11 Sep 2026) — no reseller, no forwarded password. The old mailto
  // path stays as the fallback so a half-configured deploy degrades to the
  // process that worked, not to a button that errors.
  const canProvision = Boolean(state.runtimeConfig?.workspaceProvisioning);
  const address = await appPrompt(
    canProvision
      ? `Create which @youragency.com address for ${hire.full_name}? They'll be emailed a one-time password at ${hire.personal_email}.`
      : `Which address should Example Reseller create for ${hire.full_name}?`,
    { title: canProvision ? 'Create @youragency.com account' : 'Request @youragency.com account',
      okLabel: canProvision ? 'Create account' : 'Open request', placeholder: suggestWorkEmail(hire.full_name) }
  );
  if (address === null) return;
  const workEmail = (address || '').trim() || suggestWorkEmail(hire.full_name);
  if (canProvision) { await provisionWorkspaceAccount(hireId, hire, workEmail); return; }
  const { subject, body } = workspaceRequestEmail(hire, workEmail);
  const href = `mailto:${encodeURIComponent(WORKSPACE_VENDOR_TO)}`
    + `?cc=${encodeURIComponent(WORKSPACE_VENDOR_CC.join(','))}`
    + `&subject=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
  window.open(href, '_blank');
  // Only stamped once the person says they sent it — a draft that was opened
  // and abandoned must not read as done.
  if (!await appConfirm(
    `Opened the request for ${workEmail}. Mark it as requested once you have sent it?`,
    { title: 'Account requested?', confirmLabel: 'Yes, sent' }
  )) return;
  setHireRowStatus(hireId, 'Saving', { busy: true });
  const { data, error } = await state.supabase.from('hires')
    .update({ workspace_requested_at: new Date().toISOString() }).eq('id', hireId).select();
  if (error || !data?.length) {
    setHireRowStatus(hireId, 'Could not save: ' + (error?.message || 'permission?'), { warn: true });
    return;
  }
  await loadHiringPanel();
  setHireRowStatus(hireId, `✓ Requested — forward the credentials to ${hire.full_name} when they arrive.`);
}

// The automated path. The function does the work and holds the password for
// one request; this side only reports what happened.
async function provisionWorkspaceAccount(hireId, hire, workEmail) {
  setHireRowStatus(hireId, 'Creating account', { busy: true });
  let result = {};
  let ok = false;
  try {
    const res = await fetch('/api/workspace-provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session.access_token}` },
      body: JSON.stringify({ hireId, workEmail })
    });
    result = await res.json().catch(() => ({}));
    ok = res.ok || res.status === 207;
  } catch (e) { result = { error: e.message }; }
  if (!ok) { setHireRowStatus(hireId, `Could not create the account: ${result.error || 'unknown error'}`, { warn: true }); return; }
  await loadHiringPanel();
  if (result.warning) { setHireRowStatus(hireId, result.warning, { warn: true }); return; }
  setHireRowStatus(hireId, `✓ ${result.workEmail} created — sign-in details emailed to ${hire.personal_email}.`);
}

document.getElementById('startHireBtn')?.addEventListener('click', () => startHire().catch(console.error));
document.getElementById('hiringShowDone')?.addEventListener('change', () => renderHiringList());
document.getElementById('hiringList')?.addEventListener('click', (e) => {
  const skip = e.target.closest('[data-hire-skip]');
  if (skip) { skipHireStage(skip.dataset.hireSkip).catch(console.error); return; }
  const ws = e.target.closest('[data-hire-workspace]');
  if (ws) { requestWorkspaceAccount(ws.dataset.hireWorkspace).catch(console.error); return; }
  const saveTerms = e.target.closest('[data-save-offer-terms]');
  if (saveTerms) {
    saveOfferTerms(saveTerms.dataset.saveOfferTerms).catch(console.error);
    return;
  }
  const toggle = e.target.closest('[data-hire-toggle]');
  if (toggle) {
    const detail = document.querySelector(`[data-hire-detail="${toggle.dataset.hireToggle}"]`);
    if (detail) {
      detail.classList.toggle('hidden');
      if (!detail.classList.contains('hidden')) renderHireFiles(toggle.dataset.hireToggle).catch(console.error);
    }
    return;
  }
  const action = e.target.closest('[data-hire-action]');
  if (action) { updateHireStage(action.dataset.hireId, action.dataset.hireAction).catch(console.error); return; }
  const file = e.target.closest('[data-hire-file]');
  if (file) {
    state.supabase.storage.from('hires').createSignedUrl(file.dataset.hireFile, 300)
      .then(({ data }) => { if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener'); });
  }
});
// Papersign: draft, then send. Both are functions; the panel only reports.
async function papersignAction(kind, hireId) {
  const hire = hiresCache.find((h) => h.id === hireId);
  if (!hire) return;
  if (kind === 'send' && !await appConfirm(`Send ${hire.full_name}'s agreement for signature? It goes to them and to Alex through Papersign.`, { title: 'Send for signing', confirmLabel: 'Send' })) return;
  setHireRowStatus(hireId, kind === 'draft' ? 'Drafting in Papersign' : 'Sending', { busy: true });
  let out = {}; let ok = false;
  try {
    const res = await fetch(`/api/papersign-${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session.access_token}` }, body: JSON.stringify({ hireId }) });
    out = await res.json().catch(() => ({})); ok = res.ok;
  } catch (e) { out = { error: e.message }; }
  if (!ok) { setHireRowStatus(hireId, out.error || 'Papersign failed', { warn: true }); return; }
  await loadHiringPanel();
  setHireRowStatus(hireId, kind === 'draft' ? `✓ Draft created in Papersign — Leo can review it there.` : `✓ Sent for signature.`);
  if (kind === 'draft') notifyHireEvent('contract_uploaded', hireId);
}
document.getElementById('hiringList')?.addEventListener('click', (e) => {
  const d = e.target.closest('[data-hire-ps-draft]'); if (d) { papersignAction('draft', d.dataset.hirePsDraft).catch(console.error); return; }
  const s2 = e.target.closest('[data-hire-ps-send]'); if (s2) { papersignAction('send', s2.dataset.hirePsSend).catch(console.error); }
});
document.getElementById('hiringList')?.addEventListener('click', (e) => {
  const t = e.target.closest('[data-hire-checklist-toggle]');
  if (!t) return;
  document.querySelector(`[data-hire-checklist="${t.dataset.hireChecklistToggle}"]`)?.classList.toggle('hidden');
});
document.getElementById('hiringList')?.addEventListener('change', (e) => {
  if (e.target.matches('[data-hire-contract]')) {
    uploadHireContract(e.target.dataset.hireContract, e.target.files?.[0], false).catch(console.error);
  } else if (e.target.matches('[data-hire-signed]')) {
    uploadHireContract(e.target.dataset.hireSigned, e.target.files?.[0], true).catch(console.error);
  }
});

// ── Partner feedback (own bugs/ideas + Your Agency replies; never the internal board) ──

let partnerFeedbackCache = [];

async function loadPartnerFeedback() {
  // Two readers now: the client team, and an Your Agency reviewer signed in on
  // Circle to answer them.
  if (!state.supabase) return;
  if (!state.partnerProfile && !state.staffOnCircle) return;
  const [postsRes, repliesRes] = await Promise.all([
    state.supabase.from('feature_requests')
      .select('id, request_text, request_type, status, created_at, author_name, author_partner_id')
      .order('created_at', { ascending: false }),
    state.supabase.from('feature_request_replies')
      .select('id, feature_request_id, reply_text, created_at, author_name, author_partner_id')
      .order('created_at', { ascending: true })
  ]);
  // RLS scopes both queries to this partner's ORG — the wall shows what the
  // client team has raised, not just what this one person raised (Alex,
  // 10 Sep 2026). Your Agency's own internal requests have no author_partner_id
  // and are excluded by the policy, so the two boards stay separate.
  const replies = repliesRes.data || [];
  // A reviewer's token returns EVERY request, Your Agency's fifty-three internal
  // ones included. Circle shows client posts only — the whole point of the two
  // boards being separate is that the internal one does not appear here.
  const posts = (postsRes.data || [])
    .filter(p => !state.staffOnCircle || p.author_partner_id);
  partnerFeedbackCache = posts.map(p => ({
    ...p,
    replies: replies.filter(r => r.feature_request_id === p.id)
  }));
  renderPartnerFeedback();
}

// A reviewer on Circle is looking at the client's workspace, not using it.
// Every control that would WRITE as the client is hidden; replying to feedback
// is the one thing they are here to do, and that posts as Your Agency.
//
// This is presentation, not protection. The protection is that an employee has
// no partner id, so app.briefs_insert_partner and every sibling policy refuse
// them at the database. Hiding the buttons stops someone hitting an error they
// cannot explain.
function applyStaffOnCircleReadOnly() {
  const readOnly = Boolean(state.staffOnCircle);
  const note = document.getElementById('staffCircleNote');
  if (note) note.classList.toggle('hidden', !readOnly);
  // Only ever HIDES, and only for staff. It used toggle('hidden', readOnly),
  // which for a real client UN-hid the notify bell and the Remote Work Policy
  // link that the partner sign-in path and applyFooterLinkAccess() had just
  // hidden — every client saw both from 10 to 17 Sep 2026 (found signed in as
  // the Your Agency QA test client). A client's own controls are theirs to gate.
  if (!readOnly) return;
  ['newBriefBtn', 'submitBriefBtn', 'pfComposePanel', 'orgContactsForm',
    // Employee chrome that followed the session onto the client's domain: the
    // notify bell is fed by internal signals, and the Remote Work Policy link
    // points at a screen the Circle bundle does not even contain.
    'notifyBellBtn', 'footerPolicyRemoteWork', 'footerPolicySep'].forEach((id) => {
    document.getElementById(id)?.classList.add('hidden');
  });
}

// A reply pasted or scripted with hard line breaks every ~40 characters read
// as a narrow column inside a full-width bubble (17 Sep 2026). Single
// newlines become spaces; blank lines stay as paragraph breaks.
function unwrapHardBreaks(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1 ').replace(/[ \t]{2,}/g, ' ');
}

function renderPartnerFeedback() {
  const ideas = document.getElementById('pfIdeas');
  const bugs = document.getElementById('pfBugs');
  const empty = document.getElementById('pfEmpty');
  if (!ideas || !bugs || !empty) return;
  // Your Agency raises its own work elsewhere; on Circle a reviewer only answers.
  applyStaffOnCircleReadOnly();
  empty.classList.toggle('hidden', partnerFeedbackCache.length > 0);
  const replyWho = (r) => {
    if (!r.author_partner_id) return r.author_name || 'Your Agency';
    if (r.author_partner_id === state.partnerProfile?.id) return 'You';
    return r.author_name || 'A teammate';
  };
  const card = (p) => {
    const isBug = p.request_type === 'bug';
    const status = p.status === 'done'
      ? '<span class="fr-status done">Done</span>'
      : p.status === 'in_progress'
        ? '<span class="fr-status in-progress">In progress</span>'
        : '<span class="fr-status requested">Received</span>';
    // "You" must mean this viewer specifically — the wall carries the whole
    // team's posts. A reviewer owns none of them but answers all of them.
    const mine = Boolean(state.partnerProfile) && p.author_partner_id === state.partnerProfile.id;
    const canReply = mine || state.staffOnCircle;
    const author = mine ? 'You' : (p.author_name || (state.staffOnCircle ? 'A client' : 'A teammate'));
    const replies = (p.replies || []).map((r) => `<div class="brief-comment${r.author_partner_id ? '' : ' internal'}">
      <div class="who">${escapeHtml(replyWho(r))} · ${escapeHtml(briefDateLabel(r.created_at))}</div>
      <div class="body">${linkifyProse(unwrapHardBreaks(r.reply_text))}</div>
    </div>`).join('');
    return `<div class="fr-card${isBug ? ' fr-card-bug' : ''}${p.status === 'done' ? ' pf-card-done' : ''}" data-pf-id="${p.id}">
      <div class="fr-card-head">
        <span class="fr-type-chip ${isBug ? 'fr-type-bug' : 'fr-type-feature'}">${isBug ? 'Bug' : 'Idea'}</span>
        <strong>${escapeHtml(author)}</strong>
        <span>${escapeHtml(briefDateLabel(p.created_at))}</span>
      </div>
      <div class="fr-card-body">${linkifyProse(p.request_text)}</div>
      <div class="fr-card-foot">${status}</div>
      ${replies ? `<div class="pf-replies">${replies}</div>` : ''}
      ${canReply ? `<div class="action-row pf-reply-row">
        <input type="text" data-pf-reply-input="${p.id}" placeholder="Reply…">
        <button class="ghost small" data-pf-reply="${p.id}" type="button">Reply</button>
      </div>` : ''}
    </div>`;
  };
  const byRecency = (a, b) => String(b.created_at).localeCompare(String(a.created_at));
  const order = (list) => [...list.filter((p) => p.status !== 'done').sort(byRecency), ...list.filter((p) => p.status === 'done').sort(byRecency)];
  const ideaList = order(partnerFeedbackCache.filter((p) => p.request_type !== 'bug'));
  const bugList = order(partnerFeedbackCache.filter((p) => p.request_type === 'bug'));
  ideas.innerHTML = ideaList.length ? ideaList.map(card).join('') : '<p class="mini-meta">No ideas yet.</p>';
  bugs.innerHTML = bugList.length ? bugList.map(card).join('') : '<p class="mini-meta">No bugs reported.</p>';
}

async function submitPartnerFeedback() {
  const notice = document.getElementById('pfNotice');
  const textEl = document.getElementById('pfText');
  const type = document.getElementById('pfType')?.value === 'feature' ? 'feature' : 'bug';
  const text = (textEl?.value || '').trim();
  if (!text || !state.partnerProfile) {
    if (notice) notice.textContent = 'Write a line or two first.';
    return;
  }
  if (notice) notice.textContent = 'Sending…';
  const { data, error } = await state.supabase.from('feature_requests').insert({
    author_partner_id: state.partnerProfile.id,
    author_name: `${state.partnerProfile.full_name} (${state.partnerProfile.org})`,
    request_text: text,
    request_type: type
  }).select();
  if (error) { if (notice) notice.textContent = 'Could not send: ' + error.message; return; }
  if (textEl) textEl.value = '';
  if (notice) notice.textContent = '✓ Sent to the team.';
  // Alert the admin like internal posts do (best-effort).
  const token = state.session?.access_token;
  if (token && data?.[0]?.id) {
    fetch('/api/feature-request-notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'new_bug', featureRequestId: data[0].id, actorName: state.partnerProfile.full_name })
    }).catch(() => {});
  }
  loadPartnerFeedback().catch(console.error);
}

async function submitPartnerFeedbackReply(frId) {
  const input = document.querySelector(`[data-pf-reply-input="${frId}"]`);
  const text = (input?.value || '').trim();
  if (!text) return;
  // Same box, two authors. A reviewer's reply is stamped employee_id — the
  // insert policy requires it to match them — and reads as Your Agency on the
  // client's wall, exactly as a reply posted from Colony does.
  const asStaff = state.staffOnCircle && !state.partnerProfile;
  if (!asStaff && !state.partnerProfile) return;
  const row = asStaff
    ? {
      feature_request_id: frId,
      employee_id: state.currentEmployeeId,
      author_name: displayPersonName(state.employeeProfile?.full_name, 'Your Agency'),
      reply_text: text
    }
    : {
      feature_request_id: frId,
      author_partner_id: state.partnerProfile.id,
      author_name: `${state.partnerProfile.full_name} (${state.partnerProfile.org})`,
      reply_text: text
    };
  const { error } = await state.supabase.from('feature_request_replies').insert(row);
  if (error) { console.error(error); return; }
  loadPartnerFeedback().catch(console.error);
}

document.getElementById('pfSubmitBtn')?.addEventListener('click', () => submitPartnerFeedback().catch(console.error));
document.getElementById('pfList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pf-reply]');
  if (btn) submitPartnerFeedbackReply(btn.dataset.pfReply).catch(console.error);
});


// ── Partner timeline: every brief as a stage progression ──────────

async function loadPartnerTimeline() {
  await loadBriefsData();
  renderPartnerTimeline();
}

function renderPartnerTimeline() {
  const wrap = document.getElementById('ptList');
  const empty = document.getElementById('ptEmpty');
  if (!wrap || !empty) return;
  const rows = briefsCache.filter(b => b.request_type === 'brief')
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  empty.classList.toggle('hidden', rows.length > 0);
  // Grouped by stage instead of a stepper per brief (7 Sep 2026):
  // "list the briefs under With Your Agency" rather than a circle to decode.
  wrap.innerHTML = groupBriefsByTimelineStage(rows).map(group => `
    <div class="panel"><div>
      <p class="feed-section-heading" style="margin:0 0 8px;">${escapeHtml(group.label)}
        <span class="mini-meta">(${group.briefs.length})</span></p>
      <div class="pt-table">
        ${group.briefs.map(b => {
          const badge = isBriefPaused(b)
            ? `<span class="brief-status-chip st-on_pause" title="${escapeHtml(briefPauseDetail(b))}">On pause</span>`
            : (briefTimelinePosition(b.status).badge
                ? `<span class="brief-status-chip st-pending_info">${escapeHtml(briefTimelinePosition(b.status).badge)}</span>`
                : '');
          const due = b.deadline ? `<span class="mini-meta pt-row-due">${escapeHtml(formatDealDate(b.deadline))}</span>` : '';
          return `<div class="pt-row" data-open-brief="${b.id}">
            <span class="pt-row-title">${escapeHtml(b.title)}</span>
            ${badge}${due}
          </div>`;
        }).join('')}
      </div>
    </div></div>`).join('');
}

document.getElementById('ptList')?.addEventListener('click', (e) => {
  const card = e.target.closest('[data-open-brief]');
  if (card) openPartnerBriefDetail(card.dataset.openBrief);
});

// ── the client stakeholder map (org_contacts) — shared internal + partner panel ──

let orgContactsCache = [];
let orgContactEditingId = null;
let orgContactsPanelHome = null;

function placeOrgContactsPanel(mode) {
  const panel = document.getElementById('orgContactsPanel');
  if (!panel) return;
  if (!orgContactsPanelHome) orgContactsPanelHome = { parent: panel.parentElement, next: panel.nextElementSibling };
  if (mode === 'partner') {
    document.getElementById('orgContactsPanelSlotPartner')?.appendChild(panel);
  } else if (orgContactsPanelHome.parent && panel.parentElement?.id === 'orgContactsPanelSlotPartner') {
    orgContactsPanelHome.parent.insertBefore(panel, orgContactsPanelHome.next);
  }
}

function setOrgContactsNotice(message = '', className = 'mini-meta') {
  const el = document.getElementById('orgContactsNotice');
  if (el) { el.textContent = message; el.className = className; }
}

function canEditOrgContacts() {
  // Staff on Circle are read-only there; reviewers edit the list from Colony.
  if (state.staffOnCircle) return false;
  if (isPartnerRole()) return state.partnerProfile?.partner_role !== 'client_viewer';
  return isBriefReviewer();
}

async function loadOrgContacts() {
  if (!state.supabase) return;
  const { data, error } = await state.supabase
    .from('org_contacts')
    .select('*')
    .order('full_name');
  if (error) { setOrgContactsNotice('Could not load: ' + error.message, 'mini-meta warn'); return; }
  orgContactsCache = data || [];
  // Used to bail before the query when #orgContactsPanel was absent, which made
  // the cache a side effect of that panel being on screen — the brief form's
  // approver dropdown needs the same contacts with no panel in sight.
  const panel = document.getElementById('orgContactsPanel');
  if (panel) { panel.classList.remove('hidden'); renderOrgContacts(); }
  renderBriefApproverOptions();
}

function renderOrgContacts() {
  // Clients see their own org named; Colony keeps the neutral title.
  const orgName = state.partnerProfile?.org;
  const titleEl = document.getElementById('orgContactsTitle');
  if (titleEl) titleEl.textContent = orgName ? `${orgName} stakeholders` : 'Client stakeholders';
  const list = document.getElementById('orgContactsList');
  const form = document.getElementById('orgContactsForm');
  if (!list) return;
  const canEdit = canEditOrgContacts();
  if (form) form.classList.toggle('hidden', !canEdit);

  // Simple oversight tree: roots (no reports_to) first, reports nested under.
  const byId = Object.fromEntries(orgContactsCache.map(c => [c.id, c]));
  const children = {};
  const roots = [];
  for (const c of orgContactsCache) {
    if (c.reports_to && byId[c.reports_to]) {
      (children[c.reports_to] = children[c.reports_to] || []).push(c);
    } else {
      roots.push(c);
    }
  }
  const rowHtml = (c, depth) => `<div class="brief-deliv-row" style="padding-left:${depth * 22}px;">
    <span style="flex:1;min-width:180px;">
      ${depth ? '<span class="mini-meta">↳</span> ' : ''}<strong>${escapeHtml(c.full_name)}</strong>
      ${c.team_role ? ` <span class="mini-meta">· ${escapeHtml(c.team_role)}</span>` : ''}
      ${c.email ? ` <span class="mini-meta">· ${escapeHtml(c.email)}</span>` : ''}
      ${c.oversees ? `<br><span class="mini-meta">Oversees: ${escapeHtml(c.oversees)}</span>` : ''}
      ${c.backup_contact ? `<br><span class="mini-meta">In their absence: ${escapeHtml(c.backup_contact)}</span>` : ''}
    </span>
    ${canEdit ? `<button class="ghost small" data-oc-edit="${c.id}" type="button">Edit</button>
    <button class="ghost small danger-text" data-oc-remove="${c.id}" type="button">Remove</button>` : ''}
  </div>`;
  const renderBranch = (c, depth) => rowHtml(c, depth)
    + (children[c.id] || []).map(k => renderBranch(k, depth + 1)).join('');
  list.innerHTML = roots.map(r => renderBranch(r, 0)).join('')
    || '<p class="mini-meta">No contacts yet — add the first one below.</p>';

  const reportsSel = document.getElementById('ocReportsTo');
  if (reportsSel) {
    const current = reportsSel.value;
    reportsSel.innerHTML = '<option value="">Reports to…</option>'
      + orgContactsCache.filter(c => c.id !== orgContactEditingId)
        .map(c => `<option value="${c.id}">${escapeHtml(c.full_name)}</option>`).join('');
    reportsSel.value = current;
  }
}

async function saveOrgContact() {
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const row = {
    full_name: val('ocName'),
    team_role: val('ocRole') || null,
    email: normalizeEmail(val('ocEmail')) || null,
    oversees: val('ocOversees') || null,
    backup_contact: val('ocBackup') || null,
    reports_to: val('ocReportsTo') || null
  };
  // A client's contact belongs to the client's org. The column defaults to
  // 'Example Collective', so without this any other client's save was filed under
  // the client (and refused by RLS). The DB forces the same for partner inserts.
  if (!orgContactEditingId && state.partnerProfile?.org) row.org = state.partnerProfile.org;
  if (!row.full_name) { setOrgContactsNotice('A name is the one thing we need.', 'mini-meta warn'); return; }
  setOrgContactsNotice('Saving…');
  const q = orgContactEditingId
    ? state.supabase.from('org_contacts').update({ ...row, updated_at: new Date().toISOString() }).eq('id', orgContactEditingId).select()
    : state.supabase.from('org_contacts').insert(row).select();
  const { data, error } = await q;
  if (error) { setOrgContactsNotice('Could not save: ' + error.message, 'mini-meta warn'); return; }
  if (!data?.length) { setOrgContactsNotice('Nothing saved (permission?).', 'mini-meta warn'); return; }
  resetOrgContactForm();
  setOrgContactsNotice('✓ Saved.');
  await loadOrgContacts();
}

function resetOrgContactForm(prefill = null) {
  orgContactEditingId = prefill?.id || null;
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  setVal('ocName', prefill?.full_name);
  setVal('ocRole', prefill?.team_role);
  setVal('ocEmail', prefill?.email);
  setVal('ocOversees', prefill?.oversees);
  setVal('ocBackup', prefill?.backup_contact);
  setVal('ocReportsTo', prefill?.reports_to);
  const saveBtn = document.getElementById('ocSaveBtn');
  if (saveBtn) saveBtn.textContent = prefill ? 'Save changes' : 'Add';
  document.getElementById('ocCancelBtn')?.classList.toggle('hidden', !prefill);
}

document.getElementById('ocSaveBtn')?.addEventListener('click', () => saveOrgContact().catch(console.error));
document.getElementById('ocCancelBtn')?.addEventListener('click', () => resetOrgContactForm());
document.getElementById('orgContactsList')?.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-oc-edit]');
  if (editBtn) {
    resetOrgContactForm(orgContactsCache.find(c => c.id === editBtn.dataset.ocEdit));
    return;
  }
  const removeBtn = e.target.closest('[data-oc-remove]');
  if (removeBtn) {
    const c = orgContactsCache.find(x => x.id === removeBtn.dataset.ocRemove);
    if (!c || !await appConfirm(`Remove ${c.full_name} from the team map?`, { title: 'Remove contact', confirmLabel: 'Remove', danger: true })) return;
    const { error } = await state.supabase.from('org_contacts').delete().eq('id', c.id);
    if (error) { setOrgContactsNotice('Could not remove: ' + error.message, 'mini-meta warn'); return; }
    await loadOrgContacts();
  }
});
