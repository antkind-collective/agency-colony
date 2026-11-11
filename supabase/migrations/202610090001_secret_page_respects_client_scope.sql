-- Audit 9 Oct 2026 (Fri): app.secret_page_stats() (202610080010, redefined in
-- 202610080012) is SECURITY DEFINER and gated on is_employee() alone, so it
-- read daily_tasks, clients and allocations past their RLS. A client-scoped
-- fractional (asha@: 2 clients, 9 readable tasks in 30 days) got every active
-- client's name, contract start date (clients.started_on), allocation range
-- and headcount (14 clients), and the top words of all 718 recent task titles.
-- Same class as home_briefs_delivered (202609290001) and the 5-6 Oct scope
-- fixes: a client's data follows client scope, in RPCs too.
--
-- Redefined from the LIVE definition (pg_get_functiondef, 9 Oct 2026) with
-- two filters only:
--   * words: only tasks the caller can read — the same predicate as the
--     daily_tasks_select_all_authenticated policy.
--   * rivers: only clients the caller can see (can_see_client).
-- Full-time staff and leadership (sees_every_client) are unchanged; the other
-- figures are Your Agency-wide totals with no client in them and stay as they are.
-- Dry-run: asha@ 14 clients / 25 words -> 2 / 6; maya@ 14 / 25 both ways;
-- a partner still gets NULL.

CREATE OR REPLACE FUNCTION app.secret_page_stats()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  with today as (select (now() at time zone 'Asia/Kolkata')::date as d),
  words as (
    select case when w = 'sept' then 'september' else w end as word, count(*)::int as n
    from (
      select regexp_split_to_table(regexp_replace(regexp_replace(lower(task_title), 'future tense', 'future_tense', 'g'), 'knowledge base', 'knowledge_base', 'g'), '[^a-z_]+') as w
      from app.daily_tasks t, today where t.task_date >= today.d - 30
        -- Only tasks the caller can read (daily_tasks_select_all_authenticated):
        -- a fractional sees words from their own clients, not everyone else's.
        and ((select app.sees_every_client())
             or t.employee_id = (select app.current_employee_id())
             or lower(btrim(coalesce(t.notes, ''))) = any(coalesce((select app.my_task_tags()), '{}'::text[])))
    ) x
    where length(w) > 3 and w not in ('with','from','that','this','have','into','your','will','about','what','make','work','them','they','their','post','posts','task','tasks','check','update','updates','send','call','also','team','sheet','draft','final','plus','share','list','done','review','sharing','meeting','prep','need','needs','some','more','next','week','today','other','start','finish','based','after','before','follow','followup','create','added','check')
    group by 1 order by 2 desc, 1 limit 25
  ),
  hours as (
    select extract(hour from created_at at time zone 'Asia/Kolkata')::int as h, count(*)::int as n
    from app.daily_tasks where created_at > now() - interval '30 days'
      -- 00:00-01:59 is the nightly carry-forward writing rows, not people.
      and extract(hour from created_at at time zone 'Asia/Kolkata') >= 2 group by 1
  ),
  weeks as (
    select date_trunc('week', done_on)::date as wk, count(*)::int as n from app.task_completions group by 1
  ),
  leave_days as (
    select extract(isodow from d)::int as dow, count(*)::int as n
    from (select generate_series(start_date, end_date, interval '1 day')::date as d
          from app.leave_requests where status = 'approved') x
    where extract(isodow from d) < 6 group by 1
  ),
  feedback as (
    select f.employee_id, count(*) filter (where f.request_type = 'bug')::int as bugs,
           count(*) filter (where f.request_type is distinct from 'bug')::int as ideas
    from app.feature_requests f join app.employees e on e.id = f.employee_id and e.is_active
    where f.author_partner_id is null group by 1
  ),
  rivers as (
    -- Contract start where we have one; first allocation otherwise.
    select c.name, coalesce(c.started_on, min(a.period_start)) as first_on, c.started_on is not null as contracted,
           max(a.period_start) as last_on, count(distinct a.employee_id)::int as people
    from app.clients c join app.projects p on p.client_id = c.id join app.allocations a on a.project_id = p.id
    where c.is_active and a.allocation_percent > 0
      -- A fractional sees only their own clients' rivers (audit 9 Oct 2026).
      and ((select app.sees_every_client()) or app.can_see_client(c.id))
    group by c.name, c.started_on
  )
  select case when not app.is_employee() then null else jsonb_build_object(
    'tasks_logged', (select count(*) from app.daily_tasks),
    'words', coalesce((select jsonb_agg(jsonb_build_object('word', word, 'n', n) order by n desc, word) from words), '[]'),
    'hours', coalesce((select jsonb_object_agg(h, n) from hours), '{}'),
    'median_first', (select to_char(percentile_cont(0.5) within group (order by (first_at at time zone 'Asia/Kolkata')::time), 'HH24:MI')
                     from app.task_activity, today where activity_date > today.d - 30),
    'record_week', (select jsonb_build_object('week', wk, 'n', n) from weeks order by n desc, wk limit 1),
    'this_week', coalesce((select n from weeks, today where wk = date_trunc('week', today.d)::date), 0),
    'leave_by_dow', coalesce((select jsonb_object_agg(dow, n) from leave_days), '{}'),
    'leave_90d', (select coalesce(sum(case when is_half_day then 0.5 else end_date - start_date + 1 end), 0)
                  from app.leave_requests, today where status = 'approved' and start_date > today.d - 90 and start_date <= today.d),
    'feedback', coalesce((select jsonb_agg(jsonb_build_object('id', employee_id, 'bugs', bugs, 'ideas', ideas) order by bugs + ideas desc) from feedback), '[]'),
    'clients', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'first', first_on, 'contracted', contracted, 'last', last_on, 'people', people) order by first_on, name) from rivers), '[]'),
    'photos', coalesce((select jsonb_object_agg(e.id, u.raw_user_meta_data->>'avatar_url')
                        from app.employees e join auth.users u on u.id = e.auth_user_id
                        where e.is_active and u.raw_user_meta_data->>'avatar_url' is not null), '{}')
  ) end;
$function$;
