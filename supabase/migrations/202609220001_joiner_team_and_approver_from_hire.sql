-- A joiner's team and leave approver come from their hire, set when the
-- account is created (22 Sep 2026: "instead of fixing approvers later,
-- this needs to be set at creation level").
--
-- What went wrong: ensure_employee_profile put every new joiner in AM as a
-- placeholder. The normalise trigger then gave them AM's leave approver
-- (Nadia), and nothing ever recalculated it. Dev was later moved to Art
-- but his leave still went to Nadia. The onboarding form also pre-filled the
-- team from that placeholder and did not offer Strategy, so Maya "chose" AM
-- and was activated into it. "Reports to" set direct_manager_email, which
-- leave routing never reads.
--
-- Now:
--   1. hire_profile_seed also returns the hire's department and Reports-to,
--      matched on the hire's work email first (then name, as before).
--   2. ensure_employee_profile creates the employee in the hire's department,
--      with Reports-to as both direct manager and leave approver. AM remains
--      only for a @youragency.com account that has no hire record at all.
--   3. submit_onboarding_profile keeps the hire's team and manager; the
--      joiner cannot overwrite what leadership set at hire.
--   4. normalize_employee_record: when the department changes and the
--      approver was only the old department's default, the approver follows
--      to the new department. A deliberately set approver is left alone.
--
-- Access: no new tables and no new callable functions. hire_profile_seed stays
-- in app_private with every grant revoked; the other three keep their existing
-- grants (CREATE OR REPLACE preserves them).

-- 1 ─────────────────────────────────────────────────────────────────────────
drop function if exists app_private.hire_profile_seed(text);

create function app_private.hire_profile_seed(p_email text, p_full_name text)
returns table(job_title text, personal_address text, department_id uuid, manager_email citext)
language sql
stable security definer
set search_path to 'app', 'public'
as $$
  select t.designation,
         coalesce(h.address, h.permanent_address),
         d.id,
         t.hiring_manager_email
  from app.hires h
  left join app.hire_offer_terms t on t.hire_id = h.id
  left join app.departments d on lower(d.name) = lower(btrim(t.department))
  where h.stage <> 'cancelled'
    and (lower(h.work_email) = lower(btrim(p_email))
         or lower(btrim(h.full_name)) = lower(btrim(p_full_name)))
  -- The work email is exact; the name is the fallback for hires whose account
  -- was made outside Colony (work_email never recorded).
  order by (lower(h.work_email) = lower(btrim(p_email))) desc nulls last, h.created_at desc
  limit 1;
$$;

revoke all on function app_private.hire_profile_seed(text, text) from public, anon, authenticated;

-- 2 ─────────────────────────────────────────────────────────────────────────
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
    -- Everything the hire already decided is set here, once: contract type,
    -- team, reporting line (who also approves their leave), designation and
    -- address. Nothing is left to a placeholder to be corrected later.
    SELECT * INTO seed FROM app_private.hire_profile_seed(caller_email::text, caller_name);

    -- AM only for an account with no hire behind it (made outside Colony);
    -- the approver assigns the real team at activation, and the normalise
    -- trigger moves the leave approver with it.
    dept_id := seed.department_id;
    IF dept_id IS NULL THEN
      SELECT id INTO dept_id FROM app.departments d WHERE d.name = 'AM' LIMIT 1;
    END IF;

    INSERT INTO app.employees (email, full_name, department_id, requested_department_id, auth_user_id, access_level,
                               onboarding_completed, employment_type, direct_manager_email, approver_emails, job_title, personal_address)
    VALUES (
      caller_email,
      caller_name,
      dept_id,
      seed.department_id,
      auth.uid(),
      coalesce(mapped_access, 'employee'),
      false,
      coalesce(app_private.hire_type_for_new_employee(caller_name), 'full-time'),
      seed.manager_email,
      CASE WHEN seed.manager_email IS NOT NULL THEN array[lower(seed.manager_email::text)::citext] ELSE '{}'::citext[] END,
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

-- 3 ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.submit_onboarding_profile(p_full_name text, p_direct_manager_email text, p_requested_department_id uuid, p_employment_type app.employment_type, p_current_city text, p_timezone text, p_date_of_birth date, p_emergency_contact_name text, p_emergency_contact_phone text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
declare
  v_employee_id uuid;
  v_email text;
  v_full_name text;
  v_seed record;
  v_team uuid;
  v_manager text;
begin
  select id, email into v_employee_id, v_email
    from app.employees
   where auth_user_id = auth.uid() and is_active;

  if v_employee_id is null then
    raise exception 'No active employee for the current session.';
  end if;

  -- The hire decides team and reporting line; the joiner confirms, never
  -- overrides (22 Sep 2026). Joiners without a hire still choose.
  select * into v_seed from app_private.hire_profile_seed(v_email, p_full_name);
  v_team := coalesce(v_seed.department_id, p_requested_department_id);
  v_manager := coalesce(v_seed.manager_email::text, p_direct_manager_email);

  if v_team is null then
    raise exception 'A team is required.';
  end if;
  if p_employment_type is null then
    raise exception 'Employment type is required.';
  end if;

  v_full_name := btrim(coalesce(p_full_name, ''));
  if array_length(regexp_split_to_array(v_full_name, '\s+'), 1) < 2 then
    raise exception 'Please enter your full name — first and last.';
  end if;

  perform set_config('app.onboarding_sanctioned', 'on', true);  -- transaction-local

  update app.employees
     set full_name                = v_full_name,
         direct_manager_email     = v_manager,
         requested_department_id  = v_team,
         employment_type          = p_employment_type,
         current_city             = p_current_city,
         timezone                 = coalesce(p_timezone, 'Asia/Kolkata'),
         date_of_birth            = p_date_of_birth,
         emergency_contact_name   = p_emergency_contact_name,
         emergency_contact_phone  = p_emergency_contact_phone,
         -- Everyone awaits confirmation: department_id can only be applied by
         -- an approver, so without this a new joiner's team would never land.
         setup_pending            = true,
         updated_at               = now()
   where id = v_employee_id;

  perform set_config('app.onboarding_sanctioned', 'off', true);
end;
$function$;

-- 4 ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.normalize_employee_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
declare
  dept app.departments%rowtype;
  old_dept_approver citext;
  normalized_approvers citext[];
begin
  if new.email is null then
    raise exception 'Employee email is required';
  end if;

  new.email := lower(trim(new.email::text))::citext;

  if not app.is_agency_email(new.email::text) then
    raise exception 'Only @youragency.com accounts are allowed.';
  end if;

  select *
  into dept
  from app.departments d
  where d.id = new.department_id;

  if not found then
    raise exception 'Department is required for employee records.';
  end if;

  normalized_approvers := (
    select coalesce(
      array_agg(distinct lower(trim(x::text))::citext)
      filter (where x is not null and trim(x::text) <> ''),
      '{}'::citext[]
    )
    from unnest(coalesce(new.approver_emails, '{}'::citext[])) as x
  );

  -- A department change carries the leave approver with it, but only when
  -- the approver was the old department's default and nobody changed it in
  -- the same update. A deliberately chosen approver (a Reports-to, or one set
  -- by hand) stays put (22 Sep 2026).
  if tg_op = 'UPDATE'
     and new.department_id is distinct from old.department_id
     and new.approver_emails is not distinct from old.approver_emails then
    select lower(d.approver_email::text)::citext into old_dept_approver
      from app.departments d where d.id = old.department_id;
    if old_dept_approver is not null and normalized_approvers = array[old_dept_approver] then
      normalized_approvers := '{}'::citext[];
    end if;
  end if;

  if dept.leave_tracking_enabled = false or lower(dept.name) = 'finance' then
    new.leave_tracking_enabled := false;
    new.approver_emails := '{}'::citext[];
  else
    new.leave_tracking_enabled := coalesce(new.leave_tracking_enabled, true);

    if new.leave_tracking_enabled = false then
      new.approver_emails := '{}'::citext[];
    elsif coalesce(array_length(normalized_approvers, 1), 0) = 0 and dept.approver_email is not null then
      new.approver_emails := array[lower(dept.approver_email::text)::citext];
    else
      new.approver_emails := normalized_approvers;
    end if;
  end if;

  return new;
end;
$function$;
