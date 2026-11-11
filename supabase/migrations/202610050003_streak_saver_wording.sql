-- Streak "freeze" is called "streak saver" on screen (5 Oct 2026):
-- nobody knew what a freeze was. Only the user-facing messages change.
-- Redefined from the LIVE definition (pg_get_functiondef, 5 Oct) — not from
-- 202609290001 — per CLAUDE.md "Several sessions, one repo". Table, function
-- and constant names keep "freeze": renaming them buys nothing and would
-- break the declared signature in app_private.callable_definer_functions.

CREATE OR REPLACE FUNCTION app.use_streak_freeze(p_missed_on date)
 RETURNS date
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
declare
  v_emp uuid := app.current_employee_id();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_after int;
begin
  if v_emp is null or not app.is_employee() then
    raise exception 'Only Your Agency employees have streaks.';
  end if;
  if p_missed_on is null or p_missed_on < date '2026-10-01' or p_missed_on >= v_today then
    raise exception 'That day can''t be saved.';
  end if;
  if extract(isodow from p_missed_on) in (6, 7)
     or exists (select 1 from app.public_holidays h where h.holiday_date = p_missed_on) then
    raise exception 'That was not a working day, so your streak does not need saving.';
  end if;
  if exists (select 1 from app.leave_requests l
             where l.employee_id = v_emp and l.status = 'approved'
               and p_missed_on between l.start_date and l.end_date) then
    raise exception 'You were on leave that day, so your streak does not need saving.';
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
    raise exception 'It''s too late to save that day: the 2 working days have passed.';
  end if;
  if exists (select 1 from app.streak_freezes f
             where f.employee_id = v_emp
               and f.freeze_month = (extract(year from p_missed_on) * 100 + extract(month from p_missed_on))::int) then
    raise exception 'You have already used this month''s streak saver.';
  end if;

  insert into app.streak_freezes(employee_id, missed_on) values (v_emp, p_missed_on);
  return p_missed_on;
end;
$function$;
