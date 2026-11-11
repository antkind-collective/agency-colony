-- Registrations (5 Nov 2026): the number of artists registering on a
-- client's Jotform form (Example Collective first), as a health-of-the-movement
-- metric on the client's analytics in Colony. Never on Circle: partners can't
-- read client_analytics at all (can_see_client is false for non-employees).
--
-- The Jotform API key sits in its own table that no browser role can read or
-- write: only the server (service role) uses it. The superadmin pastes it in
-- through registrations-connect, which checks it with Jotform first.
-- Colony keeps counts per week, never the answers people gave.

create table if not exists app.registration_sources (
  client_id uuid primary key references app.clients(id) on delete cascade,
  provider text not null default 'jotform' check (provider = 'jotform'),
  form_id text not null check (form_id ~ '^[0-9]{6,20}$'),
  api_host text not null default 'api.jotform.com' check (api_host in ('api.jotform.com', 'eu-api.jotform.com', 'hipaa-api.jotform.com')),
  api_key text not null check (length(api_key) between 16 and 128),
  set_by uuid references app.employees(id) on delete set null,
  set_at timestamptz not null default now()
);
alter table app.registration_sources enable row level security;
revoke all on app.registration_sources from public, anon, authenticated;
-- No policies on purpose: nobody signed in reads or writes this table.

alter table app.client_analytics drop constraint if exists client_analytics_report_type_check;
alter table app.client_analytics add constraint client_analytics_report_type_check
  check (report_type = any (array['content', 'followers', 'visitors', 'instagram', 'instagram_audience',
    'facebook', 'community_pulse', 'website', 'newsletter', 'registrations']));
