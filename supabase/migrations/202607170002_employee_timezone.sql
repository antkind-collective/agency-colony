-- Per-person timezone.
--
-- Colony had no idea where anyone was. current_city is free text people typed
-- ("gurgaon", "Calicut, Kerala", "Goa" — not a city), so it is not a timezone
-- source. Everything ran on a hardcoded IST +5:30, which is correct for 15 of
-- 16 people and wrong for Anya, who is in Tokyo: the 11:00 nudge reached her
-- at 14:30 local, about a window that closed mid-morning.
--
-- Design:
--  * timezone is its OWN column, not derived from current_city on read. The
--    city picker auto-fills it on selection (js/config.js CITY_OPTIONS carries
--    the IANA zone per city, so picking the city IS picking the zone), but the
--    two are stored separately: city answers "where do you live" and timezone
--    answers "what clock are you on". They are the same fact today for
--    everyone, and the column costs nothing if they ever diverge.
--  * IANA names, not offsets. Offsets have DST; Asia/Kolkata and Asia/Tokyo do
--    not observe it but Europe does, and the crons must not care.
--  * Default Asia/Kolkata: the honest default for this agency, and it keeps
--    every existing row behaving exactly as it does today.

alter table app.employees
  add column if not exists timezone text not null default 'Asia/Kolkata';

-- Reject typos at write time. A bad zone is not cosmetic: Intl.DateTimeFormat
-- throws RangeError on an unknown zone, so one typo'd row would crash the nudge
-- loop for EVERYONE. (task-nudge also falls back to IST per-employee rather
-- than trusting this alone — the cron must not be one bad string from silence.)
-- This is a trigger, not a CHECK: check constraints cannot contain subqueries,
-- and pg_timezone_names is a view, so it cannot be wrapped in an IMMUTABLE
-- function either.
create or replace function app.validate_employee_timezone()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Invalid IANA timezone: %', new.timezone;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_employee_timezone on app.employees;
create trigger trg_validate_employee_timezone
  before insert or update of timezone on app.employees
  for each row execute function app.validate_employee_timezone();

comment on column app.employees.timezone is
  'IANA timezone. Auto-filled from the city picker (CITY_OPTIONS in js/config.js); stored, never derived on read. Drives per-person cron timing (task-nudge).';

-- The one person the feature exists for. Everyone else is correct by default.
update app.employees set timezone = 'Asia/Tokyo' where email = 'ops-lead@youragency.com';
