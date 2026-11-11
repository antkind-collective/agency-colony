-- Allocations land on the real client's project again (27 Sep 2026).
--
-- 202609100005 moved every project off the "Internal" client onto its real
-- client. But both allocation writers -- app.save_my_allocations (My
-- Allocation) and app.resolve_internal_project (the planner) -- still looked a
-- line's name up ONLY under Internal. Finding nothing there, they created a
-- fresh Internal project of that name. From the week of 14 Sep, 26 allocation
-- rows went to eight such duplicates (Example Collective, Example Materials, Example Records,
-- Example Fintech, Example Consumer, Example AI, Your Agency, Misc/Bizdev). Symptoms: the
-- home card's "Top client: Internal 93%", and brief access -- which follows
-- the CLIENT a person is allocated to -- dropped Ben and Dev off the client.
--
-- 1. app_private.resolve_project_for_name(name, internal_client_id):
--    a) a project of that name under a real (non-Internal) client, preferring
--       the client of the same name;  b) else a real client of that name gets
--    the project created under it;  c) else Internal, found or created.
--    Archived clients still match: work booked to them belongs to them (the
--    home card already leaves archived clients out of its headline).
-- 2. Both writers call it. CREATE OR REPLACE keeps their grants.
-- 3. Data: the 26 rows move to the real projects (no week overlaps, checked);
--    Example AI's client has no project, so its Internal project is
--    repointed whole. The seven emptied duplicates are deleted. Before-images
--    in app_private.alloc_fix_20260927_* ; reversible.
--
-- Access: the helper lives in app_private (no USAGE for signed-in roles) and
-- is called only from the two SECURITY DEFINER writers.

