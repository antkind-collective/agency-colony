// Live-database security invariants (16 Sep 2026, after two backup
// tables went out without RLS). These run against the real database through
// the Management API using the gitignored .env; where that is absent (CI, a
// fresh clone) they skip loudly rather than pretend.
//
// Each invariant is something the weekday audit also checks, but a test runs
// on every `npm test`, which is before every push.
import { test as nodeTest } from 'node:test';

// Run side by side (8 Oct 2026): ~62 Management API round trips one after
// another made this file take ~2 minutes of every `npm test`. Each check is
// independent (writes happen inside begin…rollback), so they are collected
// here and run as subtests of one parent, two at a time (four outran the
// API's 120-a-minute limit; see sql() below).
const queued = [];
const test = (name, opts, fn) => queued.push(typeof opts === 'function' ? [name, {}, opts] : [name, opts, fn]);
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const live = Boolean(env.SUPABASE_PROJECT_REF && env.SUPABASE_ACCESS_TOKEN);

// The Management API allows 120 requests per fixed 60-second window and says
// so on every response (x-ratelimit-remaining, x-ratelimit-reset in seconds;
// measured 26 Oct 2026). This file makes ~120 calls, so it used to run the
// window dry near the end, and the old ~54 s of short retries gave up just
// before the reset. Now a call waits out the window once it is nearly spent,
// and a 429 waits for the reset the API names (or backs off) and tries again.
const rate = { remaining: Infinity, resetAt: 0 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// A dead connection (the Mac sleeping mid-request) used to hang npm test for
// up to 90 min (2 + 5 Nov 2026). Each request now gives up after 30s, the
// body read included, and a timed-out or dropped request is retried once.
const API_TIMEOUT_MS = 30000;

// Every call to the Supabase Management API goes through here (sql() and the
// advisor / auth-config tests alike): 30s timeout, body read included, and one
// retry when the request times out or drops. The 6 Nov audit saw the advisor
// test's plain fetch fail 2 of 583 on a stalling network.
async function managementApi(path, { method = 'GET', json, what = path } = {}) {
  for (let netRetries = 0; ; netRetries++) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}${path}`, {
        method,
        headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      });
      const body = await res.json().catch((e) => { if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw e; return {}; });
      return { res, body };
    } catch (error) {
      if (netRetries < 1) continue;
      throw new Error(`Supabase API call failed after a retry (${error?.name || 'error'}: ${error?.message}): ${what}`);
    }
  }
}

async function sql(query) {
  for (let attempt = 0; ; attempt++) {
    if (rate.remaining <= 4 && Date.now() < rate.resetAt) await pause(rate.resetAt - Date.now() + 500);
    const { res, body } = await managementApi('/database/query', { method: 'POST', json: { query }, what: query.slice(0, 80) });
    const resetHeader = res.headers.get('x-ratelimit-reset') ?? res.headers.get('retry-after');
    const resetMs = resetHeader === null ? NaN : Number(resetHeader) * 1000;
    if (res.headers.has('x-ratelimit-remaining') && Number.isFinite(resetMs)) {
      rate.remaining = Number(res.headers.get('x-ratelimit-remaining'));
      rate.resetAt = Date.now() + resetMs;
    }
    const throttled = res.status === 429 || /too many requests/i.test(String(body.message || ''));
    if (throttled && attempt < 6) {
      const wait = Number.isFinite(resetMs) && resetMs > 0 ? resetMs + 1000 : 2000 * 2 ** attempt;
      Object.assign(rate, { remaining: 0, resetAt: Date.now() + wait });
      await pause(wait + Math.random() * 1000);
      continue;
    }
    if (!res.ok || body.message) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }
}

test('every table in schema app has row-level security enabled', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const rows = await sql("select tablename from pg_tables where schemaname='app' and not rowsecurity order by 1;");
  assert.deepEqual(rows.map((r) => r.tablename), [], 'tables without RLS');
});

test('anon has no way into schema app', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ usage }] = await sql("select has_schema_privilege('anon','app','usage') as usage;");
  assert.equal(usage, false, 'anon has USAGE on schema app');
  const tables = await sql("select distinct table_name from information_schema.role_table_grants where table_schema='app' and grantee='anon' order by 1;");
  assert.deepEqual(tables.map((r) => r.table_name), [], 'anon table grants');
  const fns = await sql("select p.proname from pg_proc p where p.pronamespace='app'::regnamespace and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') order by 1;");
  assert.deepEqual(fns.map((r) => r.proname), [], 'anon can execute SECURITY DEFINER functions');
});

// Internal helpers live in app_private, which signed-in users cannot reach
// (202609170005). 202609160001 had re-opened them with a blanket grant and a
// Circle partner could read a hire's address and rewrite any employee's setup
// (17 Sep 2026). The two crons stay in app, service_role only.
test('internal helpers sit in app_private, unreachable by signed-in users', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const internal = [
    'apply_employee_setup', 'hire_profile_seed', 'hire_manager_for_new_employee', 'hire_type_for_new_employee',
    'ensure_leave_cycle_record', 'archive_leave_cycle_row', 'mapped_access_level_for_email'
  ];
  const list = internal.map((n) => `'${n}'`).join(',');
  const [{ inPrivate, inApp, usage }] = await sql(`select
    (select count(*)::int from pg_proc where pronamespace='app_private'::regnamespace and proname in (${list})) "inPrivate",
    (select count(*)::int from pg_proc where pronamespace='app'::regnamespace and proname in (${list})) "inApp",
    (has_schema_privilege('authenticated','app_private','usage') or has_schema_privilege('anon','app_private','usage')) usage;`);
  assert.equal(inPrivate, internal.length, 'an internal helper is missing from app_private');
  assert.equal(inApp, 0, 'an internal helper is back in schema app, where the API can reach it');
  assert.equal(usage, false, 'anon/authenticated can reach schema app_private');
  const leaks = await sql("select p.proname from pg_proc p where p.pronamespace='app_private'::regnamespace and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'));");
  assert.deepEqual(leaks.map((r) => r.proname), [], 'app_private functions executable by anon/authenticated');
  const crons = await sql("select bool_and(has_function_privilege('service_role', p.oid, 'execute')) svc, bool_or(has_function_privilege('authenticated', p.oid, 'execute')) auth from pg_proc p where p.pronamespace='app'::regnamespace and p.proname in ('run_due_activations','rollover_all_leave_cycles');");
  assert.equal(crons[0].svc, true, 'service_role lost EXECUTE on a cron RPC');
  assert.equal(crons[0].auth, false, 'a cron RPC is callable by signed-in users');
});

// Helpers still in schema app that only other definer functions call (or
// nobody does): no signed-in grant. is_hiring_only_email answered a Circle
// client's "is this address on the hiring-only list?" until 24 Sep 2026
// (202609240001); the other six had no caller at all (S11, 202609240003).
test('definer helpers called only from other definer functions are not client-callable', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const internal = ['is_hiring_only_email', 'current_access_level', 'current_hire_id', 'is_allocated_to_org',
    'is_assigned_to_brief', 'is_client_scoped', 'update_my_profile'];
  const rows = await sql(`select p.proname from pg_proc p where p.pronamespace='app'::regnamespace and p.proname in (${internal.map((n) => `'${n}'`).join(',')}) and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'));`);
  assert.deepEqual(rows.map((r) => r.proname), [], 'an internal-only definer helper is callable by signed-in users');
  const [{ present }] = await sql(`select count(*)::int present from pg_proc where pronamespace='app'::regnamespace and proname in (${internal.map((n) => `'${n}'`).join(',')});`);
  assert.equal(present, internal.length, 'an internal helper was renamed or dropped — update this list');
  const [{ seed }] = await sql("select pg_get_functiondef('app.ensure_employee_profile()'::regprocedure) seed;");
  assert.match(seed, /app\.is_hiring_only_email\(/, 'ensure_employee_profile no longer calls is_hiring_only_email — re-check who does before changing grants');
});

// A partner's org is never assumed (S3, 202609240002): no column default, no
// blank org, and the Colony add bar neither pre-fills nor falls back to the client.
test('a partner org is never defaulted', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def, chk }] = await sql(`select
    (select column_default from information_schema.columns where table_schema='app' and table_name='partners' and column_name='org') def,
    (select pg_get_constraintdef(oid) from pg_constraint where conname='partners_org_not_blank' and conrelid='app.partners'::regclass) chk;`);
  assert.equal(def, null, `app.partners.org has a default again: ${def}`);
  assert.match(chk || '', /btrim\(org\)/, 'partners_org_not_blank check is missing');
});

// Closed by default, enforced by the database (202609170005): new functions
// carry no PUBLIC EXECUTE, new tables get RLS, and the guard_access_ddl event
// trigger aborts any DDL that leaves an undeclared SECURITY DEFINER function
// callable, or opens app_private.
test('access is closed by default and the guard trigger is armed', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ evt, publicDefault }] = await sql(`select
    (select evtenabled from pg_event_trigger where evtname='guard_access_ddl') evt,
    exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) a
            where d.defaclrole='postgres'::regrole and d.defaclnamespace=0 and d.defaclobjtype='f'
              and a.grantee=0 and a.privilege_type='EXECUTE') "publicDefault";`);
  assert.equal(evt, 'O', 'guard_access_ddl event trigger missing or disabled');
  // No global default row at all means Postgres's implicit PUBLIC EXECUTE is back.
  const [{ hasRow }] = await sql("select exists (select 1 from pg_default_acl where defaclrole='postgres'::regrole and defaclnamespace=0 and defaclobjtype='f') \"hasRow\";");
  assert.equal(hasRow, true, 'global default ACL for functions was removed (PUBLIC EXECUTE is implicit again)');
  assert.equal(publicDefault, false, 'new functions are executable by PUBLIC by default');
  const undeclared = await sql(`select app_private.fn_signature(p.oid) sig from pg_proc p
    where p.pronamespace='app'::regnamespace and p.prosecdef and p.prorettype <> 'trigger'::regtype
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
      and not exists (select 1 from app_private.callable_definer_functions c where c.signature = app_private.fn_signature(p.oid));`);
  assert.deepEqual(undeclared.map((r) => r.sig), [], 'callable SECURITY DEFINER functions not declared in app_private.callable_definer_functions');
});

// Definer RPCs the client calls must ask who is calling. Both of these trusted
// any signed-in token — a Circle partner read employees' leave through one and
// could reset an employee's onboarding through the other (17 Sep 2026).
test('client-called definer RPCs check the caller', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ whos, spawn }] = await sql("select pg_get_functiondef('app.home_whos_out(date,date)'::regprocedure) whos, pg_get_functiondef('app.spawn_onboarding_checklist(uuid)'::regprocedure) spawn;");
  assert.match(whos, /app\.is_employee\(\)/, 'home_whos_out no longer scopes rows to employees');
  assert.match(spawn, /IF NOT app\.is_leadership_or_admin\(\)/, 'spawn_onboarding_checklist lost its leadership-or-self guard');
  assert.match(spawn, /auth_user_id = auth\.uid\(\)/, 'spawn_onboarding_checklist lost the new-joiner self path');
});

