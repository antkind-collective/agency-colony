-- Backfill an estimate of finished tasks for the last 30 days (8 Oct
-- 2026). daily_tasks only keeps a task's current status, and "archived" covers
-- both finished tasks (done, archived the next day) and duplicates the
-- overnight roll-over archived. A finished task is archived, not a repeating
-- task, and has no copy of itself on a later day; a duplicate always has one.
-- Rows added here are marked estimated, and Wins says "about" for those days.

alter table app.task_completions add column if not exists estimated boolean not null default false;

insert into app.task_completions (task_id, employee_id, done_on, done_at, estimated)
select t.id, t.employee_id, t.task_date, t.task_date::timestamp at time zone 'Asia/Kolkata', true
from app.daily_tasks t
where t.status = 'archived'
  and t.task_date >= ((now() at time zone 'Asia/Kolkata')::date - 30)
  and t.task_date < (now() at time zone 'Asia/Kolkata')::date
  and t.recurring_task_id is null
  and not exists (
    select 1 from app.daily_tasks l
    where l.employee_id = t.employee_id and lower(l.task_title) = lower(t.task_title) and l.task_date > t.task_date)
on conflict (task_id) do nothing;

-- Tasks still sitting at "done" are certain completions; only their day is
-- taken from the task's date.
insert into app.task_completions (task_id, employee_id, done_on, done_at, estimated)
select t.id, t.employee_id, t.task_date, t.updated_at, false
from app.daily_tasks t
where t.status = 'done' and t.task_date >= ((now() at time zone 'Asia/Kolkata')::date - 30)
on conflict (task_id) do nothing;

drop function if exists app.home_work_done(date);
create function app.home_work_done(p_since date)
returns table(day date, tasks_done int, people int, estimated boolean)
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  with days as (
    select activity_date as day, count(distinct employee_id)::int as people
    from app.task_activity where activity_date >= p_since group by 1
  ), done as (
    select done_on as day, count(*)::int as tasks_done, bool_or(estimated) as estimated
    from app.task_completions where done_on >= p_since group by 1
  )
  select coalesce(d.day, t.day), coalesce(t.tasks_done, 0), coalesce(d.people, 0), coalesce(t.estimated, false)
  from days d full join done t on t.day = d.day
  where app.is_employee()
  order by 1 desc;
$$;
revoke all on function app.home_work_done(date) from public, anon, authenticated;
delete from app_private.callable_definer_functions where signature like 'app.home_work_done(%';
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.home_work_done(date)'::regprocedure),
        'Home Wins: per-day counts of tasks done and people active; returns nothing unless the caller is_employee().')
on conflict do nothing;
grant execute on function app.home_work_done(date) to authenticated;
