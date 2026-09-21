-- Internal helpers live in a schema signed-in users cannot reach, and access
-- in app is closed by default (17 Sep 2026: "how can we write and
-- isolate access functions in a way that they don't keep opening up?").
--
-- The failure this replaces: every function in schema app is reachable through
-- the API, so "internal" was only a grant, and grants are easy to undo. On
-- 16 Sep one blanket `grant execute … to authenticated` loop re-opened helpers
-- that had been closed on purpose, and a Circle partner could read a hire's
-- home address (202609170001). Grants are now the second line, not the first:
--
-- 1. app_private. The helpers only other SECURITY DEFINER functions call are
--    moved here. anon and authenticated have no USAGE on the schema, so no
--    grant on a function inside it can make it callable — PostgREST does not
--    expose the schema, and Postgres refuses the call without USAGE. Their
--    callers run as the owner, which has USAGE, so behaviour is unchanged.
--    The two cron RPCs (run_due_activations, rollover_all_leave_cycles) stay
--    in app because the Netlify crons call them through PostgREST; they are
--    service_role-only and pinned by tests.
--
-- 2. Closed by default. New functions in app no longer get Postgres's implicit
--    EXECUTE for PUBLIC: a function is callable by signed-in users only after a
--    grant that names it. service_role keeps a default grant (the backend key;
--    the 10 Sep cron outage was the missing one).
--
-- 3. Enforced by the database, not by memory (event trigger
--    app_private.guard_access_ddl, after every DDL statement):
--    * a new table in app or app_private gets row-level security switched on
--      at creation — no policy means no rows, until someone writes one (the
--      10 Sep backup tables went out readable and writable without it);
--    * the statement is aborted if app_private became reachable by anon or
--      authenticated (schema USAGE or EXECUTE on anything in it);
--    * the statement is aborted if any SECURITY DEFINER function in app is
--      callable by anon/authenticated without being declared in
--      app_private.callable_definer_functions. A blanket grant — the 16 Sep
--      loop, or ON ALL FUNCTIONS IN SCHEMA — therefore fails at once, however
--      it is written. To expose a new RPC: insert its signature (with the
--      reason) into that table, THEN grant it by name, in the same migration.
--      (A text match on the GRANT statement was tried and rejected: a batch
--      submits the whole file as one query, comments included.)
--
-- The callers below are the live definitions with only `app.<helper>`
-- rewritten to `app_private.<helper>` (generated from pg_get_functiondef).

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

-- Postgres's implicit EXECUTE for PUBLIC is a GLOBAL default; a per-schema
-- default can only add to it, never take it away, so the revoke has to be
-- global for functions postgres creates. Supabase's own schemas (public,
-- storage, graphql) grant anon/authenticated explicitly in their per-schema
-- defaults and are unaffected.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges in schema app grant execute on functions to service_role;

alter function app.apply_employee_setup(uuid,uuid,app.employment_type,numeric,uuid[]) set schema app_private;
revoke all on function app_private.apply_employee_setup(uuid,uuid,app.employment_type,numeric,uuid[]) from public, anon, authenticated;
alter function app.hire_profile_seed(text) set schema app_private;
revoke all on function app_private.hire_profile_seed(text) from public, anon, authenticated;
alter function app.hire_manager_for_new_employee(text) set schema app_private;
revoke all on function app_private.hire_manager_for_new_employee(text) from public, anon, authenticated;
alter function app.hire_type_for_new_employee(text) set schema app_private;
revoke all on function app_private.hire_type_for_new_employee(text) from public, anon, authenticated;
alter function app.ensure_leave_cycle_record(uuid,date) set schema app_private;
revoke all on function app_private.ensure_leave_cycle_record(uuid,date) from public, anon, authenticated;
alter function app.archive_leave_cycle_row(uuid) set schema app_private;
revoke all on function app_private.archive_leave_cycle_row(uuid) from public, anon, authenticated;
alter function app.mapped_access_level_for_email(text) set schema app_private;
revoke all on function app_private.mapped_access_level_for_email(text) from public, anon, authenticated;

