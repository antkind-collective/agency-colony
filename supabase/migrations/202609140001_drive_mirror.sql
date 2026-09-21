-- Drive mirror (14 Sep 2026): every document Colony holds gets a copy
-- in his Drive folder. This table remembers which Drive file each Colony
-- document became, so a re-sync updates the file instead of making a twin.
-- Written only by the service role (the functions); leadership can read it
-- to show the "Copy in Drive" link.

create table if not exists app.drive_mirror (
  key            text primary key,              -- 'policy:<policy_key>' | 'agreement:<hire_id>:<doc_id>'
  file_id        text not null,
  name           text not null,
  web_view_link  text,
  synced_at      timestamptz not null default now()
);
alter table app.drive_mirror enable row level security;
drop policy if exists drive_mirror_select_leadership on app.drive_mirror;
create policy drive_mirror_select_leadership on app.drive_mirror
  for select using (app.is_leadership_or_admin());
grant select on app.drive_mirror to authenticated;

-- The folder, by Drive id. Alex's: "Agency Colony" documents folder.
insert into app.app_config (key, value)
values ('drive_mirror_folder_id', to_jsonb('YOUR_DRIVE_FOLDER_ID'::text))
on conflict (key) do update set value = excluded.value;
