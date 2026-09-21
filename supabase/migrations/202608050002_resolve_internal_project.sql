-- Ruby's bug (board, 5 Aug): "Copy to next week / indefinitely" silently
-- failed for her. Root cause: the populate path resolved the Internal client
-- CLIENT-SIDE (ensureInternalClientId) — client-scoped employees can't see
-- the Internal client under RLS, so the lookup missed, the fallback insert
-- was refused, and the whole copy aborted. Save works because
-- save_my_allocations is SECURITY DEFINER. Give the populate path the same
-- privileged resolution, mirroring save_my_allocations' find-or-create
-- exactly (same columns, same lower() name match).

create or replace function app.resolve_internal_project(p_project_name text)
returns uuid
language plpgsql
security definer
set search_path to 'app', 'public'
as $$
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

  select p.id into v_project_id
  from app.projects p
  where p.client_id = v_client_id and lower(p.name) = lower(v_name)
  limit 1;
  if v_project_id is null then
    insert into app.projects (client_id, name, engagement_type, status)
    values (v_client_id, v_name, 'project', 'active')
    returning id into v_project_id;
  end if;

  return v_project_id;
end;
$$;

grant execute on function app.resolve_internal_project(text) to authenticated;