-- activate_employee_setup: 1 reference(s) rewritten
CREATE OR REPLACE FUNCTION app.activate_employee_setup(p_employee_id uuid, p_department_id uuid, p_employment_type app.employment_type, p_capacity_percent numeric, p_client_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
begin
  if not app.is_setup_approver() then
    raise exception 'Only a setup approver can activate an employee.';
  end if;
  perform app_private.apply_employee_setup(
    p_employee_id, p_department_id, p_employment_type, p_capacity_percent, p_client_ids);
  -- Scheduling and activating are mutually exclusive: activating by hand
  -- cancels anything pending, or the cron would re-apply it later.
  delete from app.scheduled_activations where employee_id = p_employee_id and applied_at is null;
end;
$function$;

-- run_due_activations: 1 reference(s) rewritten
CREATE OR REPLACE FUNCTION app.run_due_activations()
 RETURNS TABLE(employee_id uuid, applied boolean, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
declare
  r record;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  for r in
    select s.* from app.scheduled_activations s
    where s.applied_at is null and s.activate_on <= today
    order by s.activate_on
  loop
    if not exists (select 1 from app.employees e where e.id = r.employee_id and e.setup_pending) then
      update app.scheduled_activations
         set applied_at = now(), last_error = 'skipped: already activated'
       where id = r.id;
      employee_id := r.employee_id; applied := false; detail := 'already activated';
      return next;
      continue;
    end if;
    begin
      perform app_private.apply_employee_setup(
        r.employee_id, r.department_id, r.employment_type, r.capacity_percent, r.client_ids);
      update app.scheduled_activations set applied_at = now(), last_error = null where id = r.id;
      employee_id := r.employee_id; applied := true; detail := 'activated';
      return next;
    exception when others then
      update app.scheduled_activations set last_error = sqlerrm where id = r.id;
      employee_id := r.employee_id; applied := false; detail := sqlerrm;
      return next;
    end;
  end loop;
end;
$function$;

-- ensure_leave_cycle_record: 2 reference(s) rewritten
CREATE OR REPLACE FUNCTION app_private.ensure_leave_cycle_record(p_employee_id uuid, p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS app.employee_leave_cycles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
declare
  employee_row app.employees%rowtype;
  policy_row app.leave_cycle_policy%rowtype;
  cycle_start_date date;
  cycle_end_date date;
  existing_row app.employee_leave_cycles%rowtype;
  previous_row app.employee_leave_cycles%rowtype;
begin
  if p_employee_id is null then
    return null;
  end if;

  select *
  into employee_row
  from app.employees e
  where e.id = p_employee_id
    and e.is_active = true;

  if not found then
    raise exception 'Active employee not found for leave cycle setup.';
  end if;

  if employee_row.leave_tracking_enabled = false then
    return null;
  end if;

  cycle_start_date := app.leave_cycle_start(coalesce(p_as_of_date, current_date));
  cycle_end_date := app.leave_cycle_end(cycle_start_date);

  select *
  into policy_row
  from app.leave_cycle_policy p
  where p.is_active = true
  order by p.id desc
  limit 1;

  if not found then
    policy_row.pl_allocation := 12;
    policy_row.cl_allocation := 12;
    policy_row.sl_allocation := 12;
  end if;

  select *
  into existing_row
  from app.employee_leave_cycles c
  where c.employee_id = p_employee_id
    and c.cycle_start = cycle_start_date
  limit 1;

  if found then
    return existing_row;
  end if;

  select *
  into previous_row
  from app.employee_leave_cycles c
  where c.employee_id = p_employee_id
    and c.cycle_start < cycle_start_date
  order by c.cycle_start desc
  limit 1;

  if found and previous_row.archived_at is null then
    perform app_private.archive_leave_cycle_row(previous_row.id);
  end if;

  insert into app.employee_leave_cycles (
    employee_id,
    cycle_start,
    cycle_end,
    pl_allocated,
    cl_allocated,
    sl_allocated
  )
  values (
    p_employee_id,
    cycle_start_date,
    cycle_end_date,
    coalesce(policy_row.pl_allocation, 12),
    coalesce(policy_row.cl_allocation, 12),
    coalesce(policy_row.sl_allocation, 12)
  )
  on conflict (employee_id, cycle_start)
  do update
  set cycle_end = excluded.cycle_end
  returning * into existing_row;

  return existing_row;
end;
$function$;

-- archive_leave_cycle_row: 1 reference(s) rewritten
CREATE OR REPLACE FUNCTION app_private.archive_leave_cycle_row(p_cycle_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
declare
  cycle_row app.employee_leave_cycles%rowtype;
  pl_taken_days numeric := 0;
  cl_taken_days numeric := 0;
  sl_taken_days numeric := 0;
begin
  select *
  into cycle_row
  from app.employee_leave_cycles
  where id = p_cycle_id
  for update;

  if not found then
    return;
  end if;

  select
    coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, cycle_row.cycle_start, cycle_row.cycle_end))
      filter (where lr.leave_type = 'PL' and lr.status = 'approved'), 0),
    coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, cycle_row.cycle_start, cycle_row.cycle_end))
      filter (where lr.leave_type = 'CL' and lr.status = 'approved'), 0),
    coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, cycle_row.cycle_start, cycle_row.cycle_end))
      filter (where lr.leave_type = 'SL' and lr.status = 'approved'), 0)
  into pl_taken_days, cl_taken_days, sl_taken_days
  from app.leave_requests lr
  where lr.employee_id = cycle_row.employee_id
    and lr.status = 'approved'
    and lr.end_date >= cycle_row.cycle_start
    and lr.start_date <= cycle_row.cycle_end;

  insert into app.leave_cycle_archives (
    employee_id,
    cycle_start,
    cycle_end,
    pl_allocated,
    cl_allocated,
    sl_allocated,
    pl_taken,
    cl_taken,
    sl_taken,
    pl_remaining,
    cl_remaining,
    sl_remaining,
    archived_at
  )
  values (
    cycle_row.employee_id,
    cycle_row.cycle_start,
    cycle_row.cycle_end,
    cycle_row.pl_allocated,
    cycle_row.cl_allocated,
    cycle_row.sl_allocated,
    pl_taken_days,
    cl_taken_days,
    sl_taken_days,
    cycle_row.pl_allocated - pl_taken_days,
    cycle_row.cl_allocated - cl_taken_days,
    cycle_row.sl_allocated - sl_taken_days,
    now()
  )
  on conflict (employee_id, cycle_start)
  do update
  set cycle_end = excluded.cycle_end,
      pl_allocated = excluded.pl_allocated,
      cl_allocated = excluded.cl_allocated,
      sl_allocated = excluded.sl_allocated,
      pl_taken = excluded.pl_taken,
      cl_taken = excluded.cl_taken,
      sl_taken = excluded.sl_taken,
      pl_remaining = excluded.pl_remaining,
      cl_remaining = excluded.cl_remaining,
      sl_remaining = excluded.sl_remaining,
      archived_at = excluded.archived_at;

  update app.employee_leave_cycles
  set archived_at = coalesce(archived_at, now())
  where id = cycle_row.id;