// The client SLA is per org: a second client must never read the client's contract
// turnaround (17 Sep 2026, 202609170004).
test('client_sla is scoped to the partner\'s own org', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ nullable, pk }] = await sql("select (select is_nullable from information_schema.columns where table_schema='app' and table_name='client_sla' and column_name='org') nullable, (select pg_get_constraintdef(oid) from pg_constraint where conname='client_sla_pkey') pk;");
  assert.equal(nullable, 'NO', 'client_sla.org missing or nullable');
  assert.match(pk, /org/, 'client_sla primary key no longer includes org');
  const pols = await sql("select policyname, cmd, coalesce(qual,'') q from pg_policies where schemaname='app' and tablename='client_sla' and cmd in ('SELECT','ALL');");
  for (const p of pols) {
    assert.ok(!/is_partner\(\)/.test(p.q), `${p.policyname} lets every partner read every org: ${p.q}`);
  }
  assert.ok(pols.some((p) => /current_partner_org\(\)/.test(p.q)), 'no client_sla policy scopes partners to their org');
});

test('salary and hire data stay behind is_hiring_crew', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const pols = await sql("select tablename, policyname, cmd, coalesce(qual,'') q, coalesce(with_check,'') w from pg_policies where schemaname='app' and tablename in ('hire_offer_terms','hires') order by 1,2;");
  for (const p of pols) {
    const text = `${p.q} ${p.w}`;
    const ok = /is_hiring_crew\(\)/.test(text) || /is_setup_approver\(\)/.test(text) || /is_leadership_or_admin\(\)/.test(text) || /auth_user_id = auth\.uid\(\)/.test(text);
    assert.ok(ok, `${p.tablename}.${p.policyname} (${p.cmd}) is not gated by hiring crew/approver/leadership/self: ${text}`);
  }
  assert.ok(pols.some((p) => p.tablename === 'hire_offer_terms'), 'hire_offer_terms has no policies at all');
});

// The section column was dropped on 14 Jun 2026 but New Deal and Revive kept
// sending it, so both failed for five months (11 Nov). Every key the
// browser writes to deals must be a real column.
test('Deal Flow writes only columns that exist on deals', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const insert = src.match(/async function createNewDeal[\s\S]*?\.insert\(\{([\s\S]*?)\}\)/)?.[1];
  const revive = src.match(/async function reviveDeal[\s\S]*?\.update\(\{([^}]*)\}\)/)?.[1];
  assert.ok(insert && revive, 'could not find the New Deal insert or the Revive update in app.js');
  const keys = [...insert.split(','), ...revive.split(',')].map((part) => part.split(':')[0].trim()).filter(Boolean);
  const rows = await sql("select column_name from information_schema.columns where table_schema='app' and table_name='deals';");
  const columns = new Set(rows.map((r) => r.column_name));
  assert.deepEqual(keys.filter((k) => !columns.has(k)), [], 'app.js writes columns deals does not have');
});

// logNotification only logs a failed insert to the console, so a kind missing
// from the enum loses its rows silently, and the once-only checks in the notify
// functions can't see them (client_archived and deal_contracted, S24).
test('every notification kind the functions log exists in the enum', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const dir = new URL('../netlify/functions/', import.meta.url);
  const sources = [...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => new URL(f, dir)),
    ...readdirSync(new URL('lib/', dir)).filter((f) => f.endsWith('.js')).map((f) => new URL(`lib/${f}`, dir))].map((u) => readFileSync(u, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const kinds = new Set(sources.flatMap((s) => [...s.matchAll(/\bkind:\s*'([a-z_]+)'/g)].map((m) => m[1])));
  // client-status-notify logs under its RECIPIENTS keys (kind: type).
  const recipients = readFileSync(new URL('client-status-notify.js', dir), 'utf8').match(/const RECIPIENTS = \{([\s\S]*?)\n\};/)?.[1];
  assert.ok(recipients, 'RECIPIENTS not found in client-status-notify.js');
  for (const m of recipients.matchAll(/^\s*([a-z_]+):/gm)) kinds.add(m[1]);
  assert.ok(kinds.size > 20, `only found ${kinds.size} kinds; has the scan broken?`);
  const rows = await sql("select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='notification_kind';");
  const labels = new Set(rows.map((r) => r.enumlabel));
  assert.deepEqual([...kinds].filter((k) => !labels.has(k)), [], 'kinds missing from app.notification_kind');
});

test('the Security Advisor reports no ERROR-level lint', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const { res, body } = await managementApi('/advisors/security');
  assert.ok(res.ok, `advisor API answered HTTP ${res.status}`);
  const lints = body.lints || body;
  const errors = (Array.isArray(lints) ? lints : []).filter((l) => l.level === 'ERROR').map((l) => `${l.name}: ${l.metadata?.schema}.${l.metadata?.name}`);
  assert.deepEqual(errors, [], 'advisor errors');
});

// A partner's inserts take the partner's org from the server, not the payload
// or the 'Example Collective' column default (17 Sep 2026, 202609170006).
test('partner inserts into org_contacts and briefs are forced to the partner org', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const rows = await sql("select c.relname tbl from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid where p.proname='force_partner_org' and c.relnamespace='app'::regnamespace and t.tgenabled <> 'D' order by 1;");
  assert.deepEqual(rows.map((r) => r.tbl), ['briefs', 'org_contacts']);
});

// A colleague's home address and emergency contact: themselves or leadership
// only (21 Sep 2026, 202609210001). RLS is row-level, so this is a column
// privilege — a re-grant of table-wide SELECT would silently reopen it.
test('employee address and emergency contact are not selectable by authenticated', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const rows = await sql("select column_name c, has_column_privilege('authenticated','app.employees',column_name,'SELECT') sel from information_schema.columns where table_schema='app' and table_name='employees';");
  const priv = new Set(['personal_address', 'emergency_contact_name', 'emergency_contact_phone', 'date_of_birth']);
  for (const r of rows) {
    if (priv.has(r.c)) assert.equal(r.sel, false, `authenticated can SELECT employees.${r.c}`);
  }
  assert.ok(rows.filter((r) => priv.has(r.c)).length === 4, 'a private employee column is missing');
  assert.ok(rows.some((r) => r.c === 'birthday_md' && r.sel), 'the Birthdays panel lost birthday_md');
  assert.ok(rows.some((r) => r.c === 'full_name' && r.sel), 'the directory columns lost their SELECT grant');
  const [{ def }] = await sql("select pg_get_functiondef('app.employee_private_details(uuid)'::regprocedure) def;");
  assert.match(def, /e\.id = app\.current_employee_id\(\) or app\.is_leadership_or_admin\(\)/, 'employee_private_details lost its self-or-leadership guard');
});

// Raw client analytics exports follow the client_analytics table: a
// client-scoped (fractional) employee reads only their clients' files, and
// only analytics uploaders write or delete them (25 Sep 2026, 202609250001;
// before it, is_employee() alone let asha@ download all 140 files).
test('client-analytics storage is scoped like the client_analytics table', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const pols = await sql("select policyname, cmd, coalesce(qual,'') q, coalesce(with_check,'') w from pg_policies where schemaname='storage' and tablename='objects' and (coalesce(qual,'') || coalesce(with_check,'')) like '%client-analytics%' order by 1;");
  assert.deepEqual(pols.map((p) => p.cmd).sort(), ['DELETE', 'INSERT', 'SELECT'], 'unexpected client-analytics storage policies');
  for (const p of pols) {
    const text = `${p.q} ${p.w}`;
    assert.match(text, /can_see_client\(/, `${p.policyname} is not scoped by can_see_client: ${text}`);
    if (p.cmd !== 'SELECT') assert.match(text, /is_analytics_uploader\(\)/, `${p.policyname} lets non-uploaders write: ${text}`);
  }
});

// Employees write their own allocations, to any client by name (28 Sep 2026
// audit). An allocation must only open a client's briefs to someone who may
// see that client, or a client-scoped fractional self-allocates her way in.
test('allocation-based brief access respects client scope', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def }] = await sql("select pg_get_functiondef('app.is_allocated_to_org(text)'::regprocedure) as def;");
  assert.match(def, /can_see_client\(/, 'is_allocated_to_org counts allocations to clients the caller cannot see');
});

// A client's stakeholder contacts, logins and SLA follow client scope (5 Oct
// 2026 audit, 202610050001): with is_employee() alone, asha@ (Save Missing
// Girls only) read Example Collective's contacts, all client logins and its SLA.
test('org contacts, partners and client SLA are scoped for employees by can_see_org', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const pols = await sql("select policyname, qual from pg_policies where schemaname='app' and policyname in ('org_contacts_select','partners_select_employees','client_sla_select') order by 1;");
  assert.equal(pols.length, 3, 'expected the three employee read policies');
  for (const p of pols) {
    assert.match(p.qual, /can_see_org\(org\)/, `${p.policyname} is not scoped by can_see_org: ${p.qual}`);
    assert.doesNotMatch(p.qual, /is_employee\(\)/, `${p.policyname} still lets every employee read every org: ${p.qual}`);
  }
  const [{ def }] = await sql("select pg_get_functiondef('app.can_see_org(text)'::regprocedure) as def;");
  assert.match(def, /can_see_client\(/, 'can_see_org must follow can_see_client for fractionals');
});

// S14 closed (5 Oct 2026, 202610050002): with is_employee() alone, a
// fractional scoped to one client read all 25 projects and every allocation.
test('projects and allocations are scoped by client for fractionals', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const pols = await sql("select policyname, qual from pg_policies where schemaname='app' and cmd='SELECT' and tablename in ('projects','allocations') order by 1;");
  const byName = Object.fromEntries(pols.map((p) => [p.policyname, p.qual]));
  assert.deepEqual(Object.keys(byName).sort(), ['allocations_select_all_authenticated', 'projects_select_all'], 'unexpected SELECT policies on projects/allocations');
  assert.match(byName.projects_select_all, /can_see_client\(client_id\)/, 'projects are not scoped by can_see_client');
  assert.match(byName.allocations_select_all_authenticated, /can_see_project\(project_id\)/, 'allocations are not scoped by can_see_project');
  const [{ def }] = await sql("select pg_get_functiondef('app.can_see_project(uuid)'::regprocedure) as def;");
  assert.match(def, /can_see_client\(/, 'can_see_project must follow can_see_client');
});

// S16 closed (6 Oct 2026, 202610060002): Colony's wall showed the client's posts to
// every employee. Among staff a client post is the superadmin's alone.
test('client feedback posts are readable and writable by no employee but the superadmin', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const pols = await sql("select policyname, coalesce(qual,'') || ' ' || coalesce(with_check,'') as rule from pg_policies where schemaname='app' and policyname in ('feature_requests_select_all','feature_requests_update_own_or_leadership','feature_requests_delete_own_or_leadership','feature_request_replies_select_all','feature_request_replies_insert_own') order by 1;");
  assert.equal(pols.length, 5, 'expected the five employee wall policies');
  for (const p of pols) {
    assert.match(p.rule, /is_superadmin\(\)/, `${p.policyname} does not reserve client posts for the superadmin: ${p.rule}`);
    assert.match(p.rule, /author_partner_id IS NULL/i, `${p.policyname} does not separate internal posts from client posts: ${p.rule}`);
  }
});

