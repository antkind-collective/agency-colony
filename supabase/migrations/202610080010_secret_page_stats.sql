-- The secret page, "Colony, after hours" (8 Oct 2026: the zine, eight
-- spreads). One call returns everything the page draws, as counts and totals
-- only: no task titles beyond the top words, no one's leave dates, no one's
-- slow week. Per-person values are only the celebratory ones (bugs and ideas
-- filed) plus each active colleague's Google profile photo. Nothing unless
-- is_employee(), so a Circle client or candidate gets null.
create or replace function app.secret_page_stats()
returns jsonb
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
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
    select c.name, min(a.period_start) as first_on, max(a.period_start) as last_on, count(distinct a.employee_id)::int as people
    from app.clients c join app.projects p on p.client_id = c.id join app.allocations a on a.project_id = p.id
    where c.is_active and a.allocation_percent > 0 group by c.name
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
    'clients', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'first', first_on, 'last', last_on, 'people', people) order by first_on, name) from rivers), '[]'),
    'photos', coalesce((select jsonb_object_agg(e.id, u.raw_user_meta_data->>'avatar_url')
                        from app.employees e join auth.users u on u.id = e.auth_user_id
                        where e.is_active and u.raw_user_meta_data->>'avatar_url' is not null), '{}')
  ) end;
$$;
revoke all on function app.secret_page_stats() from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.secret_page_stats()'::regprocedure),
        'Secret page (Colony, after hours): team totals, top words, hour/weekday counts, bugs+ideas per person, colleague Google photos; null unless is_employee().')
on conflict do nothing;
grant execute on function app.secret_page_stats() to authenticated;
