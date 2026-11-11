-- Home feed "Wins" counts only clients the caller can see (audit, 29 Sep 2026).
--
-- app.home_briefs_delivered (202609280004) returned delivery counts for every
-- client with briefs to every employee. A client-scoped fractional (asha@,
-- scoped to Example Foundation) got "Example Collective: N delivered", i.e. a
-- client outside their scope and its brief activity. The access truth keeps
-- fractionals to app.can_see_client, as is_allocated_to_org (202609280001)
-- and resolve_client_project (202609280002) already do.
--
-- Now a brief counts only when its org names a client the caller can see
-- (same name match as is_allocated_to_org). For leadership and full-time staff
-- can_see_client is true for every client: no change (the client, the only org with
-- briefs, has its client row). Partners, candidates and hiring-only logins
-- still get nothing (is_employee). Signature, declaration and grants unchanged.

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
    and exists (
      select 1 from app.clients c
      where lower(btrim(c.name)) = lower(btrim(b.org))
        and app.can_see_client(c.id)
    )
  group by b.org
  order by 3 desc;
$fn$;

revoke all on function app.home_briefs_delivered(date) from public, anon;
