-- Wins: one line per week instead of one per day (8 Oct 2026: the daily
-- lines were "taking over the feed"). Distinct people need counting per week,
-- which per-day rows can't give, so this returns the week totals. Counts only.
create or replace function app.home_work_weeks(p_since date)
returns table(week_start date, tasks_done int, people int, estimated boolean)
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  with act as (
    select date_trunc('week', activity_date)::date as wk, count(distinct employee_id)::int as people
    from app.task_activity where activity_date >= p_since group by 1
  ), done as (
    select date_trunc('week', done_on)::date as wk, count(*)::int as tasks_done, bool_or(estimated) as estimated
    from app.task_completions where done_on >= p_since group by 1
  )
  select coalesce(a.wk, d.wk), coalesce(d.tasks_done, 0), coalesce(a.people, 0), coalesce(d.estimated, false)
  from act a full join done d on d.wk = a.wk
  where app.is_employee()
  order by 1 desc;
$$;
revoke all on function app.home_work_weeks(date) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.home_work_weeks(date)'::regprocedure),
        'Home Wins: weekly counts of tasks done and distinct people active; nothing unless is_employee().')
on conflict do nothing;
grant execute on function app.home_work_weeks(date) to authenticated;
