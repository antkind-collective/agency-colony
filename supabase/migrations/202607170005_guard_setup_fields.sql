-- Guard the fields that decide access, and give onboarding a safe way to write.
--
-- The hole this closes (introduced by 202607170004, found before shipping):
-- setup_pending was self-writable. A project-based joiner could POST
-- setup_pending=false to their own row and, having no scope rows yet, fall
-- straight through can_see_client's "unscoped ⇒ sees everything" branch — the
-- exact escalation the pending state exists to prevent.
--
-- employment_type and capacity_percent join the guarded list too. Both were
-- already self-writable (the profile form doesn't mark them leadership-only),
-- which was merely untidy when they only affected leave and utilization maths.
-- Now employment_type is half of the client gate, so it is a permission field
-- and belongs with access_level.
--
-- These are terms of someone's engagement, not self-service settings: the
-- person reports them at onboarding, an approver confirms them.

create or replace function app.trg_block_employee_self_escalation()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public'
as $$
BEGIN
  -- If the updater is NOT leadership/admin, block changes to sensitive columns
  IF NOT app.is_leadership_or_admin() THEN
    NEW.access_level := OLD.access_level;
    NEW.is_active := OLD.is_active;
    NEW.leave_tracking_enabled := OLD.leave_tracking_enabled;
    NEW.department_id := OLD.department_id;
    NEW.approver_emails := OLD.approver_emails;
    -- Added Jul 2026: these decide client visibility and capacity maths.
    -- app.submit_onboarding_profile() is the sanctioned way for a person to
    -- declare them; app.activate_employee_setup() is how they get applied.
    NEW.setup_pending := OLD.setup_pending;
    NEW.requested_department_id := OLD.requested_department_id;
    NEW.employment_type := OLD.employment_type;
    NEW.capacity_percent := OLD.capacity_percent;
    NEW.task_nudge_enabled := OLD.task_nudge_enabled;
  END IF;
  RETURN NEW;
END;
$$;

-- The onboarding submission. SECURITY DEFINER so a new joiner can DECLARE the
-- guarded fields (their team, how they work) without being able to write them
-- freely — it only ever touches the caller's own row, and it can only ever set
-- setup_pending to true. Clearing it is activate_employee_setup()'s job.
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
end;
$$;

revoke all on function app.submit_onboarding_profile(text, uuid, app.employment_type, text, text, date, text, text) from public;
grant execute on function app.submit_onboarding_profile(text, uuid, app.employment_type, text, text, date, text, text) to authenticated;
