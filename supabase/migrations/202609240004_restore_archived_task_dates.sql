-- Q3 (24 Sep 2026): give archived daily tasks back their own dates.
--
-- The old 10:00 rollover (daily-reminders, fixed in 04bf331) moved every past
-- task that wasn't 'done' to today — archived rows included — so every
-- successful run re-dated the whole task archive to that day. The last success
-- was 8 Sep: 3,004 of the archived daily tasks read task_date = 2026-09-08,
-- all updated at 10:00–10:02 IST that morning.
--
-- A daily task row is created on the day it belongs to (new task, or the
-- carry-forward copy made that morning), so created_at in IST is its date.
-- Dry run 24 Sep (rolled back): 3,004 rows → 13 Apr … 7 Sep, 400–700 a month,
-- none in the future; a task titled "Post 29th" comes back as 29 Jun. The 52
-- archived tasks genuinely from 8 Sep are untouched (created that day).
--
-- Reversible: the previous date of every changed row is kept in
-- app_private.task_date_restore_20260924 (no grants; RLS on via
-- guard_access_ddl). To undo:
--   update app.daily_tasks t set task_date = b.old_task_date
--     from app_private.task_date_restore_20260924 b where b.id = t.id;

begin;

create table if not exists app_private.task_date_restore_20260924 as
select id, task_date as old_task_date, (created_at at time zone 'Asia/Kolkata')::date as new_task_date
  from app.daily_tasks
 where status = 'archived'
   and task_date = '2026-09-08'
   and (updated_at at time zone 'Asia/Kolkata')::time between '10:00' and '10:02'
   and (created_at at time zone 'Asia/Kolkata')::date <> task_date;

-- updated_at is left alone on purpose, so the trigger that stamps it is off for
-- this one statement: task-nudge reads daily_tasks.updated_at to decide who has
-- been active today, and 3,004 fresh stamps would mark their owners active and
-- skip their nudge. One transaction, so a failure cannot leave the trigger off.
alter table app.daily_tasks disable trigger trg_daily_tasks_set_updated_at;

update app.daily_tasks t
   set task_date = b.new_task_date
  from app_private.task_date_restore_20260924 b
 where b.id = t.id
   and t.task_date = b.old_task_date;

alter table app.daily_tasks enable trigger trg_daily_tasks_set_updated_at;

commit;
