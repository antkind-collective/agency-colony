-- One row per analytics FILE, so the uploads archive can say what each file
-- was and who sent it (18 Sep 2026: "can we also see an archive of
-- files separately for different platforms?").
--
-- Why a new table: app.client_analytics keeps ONE row per (client,
-- report_type) and overwrites file_name on every upload, so only the newest
-- file of each type could be labelled — 2 of Example Collective's 97 files. The
-- data was never recorded, so it cannot be recovered; this records it from
-- now on. object_name is the storage key, which is unique per upload and is
-- what the archive lists.
--
-- Access mirrors app.client_analytics exactly: readable by whoever can see
-- the client, written only by an analytics uploader as themselves. RLS and
-- grants are stated here, in the same migration that creates the table
-- (the 10 Sep lapse; see the colony-security-controls memory).

create table if not exists app.client_analytics_uploads (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references app.clients(id) on delete cascade,
  report_type  text not null,
  file_name    text not null,
  object_name  text not null,
  uploaded_by  uuid references app.employees(id),
  uploaded_at  timestamptz not null default now(),
  unique (client_id, object_name)
);

create index if not exists client_analytics_uploads_client_idx
  on app.client_analytics_uploads (client_id, uploaded_at desc);

alter table app.client_analytics_uploads enable row level security;

drop policy if exists analytics_uploads_select on app.client_analytics_uploads;
create policy analytics_uploads_select on app.client_analytics_uploads
  for select using (app.can_see_client(client_id));

drop policy if exists analytics_uploads_insert on app.client_analytics_uploads;
create policy analytics_uploads_insert on app.client_analytics_uploads
  for insert with check (
    app.is_analytics_uploader()
    and uploaded_by = app.current_employee_id()
    and app.can_see_client(client_id)
  );

drop policy if exists analytics_uploads_delete on app.client_analytics_uploads;
create policy analytics_uploads_delete on app.client_analytics_uploads
  for delete using (app.is_analytics_uploader() and app.can_see_client(client_id));

-- Stated by name, never by a loop over the schema. The revoke must include
-- `authenticated`: this schema's DEFAULT PRIVILEGES hand it ALL on every new
-- table, so a table created here arrives with UPDATE nobody asked for (seen
-- on this very table, 20 Sep 2026). Revoke everything first, then grant back
-- exactly the three verbs the app uses.
revoke all on app.client_analytics_uploads from public, anon, authenticated;
grant select, insert, delete on app.client_analytics_uploads to authenticated;
grant select, insert, delete on app.client_analytics_uploads to service_role;
