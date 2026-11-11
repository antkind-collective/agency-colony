-- No "Internal" client at all (27 Sep 2026): "all references to
-- internal can go", and an allocation to a name that is no client STOPS the
-- save and asks for a real one, rather than filing it somewhere nobody looks.
--
-- 1. app_private.resolve_client_project(name): a project of that name under a
--    client (preferring the client of the same name), else a client of that
--    name gets the project created under it, else an error the UI shows.
--    Replaces resolve_project_for_name (dropped).
-- 2. save_my_allocations and resolve_internal_project call it; neither looks
--    for or creates an Internal client any more. (resolve_internal_project
--    keeps its name: the browser calls it by that name.)
-- 3. The Internal client, its one project ("Internal") and that project's two
--    allocation rows (Feb/Mar 2026, Alex and Sia) are deleted. Nothing
--    else referenced the client (checked every foreign key). Before-images in
--    app_private.internal_removal_20260927_*.
--
-- Access: the helper lives in app_private, called only by the two SECURITY
-- DEFINER writers; CREATE OR REPLACE keeps the writers' grants.

create or replace function app_private.resolve_client_project(p_name text)
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
  where lower(p.name) = lower(v_name)
  order by (lower(c.name) = lower(v_name)) desc, c.is_active desc, p.created_at
  limit 1;
  if v_project is not null then
    return v_project;
  end if;

  select c.id into v_client
  from app.clients c
  where lower(btrim(c.name)) = lower(v_name)
  order by c.is_active desc, c.created_at
  limit 1;
  if v_client is not null then
    insert into app.projects (client_id, name, engagement_type, status)
    values (v_client, v_name, 'project', 'active')
    returning id into v_project;
    return v_project;
  end if;

  raise exception 'No client is called "%". Pick a client from the list, or ask leadership to add it on the Clients page.', v_name
    using errcode = 'P0001';
end;
$fn$;

revoke all on function app_private.resolve_client_project(text) from public, anon, authenticated;

-- 2. ----
CREATE OR REPLACE FUNCTION app.save_my_allocations(p_period_type app.allocation_period_type, p_period_start date, p_lines jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
declare
  requester_employee_id uuid;
  period_start_date date;
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

    -- Every line belongs to a real client; an unknown name stops the save
    -- (27 Sep 2026). See app_private.resolve_client_project.
    project_id_value := app_private.resolve_client_project(project_name_value);

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
  v_project_id uuid;
begin
  if app.current_employee_id() is null then
    raise exception 'Employees only.';
  end if;
  v_name := btrim(coalesce(p_project_name, ''));
  if v_name = '' then
    return null;
  end if;

  v_project_id := app_private.resolve_client_project(v_name);

  return v_project_id;
end;
$function$;


drop function if exists app_private.resolve_project_for_name(text, uuid);

-- 3. ---------------------------------------------------------------------
create table if not exists app_private.internal_removal_20260927_clients as
  select * from app.clients where name = 'Internal';
create table if not exists app_private.internal_removal_20260927_projects as
  select p.* from app.projects p join app.clients c on c.id = p.client_id where c.name = 'Internal';
create table if not exists app_private.internal_removal_20260927_allocations as
  select a.* from app.allocations a join app.projects p on p.id = a.project_id
  join app.clients c on c.id = p.client_id where c.name = 'Internal';

do $$
begin
  if exists (select 1 from app.projects p join app.clients c on c.id = p.client_id
             where c.name = 'Internal' and p.name <> 'Internal') then
    raise exception 'Internal still holds a project other than "Internal"; stopping.';
  end if;
end $$;

delete from app.clients where name = 'Internal';  -- cascades its project and those two rows