// S17 (6 Oct 2026, 202610060003): partners read deliverables only through
// partner_brief_deliverables(), which hides the Drive link until delivered
// and never returns the assignee.
test('clients cannot see work-in-progress Drive links or assignees on deliverables', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [pol] = await sql("select qual from pg_policies where schemaname='app' and policyname='brief_deliverables_select';");
  assert.ok(pol, 'brief_deliverables_select is missing');
  assert.doesNotMatch(pol.qual, /partner/i, `partners can read brief_deliverables directly again: ${pol.qual}`);
  const [{ def }] = await sql("select pg_get_functiondef('app.partner_brief_deliverables()'::regprocedure) as def;");
  assert.match(def, /null::uuid AS assignee_employee_id/i, 'partner_brief_deliverables returns the assignee');
  // Since 21 Oct 2026 (pieces) a client sees a piece only once it is shared,
  // so the link is filtered with the row rather than nulled per column.
  assert.match(def, /d\.status = 'delivered'/i, 'partner_brief_deliverables returns pieces or links before delivery');
  assert.match(def, /partner_can_access_brief\(/, 'partner_brief_deliverables is not limited to the caller\'s org');
});

// 11 Oct 2026 (202610110001): a task's project_id was checked nowhere, so a
// fractional could pin a task to another client's project.
test('a task can only point at a project the caller can see', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const pols = await sql("select policyname, with_check from pg_policies where schemaname='app' and tablename='daily_tasks' and cmd in ('INSERT','UPDATE') order by 1;");
  assert.equal(pols.length, 2, 'expected one insert and one update policy on daily_tasks');
  for (const p of pols) {
    assert.match(p.with_check || '', /can_see_project\(project_id\)/, `${p.policyname} does not check the project: ${p.with_check}`);
  }
  const [{ def }] = await sql("select pg_get_functiondef('app.create_daily_task(date,text,uuid,app.task_status,text,text,date)'::regprocedure) as def;");
  assert.match(def, /can_see_project\(p_project_id\)/, 'create_daily_task (SECURITY DEFINER) does not check the project');
});

// Audit 6 Oct 2026 (202610060001): with is_employee() alone, a fractional
// read every colleague's task for every client (asha@: 5,997 tasks, 21 other
// clients). The tag check must stay once-per-query: per row it took ~90 s.
test('colleagues\' tasks are scoped by client for fractionals', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const pols = await sql("select policyname, qual from pg_policies where schemaname='app' and tablename='daily_tasks' and cmd='SELECT';");
  assert.deepEqual(pols.map((p) => p.policyname), ['daily_tasks_select_all_authenticated'], 'unexpected SELECT policies on daily_tasks');
  const q = pols[0].qual;
  assert.match(q, /\(\s*SELECT app\.sees_every_client\(\)/i, 'daily_tasks lost the once-per-query full-time shortcut');
  assert.match(q, /\(\s*SELECT app\.my_task_tags\(\)/i, 'daily_tasks is not scoped by my_task_tags (once per query)');
  const [{ def }] = await sql("select pg_get_functiondef('app.my_task_tags()'::regprocedure) as def;");
  assert.match(def, /can_see_client\(/, 'my_task_tags must follow can_see_client');
});

// Sign-in may only return to hosts Your Agency controls (25 Sep 2026, S12).
// `*.netlify.app` let any stranger's netlify.app page receive a session; the
// Email provider was an unused second door.
test('auth redirects go only to Your Agency hosts, and sign-in is Google only', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const { res, body: cfg } = await managementApi('/config/auth');
  assert.ok(res.ok, `auth config API answered HTTP ${res.status}`);
  const allowed = [/^https:\/\/(colony|circle)\.youragency\.com(\/\*\*)?$/, /^https:\/\/deploy-preview-\*--youragency\.netlify\.app\/\*\*$/, /^http:\/\/localhost:\d+\/\*\*$/];
  for (const u of String(cfg.uri_allow_list || '').split(',').filter(Boolean)) {
    assert.ok(allowed.some((re) => re.test(u.trim())), `redirect allow-list entry is not an Your Agency host: ${u}`);
  }
});

// citext lives in `extensions` (S8, 202609240005). Every pinned search_path
// that names `public` must also name `extensions`, or `email = $1` silently
// becomes a case-sensitive text compare.
test('citext is out of public and every function can still find it', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ schema, stale }] = await sql("select (select extnamespace::regnamespace::text from pg_extension where extname='citext') schema, (select count(*)::int from pg_proc p, unnest(p.proconfig) c where p.pronamespace in ('app'::regnamespace,'app_private'::regnamespace) and c like 'search_path=%public%' and c not like '%extensions%') stale;");
  assert.equal(schema, 'extensions');
  assert.equal(stale, 0, 'a function pins search_path with public but without extensions');
});

// Brief viewers read, never write (27 Sep 2026). can_work_brief gates every
// brief write, so a viewer folded back into it would silently regain edit
// rights on every client's briefs.
test('brief viewers are read-only: can_work_brief excludes them, reads use can_view_brief', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ work, view }] = await sql("select pg_get_functiondef('app.can_work_brief(uuid)'::regprocedure) as work, pg_get_functiondef('app.can_view_brief(uuid)'::regprocedure) as view;");
  assert.ok(!/is_brief_viewer/.test(work), 'can_work_brief must not include brief viewers');
  assert.match(view, /is_brief_viewer/);
  const writes = await sql("select c.relname || '.' || p.polname as pol from pg_policy p join pg_class c on c.oid = p.polrelid where p.polcmd in ('a','w','d') and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~ 'can_view_brief';");
  assert.deepEqual(writes, [], 'no write policy may use can_view_brief');
});

// Allocations belong to a real client (27 Sep 2026). The writers once filed
// every name under a synthetic "Internal" client and later recreated
// client-named projects there; brief access and the home card's top client
// both went wrong for two weeks unnoticed. Internal is gone; an unknown name
// now stops the save (app_private.resolve_client_project).
test('there is no "Internal" client, and the allocation writers never create one', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const rows = await sql("select name from app.clients where lower(btrim(name)) = 'internal';");
  assert.deepEqual(rows, [], 'no client may be called Internal');
  const fns = await sql("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app','app_private') and p.prokind = 'f' and pg_get_functiondef(p.oid) ilike '%''Internal''%';");
  assert.deepEqual(fns, [], 'no function may look up or create an Internal client');
});

// Streak rewards (27 Sep 2026): only the cron grants them. A signed-in person
// who could write this table could award themselves leave.
test('streak_rewards: RLS on, signed-in users may read but never write', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ rls }] = await sql("select relrowsecurity as rls from pg_class where oid = 'app.streak_rewards'::regclass;");
  assert.equal(rls, true);
  const writes = await sql("select privilege_type from information_schema.role_table_grants where table_schema = 'app' and table_name = 'streak_rewards' and grantee in ('authenticated','anon') and privilege_type <> 'SELECT';");
  assert.deepEqual(writes, []);
  const pols = await sql("select polname from pg_policy where polrelid = 'app.streak_rewards'::regclass and polcmd <> 'r';");
  assert.deepEqual(pols, []);
});

// S14 tightening (28 Sep 2026): saving an allocation resolves only clients the
// caller can see, so a scoped fractional cannot create projects under — or
// confirm the name of — a client outside their scope.
test('resolve_client_project only matches clients the caller can see', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def }] = await sql("select pg_get_functiondef('app_private.resolve_client_project(text)'::regprocedure) as def;");
  const hits = (def.match(/can_see_client/g) || []).length;
  assert.ok(hits >= 2, 'both the project lookup and the client lookup must filter by app.can_see_client');
});

test('streak_leave_ranges gives employees leave DATES only, and no one else anything', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def, result }] = await sql(`select pg_get_functiondef('app.streak_leave_ranges(date)'::regprocedure) as def,
    pg_get_function_result('app.streak_leave_ranges(date)'::regprocedure) as result;`);
  assert.match(def, /app\.is_employee\(\)/, 'must return nothing to partners and hiring-only logins');
  assert.match(def, /status = 'approved'/, 'approved leave only');
  // Colleagues may learn THAT someone was away, never why: no type, reason or status.
  assert.equal(result, 'TABLE(employee_id uuid, start_date date, end_date date)');
  const [{ anon }] = await sql("select has_function_privilege('anon','app.streak_leave_ranges(date)','execute') as anon;");
  assert.equal(anon, false);
});

test('home_briefs_delivered gives employees a count per client, never titles', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def, result }] = await sql(`select pg_get_functiondef('app.home_briefs_delivered(date)'::regprocedure) as def,
    pg_get_function_result('app.home_briefs_delivered(date)'::regprocedure) as result;`);
  assert.match(def, /app\.is_employee\(\)/, 'partners and hiring-only logins get nothing');
  // Audit 29 Sep 2026 (202609290001): a scoped fractional saw other clients' counts.
  assert.match(def, /can_see_client\(/, 'counts must be limited to clients the caller can see');
  assert.equal(result, 'TABLE(org text, delivered integer, last_day date)');
  const [{ anon }] = await sql("select has_function_privilege('anon','app.home_briefs_delivered(date)','execute') as anon;");
  assert.equal(anon, false);
});

// Audit 9 Oct 2026 (202610090001): the secret page's definer RPC read past RLS,
// so asha@ (2 clients) got all 14 clients' start dates and headcounts and the
// top words of every colleague's tasks.
test('secret_page_stats follows client scope for fractionals', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def }] = await sql("select pg_get_functiondef('app.secret_page_stats()'::regprocedure) as def;");
  assert.match(def, /app\.is_employee\(\)/, 'partners and hiring-only logins get nothing');
  const words = def.slice(def.indexOf('words as'), def.indexOf('hours as'));
  assert.match(words, /my_task_tags\(\)/, 'task words must come only from tasks the caller can read');
  const rivers = def.slice(def.indexOf('rivers as'));
  assert.match(rivers, /can_see_client\(c\.id\)/, 'client rivers must be limited to clients the caller can see');
  const [{ anon }] = await sql("select has_function_privilege('anon','app.secret_page_stats()','execute') as anon;");
  assert.equal(anon, false);
});

test('streak_freezes: employees read, nobody writes except use_streak_freeze (caller only)', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ rls }] = await sql("select relrowsecurity as rls from pg_class where oid = 'app.streak_freezes'::regclass;");
  assert.equal(rls, true);
  const [{ ins, upd, del }] = await sql(`select has_table_privilege('authenticated','app.streak_freezes','insert') ins,
    has_table_privilege('authenticated','app.streak_freezes','update') upd, has_table_privilege('authenticated','app.streak_freezes','delete') del;`);
  assert.deepEqual([ins, upd, del], [false, false, false]);
  const [{ def }] = await sql("select pg_get_functiondef('app.use_streak_freeze(date)'::regprocedure) as def;");
  assert.match(def, /app\.current_employee_id\(\)/, 'writes for the caller only');
  assert.match(def, /task_activity/, 'refuses a day the caller already worked');
  const [{ anon }] = await sql("select has_function_privilege('anon','app.use_streak_freeze(date)','execute') as anon;");
  assert.equal(anon, false);
});

