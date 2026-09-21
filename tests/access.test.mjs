// Tests for js/access.js role/permission predicates. Loaded into a vm context
// alongside config.js + utils.js (their globals are dependencies). The access
// functions read a global `state` and two app.js helpers
// (currentUserDepartmentName, employeeReportsToManager) — we inject a mutable
// `state` and stub those two, then drive each predicate by mutating state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object, RegExp, Boolean, Array });
for (const file of ['js/config.js', 'js/utils.js', 'js/access.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
// App-level deps the access module calls at runtime — stub them.
vm.runInContext(`
  var __dept = '';
  function currentUserDepartmentName() { return __dept; }
  function employeeReportsToManager(emp, mgrEmail) { return emp && emp.manager === mgrEmail; }
  var state = {};
`, ctx);

const call = (expr) => vm.runInContext(expr, ctx);
const setState = (s) => { ctx.state = s; vm.runInContext('null', ctx); };
const setDept = (d) => vm.runInContext(`__dept = ${JSON.stringify(d)}`, ctx);

// ── superadmin (SUPERADMIN_EMAIL = admin@youragency.com from config) ──
test('isSuperadminEmail matches only the superadmin', () => {
  assert.equal(call(`isSuperadminEmail('admin@youragency.com')`), true); // case-insensitive
  assert.equal(call(`isSuperadminEmail('strategy-lead@youragency.com')`), false);
  assert.equal(call(`isSuperadminEmail('')`), false);
});

test('isSuperadminUser reads from profile then session', () => {
  setState({ employeeProfile: { email: 'admin@youragency.com' } });
  assert.equal(call('isSuperadminUser()'), true);
  setState({ session: { user: { email: 'admin@youragency.com' } } });
  assert.equal(call('isSuperadminUser()'), true);
  setState({ employeeProfile: { email: 'strategy-lead@youragency.com' } });
  assert.equal(call('isSuperadminUser()'), false);
  assert.equal(call('canManageAccessRoles()'), false);
});

// ── role / dept ──
test('normalizeAccessLevel clamps unknowns to employee', () => {
  assert.equal(call(`normalizeAccessLevel('admin')`), 'admin');
  assert.equal(call(`normalizeAccessLevel('leadership')`), 'leadership');
  assert.equal(call(`normalizeAccessLevel('superhero')`), 'employee');
  assert.equal(call(`normalizeAccessLevel(undefined)`), 'employee');
});

test('getEnforcedAccessLevel falls back to the hardcoded map when no DB overrides', () => {
  setState({ accessOverrides: null });
  assert.equal(call(`getEnforcedAccessLevel('admin@youragency.com')`), 'admin');
  assert.equal(call(`getEnforcedAccessLevel('creative-lead@youragency.com')`), 'leadership');
  assert.equal(call(`getEnforcedAccessLevel('nobody@youragency.com')`), null);
});

test('getEnforcedAccessMap prefers DB overrides, falls back when empty', () => {
  // empty object → fallback to hardcoded constant
  setState({ accessOverrides: {} });
  assert.equal(call(`getEnforcedAccessLevel('admin@youragency.com')`), 'admin'); // from fallback
  // populated → DB overrides win (and can differ from the constant)
  setState({ accessOverrides: { 'newlead@youragency.com': 'leadership', 'admin@youragency.com': 'admin' } });
  assert.equal(call(`getEnforcedAccessLevel('newlead@youragency.com')`), 'leadership'); // DB-only entry
  assert.equal(call(`getEnforcedAccessLevel('creative-lead@youragency.com')`), null); // not in DB map, fallback NOT used since map non-empty
});

test('isLeadershipRole true for leadership and admin only', () => {
  setState({ role: 'leadership' }); assert.equal(call('isLeadershipRole()'), true);
  setState({ role: 'admin' }); assert.equal(call('isLeadershipRole()'), true);
  setState({ role: 'employee' }); assert.equal(call('isLeadershipRole()'), false);
});

test('isLeadershipOrAM covers leadership OR an AM-department employee', () => {
  setState({ role: 'employee', employeeProfile: { department: { name: 'AM' } } });
  assert.equal(call('isLeadershipOrAM()'), true);
  setState({ role: 'employee', employeeProfile: { department: { name: 'Account Management' } } });
  assert.equal(call('isLeadershipOrAM()'), true);
  setState({ role: 'employee', employeeProfile: { department: { name: 'Art' } } });
  assert.equal(call('isLeadershipOrAM()'), false);
  setState({ role: 'leadership', employeeProfile: { department: { name: 'Art' } } });
  assert.equal(call('isLeadershipOrAM()'), true);
  // canEditScopeCoverage delegates to it
  assert.equal(call('canEditScopeCoverage()'), call('isLeadershipOrAM()'));
});

test('canUploadAnalytics: any employee, not just leadership/AM (11 Aug 2026)', () => {
  setState({ role: 'employee', currentEmployeeId: 'emp-1', employeeProfile: { department: { name: 'Copy' } } });
  assert.equal(call('canUploadAnalytics()'), true);
  // no employee row (partner/hire/outsider session) → no upload UI
  setState({ role: 'partner', currentEmployeeId: null, employeeProfile: null });
  assert.equal(call('canUploadAnalytics()'), false);
});

// ── operational config accessors (app_config with per-key fallback) ──
test('getConfigList: DB value wins (normalized), else fallback constant', () => {
  setState({ appConfig: null });
  // fallback to HIDDEN_EMPLOYEE_EMAILS from config.js
  assert.deepEqual(call(`getHiddenEmployeeEmails()`), call('HIDDEN_EMPLOYEE_EMAILS'));
  // DB override wins and is lowercased
  setState({ appConfig: { hidden_employee_emails: ['NEW@youragency.com', 'two@youragency.com'] } });
  assert.deepEqual(call(`getHiddenEmployeeEmails()`), ['new@youragency.com', 'two@youragency.com']);
  // Empty array in DB → EMPTY, not fallback. This used to fall back "so a wipe
  // can't silently empty the list", but that made the LAST entry impossible to
  // remove: the save wrote [] and the next read resurrected the in-code
  // default, so Remove looked broken while the person kept their access. The
  // guard against an accidental wipe is the confirm dialog, not ignoring a
  // value the admin deliberately saved.
  setState({ appConfig: { hidden_employee_emails: [] } });
  assert.equal(call(`getHiddenEmployeeEmails().length`), 0);
});

test('getConfigMap: DB value wins, else fallback constant', () => {
  setState({ appConfig: null });
  assert.deepEqual(call(`getTeamManagerMap()`), call('TEAM_MANAGER_BY_TEAM'));
  setState({ appConfig: { team_manager_by_team: { AM: 'x@youragency.com' } } });
  assert.deepEqual(call(`getTeamManagerMap()`), { AM: 'x@youragency.com' });
  setState({ appConfig: { team_manager_by_team: {} } }); // explicitly empty → empty
  assert.equal(call(`Object.keys(getTeamManagerMap()).length`), 0);
});

// ── viewers ──
test('isInvoiceViewer: hardcoded — app_config can NEVER open it', () => {
  // Deliberate (23 Jul 2026): invoices are compensation data. Even a
  // config row granting someone access must change nothing.
  setState({ session: { user: { email: 'max@youragency.com' } },
             appConfig: { invoice_viewer_emails: ['max@youragency.com'] } });
  assert.equal(call('isInvoiceViewer()'), false);
});

test('isInvoiceViewer checks the email allowlist', () => {
  setState({ session: { user: { email: 'finance@youragency.com' } } });
  assert.equal(call('isInvoiceViewer()'), true);
  setState({ session: { user: { email: 'random@youragency.com' } } });
  assert.equal(call('isInvoiceViewer()'), false);
});

test('isDealFlowViewer = leadership only by default (fallback is empty)', () => {
  // Pure leadership (23 Jul 2026): the in-code fallback is [], so a
  // missing config key fails CLOSED. Extras exist only via the panel.
  setState({ role: 'employee', employeeProfile: { email: 'bd@youragency.com' } });
  assert.equal(call('isDealFlowViewer()'), false);
  setState({ role: 'employee', employeeProfile: { email: 'bd@youragency.com' },
             appConfig: { deal_flow_extra_emails: ['bd@youragency.com'] } });
  assert.equal(call('isDealFlowViewer()'), true); // panel grant still works
  setState({ role: 'employee', employeeProfile: { email: 'random@youragency.com' } });
  assert.equal(call('isDealFlowViewer()'), false);
  setState({ role: 'leadership', employeeProfile: { email: 'random@youragency.com' } });
  assert.equal(call('isDealFlowViewer()'), true);
});

test('isFinanceUser / canAccessTeamDashboard', () => {
  setDept('Finance');
  setState({ isAuthenticated: true, role: 'employee' });
  assert.equal(call('isFinanceUser()'), true);
  assert.equal(call('canAccessTeamDashboard()'), true); // finance gets in
  setDept('Art');
  setState({ isAuthenticated: true, role: 'employee' });
  assert.equal(call('canAccessTeamDashboard()'), false);
  setState({ isAuthenticated: true, role: 'leadership' });
  assert.equal(call('canAccessTeamDashboard()'), true); // leadership gets in
});

// ── tasks ──
test('canManageTask: leadership always, else own task only', () => {
  setState({ role: 'leadership', currentEmployeeId: 'me' });
  assert.equal(call(`canManageTask({ employee_id: 'someone' })`), true);
  setState({ role: 'employee', currentEmployeeId: 'me' });
  assert.equal(call(`canManageTask({ employee_id: 'me' })`), true);
  assert.equal(call(`canManageTask({ employee_id: 'someone' })`), false);
  assert.equal(call('canManageTask(null)'), false);
});

// ── clients ──
test('client permissions key off superadmin/leadership', () => {
  setState({ employeeProfile: { email: 'admin@youragency.com', full_name: 'Alex Morgan' }, role: 'admin' });
  assert.equal(call('canAddClients()'), true);   // name contains "admin"
  assert.equal(call('canDeleteClients()'), true); // superadmin
  assert.equal(call('canEditClients()'), true);
  setState({ employeeProfile: { email: 'strategy-lead@youragency.com', full_name: 'Sam Rivera' }, role: 'leadership' });
  assert.equal(call('canAddClients()'), false);   // not Alex
  assert.equal(call('canDeleteClients()'), false); // not superadmin
  assert.equal(call('canEditClients()'), true);   // leadership can edit
});

test('canArchiveClient: leadership OR the owning AM', () => {
  setState({ role: 'employee', currentEmployeeId: 'amY', employeeProfile: { email: 'x@youragency.com' } });
  assert.equal(call(`canArchiveClient({ owner_employee_id: 'amY' })`), true);  // owner
  assert.equal(call(`canArchiveClient({ owner_employee_id: 'other' })`), false);
  setState({ role: 'leadership', currentEmployeeId: 'amY', employeeProfile: { email: 'x@youragency.com' } });
  assert.equal(call(`canArchiveClient({ owner_employee_id: 'other' })`), true); // leadership
});

// ── setup approvers: Alex + Nadia only, NOT leadership-wide ──
test('isSetupApprover is exactly the two approvers, not all leadership', () => {
  const check = (email) => { setState({ employeeProfile: { email }, role: 'leadership' }); return call('isSetupApprover()'); };
  assert.equal(check('admin@youragency.com'), true);
  assert.equal(check('am-lead@youragency.com'), true);
  assert.equal(check('am-lead@youragency.com'), true); // normalized
  // Kira and Sam ARE leadership — activation grants client access, so
  // being leadership must not be enough.
  assert.equal(check('creative-lead@youragency.com'), false);
  assert.equal(check('strategy-lead@youragency.com'), false);
  assert.equal(check('max@youragency.com'), false);
  setState({});
  assert.equal(call('isSetupApprover()'), false);
});

test('setup approvers come from app_config when present', () => {
  setState({ employeeProfile: { email: 'creative-lead@youragency.com' }, appConfig: { setup_approver_emails: ['creative-lead@youragency.com'] } });
  assert.equal(call('isSetupApprover()'), true);
  // A MISSING key falls back to the in-code constant...
  setState({ employeeProfile: { email: 'admin@youragency.com' }, appConfig: {} });
  assert.equal(call('isSetupApprover()'), true);
  // ...an explicitly emptied list means nobody EXTRA — but the superadmin is
  // an unremovable floor, mirroring app.is_setup_approver() in the DB. Without
  // the floor, emptying the list would hide the Awaiting Setup panel from the
  // one person the DB still allows to act.
  setState({ employeeProfile: { email: 'admin@youragency.com' }, appConfig: { setup_approver_emails: [] } });
  assert.equal(call('isSetupApprover()'), true);
  setState({ employeeProfile: { email: 'creative-lead@youragency.com' }, appConfig: { setup_approver_emails: [] } });
  assert.equal(call('isSetupApprover()'), false);
});

test('ONBOARDING_DEPARTMENTS offers delivery teams only', () => {
  const teams = call('ONBOARDING_DEPARTMENTS');
  assert.deepEqual([...teams].sort(), ['AM', 'Art', 'Copy', 'Video']);
  // Leadership/Finance/Strategy must not be self-selectable at onboarding.
  for (const banned of ['Leadership', 'Finance', 'Strategy']) {
    assert.ok(!teams.includes(banned), `${banned} must not be self-selectable`);
  }
});

// ── config accessors: an explicitly EMPTY list is a configuration ──
// Regression: getConfigList fell back to the in-code default whenever the
// stored list was empty, so the last entry could never be removed — the save
// wrote [] and the next read resurrected the default. The Remove button looked
// dead AND the person kept their access, because the permission predicate
// reads the same accessor.
test('getConfigList honours an explicitly empty stored list', () => {
  setState({ appConfig: { deal_flow_extra_emails: [] } });
  assert.deepEqual(call(`getDealFlowExtraEmails()`), []);
  // ...and the permission that reads it must agree
  setState({ appConfig: { deal_flow_extra_emails: [] }, employeeProfile: { email: 'bd@youragency.com' }, role: 'employee' });
  assert.equal(call('isDealFlowViewer()'), false);
});

test('getConfigList still falls back when the key was never configured', () => {
  // Compare vm-realm to vm-realm: a cross-realm array fails deepStrictEqual on
  // its prototype even when the contents match.
  setState({ appConfig: {} });
  assert.deepEqual(call(`getDealFlowExtraEmails()`), call('DEAL_FLOW_EXTRA_EMAILS'));
  setState({});
  assert.deepEqual(call(`getDealFlowExtraEmails()`), call('DEAL_FLOW_EXTRA_EMAILS'));
  // wrong shape is not a configuration either
  setState({ appConfig: { deal_flow_extra_emails: 'bd@youragency.com' } });
  assert.deepEqual(call(`getDealFlowExtraEmails()`), call('DEAL_FLOW_EXTRA_EMAILS'));
});

test('emptying a list config removes the last entry for every list key', () => {
  for (const [key, fn] of [
    ['invoice_excluded_emails', 'getInvoiceExcludedEmails()'],
    ['hidden_employee_emails', 'getHiddenEmployeeEmails()'],
    ['deal_flow_extra_emails', 'getDealFlowExtraEmails()'],
    ['setup_approver_emails', 'getSetupApproverEmails()']
  ]) {
    setState({ appConfig: { [key]: [] } });
    assert.deepEqual(call(fn), [], `${key} did not honour an empty list`);
  }
});

test('getConfigMap honours an explicitly empty stored map', () => {
  setState({ appConfig: { team_manager_by_team: {} } });
  assert.deepEqual(call('getTeamManagerMap()'), {});
  setState({ appConfig: {} });
  assert.equal(call('Object.keys(getTeamManagerMap()).length > 0'), true); // falls back
});

// ── client scope follows employment type (1 Sep 2026) ──
// Holding scope rows used to be the whole test, so type and scope drifted: a
// fractional person moved to consultant stayed restricted, and a stale row kept
// a salaried employee out of the agency capacity average. The contract type is
// now the single source of truth — mirrors app.is_client_scoped() in the DB.
const scopedEmployee = (type) => {
  setState({ clientScopeByEmployee: new Map([['e1', new Set(['c1'])]]) });
  return { id: 'e1', employment_type: type };
};

test('only a fractional person counts as client-scoped', () => {
  const isScoped = call('isClientScoped');
  assert.equal(isScoped(scopedEmployee('fractional')), true);
  // Widening the contract releases the rows without deleting them, so flipping
  // back to fractional restores exactly the old client list.
  assert.equal(isScoped(scopedEmployee('consultant')), false);
  assert.equal(isScoped(scopedEmployee('full-time')), false);
});

test('capacity exclusion follows the same rule', () => {
  const excluded = call('isCapacityExcluded');
  assert.equal(excluded(scopedEmployee('fractional')), true);
  assert.equal(excluded(scopedEmployee('full-time')), false);
});

test('a fractional person with no scope rows is not capacity-excluded', () => {
  setState({ clientScopeByEmployee: new Map() });
  assert.equal(call('isClientScoped')({ id: 'e1', employment_type: 'fractional' }), false);
  // Client visibility is a separate question, and the DB fails closed on it:
  // app.can_see_client() shows a fractional person with no rows nothing at all.
});

// ── Circle: client-facing platform on its own host (7 Sep 2026) ───────────
test('the product name comes from the hostname, not the session', () => {
  // Host-based so the tab title and splash are right on first paint, before
  // anyone has signed in and we know who they are.
  assert.equal(call('productName')('clients.youragency.com'), 'Circle');
  assert.equal(call('productName')('CLIENTS.YOURAGENCY.COM'), 'Circle');
  assert.equal(call('productName')('app.youragency.com'), 'Colony');
  assert.equal(call('productName')('localhost'), 'Colony');
  assert.equal(call('productName')(''), 'Colony');
  // A lookalike host must not borrow the brand.
  assert.equal(call('productName')('clients.youragency.com.evil.com'), 'Colony');
  assert.equal(call('isCircleHost')('clients.youragency.com:8888'), true);   // port ignored
});

test('sessions are routed to their own door, and only when they need moving', () => {
  const f = call('homeHostFor');
  // A partner who came in the employee door gets sent to Circle.
  assert.equal(f('partner', 'app.youragency.com'), 'clients.youragency.com');
  // An employee who landed on Circle has no business there.
  assert.equal(f('employee', 'clients.youragency.com'), 'app.youragency.com');
  // Already home: null, so the caller never redirects for no reason.
  assert.equal(f('partner', 'clients.youragency.com'), null);
  assert.equal(f('employee', 'app.youragency.com'), null);
  // Candidates are Your Agency's own hiring flow — Colony, like any employee.
  assert.equal(f('hire', 'clients.youragency.com'), 'app.youragency.com');
  assert.equal(f('hire', 'app.youragency.com'), null);
  // Localhost and deploy previews are left alone or testing breaks.
  assert.equal(f('partner', 'localhost'), null);
  assert.equal(f('employee', 'main--youragency.netlify.app'), null);
});

// ── hiring crew: leadership + approvers + Leo/Blake, nobody else ───────
test('isHiringCrew: leadership, approvers and the legal/finance list only', () => {
  setState({ role: 'leadership', employeeProfile: { email: 'creative-lead@youragency.com' } });
  assert.equal(call('isHiringCrew()'), true);
  setState({ role: 'employee', employeeProfile: { email: 'am-lead@youragency.com' } });
  assert.equal(call('isHiringCrew()'), true);
  setState({ role: 'employee', employeeProfile: { email: 'finance@youragency.com' } });
  assert.equal(call('isHiringCrew()'), true);
  setState({ role: 'employee', employeeProfile: { email: 'leo@youragency.com' } });
  assert.equal(call('isHiringCrew()'), true);
  setState({ role: 'employee', employeeProfile: { email: 'rhea@youragency.com' } });
  assert.equal(call('isHiringCrew()'), false);
  setState({ role: 'partner', employeeProfile: { email: 'someone@client.com' } });
  assert.equal(call('isHiringCrew()'), false);
});
