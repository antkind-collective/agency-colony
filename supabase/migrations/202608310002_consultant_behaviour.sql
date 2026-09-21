-- Consultant behaviour (31 Aug 2026): a consultant is an employee in
-- every respect — leave, task nudges, client access — and differs from salaried
-- staff only in raising an invoice.

-- 1. Activation ---------------------------------------------------------------
-- The trap: both flags were set with `= 'full-time'`, so a consultant activated
-- by an approver would silently get NO leave accrual and NO task nudges. The
-- test is "not fractional", not "is full-time".
create or replace function app.activate_employee_setup(
  p_employee_id uuid,
  p_department_id uuid,
  p_employment_type app.employment_type,
  p_capacity_percent numeric,
  p_client_ids uuid[]
)
returns void
language plpgsql security definer
set search_path to 'app', 'public'
as $function$
begin
  if not app.is_setup_approver() then
    raise exception 'Only a setup approver can activate an employee.';
  end if;
  if p_capacity_percent is null or p_capacity_percent <= 0 or p_capacity_percent > 100 then
    raise exception 'Capacity must be between 1 and 100.';
  end if;
  if p_department_id is null then
    raise exception 'A department is required to activate.';
  end if;
  -- Fractional ONLY. A fractional person with no clients falls through to
  -- "unscoped" and sees everything — the hole setup_pending exists to close.
  -- Consultants are unscoped by design, like any salaried employee.
  if p_employment_type = 'fractional' and coalesce(array_length(p_client_ids, 1), 0) = 0 then
    raise exception 'A fractional person must be scoped to at least one client.';
  end if;

  perform set_config('app.onboarding_sanctioned', 'on', true);

  update app.employees
     set department_id = p_department_id,
         employment_type = p_employment_type,
         capacity_percent = p_capacity_percent,
         -- Fractional people don't accrue leave or get nudged (agreed Jul 2026).
         -- Consultants do both: they are employees whose contract is structured
         -- differently, not part-timers.
         leave_tracking_enabled = (p_employment_type <> 'fractional'),
         task_nudge_enabled = (p_employment_type <> 'fractional'),
         requested_department_id = null,
         setup_pending = false,
         updated_at = now()
   where id = p_employee_id;

  if not found then
    raise exception 'Employee not found: %', p_employee_id;
  end if;

  perform set_config('app.onboarding_sanctioned', 'off', true);

  delete from app.employee_client_scope where employee_id = p_employee_id;
  if coalesce(array_length(p_client_ids, 1), 0) > 0 then
    insert into app.employee_client_scope (employee_id, client_id)
    select p_employee_id, unnest(p_client_ids)
    on conflict (employee_id, client_id) do nothing;
  end if;
end;
$function$;

-- 2. Carry the hire's contract type onto the employee record ------------------
-- A hire is keyed by PERSONAL email (a Gmail) and the employee by their
-- @youragency.com address, so there is no id to join on. Name is the only link we
-- have; it is matched case- and whitespace-insensitively against non-cancelled
-- hires, most recent first. If nothing matches, the column keeps its default —
-- the joiner still picks a type during onboarding and the approver confirms it
-- at activation, so a miss costs nothing.
create or replace function app.hire_type_for_new_employee(p_full_name text)
returns app.employment_type
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  select h.hire_type::text::app.employment_type
  from app.hires h
  where h.stage <> 'cancelled'
    and lower(btrim(h.full_name)) = lower(btrim(p_full_name))
  order by h.created_at desc
  limit 1;
$$;

comment on function app.hire_type_for_new_employee(text) is
  'Seeds employment_type for a brand-new employee from their hire record. Matched on name because hires carry a personal email and employees a @youragency.com one. Returns NULL when there is no match, leaving the column default.';

-- 3. ensure_employee_profile seeds employment_type from the hire record.
--    (Full body applied via the generated statement below; see migration notes.)
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

  mapped_access := app.mapped_access_level_for_email(caller_email);

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
    -- Seed the contract type from their hire record, if we have one. Without
    -- this the column defaults to 'full-time' and a consultant silently became
    -- salaried the day they signed in (31 Aug 2026).
    INSERT INTO app.employees (email, full_name, department_id, auth_user_id, access_level, onboarding_completed, employment_type)
    VALUES (
      caller_email,
      caller_name,
      dept_id,
      auth.uid(),
      coalesce(mapped_access, 'employee'),
      false,
      coalesce(app.hire_type_for_new_employee(caller_name), 'full-time')
    )
    RETURNING * INTO emp;
    is_new_employee := true;
  END IF;

  IF is_new_employee THEN
    PERFORM app.spawn_onboarding_checklist(emp.id);
  END IF;

  RETURN emp;
END;
$function$
;