end;
$function$;

-- ensure_leave_cycle_before_request: 1 reference(s) rewritten
CREATE OR REPLACE FUNCTION app.ensure_leave_cycle_before_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
begin
  perform app_private.ensure_leave_cycle_record(new.employee_id, new.start_date);
  return new;
end;
$function$;

-- get_leave_cycle_summary_for_employee: 1 reference(s) rewritten
CREATE OR REPLACE FUNCTION app.get_leave_cycle_summary_for_employee(p_employee_id uuid, p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
declare
  cycle_row app.employee_leave_cycles%rowtype;
  employee_row app.employees%rowtype;
  pl_applied_days numeric := 0;
  cl_applied_days numeric := 0;
  sl_applied_days numeric := 0;
  pl_taken_days numeric := 0;
  cl_taken_days numeric := 0;
  sl_taken_days numeric := 0;
  archive_json jsonb := '[]'::jsonb;
  caller_id uuid;
begin
  -- Authorization: caller must be the employee themselves or leadership/admin
  caller_id := app.current_employee_id();
  if p_employee_id is distinct from caller_id and not app.is_leadership_or_admin() then
    raise exception 'Access denied: requires leadership role or own profile.';
  end if;

  if p_employee_id is null then
    return jsonb_build_object(
      'leave_tracking_enabled', false,
      'cycle_label', 'Apr-Mar',
      'pl', jsonb_build_object('allocated', 0, 'applied', 0, 'taken', 0, 'remaining', 0),
      'cl', jsonb_build_object('allocated', 0, 'applied', 0, 'taken', 0, 'remaining', 0),
      'sl', jsonb_build_object('allocated', 0, 'applied', 0, 'taken', 0, 'remaining', 0),
      'archive', '[]'::jsonb
    );
  end if;

  select *
  into employee_row
  from app.employees e
  where e.id = p_employee_id
    and e.is_active = true;

  if not found or employee_row.leave_tracking_enabled = false then
    return jsonb_build_object(
      'leave_tracking_enabled', false,
      'cycle_label', 'Apr-Mar',
      'pl', jsonb_build_object('allocated', 0, 'applied', 0, 'taken', 0, 'remaining', 0),
      'cl', jsonb_build_object('allocated', 0, 'applied', 0, 'taken', 0, 'remaining', 0),
      'sl', jsonb_build_object('allocated', 0, 'applied', 0, 'taken', 0, 'remaining', 0),
      'archive', '[]'::jsonb
    );
  end if;

  cycle_row := app_private.ensure_leave_cycle_record(p_employee_id, p_as_of_date);
  if cycle_row.id is null then
    return jsonb_build_object(
      'leave_tracking_enabled', false,
      'cycle_label', 'Apr-Mar',
      'pl', jsonb_build_object('allocated', 0, 'applied', 0, 'taken', 0, 'remaining', 0),
      'cl', jsonb_build_object('allocated', 0, 'applied', 0, 'taken', 0, 'remaining', 0),
      'sl', jsonb_build_object('allocated', 0, 'applied', 0, 'taken', 0, 'remaining', 0),
      'archive', '[]'::jsonb
    );
  end if;

  select
    coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, cycle_row.cycle_start, cycle_row.cycle_end))
      filter (where lr.leave_type = 'PL' and lr.status in ('pending', 'approved')), 0),
    coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, cycle_row.cycle_start, cycle_row.cycle_end))
      filter (where lr.leave_type = 'CL' and lr.status in ('pending', 'approved')), 0),
    coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, cycle_row.cycle_start, cycle_row.cycle_end))
      filter (where lr.leave_type = 'SL' and lr.status in ('pending', 'approved')), 0),
    coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, cycle_row.cycle_start, cycle_row.cycle_end))
      filter (where lr.leave_type = 'PL' and lr.status = 'approved'), 0),
    coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, cycle_row.cycle_start, cycle_row.cycle_end))
      filter (where lr.leave_type = 'CL' and lr.status = 'approved'), 0),
    coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, cycle_row.cycle_start, cycle_row.cycle_end))
      filter (where lr.leave_type = 'SL' and lr.status = 'approved'), 0)
  into
    pl_applied_days,
    cl_applied_days,
    sl_applied_days,
    pl_taken_days,
    cl_taken_days,
    sl_taken_days
  from app.leave_requests lr
  where lr.employee_id = p_employee_id
    and lr.status in ('pending', 'approved')
    and lr.end_date >= cycle_row.cycle_start
    and lr.start_date <= cycle_row.cycle_end;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'cycle_start', a.cycle_start,
        'cycle_end', a.cycle_end,
        'cycle_label', to_char(a.cycle_start, 'Mon YYYY') || ' - ' || to_char(a.cycle_end, 'Mon YYYY'),
        'pl_remaining', a.pl_remaining,
        'cl_remaining', a.cl_remaining,
        'sl_remaining', a.sl_remaining,
        'archived_at', a.archived_at
      )
      order by a.cycle_start desc
    ),
    '[]'::jsonb
  )
  into archive_json
  from (
    select *
    from app.leave_cycle_archives
    where employee_id = p_employee_id
    order by cycle_start desc
    limit 8
  ) a;

  return jsonb_build_object(
    'leave_tracking_enabled', true,
    'cycle_start', cycle_row.cycle_start,
    'cycle_end', cycle_row.cycle_end,
    'cycle_label', to_char(cycle_row.cycle_start, 'Mon YYYY') || ' - ' || to_char(cycle_row.cycle_end, 'Mon YYYY'),
    'pl', jsonb_build_object(
      'allocated', cycle_row.pl_allocated,
      'applied', pl_applied_days,
      'taken', pl_taken_days,
      'remaining', cycle_row.pl_allocated - pl_taken_days
    ),
    'cl', jsonb_build_object(
      'allocated', cycle_row.cl_allocated,
      'applied', cl_applied_days,
      'taken', cl_taken_days,
      'remaining', cycle_row.cl_allocated - cl_taken_days
    ),
    'sl', jsonb_build_object(
      'allocated', cycle_row.sl_allocated,
      'applied', sl_applied_days,
      'taken', sl_taken_days,
      'remaining', cycle_row.sl_allocated - sl_taken_days
    ),
    'archive', archive_json
  );
