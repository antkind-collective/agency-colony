-- The client SLA belongs to one client (17 Sep 2026).
--
-- app.client_sla had no org: its 17 rows are Example Collective's signed SLA, and
-- the select policy was `is_employee() OR is_partner()`, so any active partner
-- of ANY org read them. Harmless while the client is the only client; the day a second
-- client is invited they would read the client's contract turnaround. Found by the
-- 17 Sep Circle audit with a fabricated second-org partner.
--
-- Now: every row carries its org, a type is unique per org, and a partner
-- reads only their own org's rows. Employees still read all (the internal
-- brief board picks the SLA of the brief's org). Writes stay leadership-only.
--
-- The org test goes through a SECURITY DEFINER helper, not an inline EXISTS
-- over app.partners, so the policy does not depend on partners' own RLS
-- (the 10 Sep feedback-wall trap). It is referenced by a policy, so
-- authenticated needs EXECUTE; it answers only about the caller.

create or replace function app.current_partner_org()
returns text
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select p.org from app.partners p where p.id = app.current_partner_id();
$$;
revoke all on function app.current_partner_org() from public, anon;
grant execute on function app.current_partner_org() to authenticated, service_role;

alter table app.client_sla add column if not exists org text;
update app.client_sla set org = 'Example Collective' where org is null;
alter table app.client_sla alter column org set not null;
alter table app.client_sla drop constraint client_sla_pkey;
alter table app.client_sla add constraint client_sla_pkey primary key (org, deliverable_type);

drop policy if exists client_sla_select on app.client_sla;
create policy client_sla_select on app.client_sla
  for select
  using (app.is_employee() or org = app.current_partner_org());
