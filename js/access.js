/* ── Your Agency access control: role & permission predicates ──
   Classic script — loads after config.js + utils.js, before app.js. Shares the
   global scope. These functions read the global `state` object and a couple of
   app.js helpers (currentUserDepartmentName, employeeReportsToManager); since
   they're only CALLED at runtime (after every script has loaded), those
   references resolve fine even though app.js loads later.

   IMPORTANT (matches CLAUDE.md): client-side role here is UX-only. RLS is the
   real security boundary. Never use these predicates to decide whether to add
   an employee_id filter on own-data DB queries — always filter regardless. */

// ── Superadmin ──
function isSuperadminEmail(email) {
  return normalizeEmail(email) === SUPERADMIN_EMAIL;
}

function isSuperadminUser() {
  const candidateEmail = state.employeeProfile?.email || state.session?.user?.email || '';
  return isSuperadminEmail(candidateEmail);
}

function canManageAccessRoles() {
  return isSuperadminUser();
}

// ── Role / department ──
function normalizeAccessLevel(role) {
  if (role === 'admin' || role === 'leadership' || role === 'employee') return role;
  return 'employee';
}

// Effective enforced-access map: the DB-loaded overrides (state.accessOverrides,
// editable in Admin Settings) if present, else the in-code ENFORCED_ACCESS_BY_EMAIL
// constant as a failsafe. Both are { normalizedEmail: role } objects.
function getEnforcedAccessMap() {
  return (state.accessOverrides && Object.keys(state.accessOverrides).length)
    ? state.accessOverrides
    : ENFORCED_ACCESS_BY_EMAIL;
}

function getEnforcedAccessLevel(email) {
  return getEnforcedAccessMap()[normalizeEmail(email)] || null;
}

// Operational config accessors: prefer the DB-loaded app_config (state.appConfig,
// editable in Admin Settings) per key, else the in-code constant for that key.
// loadAppConfig() (app.js) populates state.appConfig on login.
// An explicitly stored value — INCLUDING an empty list/map — is the
// configuration. Only a missing key (or the wrong shape) falls back to the
// in-code constant.
//
// These used to fall back whenever the stored value was empty, which made an
// empty list unrepresentable and so made the LAST entry impossible to remove:
// the save wrote [] correctly, then the next read resurrected the in-code
// default. The Remove button looked dead, and worse, the permission check
// reads the same accessor — so the person kept their access while the admin
// believed they'd been removed. loadAppConfig only sets keys that exist in the
// DB, so `undefined` still means "never configured" and still falls back.
function getConfigList(key, fallback) {
  const v = state.appConfig && state.appConfig[key];
  return Array.isArray(v) ? v.map(normalizeEmail) : fallback;
}
function getConfigMap(key, fallback) {
  const v = state.appConfig && state.appConfig[key];
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : fallback;
}
function getInvoiceExcludedEmails(){ return getConfigList('invoice_excluded_emails', INVOICE_EXCLUDED_EMAILS); }
function getHiddenEmployeeEmails() { return getConfigList('hidden_employee_emails',  HIDDEN_EMPLOYEE_EMAILS); }
// Dedicated to specific clients (app.employee_client_scope → state.clientScopeByEmployee).
// Mirrors app.is_client_scoped(): only a FRACTIONAL person is scoped. Rows left
// behind on someone who has since moved to full-time or consultant are inert —
// a stale row was quietly dropping a salaried employee out of the agency
// capacity average (Anya, found 1 Sep 2026).
function isClientScoped(employee) {
  const id = employee?.id;
  if (!id || !state.clientScopeByEmployee) return false;
  if (!employmentIsScoped(employee.employment_type ?? employee.employmentType)) return false;
  const clients = state.clientScopeByEmployee.get(id);
  return Boolean(clients && clients.size);
}

// Excluded from AGENCY-level capacity maths (utilization average, free
// bandwidth, Resource Planner) — a person dedicated to one client is not
// reassignable bandwidth, so "40% free" there is a phantom invitation.
// Derived from scope rather than a hand-maintained list.
// NOTE: they are NOT excluded from CLIENT-level maths — their capacity is real
// and their client must see honest delivered hours and over-commitment.
function isCapacityExcluded(employee) {
  return isClientScoped(employee);
}
function getDealFlowExtraEmails()  { return getConfigList('deal_flow_extra_emails',   DEAL_FLOW_EXTRA_EMAILS); }
function getSetupApproverEmails()  { return getConfigList('setup_approver_emails',    SETUP_APPROVER_EMAILS); }
function getBriefReviewerEmails()  { return getConfigList('brief_reviewer_emails',    BRIEF_REVIEWER_EMAILS); }
function getHiringCrewEmails()     { return getConfigList('hiring_crew_emails',       HIRING_CREW_EMAILS); }

// Hiring pipeline crew: leadership + setup approvers + the legal/finance list
// (Leo, Blake). Nobody else — mirrors app.is_hiring_crew() in the DB,
// which is the real boundary; this only decides what the UI shows.
function isHiringCrew() {
  if (isSetupApprover() || isLeadershipRole()) return true;
  const email = normalizeEmail(state.employeeProfile?.email || state.session?.user?.email || '');
  return getHiringCrewEmails().includes(email);
}

