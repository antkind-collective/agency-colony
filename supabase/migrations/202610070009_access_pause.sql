-- Access pause (7 Oct 2026): a switch that takes away someone's
-- Colony access without deactivating them. Two uses:
--   * 'emergency_contact' — S7: anyone still without an emergency contact after
--     the deadline is paused by the emergency-contact-pause cron; saving a
--     contact through app.save_my_emergency_contact() lifts it by itself.
--   * 'manual' — "we should be able to pause in emergency situations anyway":
--     the superadmin pauses or resumes anyone from their profile.
-- Enforced in the database, not just the screen: every helper that recognises
-- a signed-in employee (current_employee_id and the role checks that look the
-- caller up directly) now also requires access_paused_at is null, so a paused
-- person's existing session reads nothing the moment the flag is set. Each is
-- redefined from its LIVE definition (pg_get_functiondef, 7 Oct 2026) with only
-- that condition added. The superadmin cannot be paused (no lockout).

alter table app.employees
  add column if not exists access_paused_at timestamptz,
  add column if not exists access_pause_reason text check (access_pause_reason in ('emergency_contact', 'manual')),
  add column if not exists access_pause_note text,
  add column if not exists access_paused_by uuid references app.employees(id);

comment on column app.employees.access_paused_at is 'Set while this person''s Colony access is paused. Every employee helper treats them as not signed in.';
comment on column app.employees.access_pause_reason is 'emergency_contact (lifts itself when they save one) or manual (superadmin resumes).';

-- Leadership sees who is paused and why; the note stays with the superadmin RPC.
grant select (access_paused_at, access_pause_reason) on app.employees to authenticated;

-- Only the superadmin (through the RPC below) or the server may change the
-- pause. employees_update_own would otherwise let a paused person unpause
-- themselves with a plain update.
create or replace function app_private.guard_access_pause()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if (new.access_paused_at is distinct from old.access_paused_at
      or new.access_pause_reason is distinct from old.access_pause_reason
      or new.access_pause_note is distinct from old.access_pause_note
      or new.access_paused_by is distinct from old.access_paused_by)
     -- The request's role, not session_user: through PostgREST the session is
     -- always 'authenticator'; a signed-in browser runs as authenticated/anon,
     -- the server's crons as service_role, migrations as none.
     and coalesce(current_setting('role', true), 'none') in ('authenticated', 'anon')
     and coalesce(current_setting('app.access_pause_rpc', true), '') <> 'on' then
    raise exception 'Access pause can only be changed by the superadmin.';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_access_pause() from public, anon, authenticated;

drop trigger if exists trg_guard_access_pause on app.employees;
create trigger trg_guard_access_pause
  before update on app.employees
  for each row execute function app_private.guard_access_pause();

CREATE OR REPLACE FUNCTION app.current_employee_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  select e.id
  from app.employees e
  where e.auth_user_id = auth.uid()
    and e.is_active = true and e.access_paused_at is null
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION app.current_access_level()
 RETURNS app.access_level
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  select e.access_level
  from app.employees e
  where e.auth_user_id = auth.uid()
    and e.is_active = true and e.access_paused_at is null
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION app.is_leadership_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  select exists (
    select 1
    from app.employees e
    where e.auth_user_id = auth.uid()
      and e.is_active = true and e.access_paused_at is null
      and e.access_level in ('leadership', 'admin')
  );
$function$;

CREATE OR REPLACE FUNCTION app.is_setup_approver()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  select app.is_superadmin()
      or exists (
        select 1
        from app.employees e
        where e.auth_user_id = auth.uid()
          and e.is_active and e.access_paused_at is null
          and lower(e.email) in (
            select lower(jsonb_array_elements_text(
              coalesce(
                nullif((select value from app.app_config where key = 'setup_approver_emails'), 'null'::jsonb),
                '["admin@youragency.com","am-lead@youragency.com"]'::jsonb
              )
            ))
          )
      );
$function$;

CREATE OR REPLACE FUNCTION app.is_brief_reviewer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  select app.is_leadership_or_admin()
      or exists (
        select 1
        from app.employees e
        where e.auth_user_id = auth.uid()
          and e.is_active and e.access_paused_at is null
          and lower(e.email) in (
            select lower(jsonb_array_elements_text(
              coalesce(
                nullif((select value from app.app_config where key = 'brief_reviewer_emails'), 'null'::jsonb),
                '["rhea@youragency.com","mara@youragency.com"]'::jsonb
              )
            ))
          )
      );
$function$;

