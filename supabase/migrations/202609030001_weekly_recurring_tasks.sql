-- Weekly repeating tasks (Ruby, board request 28 Aug 2026 — setup offered
-- One-Time or Monthly only).
--
-- recurring_tasks was monthly by construction: a single NOT NULL day_of_month
-- and no notion of cadence. Adding a frequency alongside a day_of_week keeps
-- every existing rule valid as it stands (frequency defaults to 'monthly',
-- day_of_week stays null) while making the pair mutually exclusive, so a rule
-- can never carry a contradictory schedule.
--
-- day_of_week is 0=Sunday..6=Saturday — the numbering JS getDay() uses and the
-- one zonedParts() already returns to the cron, so nothing has to translate.

alter table app.recurring_tasks
  add column if not exists frequency text not null default 'monthly',
  add column if not exists day_of_week int;

-- day_of_month becomes conditional: required for monthly, absent for weekly.
alter table app.recurring_tasks alter column day_of_month drop not null;

-- The IS NOT NULL tests are load-bearing, not belt-and-braces: a CHECK passes
-- when it evaluates to NULL, and `null between 1 and 31` is NULL, not false.
-- Without them a monthly rule carrying no day_of_month was accepted and would
-- simply never fire. Naming the two frequencies here is also what restricts
-- the column — an unknown value satisfies neither branch and is rejected.
alter table app.recurring_tasks drop constraint if exists recurring_tasks_schedule_chk;
alter table app.recurring_tasks add constraint recurring_tasks_schedule_chk check (
  (frequency = 'monthly' and day_of_month is not null and day_of_month between 1 and 31 and day_of_week is null)
  or
  (frequency = 'weekly' and day_of_week is not null and day_of_week between 0 and 6 and day_of_month is null)
);