// May lock/unlock/reopen briefs and assign deliverables. UX-only; writes are
// still employee-wide at the DB (internal trust), this gates the buttons.
function isBriefReviewer() {
  if (isLeadershipRole()) return true;
  const email = normalizeEmail(state.employeeProfile?.email || state.session?.user?.email || '');
  return getBriefReviewerEmails().includes(email);
}

// Approves a new joiner's setup (team, full-time/project-based, capacity,
// clients). Alex + Nadia only — deliberately NOT leadership-wide, because
// activating someone grants client access. Mirrors app.is_setup_approver() in
// the DB, which is the real boundary; this is UX only. The superadmin floor
// matches the DB's: without it, removing the superadmin from the list hides
// the Awaiting Setup panel from the one person the DB still allows to act.
function isSetupApprover() {
  if (isSuperadminUser()) return true;
  const email = normalizeEmail(state.employeeProfile?.email || state.session?.user?.email || '');
  return getSetupApproverEmails().includes(email);
}

function getTeamManagerMap()       { return getConfigMap('team_manager_by_team',      TEAM_MANAGER_BY_TEAM); }
function getDirectManagerMap()     { return getConfigMap('direct_manager_by_email',   DIRECT_MANAGER_BY_EMAIL); }

function isLeadershipRole() {
  return state.role === 'leadership' || state.role === 'admin';
}

// Shared rule: leadership/admin OR anyone in Account Management.
// Used by Scope & Coverage editing.
function isLeadershipOrAM() {
  if (isLeadershipRole()) return true;
  const dept = (state.employeeProfile?.department?.name || '').toLowerCase();
  return dept === 'am' || dept === 'account management' || dept.startsWith('account mgmt');
}

// ── Finance / per-feature viewers ──
function isFinanceUser() {
  return currentUserDepartmentName().toLowerCase() === 'finance';
}

// Reads the HARDCODED constant, never app_config — deliberate (23 Jul
// 2026): invoices are compensation data, and this access must not be openable
// by a panel edit or config mistake. Mirrors app.is_invoice_viewer() in the DB,
// which is hardcoded to the same three people.
function isInvoiceViewer() {
  const email = normalizeEmail(state.session?.user?.email || '');
  return INVOICE_VIEWER_EMAILS.includes(email);
}

function isDealFlowViewer() {
  if (isLeadershipRole()) return true;
  const email = normalizeEmail(state.employeeProfile?.email || state.session?.user?.email || '');
  return getDealFlowExtraEmails().includes(email);
}

function canAccessTeamDashboard() {
  return state.isAuthenticated && (isLeadershipRole() || isFinanceUser());
}

// ── Employees ──
function canEditEmployee(employee) {
  if (!state.isAuthenticated) return false;
  if (isSuperadminUser()) return true;
  const empEmail = normalizeEmail(employee?.email || '');
  const myEmail = normalizeEmail(state.employeeProfile?.email || state.session?.user?.email || '');
  if (empEmail && empEmail === myEmail) return true;
  if (isLeadershipRole() && employee) {
    return employeeReportsToManager(employee, myEmail);
  }
  return false;
}

// ── Tasks ──
function canManageTask(task) {
  if (!task) return false;
  if (isLeadershipRole()) return true;
  return Boolean(state.currentEmployeeId && task.employee_id === state.currentEmployeeId);
}

function canManageTaskView(taskEmployeeId) {
  if (isLeadershipRole()) return true;
  return Boolean(state.currentEmployeeId && taskEmployeeId && state.currentEmployeeId === taskEmployeeId);
}

// ── Scope & Coverage / Analytics ──
function canEditScopeCoverage() {
  return isLeadershipOrAM();
}

function canUploadAnalytics() {
  // Any employee can upload (11 Aug 2026 — Ivy's ask; was
  // leadership/admin + AM). DB mirror: app.is_analytics_uploader(), which for
  // scoped employees also requires visibility of the client being written.
  return Boolean(state.currentEmployeeId);
}

// ── Clients ──
function canAddClients() {
  // Manual client creation is superadmin-only. Everyone else brings clients
  // in via the deal flow (closed deals auto-create clients).
  // Keyed off the superadmin EMAIL (with the enforced-access failsafe), never
  // a first name: a name test breaks silently on rename/middle-name changes
  // and would hand client creation to any namesake who joins.
  return isSuperadminUser();
}

function canEditClients() {
  if (isSuperadminUser()) return true;
  return isLeadershipRole();
}

function canDeleteClients() {
  return isSuperadminUser();
}

function canArchiveClients() {
  if (isSuperadminUser()) return true;
  return isLeadershipRole();
}

function canArchiveClient(clientEntry) {
  if (canArchiveClients()) return true;
  // Client owner (AM) can archive/unarchive their own clients
  return clientEntry?.owner_employee_id && clientEntry.owner_employee_id === state.currentEmployeeId;
}