CREATE OR REPLACE FUNCTION app.is_brief_viewer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  select exists (
    select 1 from app.employees e
    where e.auth_user_id = auth.uid() and e.is_active and e.access_paused_at is null
      and lower(e.email) in (
        select lower(jsonb_array_elements_text(
          coalesce(nullif((select value from app.app_config where key = 'brief_viewer_emails'), 'null'::jsonb), '[]'::jsonb)))
      )
  );
$function$;

CREATE OR REPLACE FUNCTION app.is_invoice_viewer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  select exists (
    select 1 from app.employees e
    where e.auth_user_id = auth.uid()
      and e.is_active and e.access_paused_at is null
      and lower(e.email) in ('finance@youragency.com', 'am-lead@youragency.com', 'admin@youragency.com')
  );
$function$;

CREATE OR REPLACE FUNCTION app.is_hiring_crew()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  select (app.is_setup_approver()
      or app.is_leadership_or_admin()
      or lower(coalesce(app.current_request_email(), '')) in (
        select lower(jsonb_array_elements_text(
          coalesce(nullif((select value from app.app_config where key = 'hiring_crew_emails'), 'null'::jsonb),
                   '["leo@youragency.com","finance@youragency.com"]'::jsonb)))
      )
  ) and not exists (
    -- A paused employee loses the hiring section too (7 Oct 2026).
    select 1 from app.employees p
    where lower(p.email::text) = lower(coalesce(app.current_request_email(), ''))
      and p.access_paused_at is not null
  );
$function$;

-- The paused person's way back in: save a contact, and an emergency-contact
-- pause lifts. Matches by auth.uid() directly because current_employee_id()
-- is null while paused.
create or replace function app.save_my_emergency_contact(p_name text, p_phone text)
returns boolean
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
declare
  emp_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'Add the contact''s name.'; end if;
  if btrim(coalesce(p_phone, '')) !~ '^\+[0-9]{1,4}[ ]?[0-9 ]{6,}$' then
    raise exception 'Add the phone number with its country code, e.g. +91 98765 43210.';
  end if;
  select id into emp_id from app.employees where auth_user_id = auth.uid() and is_active limit 1;
  if emp_id is null then raise exception 'No Colony profile for this account.'; end if;
  perform set_config('app.access_pause_rpc', 'on', true);
  update app.employees
     set emergency_contact_name = btrim(p_name),
         emergency_contact_phone = btrim(p_phone),
         access_paused_at = case when access_pause_reason = 'emergency_contact' then null else access_paused_at end,
         access_pause_note = case when access_pause_reason = 'emergency_contact' then null else access_pause_note end,
         access_paused_by = case when access_pause_reason = 'emergency_contact' then null else access_paused_by end,
         access_pause_reason = case when access_pause_reason = 'emergency_contact' then null else access_pause_reason end,
         updated_at = now()
   where id = emp_id;
  perform set_config('app.access_pause_rpc', '', true);
  return true;
end;
$$;
revoke all on function app.save_my_emergency_contact(text, text) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.save_my_emergency_contact(text,text)'::regprocedure),
        'The access-pause screen: a signed-in employee saves their own emergency contact (matched by auth.uid()); lifts an emergency_contact pause.')
on conflict do nothing;
grant execute on function app.save_my_emergency_contact(text, text) to authenticated;

-- The emergency switch. Superadmin only; the superadmin cannot be paused.
create or replace function app.set_employee_access_pause(p_employee uuid, p_pause boolean, p_note text default null)
returns boolean
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
declare
  target app.employees%rowtype;
begin
  if not app.is_superadmin() then raise exception 'Only the superadmin can pause access.'; end if;
  select * into target from app.employees where id = p_employee;
  if not found then raise exception 'No such person.'; end if;
  if lower(target.email::text) = app.superadmin_email() then raise exception 'The superadmin cannot be paused.'; end if;
  perform set_config('app.access_pause_rpc', 'on', true);
  if p_pause then
    update app.employees
       set access_paused_at = now(), access_pause_reason = 'manual',
           access_pause_note = nullif(btrim(coalesce(p_note, '')), ''),
           access_paused_by = app.current_employee_id(), updated_at = now()
     where id = p_employee;
  else
    update app.employees
       set access_paused_at = null, access_pause_reason = null, access_pause_note = null,
           access_paused_by = null, updated_at = now()
     where id = p_employee;
  end if;
  perform set_config('app.access_pause_rpc', '', true);
  return true;
end;
$$;
revoke all on function app.set_employee_access_pause(uuid, boolean, text) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.set_employee_access_pause(uuid,boolean,text)'::regprocedure),
        'Employee profile: the superadmin pauses or resumes someone''s Colony access in an emergency (checks is_superadmin).')
on conflict do nothing;
grant execute on function app.set_employee_access_pause(uuid, boolean, text) to authenticated;