// A kind missing from the enum makes logNotification's insert fail silently:
// invoice_all_received (its "sent already?" check never matched, so repeats)
// and birthday_notification (never logged) went unnoticed for weeks (30 Sep).
test('every notification kind the functions log exists in app.notification_kind', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const { readdirSync } = await import('node:fs');
  const dir = fileURLToPath(new URL('../netlify/functions/', import.meta.url));
  const files = [...readdirSync(dir).map((f) => dir + f), ...readdirSync(dir + 'lib').map((f) => `${dir}lib/${f}`)].filter((f) => f.endsWith('.js'));
  const kinds = new Set();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/logNotification\(\{[\s\S]{0,60}?\bkind:\s*'([a-z_]+)'/g)) kinds.add(m[1]);
  const [{ vals }] = await sql("select enum_range(null::app.notification_kind)::text[] as vals;");
  const missing = [...kinds].filter((k) => !vals.includes(k)).sort();
  assert.deepEqual(missing, [], 'kinds logged in code but missing from app.notification_kind');
});

// Stage history is the database's job (202609300002): changes made outside
// Colony's screens (Cowork threads, SQL) left no history before.
test('deal stage changes are recorded by trigger, one open row per stage', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ trg }] = await sql("select count(*)::int as trg from pg_trigger where tgrelid = 'app.deals'::regclass and tgname = 'trg_deals_stage_history' and tgenabled <> 'D';");
  assert.equal(trg, 1, 'trg_deals_stage_history missing or disabled');
  const [{ idx }] = await sql("select count(*)::int as idx from pg_indexes where schemaname = 'app' and indexname = 'deal_stage_history_one_open';");
  assert.equal(idx, 1);
  const { readFileSync: read } = await import('node:fs');
  const app = read(fileURLToPath(new URL('../app.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(app, /from\('deal_stage_history'\)\.insert/, 'app.js must not write stage history; the trigger does');
});

// Audit 30 Sep 2026 (202609300003): a plain employee could change their own
// email, and is_brief_reviewer / is_invoice_viewer / is_superadmin match on
// employees.email. The self-escalation trigger now resets it.
test('an employee cannot change their own email', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [emp] = await sql(`select auth_user_id, email::text as email from app.employees
    where is_active and access_level = 'employee' and auth_user_id is not null order by email limit 1;`);
  assert.ok(emp, 'need one active plain employee to impersonate');
  const claims = JSON.stringify({ sub: emp.auth_user_id, email: emp.email, role: 'authenticated' }).replace(/'/g, "''");
  const [after] = await sql(`begin;
    select set_config('request.jwt.claims', '${claims}', true);
    set local role authenticated;
    update app.employees set email = 'self-edit-probe@youragency.com' where auth_user_id = auth.uid();
    select email::text as email from app.employees where auth_user_id = auth.uid();
    rollback;`);
  assert.equal(after.email, emp.email, 'self update must not change email');
  const [{ def }] = await sql("select pg_get_functiondef('app.trg_block_employee_self_escalation'::regproc) as def;");
  assert.match(def, /NEW\.email := OLD\.email/);
});

// Access parity (audit 13 Oct 2026): "Joined Your Agency" is leadership's to set
// in the profile editor, so the DB must refuse a self-edit of it, of the
// activation date Home shows, and of the role label.
test('an employee cannot change their own joined, activated or role-title fields', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [emp] = await sql(`select auth_user_id, email::text as email, joined_on::text as joined_on,
      activated_at::text as activated_at, role_title from app.employees
    where is_active and access_level = 'employee' and auth_user_id is not null order by email limit 1;`);
  assert.ok(emp, 'need one active plain employee to impersonate');
  const claims = JSON.stringify({ sub: emp.auth_user_id, email: emp.email, role: 'authenticated' }).replace(/'/g, "''");
  const [after] = await sql(`begin;
    select set_config('request.jwt.claims', '${claims}', true);
    set local role authenticated;
    update app.employees set joined_on = '2000-01-01', activated_at = '2000-01-01', role_title = 'Leadership'
      where auth_user_id = auth.uid();
    select joined_on::text as joined_on, activated_at::text as activated_at, role_title
      from app.employees where auth_user_id = auth.uid();
    rollback;`);
  assert.equal(after.joined_on, emp.joined_on, 'self update must not change joined_on');
  assert.equal(after.activated_at, emp.activated_at, 'self update must not change activated_at');
  assert.equal(after.role_title, emp.role_title, 'self update must not change role_title');
});

// Access parity (audit 20 Oct 2026): "Reports To" is leadership's to set in the
// profile editor, and the manager may mark leave approved (mark_leave_for), so
// an employee must not be able to name their own manager through the API.
test('an employee cannot change their own manager', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [emp] = await sql(`select auth_user_id, email::text as email, direct_manager_email::text as mgr from app.employees
    where is_active and access_level = 'employee' and auth_user_id is not null order by email limit 1;`);
  assert.ok(emp, 'need one active plain employee to impersonate');
  const claims = JSON.stringify({ sub: emp.auth_user_id, email: emp.email, role: 'authenticated' }).replace(/'/g, "''");
  const [after] = await sql(`begin;
    select set_config('request.jwt.claims', '${claims}', true);
    set local role authenticated;
    update app.employees set direct_manager_email = 'self-edit-probe@youragency.com' where auth_user_id = auth.uid();
    select direct_manager_email::text as mgr from app.employees where auth_user_id = auth.uid();
    rollback;`);
  assert.equal(after.mgr, emp.mgr, 'self update must not change direct_manager_email');
});

// Self-write sweep (audit 20 Oct 2026): own-row update policies say WHOSE row,
// not WHICH columns. An assignee cannot move a deliverable to another brief, an
// employee's wall reply cannot be re-pointed at a client's post (an unfiltered
// PATCH skips the SELECT re-check), and an invoice row must name a file in the
// caller's own folder.
test('self-writes cannot move deliverables, wall replies or invoice files', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [emp] = await sql(`select e.id, e.auth_user_id, e.email::text as email from app.employees e
    where e.is_active and e.access_level = 'employee' and e.auth_user_id is not null
      and not exists (select 1 from app.access_overrides o where lower(o.email::text) = lower(e.email::text))
      and lower(e.email::text) not in (select lower(x) from app.app_config c, jsonb_array_elements_text(c.value) x where c.key = 'brief_reviewer_emails')
    order by e.email limit 1;`);
  const [other] = await sql(`select id from app.employees where is_active and id <> '${emp.id}' order by email limit 1;`);
  const [post] = await sql(`select id from app.feature_requests where author_partner_id is not null limit 1;`);
  const [briefs] = await sql(`select (select id from app.briefs order by created_at limit 1) as a, (select id from app.briefs order by created_at desc limit 1) as b;`);
  assert.ok(emp && other && post && briefs.a, 'need an employee, a colleague, a client post and a brief');
  const claims = JSON.stringify({ sub: emp.auth_user_id, email: emp.email, role: 'authenticated' }).replace(/'/g, "''");
  const attempt = (k, stmt) => `do $$ begin ${stmt}; insert into _o values ('${k}', 'allowed'); exception when others then insert into _o values ('${k}', 'refused: ' || sqlerrm); end $$;`;
  const rows = await sql(`begin;
    create temp table _o(k text, v text) on commit drop; grant all on _o to authenticated;
    insert into app.brief_deliverables (id, brief_id, title, deliverable_type, status, assignee_employee_id)
      values ('00000000-0000-0000-0000-0000000000d1', '${briefs.a}', 'probe', 'probe', 'queued', '${emp.id}');
    insert into app.feature_requests (id, employee_id, request_text, status) values ('00000000-0000-0000-0000-0000000000f1', '${emp.id}', 'probe', 'requested');
    insert into app.feature_request_replies (id, feature_request_id, employee_id, reply_text) values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', '${emp.id}', 'probe');
    select set_config('request.jwt.claims', '${claims}', true);
    set local role authenticated;
    ${attempt('deliv_title', "update app.brief_deliverables set title = 'moved' where id = '00000000-0000-0000-0000-0000000000d1'")}
    ${attempt('deliv_status', "update app.brief_deliverables set status = 'in_progress' where id = '00000000-0000-0000-0000-0000000000d1'")}
    ${attempt('reply_move', `update app.feature_request_replies set feature_request_id = '${post.id}'`)}
    ${attempt('post_author_name', "update app.feature_requests set author_name = 'Someone else' where id = '00000000-0000-0000-0000-0000000000f1'")}
    ${attempt('post_text', "update app.feature_requests set request_text = 'edited' where id = '00000000-0000-0000-0000-0000000000f1'")}
    ${attempt('invoice_other_folder', `insert into app.invoices (employee_id, invoice_month, file_name, file_path, file_size_bytes) values ('${emp.id}', '2026-10', 'x.pdf', '${other.id}/2026-10/x.pdf', 1)`)}
    ${attempt('invoice_own_folder', `insert into app.invoices (employee_id, invoice_month, file_name, file_path, file_size_bytes) values ('${emp.id}', to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM'), 'x.pdf', '${emp.id}/m/x.pdf', 1)`)}
    ${attempt('invoice_backdated', `insert into app.invoices (employee_id, invoice_month, file_name, file_path, file_size_bytes) values ('${emp.id}', to_char(now() - interval '45 days', 'YYYY-MM'), 'x.pdf', '${emp.id}/m/x.pdf', 1)`)}
    ${attempt('invoice_future', `insert into app.invoices (employee_id, invoice_month, file_name, file_path, file_size_bytes) values ('${emp.id}', to_char(now() + interval '45 days', 'YYYY-MM'), 'x.pdf', '${emp.id}/m/x.pdf', 1)`)}
    reset role;
    select k, v from _o;
    rollback;`);
  const got = Object.fromEntries(rows.map((r) => [r.k, r.v.split(':')[0]]));
  assert.deepEqual(got, {
    // deliv_status: since 21 Oct 2026 a piece's stage moves by itself (owners
    // mark their part done; leads and AMs approve), so nobody sets it directly.
    deliv_title: 'refused', deliv_status: 'refused', reply_move: 'refused', post_author_name: 'refused',
    post_text: 'allowed', invoice_other_folder: 'refused', invoice_own_folder: 'allowed',
    // 3 Nov 2026 (audit): an own invoice is filed under the current month only.
    invoice_backdated: 'refused', invoice_future: 'refused',
  });
});

// The old onboarding checklist was retired 8 Oct 2026; its spawn RPC has no
// caller, so signed-in users cannot run it (audit 13 Oct 2026).
test('the retired onboarding checklist RPC is not callable by signed-in users', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ ok }] = await sql("select has_function_privilege('authenticated', 'app.spawn_onboarding_checklist(uuid)', 'execute') as ok;");
  assert.equal(ok, false);
});

// the client answers a delivery (30 Sep 2026): approve or ask for changes, nothing else.
test('from delivered a partner may only approve or request a revision', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def }] = await sql("select pg_get_functiondef('app.guard_partner_brief_update()'::regprocedure) as def;");
  assert.match(def, /new\.status not in \('under_revision', 'completed'\)/);
  const [{ c }] = await sql("select pg_get_expr(polwithcheck, polrelid) as c from pg_policy where polrelid = 'app.briefs'::regclass and polname = 'briefs_update_partner';");
  assert.match(c, /'completed'::app\.brief_status/);
  assert.doesNotMatch(c, /'delivered'::app\.brief_status|'in_creative'::app\.brief_status/, 'partners must never set Your Agency-side statuses');
});

// Your Agency's own brief fields are not a client's to write (audit 1 Oct 2026):
// pause flag, created_at and locks; and a delivered answer changes status only.
test('partners cannot write pause, created_at or locks on a brief', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [p] = await sql(`select p.id, p.email::text as email, u.id as uid from app.partners p
    join auth.users u on lower(u.email) = lower(p.email::text)
    where p.is_active and p.partner_role in ('submitter', 'coordinator') and p.org = 'Example Collective'
    order by p.email limit 1;`);
  assert.ok(p, 'need one active the client partner with a sign-in');
  const claims = JSON.stringify({ sub: p.uid, email: p.email, role: 'authenticated' }).replace(/'/g, "''");
  // Runs in one transaction that always raises, so nothing commits; the
  // message carries the outcome of each attempt.
  const run = async () => {
    try {
      await sql(`begin;
        create temp table _o(k text, v text) on commit drop;
        grant all on _o to authenticated;
        set local role authenticated;
        select set_config('request.jwt.claims', '${claims}', true);
        do $$
        declare v_id uuid; v text;
        begin
          insert into app.briefs(title, request_type, org, submitted_by_partner_id, paused_at, pause_reason, created_at, locked_at)
            values ('invariant probe', 'brief', 'Example Collective', '${p.id}', now(), 'probe', '2020-01-01', now())
            returning id, concat_ws(',', paused_at is not null, locked_at is not null, created_at < '2021-01-01') into v_id, v;
          insert into _o values ('insert_kept_staff_fields', v);
          begin
            update app.briefs set paused_at = now(), created_at = '2020-01-01' where id = v_id;
            insert into _o values ('update_staff_fields', 'allowed');
          exception when others then insert into _o values ('update_staff_fields', 'refused');
          end;
          -- Your Agency delivers it: as postgres, with no client claims.
          reset role;
          perform set_config('request.jwt.claims', '', true);
          update app.briefs set status = 'delivered' where id = v_id;
          perform set_config('request.jwt.claims', '${claims}', true);
          set local role authenticated;
          begin
            update app.briefs set status = 'completed', priority = 'P0' where id = v_id;
            insert into _o values ('delivered_side_field', 'allowed');
          exception when others then insert into _o values ('delivered_side_field', 'refused');
          end;
          update app.briefs set status = 'completed' where id = v_id;
          get diagnostics v = row_count;
          insert into _o values ('plain_approve_rows', v);
        end $$;
        reset role;
        do $x$ begin raise exception 'RESULT %', (select json_object_agg(k, v) from _o); end $x$;`);
    } catch (e) {
      const m = String(e.message).match(/RESULT (\{.*?\})/);
      if (!m) throw e;
      return JSON.parse(m[1]);
    }
    throw new Error('probe did not raise');
  };
  const r = await run();
  assert.equal(r.insert_kept_staff_fields, 'f,f,f', 'a partner insert must start unpaused, unlocked, dated now');
  assert.equal(r.update_staff_fields, 'refused', 'a partner must not pause or backdate a brief');
  assert.equal(r.delivered_side_field, 'refused', 'answering a delivery changes status only');
  assert.equal(r.plain_approve_rows, '1', 'Approve delivery must still work');
});

// Fixed-term contracts (6 Oct 2026): the end date lives on the crew-only
// offer terms, and the database refuses one for a full-time hire.
test('contract end dates: crew-only table, never on a full-time hire', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ col }] = await sql("select count(*)::int as col from information_schema.columns where table_schema='app' and table_name='hire_offer_terms' and column_name='contract_end_date';");
  assert.equal(col, 1);
  const [{ trg }] = await sql("select count(*)::int as trg from pg_trigger where tgrelid='app.hire_offer_terms'::regclass and tgname='trg_hire_contract_end_check' and tgenabled <> 'D';");
  assert.equal(trg, 1, 'trg_hire_contract_end_check missing or disabled');
  const [{ def }] = await sql("select pg_get_functiondef('app_private.hire_contract_end_check()'::regprocedure) as def;");
  assert.match(def, /full-time/);
});

// Activate threw "cannot cast type hire_type to employment_type" for every
// hire (9 Oct 2026): two enums with the same labels need a text hop.
// Audit 12 Oct 2026 (Alex: "paused should not be read by everyone"):
// 202610070009 granted the pause columns to every signed-in user, so every
// colleague saw who was paused and why. Leadership reads them through
// employee_access_pauses(); the columns are closed (202610120002).
test('who is paused, and why, is readable by leadership only', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def }] = await sql("select pg_get_functiondef('app.employee_access_pauses()'::regprocedure) as def;");
  assert.match(def, /app\.is_leadership_or_admin\(\)/, 'employee_access_pauses must return nothing to non-leadership');
  const [{ anon }] = await sql("select has_function_privilege('anon','app.employee_access_pauses()','execute') as anon;");
  assert.equal(anon, false);
  const cols = await sql("select column_name c from information_schema.columns where table_schema='app' and table_name='employees' and column_name like 'access_pause%' and has_column_privilege('authenticated','app.employees',column_name,'SELECT');");
  assert.deepEqual(cols.map((r) => r.c), [], 'authenticated can SELECT a pause column on app.employees');
});

// Pin the cast, and when a joiner is waiting, activate them as their hiring
// manager inside a rolled-back transaction.
test('activating a hire works (hire_type to employment_type via text)', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def }] = await sql("select pg_get_functiondef('app.activate_hire(uuid,date)'::regprocedure) as def;");
  assert.doesNotMatch(def, /hire_type\s*,\s*'full-time'\s*\)\s*::\s*app\.employment_type/, 'cast hire_type to text before employment_type');
  const waiting = await sql(`select h.id, u.id as uid, lower(t.hiring_manager_email) as mgr
    from app.hires h join app.hire_offer_terms t on t.hire_id = h.id
    join app.employees e on lower(e.email::text) = lower(h.work_email) and e.is_active and e.setup_pending
    join app.employees m on lower(m.email::text) = lower(t.hiring_manager_email)
    join auth.users u on u.id = m.auth_user_id
    where h.stage in ('signed', 'payroll_done') limit 1;`);
  if (!waiting.length) return;
  const w = waiting[0];
  const rows = await sql(`begin; set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${w.uid}","email":"${w.mgr}","role":"authenticated"}', true);
    select app.activate_hire('${w.id}') as r; rollback;`);
  assert.equal(rows[0]?.r, 'activated');
});

// Briefs archive (13 Oct 2026): only reviewers move a brief in or out, and a
// deleted brief is hidden from the client.
test('briefs archive: guarded, and hidden from partners', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ trg }] = await sql("select count(*)::int as trg from pg_trigger where tgrelid='app.briefs'::regclass and tgname='trg_guard_brief_archive' and tgenabled <> 'D';");
  assert.equal(trg, 1, 'trg_guard_brief_archive missing or disabled');
  const [{ q }] = await sql("select pg_get_expr(polqual, polrelid) as q from pg_policy where polrelid='app.briefs'::regclass and polname='briefs_select';");
  assert.match(q, /archived_at IS NULL/, 'partners must not see deleted briefs');
  const [{ def }] = await sql("select pg_get_functiondef('app.guard_partner_brief_update()'::regprocedure) as def;");
  assert.match(def, /archived_at is distinct from/, 'partners must not archive or restore');
});

// 14 Oct audit: a deleted brief's child rows (history, comments, files,
// deliverables) are closed to the client too. Archive the sample inside a
// rolled-back transaction and read as a the client partner.
test('a client cannot read an archived brief\'s history', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def }] = await sql("select pg_get_functiondef('app.partner_can_access_brief(uuid)'::regprocedure) as def;");
  assert.match(def, /archived_at is null/);
  const [p] = await sql(`select u.id as uid, lower(p.email) as email, b.id as brief from app.partners p
    join auth.users u on lower(u.email) = lower(p.email)
    join app.briefs b on b.org = p.org and b.archived_at is null
    join app.brief_status_history h on h.brief_id = b.id
    where p.is_active limit 1;`);
  if (!p) return;
  const rows = await sql(`begin; update app.briefs set archived_at = now() where id = '${p.brief}';
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${p.uid}","email":"${p.email}","role":"authenticated"}', true);
    select (select count(*) from app.brief_status_history where brief_id = '${p.brief}')::int as n; rollback;`);
  assert.equal(rows[0]?.n, 0);
});

// 14 Oct 2026 (Alex): only leadership names a hire's hiring manager, who can
// then activate the hire. Crew who are not leadership keep the other terms.
test('only leadership can set a hire\'s hiring manager', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  // finance@ is the crew member who is not leadership (the case the audit found).
  const [c] = await sql(`select u.id as uid, lower(e.email::text) as email, (select hire_id from app.hire_offer_terms limit 1) as hire
    from app.employees e join auth.users u on u.id = e.auth_user_id
    where e.is_active and lower(e.email::text) = 'finance@youragency.com' limit 1;`);
  if (!c?.hire) return;
  await assert.rejects(sql(`begin; set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${c.uid}","email":"${c.email}","role":"authenticated"}', true);
    update app.hire_offer_terms set hiring_manager_email = '${c.email}' where hire_id = '${c.hire}'; rollback;`), /Only leadership can choose the hiring manager/);
});

// 14 Oct 2026 (Alex): only a person's own manager can mark them out.
test('only their manager can mark someone out', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [p] = await sql(`select t.id as target, mu.id as m_uid, lower(m.email::text) as m_email, ou.id as o_uid, lower(o.email::text) as o_email
    from app.employees t
    join app.employees m on lower(m.email::text) = lower(t.direct_manager_email) and m.is_active
    join auth.users mu on mu.id = m.auth_user_id
    join app.employees o on o.is_active and o.id <> m.id and o.id <> t.id and lower(o.email::text) <> lower(coalesce(t.direct_manager_email, ''))
      and not (lower(o.email::text) = any (select lower(x::text) from unnest(t.approver_emails) x))
    join auth.users ou on ou.id = o.auth_user_id
    where t.is_active and coalesce(t.leave_tracking_enabled, true) limit 1;`);
  if (!p) return;
  const as = (uid, email, q) => `begin; set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${uid}","email":"${email}","role":"authenticated"}', true); ${q}; rollback;`;
  const ok = await sql(as(p.m_uid, p.m_email, `select status::text from app.mark_leave_for('${p.target}', 'SL', '2030-01-07', '2030-01-07')`));
  assert.equal(ok[0]?.status, 'approved');
  await assert.rejects(sql(as(p.o_uid, p.o_email, `select status from app.mark_leave_for('${p.target}', 'SL', '2030-01-07', '2030-01-07')`)), /Only their manager/);
});

// Audit 19 Oct 2026: an employee could insert their own leave already
// approved, or set marked_by_employee_id themselves to skip the SL
// certificate rule. Only pending, unmarked rows go in by the direct path.
test('an employee cannot self-approve leave or mark it as their manager', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [emp] = await sql(`select e.auth_user_id, lower(e.email::text) as email from app.employees e
    where e.is_active and e.access_level = 'employee' and e.auth_user_id is not null
      and coalesce(e.leave_tracking_enabled, true) and e.access_paused_at is null order by e.email limit 1;`);
  assert.ok(emp, 'need one active plain employee with leave tracking');
  const as = (q) => `begin; set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${emp.auth_user_id}","email":"${emp.email}","role":"authenticated"}', true); ${q}; rollback;`;
  await assert.rejects(sql(as(`insert into app.leave_requests(employee_id, leave_type, start_date, end_date, status, decided_by_employee_id, decided_at)
    values (app.current_employee_id(), 'CL', '2030-12-02', '2030-12-02', 'approved', app.current_employee_id(), now())`)), /row-level security/);
  await assert.rejects(sql(as(`insert into app.leave_requests(employee_id, leave_type, start_date, end_date, marked_by_employee_id)
    values (app.current_employee_id(), 'SL', '2030-12-09', '2030-12-11', app.current_employee_id())`)), /row-level security/);
  const ok = await sql(as(`insert into app.leave_requests(employee_id, leave_type, start_date, end_date)
    values (app.current_employee_id(), 'CL', '2030-12-16', '2030-12-16') returning status::text as status`));
  assert.equal(ok[0]?.status, 'pending');
});

// Audit 19 Oct 2026: a wall post (staff or client) could be inserted already
// closed, so a client post never reached Alex's until-fixed reminder.
test('a new Bugs & Features or feedback post always starts as requested', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [emp] = await sql(`select auth_user_id, lower(email::text) as email from app.employees
    where is_active and access_level = 'employee' and auth_user_id is not null and access_paused_at is null order by email limit 1;`);
  const [par] = await sql(`select u.id as auth_user_id, lower(p.email::text) as email from app.partners p
    join auth.users u on lower(u.email) = lower(p.email::text) where p.is_active order by p.email limit 1;`);
  assert.ok(emp && par, 'need an active employee and an active partner');
  const as = (who, q) => `begin; set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${who.auth_user_id}","email":"${who.email}","role":"authenticated"}', true); ${q}; rollback;`;
  await assert.rejects(sql(as(emp, `insert into app.feature_requests(employee_id, request_text, status)
    values (app.current_employee_id(), 'audit probe', 'done')`)), /row-level security/);
  await assert.rejects(sql(as(par, `insert into app.feature_requests(author_partner_id, request_text, status)
    values (app.current_partner_id(), 'audit probe', 'done')`)), /row-level security/);
  const ok = await sql(as(par, `insert into app.feature_requests(author_partner_id, request_text)
    values (app.current_partner_id(), 'audit probe') returning status::text as status`));
  assert.equal(ok[0]?.status, 'requested');
});

// Audit 26 Oct 2026: a piece's link is an <a href> in Colony and on Circle.
// The API took a javascript: URL from its owner, and owners could change the
// link after the client had it (202610260001).
test('a piece link is https only, and its owner cannot change it once delivered', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [emp] = await sql(`select e.id, e.auth_user_id, e.email::text as email from app.employees e
    where e.is_active and e.access_paused_at is null and e.access_level = 'employee' and e.auth_user_id is not null
      and not exists (select 1 from app.access_overrides o where lower(o.email::text) = lower(e.email::text))
      and lower(e.email::text) not in (select lower(x) from app.app_config c, jsonb_array_elements_text(c.value) x where c.key = 'brief_reviewer_emails')
    order by e.email limit 1;`);
  const [brief] = await sql(`select id from app.briefs order by created_at limit 1;`);
  assert.ok(emp && brief, 'need an employee and a brief');
  const claims = JSON.stringify({ sub: emp.auth_user_id, email: emp.email, role: 'authenticated' }).replace(/'/g, "''");
  const attempt = (k, stmt) => `do $$ begin ${stmt}; insert into _o values ('${k}', 'allowed'); exception when others then insert into _o values ('${k}', 'refused: ' || sqlerrm); end $$;`;
  const piece = "'00000000-0000-0000-0000-0000000000d2'";
  const rows = await sql(`begin;
    create temp table _o(k text, v text) on commit drop; grant all on _o to authenticated;
    insert into app.brief_deliverables (id, brief_id, title, deliverable_type, needs_design, design_assignee_id)
      values (${piece}, '${brief.id}', 'probe', 'probe', true, '${emp.id}');
    select set_config('request.jwt.claims', '${claims}', true);
    set local role authenticated;
    ${attempt('script_link', `update app.brief_deliverables set delivery_url = 'javascript:alert(1)' where id = ${piece}`)}
    ${attempt('https_link', `update app.brief_deliverables set delivery_url = 'https://drive.google.com/x' where id = ${piece}`)}
    reset role;
    select set_config('request.jwt.claims', '', true);
    update app.brief_deliverables set status = 'delivered' where id = ${piece};
    select set_config('request.jwt.claims', '${claims}', true);
    set local role authenticated;
    ${attempt('change_after_delivery', `update app.brief_deliverables set delivery_url = 'https://example.com/y' where id = ${piece}`)}
    reset role;
    select k, v from _o;
    rollback;`);
  const got = Object.fromEntries(rows.map((r) => [r.k, r.v.split(':')[0]]));
  assert.deepEqual(got, { script_link: 'refused', https_link: 'allowed', change_after_delivery: 'refused' });
});

nodeTest('live database invariants', { concurrency: 2 }, async (t) => {
  await Promise.all(queued.map(([name, opts, fn]) => t.test(name, opts, fn)));
});

// 21 Oct 2026: a new date for the client is set only by the brief reviewers
// list and Alex, not all leadership; links follow the brief file rules
// (a client adds working links only and sees delivered ones after delivery).
test('only the reviewers and Alex set a new client date; links follow file rules', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [b] = await sql(`select id from app.briefs where archived_at is null and status not in ('delivered','completed') and request_type = 'brief' order by created_at limit 1;`);
  const [rev] = await sql(`select e.auth_user_id as uid, lower(e.email::text) as email from app.employees e
    where e.is_active and e.access_paused_at is null and e.auth_user_id is not null
      and lower(e.email::text) in (select lower(jsonb_array_elements_text(value)) from app.app_config where key = 'brief_reviewer_emails') limit 1;`);
  const [lead] = await sql(`select e.auth_user_id as uid, lower(e.email::text) as email from app.employees e
    where e.is_active and e.access_paused_at is null and e.auth_user_id is not null and e.access_level <> 'employee'
      and lower(e.email::text) <> 'admin@youragency.com'
      and lower(e.email::text) not in (select lower(jsonb_array_elements_text(value)) from app.app_config where key = 'brief_reviewer_emails') limit 1;`);
  const [pt] = await sql(`select p.auth_user_id as uid, lower(p.email) as email from app.partners p join app.briefs b on b.org = p.org
    where b.id = '${b?.id}' and p.is_active and p.auth_user_id is not null and p.partner_role in ('submitter','coordinator') limit 1;`);
  assert.ok(b && rev && lead && pt, 'need an open brief, a reviewer, a non-reviewer leader and a client');
  const as = (u, q) => `begin; set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${u.uid}","email":"${u.email}","role":"authenticated"}', true); ${q}; rollback;`;
  const ok = await sql(as(rev, `update app.briefs set revised_deadline = '2030-01-07' where id = '${b.id}' returning revised_deadline::text as d, revised_deadline_by is not null as by`));
  assert.equal(ok[0]?.d, '2030-01-07');
  assert.equal(ok[0]?.by, true);
  await assert.rejects(sql(as(lead, `update app.briefs set revised_deadline = '2030-01-07' where id = '${b.id}'`)), /can set a new date/);
  await assert.rejects(sql(as(pt, `insert into app.brief_links(brief_id, folder, url, added_by_partner_id) values ('${b.id}', 'delivered', 'https://example.com/a', app.current_partner_id())`)), /row-level security/);
  const seen = await sql(as(rev, `insert into app.brief_links(brief_id, folder, url, added_by_employee_id) values ('${b.id}', 'delivered', 'https://example.com/d', app.current_employee_id());
    select set_config('request.jwt.claims', '{"sub":"${pt.uid}","email":"${pt.email}","role":"authenticated"}', true);
    select count(*)::int as n from app.brief_links where brief_id = '${b.id}' and folder = 'delivered'`));
  assert.equal(seen[0]?.n, 0);
  await assert.rejects(sql(as(rev, `insert into app.brief_links(brief_id, folder, url, added_by_employee_id) values ('${b.id}', 'ga', 'https://example.com/twice', app.current_employee_id());
    insert into app.brief_links(brief_id, folder, url, added_by_employee_id) values ('${b.id}', 'ga', 'https://example.com/twice', app.current_employee_id())`)), /already on this brief/);
});

