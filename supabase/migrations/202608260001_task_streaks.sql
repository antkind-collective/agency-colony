-- Daily task streaks (All Hands, 24 Aug 2026: Kira's "credit system", which
-- Sam simplified to a plain streak and the room settled at company-wide).
--
-- One row per person per day they actually DID something to their tasks.
-- Deliberately NOT derived from daily_tasks.updated_at: the nightly cleanup
-- archives completed tasks and carries unfinished ones forward, touching rows
-- nobody looked at — a streak read from those timestamps would hand the whole
-- company a permanent streak and mean nothing.

create table app.task_activity (
  employee_id   uuid not null references app.employees(id) on delete cascade,
  activity_date date not null,
  first_at      timestamptz not null default now(),
  primary key (employee_id, activity_date)
);

comment on table app.task_activity is
  'One row per employee per day they touched their own tasks. Source of truth for streaks — never inferred from row timestamps, which the nightly cleanup also writes.';

create index idx_task_activity_date on app.task_activity(activity_date desc);

alter table app.task_activity enable row level security;

-- Everyone can see everyone's activity: the leaderboard needs it, and it is
-- nothing more sensitive than "did this person update tasks that day".
create policy task_activity_select on app.task_activity for select
  using (app.is_employee());

-- You can only ever record your OWN activity, and only for today. Without the
-- date guard a streak could be back-filled by anyone with the console open.
create policy task_activity_insert on app.task_activity for insert
  with check (
    employee_id = app.current_employee_id()
    and activity_date = (now() at time zone 'Asia/Kolkata')::date
  );
