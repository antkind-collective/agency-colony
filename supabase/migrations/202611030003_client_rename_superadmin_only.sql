-- 3 Nov 2026 (Alex): "no one should be able to rename the account name
-- except me". clients_update_own_or_leadership lets the account owner,
-- leadership and Deal Flow viewers update a client row, with no limit on
-- which columns, so any of them could rename it. A client's name is the key
-- other rows match on as text: partners.org, briefs.org, org_contacts.org,
-- client_sla.org (can_see_org), project names, and daily task client tags.
-- A rename by anyone else could cut a client's logins off from their own
-- briefs, or collide with another client's name.
--
-- Now only the superadmin (Alex) may change clients.name. Everything else the
-- policy allows (owner, active/archived, type) is unchanged. The service role
-- (no auth.uid()) is untouched. Clients' editor makes the name read-only for
-- everyone else (app.js startClientEdit).

create or replace function app_private.guard_client_rename()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if auth.uid() is null or app.is_superadmin() then return new; end if;
  if new.name is distinct from old.name then
    raise exception 'Only Alex can rename a client.';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_client_rename() from public, anon, authenticated;
drop trigger if exists trg_guard_client_rename on app.clients;
create trigger trg_guard_client_rename before update of name on app.clients
  for each row execute function app_private.guard_client_rename();
