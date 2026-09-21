-- Let the onboarding RPC write the fields it is supposed to write.
--
-- 202607170005 guarded setup_pending / requested_department_id /
-- employment_type / capacity_percent against self-writes, and gave onboarding
-- app.submit_onboarding_profile() as the sanctioned path. But SECURITY DEFINER
-- does NOT get past the trigger: the trigger asks whether the CALLER is
-- leadership, not which role is executing, so a new joiner's declaration was
-- silently reverted by the very guard meant to permit it. (Activation escaped
-- this only because both approvers happen to be leadership — luck, not design.)
--
-- The fix is an explicit, transaction-local sanction flag. Only these two
-- SECURITY DEFINER functions set it, both after validating the caller, and it
-- dies with the transaction. It is not reachable from PostgREST: there is no
-- endpoint that runs set_config, so a client cannot raise it by itself.
--
-- Named app.onboarding_sanctioned rather than something generic so a future
-- reader can see exactly which two callers are allowed to raise it.

create or replace function app.trg_block_employee_self_escalation()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public'
as $$
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
  END IF;
  RETURN NEW;
END;
$$;

-- Note the flag is raised AFTER the caller is resolved, and access_level /
-- is_active / approver_emails are never written here — the sanction covers the
-- onboarding declaration only, not the escalation-sensitive fields.
create or replace function app.submit_onboarding_profile(
  p_direct_manager_email text,
  p_requested_department_id uuid,
  p_employment_type app.employment_type,
  p_current_city text,
  p_timezone text,
  p_date_of_birth date,
  p_emergency_contact_name text,
  p_emergency_contact_phone text
)
returns void
language plpgsql
security definer
set search_path to 'app', 'public'
as $$
declare
  v_employee_id uuid;
begin
  select id into v_employee_id
    from app.employees
   where auth_user_id = auth.uid() and is_active;

  if v_employee_id is null then
    raise exception 'No active employee for the current session.';
  end if;
  if p_requested_department_id is null then
    raise exception 'A team is required.';
  end if;
  if p_employment_type is null then
    raise exception 'Employment type is required.';
  end if;

  perform set_config('app.onboarding_sanctioned', 'on', true);  -- transaction-local

  update app.employees
     set direct_manager_email     = p_direct_manager_email,
         requested_department_id  = p_requested_department_id,
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
$$;

-- Activation raises it too, so it stops depending on the accident that both
-- approvers are leadership. If a non-leadership approver is ever configured,
-- activation must still work.
create or replace function app.activate_employee_setup(
  p_employee_id uuid,
  p_department_id uuid,
  p_employment_type app.employment_type,
  p_capacity_percent numeric,
  p_client_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path to 'app', 'public'
as $$
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
  -- A project-based person with no clients would fall through to "unscoped" and
  -- see everything — the precise hole setup_pending exists to close. Refuse.
  if p_employment_type = 'fractional' and coalesce(array_length(p_client_ids, 1), 0) = 0 then
    raise exception 'A project-based person must be scoped to at least one client.';
  end if;

  perform set_config('app.onboarding_sanctioned', 'on', true);

  update app.employees
     set department_id = p_department_id,
         employment_type = p_employment_type,
         capacity_percent = p_capacity_percent,
         -- Project-based people don't accrue leave (agreed Jul 2026).
         leave_tracking_enabled = (p_employment_type = 'full-time'),
         task_nudge_enabled = (p_employment_type = 'full-time'),
         requested_department_id = null,
         setup_pending = false,
         updated_at = now()
   where id = p_employee_id;

  if not found then
    raise exception 'Employee not found: %', p_employee_id;
  end if;

  perform set_config('app.onboarding_sanctioned', 'off', true);

  -- Replace scope wholesale: activation is the definitive statement of who they
  -- work with, and re-running it must converge rather than accumulate.
  delete from app.employee_client_scope where employee_id = p_employee_id;
  if coalesce(array_length(p_client_ids, 1), 0) > 0 then
    insert into app.employee_client_scope (employee_id, client_id)
    select p_employee_id, unnest(p_client_ids)
    on conflict (employee_id, client_id) do nothing;
  end if;
end;
$$;
