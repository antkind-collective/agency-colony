-- Out of office (4 Nov 2026). Fractional people, and anyone whose leave
-- Colony doesn't track (Blake), had no way to say they're away: the leave
-- form is off for them, so they never showed in Who's out. Now they mark
-- themselves out here. No balance, no approval: it's an FYI. Their manager
-- gets an email (ooo-notify) and Home shows them as on leave.
--
-- Its own table, not leave_requests, so nothing here can reach a leave
-- balance, payroll or the approval flow.

-- Who may mark themselves out: the people the leave form is closed to.
create or replace function app.can_mark_out_of_office()
 returns boolean
 language sql
 stable security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
  select coalesce((
    select e.is_active and e.access_paused_at is null
      and (e.employment_type = 'fractional'
           or e.leave_tracking_enabled = false
           or coalesce(d.leave_tracking_enabled, true) = false)
    from app.employees e
    left join app.departments d on d.id = e.department_id
    where e.id = app.current_employee_id()
  ), false);
$function$;
revoke all on function app.can_mark_out_of_office() from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.can_mark_out_of_office()'::regprocedure),
        'out_of_office insert RLS and the Leave page: may the caller mark themselves out (fractional or leave not tracked)')
on conflict do nothing;
grant execute on function app.can_mark_out_of_office() to authenticated;

create table if not exists app.out_of_office (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references app.employees(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  is_half_day boolean not null default false,
  note text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now(),
  constraint ooo_date_range_ck check (end_date >= start_date and end_date - start_date <= 90),
  constraint ooo_half_day_single_day check (not is_half_day or start_date = end_date)
);
create index if not exists out_of_office_employee_idx on app.out_of_office(employee_id, start_date);

alter table app.out_of_office enable row level security;
revoke all on app.out_of_office from anon, authenticated;
grant select, insert, delete on app.out_of_office to authenticated;

create policy out_of_office_select_own_or_leadership on app.out_of_office
  for select to authenticated
  using (employee_id = (select app.current_employee_id()) or (select app.is_leadership_or_admin()));
create policy out_of_office_insert_own on app.out_of_office
  for insert to authenticated
  with check (employee_id = (select app.current_employee_id()) and (select app.can_mark_out_of_office())
              and start_date >= (now() at time zone 'Asia/Kolkata')::date - 7);
create policy out_of_office_delete_own_or_leadership on app.out_of_office
  for delete to authenticated
  using (employee_id = (select app.current_employee_id()) or (select app.is_leadership_or_admin()));

-- No two entries on the same dates (the same double-save that showed Carmen
-- twice, 26 Oct). Two half days on one date are fine.
create or replace function app_private.guard_ooo_overlap()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
begin
  if exists (
    select 1 from app.out_of_office o
    where o.employee_id = new.employee_id
      and o.id <> new.id
      and o.start_date <= new.end_date and o.end_date >= new.start_date
      and not (o.is_half_day and new.is_half_day and o.start_date = new.start_date)
  ) then
    raise exception 'You are already marked out on these dates.';
  end if;
  return new;
end;
$function$;
revoke all on function app_private.guard_ooo_overlap() from public, anon, authenticated;

drop trigger if exists trg_out_of_office_no_overlap on app.out_of_office;
create trigger trg_out_of_office_no_overlap
  before insert on app.out_of_office
  for each row execute function app_private.guard_ooo_overlap();

-- Who's out now includes them, as type 'OOO', already approved. Redefined
-- from the live definition (4 Nov 2026); only the union is new.
CREATE OR REPLACE FUNCTION app.home_whos_out(p_from date, p_until date)
 RETURNS TABLE(full_name text, email text, leave_type text, status text, start_date date, end_date date, is_half_day boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  SELECT * FROM (
    SELECT e.full_name, e.email::text, lr.leave_type::text, lr.status::text, lr.start_date, lr.end_date, lr.is_half_day
    FROM app.leave_requests lr
    JOIN app.employees e ON e.id = lr.employee_id
    WHERE app.is_employee()
      AND e.is_active
      AND p_until >= p_from
      AND p_until <= p_from + 31               -- sanity-clamp the window
      AND lr.end_date >= p_from
      AND lr.start_date <= p_until
      AND (
        lr.status = 'approved'
        OR (lr.status = 'pending' AND lr.leave_type = 'SL' AND lr.start_date <= current_date)
      )
    UNION ALL
    SELECT e.full_name, e.email::text, 'OOO', 'approved', o.start_date, o.end_date, o.is_half_day
    FROM app.out_of_office o
    JOIN app.employees e ON e.id = o.employee_id
    WHERE app.is_employee()
      AND e.is_active
      AND p_until >= p_from
      AND p_until <= p_from + 31
      AND o.end_date >= p_from
      AND o.start_date <= p_until
  ) w
  ORDER BY w.start_date, w.full_name;
$function$;
