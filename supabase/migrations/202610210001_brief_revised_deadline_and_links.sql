-- 21 Oct 2026 (Alex, Rhea). Two brief changes for Circle.
--
-- 1. A new date for the client. the client's comms package was due 15 Oct, a new
--    date of 21 Oct was agreed, and Circle kept showing "15 Oct, 6 days late":
--    `deadline` is the client's own date and freezes once creative starts
--    (locked_at), and the only date Your Agency could edit was
--    creative_briefs.internal_deadline, which clients never see. So the brief
--    gets `revised_deadline`: the date both sides now work to. `deadline`
--    stays as the client asked, so a slip is shown, never hidden.
--    Only the three brief reviewers set it (Rhea, Mara, Nadia: the
--    app_config.brief_reviewer_emails list) and Alex (21 Oct: "keep
--    the date change option with the 3 of us for now"). Not all leadership,
--    which app.is_brief_reviewer() would allow. It goes through the existing
--    briefs_update_employee policy; this trigger refuses everyone else and
--    stamps who and when.
--
-- 2. Links on a brief. Files only took uploads; Rhea asked for Drive and
--    Canva links. app.brief_links mirrors the 'briefs' storage policies
--    exactly: the same two folders ('ga' = working, client can see;
--    'delivered' = client sees once delivered or completed), the same writers,
--    reviewers delete.

alter table app.briefs
  add column if not exists revised_deadline date,
  add column if not exists revised_deadline_at timestamptz,
  add column if not exists revised_deadline_by uuid references app.employees(id) on delete set null;

create or replace function app_private.can_set_client_date()
 returns boolean
 language sql
 stable security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
  select app.is_superadmin()
      or exists (
        select 1 from app.employees e
        where e.auth_user_id = auth.uid()
          and e.is_active and e.access_paused_at is null
          and lower(e.email) in (
            select lower(jsonb_array_elements_text(coalesce(
              nullif((select value from app.app_config where key = 'brief_reviewer_emails'), 'null'::jsonb),
              '[]'::jsonb)))));
$function$;
revoke all on function app_private.can_set_client_date() from public, anon, authenticated;

create or replace function app_private.guard_brief_revised_deadline()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
begin
  -- Service role and SQL (no signed-in user) pass.
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if new.revised_deadline is not null or new.revised_deadline_at is not null or new.revised_deadline_by is not null then
      raise exception 'A brief starts without a new date.';
    end if;
    return new;
  end if;
  if new.revised_deadline is distinct from old.revised_deadline then
    if not app_private.can_set_client_date() then
      raise exception 'Only Rhea, Mara, Nadia and Alex can set a new date for the client.';
    end if;
    new.revised_deadline_at := case when new.revised_deadline is null then null else now() end;
    new.revised_deadline_by := case when new.revised_deadline is null then null else app.current_employee_id() end;
  elsif new.revised_deadline_at is distinct from old.revised_deadline_at
     or new.revised_deadline_by is distinct from old.revised_deadline_by then
    -- Who and when follow the date; nobody writes them directly.
    new.revised_deadline_at := old.revised_deadline_at;
    new.revised_deadline_by := old.revised_deadline_by;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_brief_revised_deadline on app.briefs;
create trigger trg_guard_brief_revised_deadline
  before insert or update on app.briefs
  for each row execute function app_private.guard_brief_revised_deadline();

create table if not exists app.brief_links (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references app.briefs(id) on delete cascade,
  folder text not null check (folder in ('ga', 'delivered')),
  url text not null check (url ~* '^https://[^\s]+$' and length(url) <= 2000),
  label text check (label is null or length(label) <= 200),
  added_by_employee_id uuid references app.employees(id) on delete set null,
  added_by_partner_id uuid references app.partners(id) on delete set null,
  created_at timestamptz not null default now(),
  check (num_nonnulls(added_by_employee_id, added_by_partner_id) <= 1)
);
create index if not exists brief_links_brief_idx on app.brief_links(brief_id);

alter table app.brief_links enable row level security;

-- Read: same as briefs_storage_select.
drop policy if exists brief_links_select on app.brief_links;
create policy brief_links_select on app.brief_links for select using (
  app.can_view_brief(brief_id)
  or (app.partner_can_access_brief(brief_id)
      and (folder = 'ga'
           or exists (select 1 from app.briefs b
                      where b.id = brief_links.brief_id
                        and b.status in ('delivered', 'completed'))))
);

-- Add: same as briefs_storage_insert, and the row names its real author.
drop policy if exists brief_links_insert on app.brief_links;
create policy brief_links_insert on app.brief_links for insert with check (
  (app.can_work_brief(brief_id)
   and added_by_employee_id = app.current_employee_id()
   and added_by_partner_id is null)
  or (folder = 'ga'
      and app.partner_can_edit_brief(brief_id)
      and added_by_partner_id = app.current_partner_id()
      and added_by_employee_id is null
      and exists (select 1 from app.partners p
                  where p.id = app.current_partner_id()
                    and p.partner_role in ('submitter', 'coordinator')))
);

-- Remove: same as briefs_storage_delete. No updates: remove and add again.
drop policy if exists brief_links_delete on app.brief_links;
create policy brief_links_delete on app.brief_links for delete using (app.is_brief_reviewer());

grant select, insert, delete on app.brief_links to authenticated;
