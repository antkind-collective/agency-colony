-- Audit 5 Oct 2026 (Mon, data layer): a client's people, logins and SLA follow
-- client scope, like the rest of a client's data.
--
-- org_contacts, partners and client_sla let every employee read every org
-- (`app.is_employee()`). A fractional is scoped to her clients
-- (`can_see_client`), yet asha@ (Example Foundation only) read Global
-- Artivism's 8 stakeholder contacts (names, emails, roles, reporting lines),
-- all 14 client logins and the client's 17 SLA rows. Same rule as client_scope_items
-- and client_analytics now: the employee branch needs the caller to see the
-- org's client. Full-time staff and leadership see every org as before
-- (`can_see_org` is true for any org name, even one with no client row);
-- partner branches are unchanged.

create or replace function app.can_see_org(p_org text)
returns boolean
language sql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
  -- Answers for the CALLER only. Orgs are client names (is_allocated_to_org
  -- matches them the same way).
  select case
    when app.is_leadership_or_admin() then true
    when not app.is_employee() then false
    when coalesce((
      select e.employment_type = 'fractional'
      from app.employees e where e.id = app.current_employee_id()
    ), false) then exists (
      select 1 from app.clients c
      where lower(btrim(c.name)) = lower(btrim(coalesce(p_org, '')))
        and app.can_see_client(c.id)
    )
    else true
  end;
$fn$;

revoke all on function app.can_see_org(text) from public, anon;

insert into app_private.callable_definer_functions(signature, reason) values
  (app_private.fn_signature('app.can_see_org(text)'::regprocedure),
   'RLS helper: org_contacts / partners / client_sla employee read policies; answers about the CALLER only (audit 5 Oct 2026)')
on conflict do nothing;

grant execute on function app.can_see_org(text) to authenticated;

alter policy org_contacts_select on app.org_contacts
  using (app.can_see_org(org) or exists (
    select 1 from app.partners p
    where p.id = app.current_partner_id() and p.org = org_contacts.org));

alter policy partners_select_employees on app.partners
  using (app.can_see_org(org));

alter policy client_sla_select on app.client_sla
  using (app.can_see_org(org) or org = app.current_partner_org());
