-- Everyone sees the same streaks (28 Sep 2026).
--
-- Streaks are computed in the browser from task_activity plus APPROVED leave:
-- a leave day neither counts nor breaks a streak, however many there are.
-- But leave_requests RLS is own-or-leadership, so on an ordinary employee's
-- screen every COLLEAGUE's leave read as a missed day: the first used their
-- monthly grace, the second broke the streak. On 28 Sep Luke's real streak
-- was 20 and non-leadership colleagues saw 7; three others read one day high.
-- Leadership (who can read all leave) saw the right numbers, which is why it
-- went unnoticed.
--
-- app.streak_leave_ranges(p_since) returns only (employee, start, end) of
-- approved leave for active employees — no type, no reason, no status, no
-- half-day flag (a half day off is skipped whole, as before). The home feed
-- already tells every employee who is on leave each day, so dates alone add
-- little. Window clamped to 200 days (the streak strip reads 170).
--
-- Access: SECURITY DEFINER, answers only for signed-in EMPLOYEES
-- (app.is_employee(); partners get nothing). Declared in
-- app_private.callable_definer_functions before the grant, as
-- guard_access_ddl requires. No anon access.

create or replace function app.streak_leave_ranges(p_since date)
returns table(employee_id uuid, start_date date, end_date date)
language sql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
  select lr.employee_id, lr.start_date, lr.end_date
  from app.leave_requests lr
  join app.employees e on e.id = lr.employee_id
  where app.is_employee()
    and e.is_active
    and lr.status = 'approved'
    and lr.end_date >= greatest(coalesce(p_since, current_date - 170), current_date - 200)
  order by lr.employee_id, lr.start_date;
$fn$;

revoke all on function app.streak_leave_ranges(date) from public, anon;

insert into app_private.callable_definer_functions(signature, reason) values
  (app_private.fn_signature('app.streak_leave_ranges(date)'::regprocedure),
   'Home streak strip (loadStreakData): colleagues'' approved-leave DATES only, employees only, 200-day window (28 Sep 2026)')
on conflict do nothing;

grant execute on function app.streak_leave_ranges(date) to authenticated;
