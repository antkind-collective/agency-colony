-- Retire the old onboarding checklist (8 Oct 2026). Its 17 items were
-- ticked by nobody, so four people showed "onboarding" for weeks; most items
-- are now automatic steps on the hire, and the human ones (first 1:1, clients
-- briefed, tools, 30-day check-in) moved there too. ensure_employee_profile is
-- redefined from its LIVE definition with only the spawn call removed.

CREATE OR REPLACE FUNCTION app.ensure_employee_profile()
 RETURNS app.employees
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
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

  -- The old onboarding checklist is retired (8 Oct 2026): a joiner's steps
  -- live on their hire now, so nothing is spawned here any more.

  RETURN emp;
END;
$function$;

update app.onboarding_checklists set status = 'completed' where status = 'active';

-- The human steps after activation, on the hire, ticked by the hiring manager
-- (or Alex). First tasks and first invoice tick themselves from Colony data.
alter table app.hires
  add column if not exists first_one_on_one_at timestamptz,
  add column if not exists clients_briefed_at timestamptz,
  add column if not exists tools_set_up_at timestamptz,
  add column if not exists checkin_30_at timestamptz;

create or replace function app.tick_hire_followup(p_hire_id uuid, p_step text, p_done boolean default true)
returns void
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if not app_private.can_activate_hire(p_hire_id) then
    raise exception 'Only the hiring manager or Alex can tick this.';
  end if;
  if p_step = 'one_on_one' then
    update app.hires set first_one_on_one_at = case when p_done then now() end, updated_at = now() where id = p_hire_id;
  elsif p_step = 'clients' then
    update app.hires set clients_briefed_at = case when p_done then now() end, updated_at = now() where id = p_hire_id;
  elsif p_step = 'tools' then
    update app.hires set tools_set_up_at = case when p_done then now() end, updated_at = now() where id = p_hire_id;
  elsif p_step = 'checkin' then
    update app.hires set checkin_30_at = case when p_done then now() end, updated_at = now() where id = p_hire_id;
  else
    raise exception 'Unknown step.';
  end if;
end;
$$;
revoke all on function app.tick_hire_followup(uuid, text, boolean) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.tick_hire_followup(uuid,text,boolean)'::regprocedure),
        'Hiring screen: the hiring manager or Alex ticks a joiner''s first 1:1 / clients briefed / tools / 30-day check-in; checks can_activate_hire.')
on conflict do nothing;
grant execute on function app.tick_hire_followup(uuid, text, boolean) to authenticated;

-- When each joiner first added a task and first uploaded an invoice, for the
-- crew's hire screen. Dates only.
create or replace function app.hire_followup_signals()
returns table(hire_id uuid, first_task_on date, first_invoice_on date)
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select h.id,
         (select min(t.task_date) from app.daily_tasks t where t.employee_id = e.id),
         (select min(i.uploaded_at)::date from app.invoices i where i.employee_id = e.id)
  from app.hires h
  join app.employees e on lower(e.email::text) = lower(h.work_email)
  where app.is_hiring_crew();
$$;
revoke all on function app.hire_followup_signals() from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.hire_followup_signals()'::regprocedure),
        'Hiring screen: each joiner''s first task date and first invoice date; nothing unless is_hiring_crew().')
on conflict do nothing;
grant execute on function app.hire_followup_signals() to authenticated;
