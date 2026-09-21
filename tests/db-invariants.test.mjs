// Live-database security invariants (16 Sep 2026, after two backup
// tables went out without RLS). These run against the real database through
// the Management API using the gitignored .env; where that is absent (CI, a
// fresh clone) they skip loudly rather than pretend.
//
// Each invariant is something the weekday audit also checks, but a test runs
// on every `npm test`, which is before every push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const body = await res.json();
  if (!res.ok || body.message) throw new Error(body.message || `HTTP ${res.status}`);
  return body;
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

test('the Security Advisor reports no ERROR-level lint', { skip: !live && 'no .env — live invariants skipped' }, async () => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/advisors/security`, {
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }
  });
  const body = await res.json();
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
  const priv = new Set(['personal_address', 'emergency_contact_name', 'emergency_contact_phone']);
  for (const r of rows) {
    if (priv.has(r.c)) assert.equal(r.sel, false, `authenticated can SELECT employees.${r.c}`);
  }
  assert.ok(rows.filter((r) => priv.has(r.c)).length === 3, 'a private employee column is missing');
  assert.ok(rows.some((r) => r.c === 'full_name' && r.sel), 'the directory columns lost their SELECT grant');
  const [{ def }] = await sql("select pg_get_functiondef('app.employee_private_details(uuid)'::regprocedure) def;");
  assert.match(def, /e\.id = app\.current_employee_id\(\) or app\.is_leadership_or_admin\(\)/, 'employee_private_details lost its self-or-leadership guard');
});
