-- Activation moves onto the hire (8 Oct 2026). "Awaiting Setup" in
-- Admin Settings is gone for hires: switching a joiner's Colony access on is a
-- step in their hire, pressed by the hiring manager (or the superadmin) and
-- nobody else. Team, type, capacity and clients come from the hire, which
-- already decided them. Activating then sets off, by itself, the All Hands and
-- Thirsty Thursday invites (joiner-calendar) and the Slack invite email
-- (joiner-slack), each ticking on the hire with its date.

alter table app.hires
  add column if not exists activation_scheduled_on date,
  add column if not exists activated_at timestamptz,
  add column if not exists slack_invited_at timestamptz;

comment on column app.hires.activation_scheduled_on is 'The day this hire''s Colony access is scheduled to switch on (scheduled_activations holds the payload). Null once activated or cancelled.';
comment on column app.hires.activated_at is 'When their Colony access was switched on, by hand or on schedule. Set by trg_employee_activated_stamp_hire.';
comment on column app.hires.slack_invited_at is 'When Colony emailed them the Slack invite (joiner-slack, after activation).';

-- Every activation path (this RPC, the schedule, the legacy Awaiting Setup for
-- people without a hire) ends with setup_pending going false, so the hire is
-- stamped there, once.
create or replace function app_private.stamp_hire_activated()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if old.setup_pending and not new.setup_pending then
    update app.hires
       set activated_at = now(), activation_scheduled_on = null, updated_at = now()
     where lower(work_email) = lower(new.email::text) and activated_at is null;
  end if;
  return new;
end;
$$;
revoke all on function app_private.stamp_hire_activated() from public, anon, authenticated;
drop trigger if exists trg_employee_activated_stamp_hire on app.employees;
create trigger trg_employee_activated_stamp_hire
  after update of setup_pending on app.employees
  for each row execute function app_private.stamp_hire_activated();

-- Who may switch a hire on: the superadmin, or that hire's hiring manager.
create or replace function app_private.can_activate_hire(p_hire_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select app.is_superadmin()
      or (app.is_employee() and exists (
            select 1 from app.hire_offer_terms t
            where t.hire_id = p_hire_id
              and lower(coalesce(t.hiring_manager_email, '')) <> ''
              and lower(t.hiring_manager_email) = lower(coalesce(app.current_request_email(), ''))));
$$;
revoke all on function app_private.can_activate_hire(uuid) from public, anon, authenticated;

-- Activate now (p_activate_on null or today) or schedule for a later day.
create or replace function app.activate_hire(p_hire_id uuid, p_activate_on date default null)
returns text
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
declare
  h app.hires%rowtype;
  t app.hire_offer_terms%rowtype;
  e app.employees%rowtype;
  dept uuid;
  etype app.employment_type;
  cap numeric;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not app_private.can_activate_hire(p_hire_id) then
    raise exception 'Only the hiring manager or Alex can switch on Colony access.';
  end if;
  select * into h from app.hires where id = p_hire_id;
  if not found then raise exception 'No such hire.'; end if;
  select * into t from app.hire_offer_terms where hire_id = p_hire_id;
  if h.work_email is null then raise exception 'They have no @youragency.com account yet.'; end if;
  select * into e from app.employees where lower(email::text) = lower(h.work_email) and is_active limit 1;
  if not found then raise exception 'They haven''t signed in to Colony yet.'; end if;
  if not e.setup_pending then raise exception 'Their Colony access is already on.'; end if;

  select id into dept from app.departments where name = t.department limit 1;
  dept := coalesce(dept, e.requested_department_id, e.department_id);
  if dept is null then raise exception 'No team on the hire. Add one in its terms first.'; end if;
  etype := coalesce(h.hire_type, 'full-time')::app.employment_type;
  cap := case when etype = 'fractional' then 50 else 100 end;
  if etype = 'fractional' and coalesce(array_length(t.scoped_client_ids, 1), 0) = 0 then
    raise exception 'A fractional hire needs at least one client in its terms before activating.';
  end if;

  delete from app.scheduled_activations where employee_id = e.id and applied_at is null;
  if p_activate_on is null or p_activate_on <= today then
    perform app_private.apply_employee_setup(e.id, dept, etype, cap, coalesce(t.scoped_client_ids, '{}'));
    return 'activated';
  end if;
  insert into app.scheduled_activations
    (employee_id, activate_on, department_id, employment_type, capacity_percent, client_ids, scheduled_by)
  values (e.id, p_activate_on, dept, etype, cap, coalesce(t.scoped_client_ids, '{}'), app.current_employee_id());
  update app.hires set activation_scheduled_on = p_activate_on, updated_at = now() where id = p_hire_id;
  return 'scheduled';
end;
$$;
revoke all on function app.activate_hire(uuid, date) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.activate_hire(uuid,date)'::regprocedure),
        'Hiring screen: the hire''s hiring manager or the superadmin switches on (or schedules) the joiner''s Colony access; checks can_activate_hire.')
on conflict do nothing;
grant execute on function app.activate_hire(uuid, date) to authenticated;

create or replace function app.cancel_hire_activation(p_hire_id uuid)
returns void
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
declare
  h app.hires%rowtype;
begin
  if not app_private.can_activate_hire(p_hire_id) then
    raise exception 'Only the hiring manager or Alex can change this.';
  end if;
  select * into h from app.hires where id = p_hire_id;
  delete from app.scheduled_activations s
   using app.employees e
   where s.employee_id = e.id and lower(e.email::text) = lower(h.work_email) and s.applied_at is null;
  update app.hires set activation_scheduled_on = null, updated_at = now() where id = p_hire_id;
end;
$$;
revoke all on function app.cancel_hire_activation(uuid) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.cancel_hire_activation(uuid)'::regprocedure),
        'Hiring screen: the hiring manager or superadmin cancels a scheduled activation; checks can_activate_hire.')
on conflict do nothing;
grant execute on function app.cancel_hire_activation(uuid) to authenticated;

-- Hires already active before this existed: stamp from their employee row so
-- nothing re-fires for them (no invites, no Slack email).
update app.hires h
   set activated_at = coalesce(h.activated_at, e.updated_at)
  from app.employees e
 where lower(e.email::text) = lower(h.work_email) and e.is_active and not e.setup_pending and h.activated_at is null;