create or replace function app_private.resolve_project_for_name(p_name text, p_internal_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_project uuid;
  v_client uuid;
begin
  if v_name = '' then
    return null;
  end if;

  select p.id into v_project
  from app.projects p
  join app.clients c on c.id = p.client_id
  where c.id <> p_internal_client_id
    and lower(p.name) = lower(v_name)
  order by (lower(c.name) = lower(v_name)) desc, c.is_active desc, p.created_at
  limit 1;
  if v_project is not null then
    return v_project;
  end if;

  select c.id into v_client
  from app.clients c
  where c.id <> p_internal_client_id and lower(btrim(c.name)) = lower(v_name)
  order by c.is_active desc, c.created_at
  limit 1;
  if v_client is not null then
    insert into app.projects (client_id, name, engagement_type, status)
    values (v_client, v_name, 'project', 'active')
    returning id into v_project;
    return v_project;
  end if;

  select p.id into v_project
  from app.projects p
  where p.client_id = p_internal_client_id and lower(p.name) = lower(v_name)
  limit 1;
  if v_project is null then
    insert into app.projects (client_id, name, engagement_type, status)
    values (p_internal_client_id, v_name, 'project', 'active')
    returning id into v_project;
  end if;
  return v_project;
end;
$fn$;

revoke all on function app_private.resolve_project_for_name(text, uuid) from public, anon, authenticated;

-- 2 ----
CREATE OR REPLACE FUNCTION app.save_my_allocations(p_period_type app.allocation_period_type, p_period_start date, p_lines jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
declare
  requester_employee_id uuid;
  period_start_date date;
  internal_client_id uuid;
  line_item jsonb;
  project_name_value text;
  project_id_value uuid;
  allocation_value numeric;
  inserted_count int := 0;
  incoming_project_ids uuid[] := '{}';
begin
  requester_employee_id := app.current_employee_id();

  if requester_employee_id is null then
    raise exception 'Employee profile not found. Please complete account bootstrap.';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'p_lines must be a JSON array.';
  end if;

  period_start_date := coalesce(
    p_period_start,
    date_trunc('month', now())::date
  );

  -- Ensure an internal client exists for allocation-only entries.
  select c.id
  into internal_client_id
  from app.clients c
  where c.name = 'Internal'
  limit 1;

  if internal_client_id is null then
    insert into app.clients (name)
    values ('Internal')
    returning id into internal_client_id;
  end if;

  -- Upsert each line, only touching updated_at when percent changes
  for line_item in
    select value from jsonb_array_elements(p_lines)
  loop
    project_name_value := trim(coalesce(line_item ->> 'project_name', ''));
    if project_name_value = '' then
      continue;
    end if;

    allocation_value := greatest(
      0,
      least(
        100,
        coalesce((line_item ->> 'allocation_percent')::numeric, 0)
      )
    );

    -- The real client's project first (27 Sep 2026); Internal only for work
    -- that belongs to no client. See app_private.resolve_project_for_name.
    project_id_value := app_private.resolve_project_for_name(project_name_value, internal_client_id);

    incoming_project_ids := incoming_project_ids || project_id_value;

    insert into app.allocations (
      employee_id,
      project_id,
      period_type,
      period_start,
      allocation_percent,
      created_by_employee_id
    )
    values (
      requester_employee_id,
      project_id_value,
      p_period_type,
      period_start_date,
      allocation_value,
      requester_employee_id
    )
    on conflict (employee_id, project_id, period_type, period_start)
    do update
    set allocation_percent = excluded.allocation_percent,
        updated_at = case
          when app.allocations.allocation_percent <> excluded.allocation_percent then now()
          else app.allocations.updated_at
        end,
        created_by_employee_id = excluded.created_by_employee_id;

    inserted_count := inserted_count + 1;
  end loop;

  -- Only delete allocations not in the incoming set (removed lines)
  delete from app.allocations a
  where a.employee_id = requester_employee_id
    and a.period_type = p_period_type
    and a.period_start = period_start_date
    and a.project_id <> all(incoming_project_ids);

  return inserted_count;
end;
$function$;

CREATE OR REPLACE FUNCTION app.resolve_internal_project(p_project_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
declare
  v_name text;
  v_client_id uuid;
  v_project_id uuid;
begin
  if app.current_employee_id() is null then
    raise exception 'Employees only.';
  end if;
  v_name := btrim(coalesce(p_project_name, ''));
  if v_name = '' then
    return null;
  end if;

  select c.id into v_client_id
  from app.clients c where c.name = 'Internal' limit 1;
  if v_client_id is null then
    insert into app.clients (name) values ('Internal')
    returning id into v_client_id;
  end if;

  v_project_id := app_private.resolve_project_for_name(v_name, v_client_id);

  return v_project_id;
end;
$function$;


-- 3. Data -------------------------------------------------------------------
create table if not exists app_private.alloc_fix_20260927_allocations as
  select a.* from app.allocations a
  join app.projects p on p.id = a.project_id
  join app.clients c on c.id = p.client_id
  where c.name = 'Internal' and p.name not in ('Internal', 'Pitches/BD');
create table if not exists app_private.alloc_fix_20260927_projects as
  select p.* from app.projects p
  join app.clients c on c.id = p.client_id
  where c.name = 'Internal' and p.name not in ('Internal', 'Pitches/BD');

do $$
declare
  v_internal uuid := (select id from app.clients where name = 'Internal' limit 1);
  r record;
  v_target uuid;
  v_client uuid;
begin
  for r in
    select p.id, p.name from app.projects p
    where p.client_id = v_internal and p.name not in ('Internal', 'Pitches/BD')
  loop
    select p2.id into v_target
    from app.projects p2 join app.clients c on c.id = p2.client_id
    where c.id <> v_internal and lower(p2.name) = lower(r.name)
    order by (lower(c.name) = lower(r.name)) desc, c.is_active desc, p2.created_at
    limit 1;

    if v_target is not null then
      if exists (select 1 from app.allocations a
                 join app.allocations b on b.employee_id = a.employee_id and b.period_type = a.period_type
                   and b.period_start = a.period_start and b.project_id = v_target
                 where a.project_id = r.id) then
        raise exception 'Overlap moving % onto its real project; stopping.', r.name;
      end if;
      update app.allocations set project_id = v_target where project_id = r.id;
      update app.daily_tasks set project_id = v_target where project_id = r.id;
      delete from app.projects where id = r.id;
      continue;
    end if;

    select c.id into v_client from app.clients c
    where c.id <> v_internal and lower(btrim(c.name)) = lower(r.name)
    order by c.is_active desc limit 1;
    if v_client is not null then
      update app.projects set client_id = v_client where id = r.id;
    end if;
    -- Neither: genuinely internal work; left where it is.
  end loop;
end $$;
