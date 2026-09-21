-- Hiring-only logins (Leo) have @youragency.com emails but must never become
-- employees: an employees row would grant is_employee() reads of everything.
-- Add the guard to the bootstrap; identical otherwise to the live definition.

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
    INSERT INTO app.employees (email, full_name, department_id, auth_user_id, access_level, onboarding_completed)
    VALUES (
      caller_email,
      caller_name,
      dept_id,
      auth.uid(),
      coalesce(mapped_access, 'employee'),
      false
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