// 21 Oct 2026: brief pieces. A lead may mark a part not needed; an owner may
// not; a piece must need copy or design.
test('pieces: leads mark parts not needed, owners cannot, and never both', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def }] = await sql("select pg_get_functiondef('app_private.guard_brief_deliverable_update()'::regprocedure) as def;");
  assert.match(def, /Only the creative leads and account managers change what a piece needs/);
  assert.match(def, /A piece needs copy, design or both/);
  assert.match(def, /Only the creative leads and account managers assign people/);
  const [pol] = await sql("select qual from pg_policies where schemaname='app' and policyname='brief_deliverables_update';");
  assert.match(pol.qual, /is_creative_lead\(brief_id\)/);
});

// 21 Oct 2026: a brief that reaches Your Agency gets one piece per requested
// deliverable (caption / content calendar copy only); the button is for
// brief reviewers only.
test('pieces are prefilled when a brief reaches Your Agency; the button is reviewers only', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [rev] = await sql(`select e.auth_user_id as uid, lower(e.email::text) as email from app.employees e
    where e.is_active and e.access_paused_at is null and e.auth_user_id is not null
      and lower(e.email::text) in (select lower(jsonb_array_elements_text(value)) from app.app_config where key = 'brief_reviewer_emails') limit 1;`);
  const [emp] = await sql(`select e.auth_user_id as uid, lower(e.email::text) as email from app.employees e
    where e.is_active and e.access_level = 'employee' and e.auth_user_id is not null
      and lower(e.email::text) not in (select lower(jsonb_array_elements_text(value)) from app.app_config where key = 'brief_reviewer_emails') limit 1;`);
  const [{ org }] = await sql(`select org from app.partners where org is not null limit 1;`);
  const as = (u, q) => `begin; set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${u.uid}","email":"${u.email}","role":"authenticated"}', true); ${q}; rollback;`;
  const rows = await sql(as(rev, `insert into app.briefs(id, title, request_type, status, org, submitted_by_employee_id, requested_deliverables, deadline)
      values ('00000000-0000-0000-0000-0000000000b9', 'probe', 'brief', 'ready_for_review', '${org}', app.current_employee_id(), array['caption','carousel'], '2030-01-07');
    select title, needs_copy, needs_design from app.brief_deliverables where brief_id = '00000000-0000-0000-0000-0000000000b9' order by title`));
  assert.deepEqual(rows.map((r) => [r.title, r.needs_copy, r.needs_design]), [['Caption', true, false], ['Carousel', true, true]]);
  await assert.rejects(sql(as(emp, `select app.prefill_brief_pieces('00000000-0000-0000-0000-0000000000b9')`)), /Only the account managers/);
});