end;
$function$;

-- get_leave_summaries_for_employees: 1 reference(s) rewritten
CREATE OR REPLACE FUNCTION app.get_leave_summaries_for_employees(p_employee_ids uuid[], p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
declare
  emp_id uuid;
  cycle_row app.employee_leave_cycles%rowtype;
  result_rows jsonb := '[]'::jsonb;
begin
  if not app.is_leadership_or_admin() then
    raise exception 'Access denied: requires leadership or admin role.';
  end if;

  -- Ensure cycle records exist for each employee (has side effects: inserts rows)
  foreach emp_id in array p_employee_ids loop
    begin
      perform app_private.ensure_leave_cycle_record(emp_id, p_as_of_date);
    exception when others then
      -- Skip employees that error (inactive, etc.)
      null;
    end;
  end loop;

  -- Single set-based query for all summaries
  select coalesce(jsonb_agg(row_obj order by row_obj->>'full_name'), '[]'::jsonb)
  into result_rows
  from (
    select jsonb_build_object(
      'employee_id', e.id,
      'full_name', e.full_name,
      'leave_tracking_enabled', e.leave_tracking_enabled,
      'pl_allocated', c.pl_allocated,
      'cl_allocated', c.cl_allocated,
      'sl_allocated', c.sl_allocated,
      'pl_taken', coalesce(lr_agg.pl_taken, 0),
      'cl_taken', coalesce(lr_agg.cl_taken, 0),
      'sl_taken', coalesce(lr_agg.sl_taken, 0),
      'pl_remaining', c.pl_allocated - coalesce(lr_agg.pl_taken, 0),
      'cl_remaining', c.cl_allocated - coalesce(lr_agg.cl_taken, 0),
      'sl_remaining', c.sl_allocated - coalesce(lr_agg.sl_taken, 0)
    ) as row_obj
    from unnest(p_employee_ids) as eid(id)
    join app.employees e on e.id = eid.id and e.is_active = true
    join app.employee_leave_cycles c
      on c.employee_id = e.id
      and c.cycle_start = app.leave_cycle_start(p_as_of_date)
      and c.archived_at is null
    left join lateral (
      select
        coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, c.cycle_start, c.cycle_end))
          filter (where lr.leave_type = 'PL' and lr.status = 'approved'), 0) as pl_taken,
        coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, c.cycle_start, c.cycle_end))
          filter (where lr.leave_type = 'CL' and lr.status = 'approved'), 0) as cl_taken,
        coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, c.cycle_start, c.cycle_end))
          filter (where lr.leave_type = 'SL' and lr.status = 'approved'), 0) as sl_taken
      from app.leave_requests lr
      where lr.employee_id = e.id
        and lr.status = 'approved'
        and lr.end_date >= c.cycle_start
        and lr.start_date <= c.cycle_end
    ) lr_agg on true
  ) sub;

  return result_rows;
