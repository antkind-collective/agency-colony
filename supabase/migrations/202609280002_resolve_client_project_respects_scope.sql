-- Saving an allocation resolves only clients the caller can see (S14
-- tightening; Alex, 28 Sep 2026).
--
-- app_private.resolve_client_project (called by save_my_allocations and
-- resolve_internal_project, both SECURITY DEFINER) matched ANY client by name.
-- For a client-scoped fractional that meant it (a) created projects under
-- clients they cannot see and (b) answered "does a client called X exist?"
-- — a yes/no oracle over the client list. 202609280001 already stops such an
-- allocation from opening briefs; this stops it being written at all.
--
-- Now both lookups only consider clients app.can_see_client() allows, and an
-- invisible client gets the SAME error as a name that does not exist, so the
-- message reveals nothing. For full-time staff and leadership can_see_client
-- is true for every client: no change. A scoped fractional can no longer book
-- Misc/Bizdev or Pitches/BD either; checked 28 Sep: no fractional holds any
-- allocation outside their scope (Ruby: Example Foundation + Example Records, both
-- in scope; Asha and Mara: none).
--
-- Keep with it (audit, 28 Sep): is_allocated_to_org must keep requiring
-- can_see_client — tests/db-invariants.test.mjs enforces that separately.
-- Access: unchanged. The helper stays in app_private with no grants.

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
    and app.can_see_client(c.id)
  order by (lower(c.name) = lower(v_name)) desc, c.is_active desc, p.created_at
  limit 1;
  if v_project is not null then
    return v_project;
  end if;

  select c.id into v_client
  from app.clients c
  where lower(btrim(c.name)) = lower(v_name)
    and app.can_see_client(c.id)
  order by c.is_active desc, c.created_at
  limit 1;
  if v_client is not null then
    insert into app.projects (client_id, name, engagement_type, status)
    values (v_client, v_name, 'project', 'active')
    returning id into v_project;
    return v_project;
  end if;

  -- Same words whether the client does not exist or is outside the caller's
  -- scope: the error must not confirm a name.
  raise exception 'No client is called "%". Pick a client from the list, or ask leadership to add it on the Clients page.', v_name
    using errcode = 'P0001';
end;
$fn$;

revoke all on function app_private.resolve_client_project(text) from public, anon, authenticated;
