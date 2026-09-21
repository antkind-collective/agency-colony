-- Onboarding fixes (29 Jul 2026): people were landing with only a
-- first name (full_name inherits the Google JWT name and the form never asked).
-- The RPC now takes and REQUIRES a full name — at least two words — validated
-- server-side so the rule can't be bypassed. Drop-and-recreate because adding
-- a parameter would otherwise create an overload next to the old signature.

drop function if exists app.submit_onboarding_profile(text, uuid, app.employment_type, text, text, date, text, text);

create function app.submit_onboarding_profile(
  p_full_name text,
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
as $function$
declare
  v_employee_id uuid;
  v_full_name text;
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

  v_full_name := btrim(coalesce(p_full_name, ''));
  if array_length(regexp_split_to_array(v_full_name, '\s+'), 1) < 2 then
    raise exception 'Please enter your full name — first and last.';
  end if;

  perform set_config('app.onboarding_sanctioned', 'on', true);  -- transaction-local

  update app.employees
     set full_name                = v_full_name,
         direct_manager_email     = p_direct_manager_email,
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
$function$;

grant execute on function app.submit_onboarding_profile(text, text, uuid, app.employment_type, text, text, date, text, text) to authenticated;