// 22 Oct 2026: NDAs. The team reads; nobody writes directly; the link's hash
// is never readable; non-crew read nothing.
test('ndas: crew-only reads, no direct writes, the link hash hidden', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [p] = await sql(`select has_table_privilege('authenticated','app.ndas','insert') ins, has_table_privilege('authenticated','app.ndas','update') upd,
    has_table_privilege('authenticated','app.ndas','delete') del, has_column_privilege('authenticated','app.ndas','intake_token_hash','select') hash,
    has_table_privilege('anon','app.ndas','select') anon;`);
  assert.deepEqual(p, { ins: false, upd: false, del: false, hash: false, anon: false });
  const [emp] = await sql(`select e.auth_user_id as uid, lower(e.email::text) as email from app.employees e
    where e.is_active and e.auth_user_id is not null
      and lower(e.email::text) not in (select lower(jsonb_array_elements_text(value)) from app.app_config where key = 'nda_crew_emails') limit 1;`);
  const rows = await sql(`begin; insert into app.ndas(id, with_name, purpose) values ('00000000-0000-0000-0000-0000000000d7','probe','probe');
    set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${emp.uid}","email":"${emp.email}","role":"authenticated"}', true);
    select count(*)::int n from app.ndas; rollback;`);
  assert.equal(rows[0].n, 0);
});

