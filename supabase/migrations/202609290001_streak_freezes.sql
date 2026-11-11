-- Streak freezes, used by choice (28 Sep 2026). Live from 1 Oct 2026.
--
-- Until 30 Sep a missed working day was covered by an automatic grace day (one
-- per month). From 1 Oct the person decides: the morning after a miss their
-- own streak row asks "Use your streak freeze?". A click writes one row here.
-- js/streaks.js and the streak-rewards cron read these rows; a miss with no
-- row stays pending for 2 working days, then breaks the streak.
--
-- Access: RLS on. Any active employee may READ (dates only; the home page
-- computes everyone's streak for the leaderboard, so it needs everyone's
-- freezes, just as it needs everyone's leave dates). Nobody writes directly:
-- no insert/update/delete grants. The only writer is app.use_streak_freeze,
-- which acts for the caller alone and checks every rule server-side, so a
-- hand-made request can't freeze a colleague, a day you worked, a weekend,
-- a day on leave, a stale miss, or a second day in one month.

create table if not exists app.streak_freezes (
  employee_id uuid not null references app.employees(id) on delete cascade,
  missed_on date not null check (missed_on >= date '2026-10-01'),
  -- YYYYMM as a number: to_char() is not immutable, so it can't back a stored column.
  freeze_month int generated always as ((extract(year from missed_on) * 100 + extract(month from missed_on))::int) stored,
  used_at timestamptz not null default now(),
  primary key (employee_id, missed_on),
  unique (employee_id, freeze_month)
);

alter table app.streak_freezes enable row level security;

drop policy if exists streak_freezes_select on app.streak_freezes;
create policy streak_freezes_select on app.streak_freezes
  for select to authenticated
  using (app.is_employee());

revoke all on app.streak_freezes from anon, authenticated;
grant select on app.streak_freezes to authenticated;

create or replace function app.use_streak_freeze(p_missed_on date)
returns date
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
declare
  v_emp uuid := app.current_employee_id();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_after int;
begin
  if v_emp is null or not app.is_employee() then
    raise exception 'Only Your Agency employees have streaks.';
  end if;
  if p_missed_on is null or p_missed_on < date '2026-10-01' or p_missed_on >= v_today then
    raise exception 'That day can''t be frozen.';
  end if;
  if extract(isodow from p_missed_on) in (6, 7)
     or exists (select 1 from app.public_holidays h where h.holiday_date = p_missed_on) then
    raise exception 'That was not a working day, so your streak does not need a freeze.';
  end if;
  if exists (select 1 from app.leave_requests l
             where l.employee_id = v_emp and l.status = 'approved'
               and p_missed_on between l.start_date and l.end_date) then
    raise exception 'You were on leave that day, so your streak does not need a freeze.';
  end if;
  if exists (select 1 from app.task_activity a where a.employee_id = v_emp and a.activity_date = p_missed_on) then
    raise exception 'You updated a task that day, so it already counts.';
  end if;
  -- Working days since the miss, today included (weekends, holidays and your
  -- approved leave don't use up the window). Must match STREAK_FREEZE_WINDOW.
  select count(*) into v_after
  from generate_series(p_missed_on + 1, v_today, interval '1 day') g(d)
  where extract(isodow from g.d) not in (6, 7)
    and not exists (select 1 from app.public_holidays h where h.holiday_date = g.d::date)
    and not exists (select 1 from app.leave_requests l
                    where l.employee_id = v_emp and l.status = 'approved'
                      and g.d::date between l.start_date and l.end_date);
  if v_after > 2 then
    raise exception 'The freeze window for that day has closed.';
  end if;
  if exists (select 1 from app.streak_freezes f
             where f.employee_id = v_emp
               and f.freeze_month = (extract(year from p_missed_on) * 100 + extract(month from p_missed_on))::int) then
    raise exception 'You have already used this month''s streak freeze.';
  end if;

  insert into app.streak_freezes(employee_id, missed_on) values (v_emp, p_missed_on);
  return p_missed_on;
end;
$fn$;

revoke all on function app.use_streak_freeze(date) from public, anon;

insert into app_private.callable_definer_functions(signature, reason) values
  (app_private.fn_signature('app.use_streak_freeze(date)'::regprocedure),
   'Home streak row "Use freeze": writes a freeze for the CALLER only, every rule re-checked server-side (28 Sep 2026)')
on conflict do nothing;

grant execute on function app.use_streak_freeze(date) to authenticated;
