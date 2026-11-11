-- Wins shows how much work got done each day (8 Oct 2026). A task is
-- finished when its owner marks it done; the next day it is archived along
-- with nightly clean-up duplicates, so daily_tasks cannot say afterwards which
-- archived rows were real completions. This records the moment instead, once
-- per task, and only counts leave the database (home_work_done), never titles.

create table if not exists app.task_completions (
  task_id uuid primary key references app.daily_tasks(id) on delete cascade,
  employee_id uuid not null references app.employees(id) on delete cascade,
  done_on date not null,
  done_at timestamptz not null default now()
);
alter table app.task_completions enable row level security;
-- No policies: nobody reads rows directly; counts come from home_work_done().
revoke all on app.task_completions from anon, authenticated;
create index if not exists task_completions_done_on on app.task_completions (done_on);

create or replace function app_private.record_task_completion()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    insert into app.task_completions (task_id, employee_id, done_on)
    values (new.id, new.employee_id, (now() at time zone 'Asia/Kolkata')::date)
    on conflict (task_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function app_private.record_task_completion() from public, anon, authenticated;
drop trigger if exists trg_daily_tasks_record_completion on app.daily_tasks;
create trigger trg_daily_tasks_record_completion
  after update of status on app.daily_tasks
  for each row execute function app_private.record_task_completion();

-- Per day since p_since: tasks finished, and people who moved their work
-- forward (task_activity, which goes back further). Counts only.
create or replace function app.home_work_done(p_since date)
returns table(day date, tasks_done int, people int)
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  with days as (
    select activity_date as day, count(distinct employee_id)::int as people
    from app.task_activity
    where activity_date >= p_since
    group by 1
  ), done as (
    select done_on as day, count(*)::int as tasks_done
    from app.task_completions
    where done_on >= p_since
    group by 1
  )
  select coalesce(d.day, t.day), coalesce(t.tasks_done, 0), coalesce(d.people, 0)
  from days d full join done t on t.day = d.day
  where app.is_employee()
  order by 1 desc;
$$;
revoke all on function app.home_work_done(date) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.home_work_done(date)'::regprocedure),
        'Home Wins: per-day counts of tasks done and people active; returns nothing unless the caller is_employee().')
on conflict do nothing;
grant execute on function app.home_work_done(date) to authenticated;