// 26 Oct 2026: a repeat mark-out put Carmen on leave twice for the same day.
test('leave that overlaps existing leave is refused', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def }] = await sql("select pg_get_functiondef('app_private.guard_leave_overlap()'::regprocedure) as def;");
  assert.match(def, /There is already leave on these dates/);
  const [t] = await sql("select count(*)::int n from pg_trigger where tgrelid = 'app.leave_requests'::regclass and tgname = 'trg_leave_requests_no_overlap';");
  assert.equal(t.n, 1);
  const [e] = await sql(`select id from app.employees where is_active and coalesce(leave_tracking_enabled, true) limit 1;`);
  await assert.rejects(sql(`begin; insert into app.leave_requests(employee_id, leave_type, start_date, end_date, status) values ('${e.id}', 'CL', '2031-02-03', '2031-02-04', 'approved');
    insert into app.leave_requests(employee_id, leave_type, start_date, end_date, status) values ('${e.id}', 'CL', '2031-02-04', '2031-02-04', 'pending'); rollback;`), /already leave/);
});

// Audit 27 Oct 2026: the guard ran on insert only, so moving one's own pending
// leave onto other leave (an own-row update the UI never sends) got past it.
test('moving leave onto existing leave is refused too', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [t] = await sql("select pg_get_triggerdef(oid) def from pg_trigger where tgrelid = 'app.leave_requests'::regclass and tgname = 'trg_leave_requests_no_overlap';");
  assert.match(t.def, /BEFORE INSERT OR UPDATE OF start_date, end_date, is_half_day, status, employee_id/);
  const [e] = await sql(`select id from app.employees where is_active and coalesce(leave_tracking_enabled, true) limit 1;`);
  await assert.rejects(sql(`begin; insert into app.leave_requests(employee_id, leave_type, start_date, end_date, status) values ('${e.id}', 'CL', '2031-03-03', '2031-03-03', 'pending');
    insert into app.leave_requests(id, employee_id, leave_type, start_date, end_date, status) values ('00000000-0000-0000-0000-0000000027a2', '${e.id}', 'CL', '2031-03-05', '2031-03-05', 'pending');
    update app.leave_requests set start_date = '2031-03-03', end_date = '2031-03-03' where id = '00000000-0000-0000-0000-0000000027a2'; rollback;`), /already leave/);
});

// Audit 27 Oct 2026: every employee may update analytics rows (the insight
// cache), so who uploaded a report and its client are pinned by a trigger.
test('an analytics report cannot be re-attributed or moved to another client', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [a] = await sql(`select a.id, e.auth_user_id uid, lower(e.email::text) email from app.client_analytics a
    join app.employees e on e.is_active and e.auth_user_id is not null and e.access_paused_at is null and e.id <> a.uploaded_by and e.employment_type::text <> 'fractional'
    where a.uploaded_by is not null limit 1;`);
  const as = `set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${a.uid}","email":"${a.email}","role":"authenticated"}', true);`;
  await assert.rejects(sql(`begin; ${as} update app.client_analytics set uploaded_by = (select id from app.employees where id <> app.current_employee_id() and is_active limit 1) where id = '${a.id}'; rollback;`), /uploaded by you/);
  await assert.rejects(sql(`begin; ${as} update app.client_analytics set client_id = (select id from app.clients where id <> (select client_id from app.client_analytics where id = '${a.id}') limit 1) where id = '${a.id}'; rollback;`), /stays with its client/);
  const ok = await sql(`begin; ${as} update app.client_analytics set insights_cache = insights_cache, uploaded_by = app.current_employee_id() where id = '${a.id}' returning id; rollback;`);
  assert.equal(ok.length, 1);
});

// 26 Oct 2026 (Alex, S20): no fractional employee has NDA access, even if
// someone adds them to nda_crew_emails.
test('fractional employees never get NDA access', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [{ def }] = await sql("select pg_get_functiondef('app.is_nda_crew()'::regprocedure) as def;");
  assert.match(def, /employment_type::text <> 'fractional'/);
  const rows = await sql(`select e.email from app.employees e
    where e.employment_type::text = 'fractional'
      and lower(e.email) in (select lower(jsonb_array_elements_text(value)) from app.app_config where key = 'nda_crew_emails');`);
  assert.deepEqual(rows, []);
});

// 28 Oct 2026 (Alex): Blake (accounts) reads everyone's leave BALANCES,
// this year and last, and nothing else: no one else's leave requests, and a
// regular employee is still refused the balances. A look back never creates
// leave-year records.
test('leave viewers read balances only; everyone else is refused', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [viewer] = await sql(`select auth_user_id as uid, email from app.employees
    where is_active and lower(email) in (select lower(jsonb_array_elements_text(value)) from app.app_config where key = 'leave_viewer_emails') limit 1;`);
  assert.ok(viewer, 'leave_viewer_emails names an active employee');
  const [plain] = await sql(`select e.auth_user_id as uid, e.email from app.employees e
    where e.is_active and e.auth_user_id is not null and lower(e.email) = 'maya@youragency.com' limit 1;`);
  const as = (p) => `set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${p.uid}","email":"${p.email}","role":"authenticated"}', true);`;
  const ids = `(select array_agg(id) from app.employees where is_active)`;
  const [before] = await sql('select count(*)::int as n from app.employee_leave_cycles;');
  const [v] = await sql(`begin; ${as(viewer)} select jsonb_array_length(app.get_leave_summaries_for_employees(${ids}, current_date)) as now_n,
    jsonb_array_length(app.get_leave_summaries_for_employees(${ids}, (app.leave_cycle_start(current_date) - 1))) as last_n,
    (select count(*) from app.leave_requests where employee_id <> app.current_employee_id())::int as others; rollback;`);
  assert.ok(v.now_n > 0 && v.last_n > 0, 'this year and last year both read');
  assert.equal(v.others, 0, 'no one else\'s leave requests');
  const [after] = await sql('select count(*)::int as n from app.employee_leave_cycles;');
  assert.equal(after.n, before.n, 'a look back creates no leave-year records');
  if (plain) {
    await assert.rejects(sql(`begin; ${as(plain)} select app.get_leave_summaries_for_employees(${ids}, current_date); rollback;`), /Access denied/);
  }
});

// 28 Oct 2026 (Alex): pay is private. A person reads only their own salary
// slips; Finance reads everyone's invoices and slips only behind the emailed
// code, and only in the session that entered it; nobody deletes an upload
// from a past month (Finance does). Rolled back.
test('pay: own slips only; finance only behind the code, per session; past months locked', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const people = await sql(`select email, id, auth_user_id as uid from app.employees
    where is_active and auth_user_id is not null and email in ('finance@youragency.com', 'carmen@youragency.com', 'maya@youragency.com');`);
  const p = Object.fromEntries(people.map((x) => [x.email.split('@')[0], x]));
  assert.ok(p.finance && p.carmen && p.maya, 'test people exist');
  const [old] = await sql(`select i.id, e.auth_user_id as uid from app.invoices i join app.employees e on e.id = i.employee_id
    where i.uploaded_at < date_trunc('month', now() at time zone 'Asia/Kolkata') and e.auth_user_id is not null limit 1;`);
  const S1 = '11111111-2222-4333-8444-555555555555', S2 = '99999999-2222-4333-8444-555555555555';
  const as = (uid, sid) => `reset role; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated","session_id":"${sid}"}', true);`;
  const rows = await sql(`begin;
    insert into app.finance_gate (employee_id, session_id, verified_at) values ('${p.finance.id}', '${S1}', now());
    insert into app.payslips (employee_id, pay_month, file_path, file_name) values ('${p.carmen.id}', '1999-01', '${p.carmen.id}/1999-01_probe.pdf', 'probe.pdf');
    create temp table r (k text, v text) on commit drop; grant all on r to authenticated;
    ${as(p.finance.uid, S1)} insert into r select 'fin_on', app.finance_unlocked()::text; insert into r select 'fin_slips', count(*)::text from app.payslips where pay_month = '1999-01';
    ${as(p.finance.uid, S2)} insert into r select 'fin_other_on', app.finance_unlocked()::text; insert into r select 'fin_other_slips', count(*)::text from app.payslips where pay_month = '1999-01';
    ${as(p.carmen.uid, S1)} insert into r select 'own_slips', count(*)::text from app.payslips where pay_month = '1999-01'; insert into r select 'own_on', app.finance_unlocked()::text;
    ${as(p.maya.uid, S1)} insert into r select 'other_slips', count(*)::text from app.payslips where pay_month = '1999-01';
    ${old ? `${as(old.uid, S1)} with d as (delete from app.invoices where id = '${old.id}' returning id) insert into r select 'past_delete', count(*)::text from d;` : ''}
    reset role; select k, v from r; rollback;`);
  const r = Object.fromEntries(rows.map((x) => [x.k, x.v]));
  assert.equal(r.fin_on, 'true'); assert.equal(r.fin_slips, '1');
  assert.equal(r.fin_other_on, 'false', 'the code unlocks only the session that entered it');
  assert.equal(r.fin_other_slips, '0');
  assert.equal(r.own_slips, '1'); assert.equal(r.own_on, 'false');
  assert.equal(r.other_slips, '0', 'nobody reads someone else\'s slip');
  if (old) assert.equal(r.past_delete, '0', 'a past month\'s upload cannot be deleted by its owner');
  await assert.rejects(sql(`begin; ${as(p.carmen.uid, S1)} insert into app.payslips (employee_id, pay_month, file_path, file_name) values ('${p.carmen.id}', '1999-02', '${p.carmen.id}/x.pdf', 'x.pdf'); rollback;`));
  const [b] = await sql("select public from storage.buckets where id = 'payslips';");
  assert.equal(b.public, false, 'the payslips bucket is private');
});

