-- T3 (8 Oct 2026). Celebrate, never rank: personal bests compare a
-- person only with their own past, and only the good news leaves the
-- database — nobody can read anyone's ordinary or slow weeks through this.

-- Weeks that were someone's best yet: more finished tasks than any earlier
-- week of theirs, with at least three earlier weeks to beat and 10+ tasks.
create or replace function app.home_personal_bests(p_since date)
returns table(employee_id uuid, week_start date, tasks int)
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  with weekly as (
    select c.employee_id, date_trunc('week', c.done_on)::date as wk, count(*)::int as n
    from app.task_completions c
    group by 1, 2
  ), ranked as (
    select w.*,
           max(n) over (partition by employee_id order by wk rows between unbounded preceding and 1 preceding) as prev_best,
           count(*) over (partition by employee_id order by wk rows between unbounded preceding and 1 preceding) as prev_weeks
    from weekly w
  )
  select employee_id, wk, n
  from ranked
  where app.is_employee()
    and wk >= date_trunc('week', p_since)::date
    and prev_weeks >= 3 and n >= 10 and n > coalesce(prev_best, 0)
  order by wk desc;
$$;
revoke all on function app.home_personal_bests(date) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.home_personal_bests(date)'::regprocedure),
        'Home Wins: weeks that beat a person''s own previous best (only those); nothing unless is_employee().')
on conflict do nothing;
grant execute on function app.home_personal_bests(date) to authenticated;

-- Leadership: per client, planned time (sum of weekly allocation %) against
-- finished tasks (tasks carry their client as text in notes).
create or replace function app.overview_plan_vs_done(p_since date)
returns table(client text, planned_pct numeric, tasks_done int)
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  with plan as (
    select cl.name as client, sum(a.allocation_percent) as planned
    from app.allocations a
    join app.projects p on p.id = a.project_id
    join app.clients cl on cl.id = p.client_id
    where a.period_type = 'week' and a.period_start >= date_trunc('week', p_since)::date
      and a.period_start <= (now() at time zone 'Asia/Kolkata')::date
    group by 1
  ), done as (
    select btrim(t.notes) as client, count(*)::int as n
    from app.task_completions c
    join app.daily_tasks t on t.id = c.task_id
    where c.done_on >= p_since and coalesce(btrim(t.notes), '') <> ''
    group by 1
  )
  select coalesce(p.client, d.client), coalesce(p.planned, 0), coalesce(d.n, 0)
  from plan p full join done d on lower(d.client) = lower(p.client)
  where app.is_leadership_or_admin()
  order by 2 desc, 3 desc;
$$;
revoke all on function app.overview_plan_vs_done(date) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.overview_plan_vs_done(date)'::regprocedure),
        'Overview (leadership): planned allocation vs finished tasks per client; nothing unless is_leadership_or_admin().')
on conflict do nothing;
grant execute on function app.overview_plan_vs_done(date) to authenticated;
