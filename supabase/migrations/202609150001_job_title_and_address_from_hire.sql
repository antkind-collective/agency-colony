-- Designation and address travel from the hire to the employee (15 Sep
-- 2026: "where are we collecting address and designation?" — both were
-- collected, neither reached the profile).
--
-- employees.job_title is NEW: role_title is the access label ('Employee' /
-- 'Leadership' / 'Admin') and is overwritten by the access editor, so it
-- cannot carry "Senior Strategist". employees.personal_address already
-- existed but nothing ever wrote it.

alter table app.employees add column if not exists job_title text;

-- What the hire record knows about the person about to sign in.
create or replace function app.hire_profile_seed(p_full_name text)
returns table (job_title text, personal_address text)
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select t.designation, coalesce(h.address, h.permanent_address)
  from app.hires h
  left join app.hire_offer_terms t on t.hire_id = h.id
  where h.stage <> 'cancelled'
    and lower(btrim(h.full_name)) = lower(btrim(p_full_name))
  order by h.created_at desc
  limit 1;
$$;
revoke all on function app.hire_profile_seed(text) from public;

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
    -- Seed what the hire record already knows: contract type (31 Aug 2026),
    -- reporting line (11 Sep), designation and address (15 Sep). The joiner
    -- should not be asked again for what leadership and they already gave.
    SELECT * INTO seed FROM app.hire_profile_seed(caller_name);
    INSERT INTO app.employees (email, full_name, department_id, auth_user_id, access_level, onboarding_completed, employment_type, direct_manager_email, job_title, personal_address)
    VALUES (
      caller_email,
      caller_name,
      dept_id,
      auth.uid(),
      coalesce(mapped_access, 'employee'),
      false,
      coalesce(app.hire_type_for_new_employee(caller_name), 'full-time'),
      app.hire_manager_for_new_employee(caller_name),
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

-- The three people who came through before this existed.
update app.employees e
set job_title = coalesce(e.job_title, s.job_title),
    personal_address = coalesce(e.personal_address, s.personal_address)
from (
  select e2.id, (app.hire_profile_seed(e2.full_name)).*
  from app.employees e2
  where e2.email in ('maya@youragency.com', 'dev@youragency.com', 'asha@youragency.com')
) s
where s.id = e.id;

-- Designation is leadership's to set, like team and type: an employee's own
-- profile save must not be able to retitle them.
CREATE OR REPLACE FUNCTION app.trg_block_employee_self_escalation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
BEGIN
  -- If the updater is NOT leadership/admin, block changes to sensitive columns
  IF NOT app.is_leadership_or_admin()
     AND coalesce(current_setting('app.onboarding_sanctioned', true), '') <> 'on' THEN
    NEW.access_level := OLD.access_level;
    NEW.is_active := OLD.is_active;
    NEW.leave_tracking_enabled := OLD.leave_tracking_enabled;
    NEW.department_id := OLD.department_id;
    NEW.approver_emails := OLD.approver_emails;
    -- Added Jul 2026: these decide client visibility and capacity maths.
    NEW.setup_pending := OLD.setup_pending;
    NEW.requested_department_id := OLD.requested_department_id;
    NEW.employment_type := OLD.employment_type;
    NEW.capacity_percent := OLD.capacity_percent;
    NEW.task_nudge_enabled := OLD.task_nudge_enabled;
    -- Added 15 Sep 2026: the job title.
    NEW.job_title := OLD.job_title;
  END IF;
  RETURN NEW;
END;
$function$;