end;
$function$;

-- rollover_all_leave_cycles: 1 reference(s) rewritten
CREATE OR REPLACE FUNCTION app.rollover_all_leave_cycles(p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
declare
  employee_row record;
  processed_count int := 0;
begin
  for employee_row in
    select e.id
    from app.employees e
    where e.is_active = true
      and e.leave_tracking_enabled = true
  loop
    perform app_private.ensure_leave_cycle_record(employee_row.id, p_as_of_date);
    processed_count := processed_count + 1;
  end loop;

  return processed_count;
end;
$function$;

-- ensure_employee_profile: 4 reference(s) rewritten
CREATE OR REPLACE FUNCTION app.ensure_employee_profile()
 RETURNS app.employees
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
DECLARE
  caller_email citext;
  caller_name text;
  emp app.employees%rowtype;
  dept_id uuid;
  mapped_access app.access_level;
  is_new_employee boolean := false;
  seed record;
BEGIN
  caller_email := lower(coalesce(
    current_setting('request.jwt.claims', true)::json->>'email',
    auth.email()
  ));

  IF caller_email IS NULL OR caller_email = '' THEN
    RAISE EXCEPTION 'No email found in JWT – cannot create employee profile';
  END IF;

  -- Partner/external accounts must never reach the employee path.
  IF caller_email::text NOT LIKE '%@youragency.com' THEN
    RAISE EXCEPTION 'Employee profiles are for @youragency.com accounts';
  END IF;

  -- Hiring-only accounts (legal counsel) get the hiring section, not a
  -- Colony employee profile.
  IF app.is_hiring_only_email(caller_email::text) THEN
    RAISE EXCEPTION 'This account is set up for the hiring section only.';
  END IF;

  caller_name := coalesce(
    nullif(btrim(current_setting('request.jwt.claims', true)::json->>'name'), ''),
    nullif(btrim(current_setting('request.jwt.claims', true)::json->>'full_name'), ''),
    split_part(caller_email::text, '@', 1)
  );

  SELECT id INTO dept_id
  FROM app.departments d
  WHERE d.name = 'AM'
  LIMIT 1;

  SELECT *
  INTO emp
  FROM app.employees e
  WHERE e.auth_user_id = auth.uid();

  IF NOT FOUND THEN
    SELECT *
    INTO emp
    FROM app.employees e
    WHERE lower(e.email) = caller_email;
  END IF;

  mapped_access := app_private.mapped_access_level_for_email(caller_email);

  IF FOUND THEN
    UPDATE app.employees
    SET
      auth_user_id = auth.uid(),
      full_name = CASE WHEN full_name IS NULL OR btrim(full_name) = '' THEN caller_name ELSE full_name END,
      access_level = coalesce(mapped_access, employees.access_level),
      updated_at = now()
    WHERE id = emp.id
    RETURNING * INTO emp;
  ELSE
    -- Seed what the hire record already knows: contract type (31 Aug 2026),
    -- reporting line (11 Sep), designation and address (15 Sep). The joiner
    -- should not be asked again for what leadership and they already gave.
    SELECT * INTO seed FROM app_private.hire_profile_seed(caller_name);
    INSERT INTO app.employees (email, full_name, department_id, auth_user_id, access_level, onboarding_completed, employment_type, direct_manager_email, job_title, personal_address)
    VALUES (
      caller_email,
      caller_name,
      dept_id,
      auth.uid(),
      coalesce(mapped_access, 'employee'),
      false,
      coalesce(app_private.hire_type_for_new_employee(caller_name), 'full-time'),
      app_private.hire_manager_for_new_employee(caller_name),
      seed.job_title,
      seed.personal_address
    )
    RETURNING * INTO emp;
    is_new_employee := true;
  END IF;

  IF is_new_employee THEN
    PERFORM app.spawn_onboarding_checklist(emp.id);
  END IF;

  RETURN emp;
END;
$function$;

-- enforce_mapped_access_level: 1 reference(s) rewritten
CREATE OR REPLACE FUNCTION app.enforce_mapped_access_level()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
declare
  mapped_access app.access_level;
begin
  mapped_access := app_private.mapped_access_level_for_email(new.email::text);
  if mapped_access is not null then
    new.access_level := mapped_access;
  end if;
  return new;
end;
$function$;

-- The declared public surface. Seeded with every SECURITY DEFINER function
-- signed-in users can call today (client RPCs and RLS-policy helpers — each
-- one was exercised as a partner in the 17 Sep audit). Signatures are rendered
-- with search_path = pg_catalog so they are fully qualified and stable.
create or replace function app_private.fn_signature(p_oid oid)
returns text
language sql stable
set search_path to 'pg_catalog'
as $$ select p_oid::regprocedure::text $$;
revoke all on function app_private.fn_signature(oid) from public, anon, authenticated;

create table if not exists app_private.callable_definer_functions (
  signature text primary key,
  reason text not null,
  added_at timestamptz not null default now()
);
revoke all on app_private.callable_definer_functions from public, anon, authenticated;

insert into app_private.callable_definer_functions (signature, reason)
select app_private.fn_signature(p.oid), 'baseline 17 Sep 2026: client RPC or RLS policy helper'
from pg_proc p
where p.pronamespace = 'app'::regnamespace
  and p.prosecdef
  and p.prorettype <> 'trigger'::regtype
  and (has_function_privilege('authenticated', p.oid, 'execute')
       or has_function_privilege('anon', p.oid, 'execute'))
on conflict (signature) do nothing;

create or replace function app_private.guard_access_ddl()
returns event_trigger
language plpgsql
set search_path to 'pg_catalog'
as $$
declare
  cmd record;
  leak text;
begin
  -- New tables start closed: RLS on, no policy, no rows.
  for cmd in select * from pg_event_trigger_ddl_commands() loop
    if cmd.command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
       and cmd.object_type = 'table'
       and cmd.schema_name in ('app', 'app_private') then
      execute format('alter table %s enable row level security', cmd.object_identity);
    end if;
  end loop;

  if has_schema_privilege('anon', 'app_private', 'usage')
     or has_schema_privilege('authenticated', 'app_private', 'usage') then
    raise exception 'app_private must not be reachable by anon or authenticated (guard_access_ddl).';
  end if;

  select string_agg(app_private.fn_signature(p.oid), ', ') into leak
  from pg_proc p
  where p.pronamespace = 'app_private'::regnamespace
    and (has_function_privilege('anon', p.oid, 'execute')
         or has_function_privilege('authenticated', p.oid, 'execute'));
  if leak is not null then
    raise exception 'app_private functions made callable by anon/authenticated: % (guard_access_ddl)', leak;
  end if;

  select string_agg(app_private.fn_signature(p.oid), ', ') into leak
  from pg_proc p
  where p.pronamespace = 'app'::regnamespace
    and p.prosecdef
    and p.prorettype <> 'trigger'::regtype
    and (has_function_privilege('authenticated', p.oid, 'execute')
         or has_function_privilege('anon', p.oid, 'execute'))
    and not exists (select 1 from app_private.callable_definer_functions c
                    where c.signature = app_private.fn_signature(p.oid));
  if leak is not null then
    raise exception 'SECURITY DEFINER functions callable by signed-in users but not declared in app_private.callable_definer_functions: % (guard_access_ddl). Declare each one with a reason, then grant it by name.', leak;
  end if;
end;
$$;
revoke all on function app_private.guard_access_ddl() from public, anon, authenticated;

drop event trigger if exists guard_access_ddl;
create event trigger guard_access_ddl on ddl_command_end
  execute function app_private.guard_access_ddl();
