-- Coming up gets fuller (8 Oct 2026): new joiners starting, work
-- anniversaries, people back from leave, and the team meetings.

-- Who starts in the window: first name and team only. Hire rows are crew-only,
-- so everyone else reads this, and only for signed hires.
create or replace function app.home_joiners_starting(p_from date, p_until date)
returns table(first_name text, team text, start_date date)
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select split_part(btrim(h.full_name), ' ', 1), nullif(btrim(t.department), ''), h.start_date
  from app.hires h
  left join app.hire_offer_terms t on t.hire_id = h.id
  where app.is_employee()
    and h.stage in ('signed', 'payroll_done')
    and h.start_date between p_from and p_until
  order by h.start_date;
$$;
revoke all on function app.home_joiners_starting(date, date) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.home_joiners_starting(date,date)'::regprocedure),
        'Home Coming up: first name, team and start date of signed hires starting soon; nothing unless is_employee().')
on conflict do nothing;
grant execute on function app.home_joiners_starting(date, date) to authenticated;

-- The day someone joined Your Agency, for anniversaries. Colony only knows it for
-- people hired through Colony; the rest are filled in by hand.
alter table app.employees add column if not exists joined_on date;
comment on column app.employees.joined_on is 'The day they joined Your Agency (not their first Colony sign-in). Drives work anniversaries on Coming up.';
grant select (joined_on) on app.employees to authenticated;
update app.employees e set joined_on = h.start_date
  from app.hires h
 where lower(h.work_email) = lower(e.email::text) and h.start_date is not null and e.joined_on is null;
