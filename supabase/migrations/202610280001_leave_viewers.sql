-- 28 Oct 2026 (Alex): Blake (accounts) sees everyone's leave balances for
-- the financial year, read-only, plus last year's. A short list in app_config
-- (leave_viewer_emails), like brief_viewer_emails; leadership is unchanged.
-- He gets the Team balances numbers only: leave_requests RLS still shows him
-- his own requests and nobody else's reasons.

insert into app.app_config (key, value)
values ('leave_viewer_emails', '["finance@youragency.com"]'::jsonb)
on conflict (key) do nothing;

create or replace function app.is_leave_viewer()
 returns boolean
 language sql
 stable security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
  select exists (
    select 1 from app.employees e
    where e.auth_user_id = auth.uid() and e.is_active and e.access_paused_at is null
      and lower(e.email) in (
        select lower(jsonb_array_elements_text(
          coalesce(nullif((select value from app.app_config where key = 'leave_viewer_emails'), 'null'::jsonb), '[]'::jsonb)))
      )
  );
$function$;

insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.is_leave_viewer()'::regprocedure),
        'Leave page Team balances panel + get_leave_summaries_for_employees: is the caller on leave_viewer_emails (active, unpaused)')
on conflict do nothing;
revoke all on function app.is_leave_viewer() from public, anon;
grant execute on function app.is_leave_viewer() to authenticated;

-- Redefined from the LIVE definition: leave viewers may read the summaries;
-- cycle rows are only created for the current year; a past year reads its
-- (archived) records.
CREATE OR REPLACE FUNCTION app.get_leave_summaries_for_employees(p_employee_ids uuid[], p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
declare
  emp_id uuid;
  cycle_row app.employee_leave_cycles%rowtype;
  result_rows jsonb := '[]'::jsonb;
begin
  if not (app.is_leadership_or_admin() or app.is_leave_viewer()) then
    raise exception 'Access denied: requires leadership or admin role.';
  end if;

  -- Ensure cycle records exist for each employee (has side effects: inserts
  -- rows). Only for the year running now: a look back at last year reads the
  -- records that exist and never makes new ones (28 Oct 2026).
  if app.leave_cycle_start(p_as_of_date) = app.leave_cycle_start(current_date) then
  foreach emp_id in array p_employee_ids loop
    begin
      perform app_private.ensure_leave_cycle_record(emp_id, p_as_of_date);
    exception when others then
      -- Skip employees that error (inactive, etc.)
      null;
    end;
  end loop;
  end if;

  -- Single set-based query for all summaries
  select coalesce(jsonb_agg(row_obj order by row_obj->>'full_name'), '[]'::jsonb)
  into result_rows
  from (
    select jsonb_build_object(
      'employee_id', e.id,
      'full_name', e.full_name,
      'leave_tracking_enabled', e.leave_tracking_enabled,
      'pl_allocated', c.pl_allocated,
      'cl_allocated', c.cl_allocated,
      'sl_allocated', c.sl_allocated,
      'pl_taken', coalesce(lr_agg.pl_taken, 0),
      'cl_taken', coalesce(lr_agg.cl_taken, 0),
      'sl_taken', coalesce(lr_agg.sl_taken, 0),
      'pl_remaining', c.pl_allocated - coalesce(lr_agg.pl_taken, 0),
      'cl_remaining', c.cl_allocated - coalesce(lr_agg.cl_taken, 0),
      'sl_remaining', c.sl_allocated - coalesce(lr_agg.sl_taken, 0)
    ) as row_obj
    from unnest(p_employee_ids) as eid(id)
    join app.employees e on e.id = eid.id and e.is_active = true
    join app.employee_leave_cycles c
      on c.employee_id = e.id
      and c.cycle_start = app.leave_cycle_start(p_as_of_date)
      -- last year's records are archived at rollover; a look back reads them
      and (c.archived_at is null or app.leave_cycle_start(p_as_of_date) < app.leave_cycle_start(current_date))
    left join lateral (
      select
        coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, c.cycle_start, c.cycle_end))
          filter (where lr.leave_type = 'PL' and lr.status = 'approved'), 0) as pl_taken,
        coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, c.cycle_start, c.cycle_end))
          filter (where lr.leave_type = 'CL' and lr.status = 'approved'), 0) as cl_taken,
        coalesce(sum((case when lr.is_half_day then 0.5 else 1 end) * app.overlap_days(lr.start_date, lr.end_date, c.cycle_start, c.cycle_end))
          filter (where lr.leave_type = 'SL' and lr.status = 'approved'), 0) as sl_taken
      from app.leave_requests lr
      where lr.employee_id = e.id
        and lr.status = 'approved'
        and lr.end_date >= c.cycle_start
        and lr.start_date <= c.cycle_end
    ) lr_agg on true
  ) sub;

  return result_rows;
end;
$function$;
