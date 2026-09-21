-- A partner's rows belong to the partner's org, decided by the server
-- (17 Sep 2026, Circle test as a second client, "Your Agency QA").
--
-- app.org_contacts.org and app.briefs.org default to 'Example Collective'. The
-- client did not send org when saving a team contact, so every client's
-- contact would have been filed under the client; RLS (is_org_contact_editor(org))
-- refused it, which meant a second client could not add contacts at all.
-- The client now sends its org; this trigger makes it true regardless of
-- what the payload says, the same way guard_partner_brief_insert decides a
-- partner's brief status. Employees (brief reviewers) are untouched.

create or replace function app.force_partner_org()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public'
as $$
declare
  v_org text;
begin
  if auth.uid() is null or app.is_employee() then
    return new;
  end if;
  v_org := app.current_partner_org();
  if v_org is not null then
    new.org := v_org;
  end if;
  return new;
end;
$$;
revoke all on function app.force_partner_org() from public, anon, authenticated;

drop trigger if exists trg_org_contacts_partner_org on app.org_contacts;
create trigger trg_org_contacts_partner_org
  before insert on app.org_contacts
  for each row execute function app.force_partner_org();

drop trigger if exists trg_briefs_partner_org on app.briefs;
create trigger trg_briefs_partner_org
  before insert on app.briefs
  for each row execute function app.force_partner_org();
