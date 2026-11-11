-- Home feed Wins window: 7 -> 30 days (29 Sep 2026: "looks a bit
-- empty"). Built on the audit's scoped version (202609290001_home_briefs_
-- delivered_respects_scope): only the look-back changes, 14-day cap -> 31.
-- The can_see_client filter MUST stay (a first draft of this file was cut
-- from the older 202609280004 and briefly dropped it on 29 Sep; restored).

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
        >= greatest(coalesce(p_since, current_date - 30), current_date - 31)
    and exists (
      select 1 from app.clients c
      where lower(btrim(c.name)) = lower(btrim(b.org))
        and app.can_see_client(c.id)
    )
  group by b.org
  order by 3 desc;
$fn$;

revoke all on function app.home_briefs_delivered(date) from public, anon;
