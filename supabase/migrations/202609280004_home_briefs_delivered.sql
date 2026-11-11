-- Home feed "Wins": briefs delivered, as a COUNT per client (28 Sep 2026).
--
-- Brief rows are visible only to reviewers, viewers and people working on that
-- client, so a plain select would show each person a different (mostly empty)
-- win list. This returns only client name, how many distinct briefs reached
-- "delivered" in the window, and the last day one did. No titles, no ids.
-- Employees only; the window is capped at 14 days.
--
-- Client-callable SECURITY DEFINER, so it is declared in
-- app_private.callable_definer_functions before the grant (guard_access_ddl).

create or replace function app.home_briefs_delivered(p_since date)
returns table(org text, delivered integer, last_day date)
language sql stable security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
  select b.org,
         count(distinct h.brief_id)::integer,
         max((h.entered_at at time zone 'Asia/Kolkata')::date)
  from app.brief_status_history h
  join app.briefs b on b.id = h.brief_id
  where app.is_employee()
    and h.status = 'delivered'
    and (h.entered_at at time zone 'Asia/Kolkata')::date
        >= greatest(coalesce(p_since, current_date - 7), current_date - 14)
  group by b.org
  order by 3 desc;
$fn$;

revoke all on function app.home_briefs_delivered(date) from public, anon;

insert into app_private.callable_definer_functions(signature, reason) values
  (app_private.fn_signature('app.home_briefs_delivered(date)'::regprocedure),
   'Home feed Wins: count of briefs delivered per client, employees only, 14-day cap, no titles (28 Sep 2026)')
on conflict do nothing;

grant execute on function app.home_briefs_delivered(date) to authenticated;
