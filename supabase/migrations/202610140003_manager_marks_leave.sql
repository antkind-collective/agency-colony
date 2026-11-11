-- A manager marks someone out (14 Oct 2026): "if someone is super sick,
-- their manager should be able to set that". Only the person's own manager
-- (employees.direct_manager_email; their leave approver when no manager is
-- set) may do it. The leave is approved at once, decided by the manager, and
-- marked_by_employee_id records who added it. prepare_leave_request is
-- redefined from its LIVE definition: only the SL certificate rule changes.
alter table app.leave_requests add column if not exists marked_by_employee_id uuid references app.employees(id) on delete set null;

create or replace function app_private.is_manager_of(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select exists (
    select 1 from app.employees t, app.employees me
    where t.id = p_employee_id and t.is_active
      and me.id = app.current_employee_id() and me.id <> t.id
      and (
        lower(coalesce(nullif(btrim(t.direct_manager_email), ''), '')) = lower(me.email::text)
        or (coalesce(nullif(btrim(t.direct_manager_email), ''), '') = ''
            and lower(me.email::text) = any (select lower(x::text) from unnest(t.approver_emails) x))
      )
  );
$$;
revoke all on function app_private.is_manager_of(uuid) from public, anon, authenticated;

-- The people this caller can mark out: whoever reports to them.
create or replace function app.my_leave_reports()
returns table(id uuid, full_name text)
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select e.id, e.full_name from app.employees e
  where e.is_active and coalesce(e.leave_tracking_enabled, true) and app_private.is_manager_of(e.id)
  order by e.full_name;
$$;
revoke all on function app.my_leave_reports() from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.my_leave_reports()'::regprocedure),
        'Leave form "For" picker: the caller''s own reports (is_manager_of); empty for everyone else.')
on conflict do nothing;
grant execute on function app.my_leave_reports() to authenticated;

create or replace function app.mark_leave_for(p_employee_id uuid, p_leave_type app.leave_type, p_start_date date, p_end_date date,
  p_reason text default null, p_is_half_day boolean default false)
returns app.leave_requests
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
declare
  me uuid := app.current_employee_id();
  r app.leave_requests%rowtype;
begin
  if me is null or not app_private.is_manager_of(p_employee_id) then
    raise exception 'Only their manager can mark someone out.';
  end if;
  if p_leave_type = 'SR' then
    raise exception 'A streak reward is taken by the person themselves.';
  end if;
  insert into app.leave_requests (employee_id, leave_type, start_date, end_date, reason, is_half_day,
    status, decided_by_employee_id, decided_at, decision_note, marked_by_employee_id)
  values (p_employee_id, p_leave_type, p_start_date, p_end_date, nullif(btrim(p_reason), ''), coalesce(p_is_half_day, false) and p_start_date = p_end_date,
    'approved', me, now(), 'Marked out by their manager', me)
  returning * into r;
  return r;
end;
$$;
revoke all on function app.mark_leave_for(uuid, app.leave_type, date, date, text, boolean) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.mark_leave_for(uuid, app.leave_type, date, date, text, boolean)'::regprocedure),
        'Leave form: a manager marks their own report out (approved at once); refuses anyone else.')
on conflict do nothing;
grant execute on function app.mark_leave_for(uuid, app.leave_type, date, date, text, boolean) to authenticated;

CREATE OR REPLACE FUNCTION app.prepare_leave_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
declare
  employee_row app.employees%rowtype;
  dept_row app.departments%rowtype;
  computed_approvers citext[];
  requested_days int;
begin
  select *
  into employee_row
  from app.employees e
  where e.id = new.employee_id
    and e.is_active = true;

  if not found then
    raise exception 'Active employee record not found.';
  end if;

  if employee_row.leave_tracking_enabled = false then
    raise exception 'Finance leave workflow is excluded from Agency Colony v1.';
  end if;

  if new.end_date < new.start_date then
    raise exception 'Leave end date cannot be before start date.';
  end if;

  requested_days := (new.end_date - new.start_date) + 1;

  -- A manager marking someone out sick (marked_by_employee_id) is not held
  -- up for a certificate the sick person can send later (14 Oct 2026).
  if new.leave_type = 'SL' and requested_days >= 3 and coalesce(new.medical_certificate_url, '') = ''
     and new.marked_by_employee_id is null then
    raise exception 'SL requests for 3+ days require a medical certificate URL.';
  end if;

  select *
  into dept_row
  from app.departments d
  where d.id = employee_row.department_id;

  computed_approvers := employee_row.approver_emails;

  if coalesce(array_length(computed_approvers, 1), 0) = 0 and dept_row.approver_email is not null then
    computed_approvers := array[lower(dept_row.approver_email::text)::citext];
  end if;

  if coalesce(array_length(computed_approvers, 1), 0) = 0 then
    raise exception 'No leave approver configured for this employee/department.';
  end if;

  new.approver_emails := computed_approvers;

  -- Superadmin's own leave needs no approval theater: log it approved.
  -- (Insert policy doesn't require 'pending'; the leave-submitted email
  -- already skips non-pending rows, so no self-notification goes out.)
  if tg_op = 'INSERT'
    and new.employee_id = app.current_employee_id()
    and app.is_superadmin()
  then
    new.status := 'approved';
    new.decided_by_employee_id := new.employee_id;
    new.decided_at := now();
    new.decision_note := 'Auto-approved (superadmin)';
  end if;

  if tg_op = 'UPDATE' then
    if old.status <> new.status and new.status in ('approved', 'rejected') then
      if new.decided_by_employee_id is null then
        new.decided_by_employee_id := app.current_employee_id();
      end if;
      if new.decided_at is null then
        new.decided_at := now();
      end if;
    elsif new.status = 'pending' then
      new.decided_by_employee_id := null;
      new.decided_at := null;
      new.decision_note := null;
    end if;
  end if;

  return new;
end;
$function$;