// 29 Oct 2026 (audit): an employee's own invoice takes uploaded_at from the
// database, never from the caller, so it can't be backdated for Finance or
// forward-dated past the own-month delete rule. Normal uploads still save.
test('invoices: uploaded_at is not the caller\'s to set', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [g] = await sql("select id, auth_user_id as uid from app.employees where email = 'maya@youragency.com' and auth_user_id is not null;");
  assert.ok(g, 'test person exists');
  const as = `set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${g.uid}","role":"authenticated"}', true);`;
  const row = (extra) => `insert into app.invoices (employee_id, invoice_month, invoice_type, file_name, file_path, file_size_bytes${extra ? ', uploaded_at' : ''})
    values ('${g.id}', to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM'), 'invoice', 'probe.pdf', '${g.id}/1999-01/probe.pdf', 1${extra ? `, '${extra}'` : ''})`;
  await assert.rejects(sql(`begin; ${as} ${row('2099-01-01T00:00:00Z')}; rollback;`), /permission denied/);
  const [ok] = await sql(`begin; ${as} ${row('')}; select (uploaded_at > now() - interval '5 minutes') as fresh from app.invoices where file_path = '${g.id}/1999-01/probe.pdf'; rollback;`);
  assert.equal(ok.fresh, true, 'a normal upload still saves, stamped now');
  const [grant] = await sql("select has_column_privilege('authenticated','app.invoices','uploaded_at','INSERT') ins, has_column_privilege('authenticated','app.invoices','id','INSERT') id_ins;");
  assert.equal(grant.ins, false); assert.equal(grant.id_ins, false);
});

// 3 Nov 2026 (audit): a brief comment carries its author's real name and the
// time it was written. The thread shows author_name first, so a caller-set
// name let a client post as an Your Agency reviewer, or staff as a client.
// 3 Nov 2026 (Alex): only she renames a client. Owners, leadership and Deal
// Flow viewers keep every other client edit (owner, archive).
test('clients: only the superadmin can rename one', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [c] = await sql(`select c.id, e.auth_user_id as owner_uid from app.clients c join app.employees e on e.id = c.account_owner_employee_id
    where c.is_active and e.auth_user_id is not null and lower(e.email) <> 'admin@youragency.com' order by c.name limit 1;`);
  const [lead] = await sql("select auth_user_id as uid from app.employees where email = 'am-lead@youragency.com' and auth_user_id is not null;");
  const [su] = await sql("select auth_user_id as uid from app.employees where email = 'admin@youragency.com' and auth_user_id is not null;");
  assert.ok(c && lead && su, 'a client with a non-superadmin owner, am-lead@ and admin@ exist');
  const as = (uid) => `reset role; select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true); set local role authenticated;`;
  const attempt = (k, stmt) => `do $$ begin ${stmt}; insert into _o values ('${k}', 'allowed'); exception when others then insert into _o values ('${k}', 'refused'); end $$;`;
  const rows = await sql(`begin; create temp table _o(k text, v text) on commit drop; grant all on _o to authenticated;
    ${as(c.owner_uid)} ${attempt('owner_rename', `update app.clients set name = name || ' probe' where id = '${c.id}'`)}
    ${as(c.owner_uid)} ${attempt('owner_archive', `update app.clients set is_active = false where id = '${c.id}'`)}
    ${as(lead.uid)} ${attempt('leadership_rename', `update app.clients set name = name || ' probe2' where id = '${c.id}'`)}
    ${as(su.uid)} ${attempt('superadmin_rename', `update app.clients set name = name || ' probe3' where id = '${c.id}'`)}
    reset role; select k, v from _o; rollback;`);
  const got = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  assert.deepEqual(got, { owner_rename: 'refused', owner_archive: 'allowed', leadership_rename: 'refused', superadmin_rename: 'allowed' });
});

// 10 Nov 2026 (audit): a plain employee could create a client by naming
// themselves owner. The UI has two ways in: Add client (superadmin) and a
// Closed Won deal (Deal Flow viewers). 202611100001.
test('clients: only leadership or Deal Flow viewers create one', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [emp] = await sql("select auth_user_id as uid from app.employees where email = 'maya@youragency.com' and auth_user_id is not null;");
  const [lead] = await sql("select auth_user_id as uid from app.employees where email = 'am-lead@youragency.com' and auth_user_id is not null;");
  assert.ok(emp && lead, 'maya@ and am-lead@ exist');
  const as = (uid) => `reset role; select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true); set local role authenticated;`;
  const attempt = (k, stmt) => `do $$ begin ${stmt}; insert into _o values ('${k}', 'allowed'); exception when others then insert into _o values ('${k}', 'refused'); end $$;`;
  const ins = (n) => `insert into app.clients (name, account_owner_employee_id, is_active) values ('ZZ audit probe ${n}', app.current_employee_id(), true)`;
  const rows = await sql(`begin; create temp table _o(k text, v text) on commit drop; grant all on _o to authenticated;
    ${as(emp.uid)} ${attempt('employee_own', ins(1))}
    ${as(lead.uid)} ${attempt('leadership', ins(2))}
    reset role; select k, v from _o; rollback;`);
  const got = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  assert.deepEqual(got, { employee_own: 'refused', leadership: 'allowed' });
});

// 3 Nov 2026: a feedback-wall post or reply carries its author's real name
// and the time it was written. Circle shows author_name as the author.
test('feedback wall: author name and time are stamped, not the caller\'s', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [p] = await sql("select p.id, u.id as uid, p.full_name, p.org from app.partners p join auth.users u on lower(u.email) = lower(p.email) where p.email = 'grace@example.org' and p.is_active;");
  const [su] = await sql("select id, auth_user_id as uid, full_name from app.employees where email = 'admin@youragency.com' and auth_user_id is not null;");
  const [t] = await sql("select request_type::text as t from app.feature_requests where author_partner_id is not null limit 1;");
  assert.ok(p && su && t, 'grace@, admin@ and a partner post type exist');
  const as = (uid) => `reset role; select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true); set local role authenticated;`;
  const F = '00000000-0000-0000-0000-0000000fa001';
  const rows = await sql(`begin;
    ${as(p.uid)} insert into app.feature_requests (id, author_partner_id, author_name, request_text, request_type, status, created_at)
      values ('${F}', '${p.id}', 'Alex Morgan', 'probe', '${t.t}', 'requested', '2026-01-01');
    ${as(p.uid)} insert into app.feature_request_replies (id, feature_request_id, author_partner_id, author_name, reply_text, created_at)
      values ('00000000-0000-0000-0000-0000000fa002', '${F}', '${p.id}', 'Alex Morgan', 'probe', '2026-01-01');
    ${as(su.uid)} insert into app.feature_request_replies (id, feature_request_id, employee_id, author_name, reply_text)
      values ('00000000-0000-0000-0000-0000000fa003', '${F}', '${su.id}', 'Someone at the client', 'probe');
    reset role;
    select id::text, author_name, (created_at > now() - interval '5 minutes') as fresh from app.feature_requests where id = '${F}'
    union all select id::text, author_name, (created_at > now() - interval '5 minutes') from app.feature_request_replies where feature_request_id = '${F}'
    order by 1;
    rollback;`);
  const client = `${p.full_name} (${p.org})`;
  const staff = su.full_name.trim().split(/\s+/).filter(Boolean);
  const staffName = staff.length > 1 ? `${staff[0]} ${staff[staff.length - 1]}` : staff[0];
  assert.deepEqual(rows.map((r) => [r.author_name, r.fresh]), [[client, true], [client, true], [staffName, true]]);
});

test('brief comments: author name and time are stamped, not the caller\'s', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [e] = await sql("select id, auth_user_id as uid, full_name from app.employees where email = 'rhea@youragency.com' and auth_user_id is not null;");
  const [p] = await sql("select p.id, u.id as uid, p.full_name from app.partners p join auth.users u on lower(u.email) = lower(p.email) where p.email = 'grace@example.org' and p.is_active;");
  const [b] = await sql("select id from app.briefs where org = 'Example Collective' order by created_at limit 1;");
  assert.ok(e && p && b, 'test people and a the client brief exist');
  const as = (uid) => `reset role; select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true); set local role authenticated;`;
  const rows = await sql(`begin;
    ${as(e.uid)} insert into app.brief_comments (id, brief_id, body, visibility, author_employee_id, author_name, created_at)
      values ('00000000-0000-0000-0000-0000000000c1', '${b.id}', 'probe', 'shared', '${e.id}', 'Someone at the client', '2026-01-01');
    ${as(p.uid)} insert into app.brief_comments (id, brief_id, body, visibility, author_partner_id, author_name, created_at)
      values ('00000000-0000-0000-0000-0000000000c2', '${b.id}', 'probe', 'shared', '${p.id}', 'Someone at Your Agency', '2026-01-01');
    reset role;
    select id, author_name, (created_at > now() - interval '5 minutes') as fresh from app.brief_comments
      where id in ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2') order by id;
    rollback;`);
  assert.equal(rows.length, 2, 'both comments saved');
  assert.deepEqual(rows.map((r) => [r.author_name, r.fresh]), [[e.full_name, true], [p.full_name, true]]);
});

// Out of office (4 Nov 2026): only people the leave form is closed to may
// mark themselves out, only for themselves, and it is FYI-only (no update).
test('only fractional or untracked people mark themselves out of office', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const [ooo] = await sql(`select e.auth_user_id, lower(e.email::text) email from app.employees e
    where e.is_active and e.employment_type = 'fractional' and e.access_level = 'employee' and e.auth_user_id is not null and e.access_paused_at is null order by e.email limit 1;`);
  const [ft] = await sql(`select e.auth_user_id, lower(e.email::text) email, e.id from app.employees e
    where e.is_active and e.employment_type <> 'fractional' and coalesce(e.leave_tracking_enabled, true) and e.access_level = 'employee'
      and e.auth_user_id is not null and e.access_paused_at is null order by e.email limit 1;`);
  assert.ok(ooo && ft, 'need one fractional and one tracked employee');
  const as = (u, q) => `begin; set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${u.auth_user_id}","email":"${u.email}","role":"authenticated"}', true); ${q}; rollback;`;
  const [{ rls }] = await sql("select relrowsecurity rls from pg_class where oid = 'app.out_of_office'::regclass;");
  assert.equal(rls, true);
  const [{ upd }] = await sql("select has_table_privilege('authenticated', 'app.out_of_office', 'UPDATE') upd;");
  assert.equal(upd, false, 'out_of_office rows are never edited, only added and removed');
  const ok = await sql(as(ooo, `insert into app.out_of_office(employee_id, start_date, end_date) values (app.current_employee_id(), '2031-04-07', '2031-04-07') returning id`));
  assert.equal(ok.length, 1);
  await assert.rejects(sql(as(ft, `insert into app.out_of_office(employee_id, start_date, end_date) values (app.current_employee_id(), '2031-04-07', '2031-04-07')`)), /row-level security/);
  await assert.rejects(sql(as(ooo, `insert into app.out_of_office(employee_id, start_date, end_date) values ('${ft.id}', '2031-04-07', '2031-04-07')`)), /row-level security/);
  await assert.rejects(sql(as(ooo, `insert into app.out_of_office(employee_id, start_date, end_date) values (app.current_employee_id(), '2031-04-07', '2031-04-08');
    insert into app.out_of_office(employee_id, start_date, end_date) values (app.current_employee_id(), '2031-04-08', '2031-04-08')`)), /already marked out/);
});
