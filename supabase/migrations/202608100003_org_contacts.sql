-- the client stakeholder map (Rhea's clarified org-chart ask, 10 Aug 2026):
-- the CLIENT's own people — name, team/role, email, who they report to, who
-- covers them when away. Visible to Your Agency employees AND all partners of the
-- org; editable by the org's coordinator/submitter partners (the client decides who
-- maintains it) and by brief reviewers internally. Not Your Agency's org chart —
-- no employee data lives here.

create table app.org_contacts (
  id uuid primary key default gen_random_uuid(),
  org text not null default 'Example Collective',
  full_name text not null,
  team_role text,
  email text,
  oversees text,
  backup_contact text,
  reports_to uuid references app.org_contacts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_org_contacts_org on app.org_contacts(org);

alter table app.org_contacts enable row level security;

create or replace function app.is_org_contact_editor(p_org text)
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select app.is_brief_reviewer()
      or exists (
        select 1 from app.partners p
        where p.id = app.current_partner_id()
          and p.org = p_org
          and p.partner_role in ('coordinator', 'submitter')
      );
$$;
grant execute on function app.is_org_contact_editor(text) to authenticated;

create policy org_contacts_select on app.org_contacts for select
  using (
    app.is_employee()
    or exists (
      select 1 from app.partners p
      where p.id = app.current_partner_id() and p.org = org_contacts.org
    )
  );
create policy org_contacts_insert on app.org_contacts for insert
  with check (app.is_org_contact_editor(org));
create policy org_contacts_update on app.org_contacts for update
  using (app.is_org_contact_editor(org))
  with check (app.is_org_contact_editor(org));
create policy org_contacts_delete on app.org_contacts for delete
  using (app.is_org_contact_editor(org));

-- (seed rows removed from the public release)
