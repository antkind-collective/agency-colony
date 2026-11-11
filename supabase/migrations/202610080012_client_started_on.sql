-- Real client start dates (8 Oct 2026, from the signed contracts).
-- Allocations only begin 23 Feb 2026, so the secret page's river showed every
-- older client starting that day. started_on is the contract start. Where no
-- contract carries a date, Alex set one: Example Records and EXAMPLE COUNCIL 1 Apr 2026,
-- Example AI 8 Oct 2026. NULL falls back to the first allocation. secret_page_stats is redefined from its LIVE
-- definition with only the rivers CTE changed.
alter table app.clients add column if not exists started_on date;
comment on column app.clients.started_on is 'Contract start date (from the signed agreement); NULL if none signed yet.';
update app.clients c set started_on = v.d from (values
  ('Example Materials', date '2024-11-01'), ('Example Arts', date '2025-07-10'), ('EXAMPLE RESEARCH', date '2025-12-03'),
  ('EXAMPLE COUNCIL', date '2026-04-01'), ('Example Records', date '2026-04-01'), ('Example AI', date '2026-10-08'), ('Example Health', date '2025-11-01'), ('Example Collective', date '2026-04-01'),
  ('Example Consumer', date '2026-05-15'), ('Example Industries', date '2026-05-07'), ('Example Philanthropy', date '2026-06-02'),
  ('Example Foundation', date '2026-07-15')
) as v(n, d) where c.name = v.n;

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
      from app.daily_tasks, today where task_date >= today.d - 30
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
    where c.is_active and a.allocation_percent > 0 group by c.name, c.started_on
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
