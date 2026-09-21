-- ============================================================
-- the client Brief Tracking: briefs + deliverables + SLA + history + comments
-- Per plan (GA_Dashboard_Flow_Document + the client SLA doc). Partners see only
-- their org's briefs; everything internal lives in creative_briefs and
-- internal-visibility comments, which partners can never read.
-- ============================================================

-- Enums ----------------------------------------------------------------------

create type app.brief_status as enum (
  'submitted', 'pending_info', 'ready_for_review', 'locked',
  'in_creative', 'delivered', 'completed',
  -- notify_only requests use this lightweight subset instead:
  'acknowledged', 'closed'
);

create type app.brief_request_type as enum ('brief', 'notify_only');
create type app.brief_priority as enum ('P0', 'P1', 'P2', 'P3');
create type app.deliverable_status as enum ('queued', 'in_progress', 'in_review', 'ready_to_share', 'delivered');
create type app.brief_comment_visibility as enum ('shared', 'internal');

-- Briefs (GA-facing — contains ONLY partner-authored/partner-visible fields) --

create table app.briefs (
  id uuid primary key default gen_random_uuid(),
  org text not null default 'Example Collective',
  title text not null,
  request_type app.brief_request_type not null default 'brief',
  status app.brief_status not null default 'submitted',
  priority app.brief_priority not null default 'P2',
  urgency_reason text,
  platforms text[] not null default '{}',
  objective text,
  audience text,
  key_message text,
  content_text text,
  key_dates text,
  links text,
  media_credits text,
  preferred_publish_date date,
  deadline date,
  approver_name text,
  notes text,
  submitted_by_partner_id uuid references app.partners(id),
  submitted_by_employee_id uuid references app.employees(id),
  locked_at timestamptz,
  locked_by_employee_id uuid references app.employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- notify_only requests live on the lightweight status subset; full briefs never use it
  constraint brief_status_matches_type_ck check (
    (request_type = 'notify_only' and status in ('submitted', 'acknowledged', 'closed'))
    or
    (request_type = 'brief' and status not in ('acknowledged', 'closed'))
  )
);

create index idx_briefs_status on app.briefs(status);
create index idx_briefs_org on app.briefs(org);
create index idx_briefs_submitter on app.briefs(submitted_by_partner_id);

-- SLA reference (seeded from the the client SLA doc; upper bound of quoted ranges) ----

create table app.deliverable_sla (
  id uuid primary key default gen_random_uuid(),
  discipline text not null,
  deliverable_type text not null,
  label text not null,
  sla_days numeric not null,
  unique (discipline, deliverable_type)
);

insert into app.deliverable_sla (discipline, deliverable_type, label, sla_days) values
  ('Copy',   'static',              'Social Media Static',        1),
  ('Copy',   'carousel',            'Carousel',                   1),
  ('Copy',   'video',               'Video',                      2),
  ('Copy',   'story_set',           'Story Set (3-5)',            1),
  ('Copy',   'slides_10',           'Presentation Slides (10)',   3),
  ('Copy',   'slides_20',           'Presentation Slides (20)',   5),
  ('Copy',   'newsletter',          'Newsletter',                10),
  ('Copy',   'announcement_board',  'Announcement Board (4)',     1),
  ('Design', 'static',              'Social Media Static',        1),
  ('Design', 'carousel',            'Carousel',                   2),
  ('Design', 'story_set',           'Story Set (3-5)',            1),
  ('Design', 'slides_10',           'Presentation Slides (10)',   3),
  ('Design', 'slides_20',           'Presentation Slides (20)',   5),
  ('Design', 'newsletter',          'Newsletter',                 4),
  ('Design', 'announcement_board',  'Announcement Board (4)',     1),
  ('Video',  'short_form',          'Short Form (30 Sec)',        2),
  ('Video',  'reel',                'Reel (45-60 Sec)',           4),
  ('Video',  'event_highlight',     'Event Highlight Video',      2),
  ('Video',  'complex_animation',   'Complex Animation',          7),
  ('Social', 'content_calendar',    'Content Calendar',           5),
  ('Social', 'campaign_concept',    'Campaign Concept',           5),
  ('Campaign', 'toolkit',           'Campaign Toolkit',          10),
  ('Campaign', 'adaptations',       'Campaign Adaptations',       4),
  ('Print',  'event_collateral',    'Event Collateral Suite',     7);

-- Deliverables (one row per output; SLA clock + assignment live here) ---------

create table app.brief_deliverables (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references app.briefs(id) on delete cascade,
  title text,
  discipline text,
  deliverable_type text,
  status app.deliverable_status not null default 'queued',
  sla_days numeric,
  started_at timestamptz,
  due_at timestamptz,
  delivered_at timestamptz,
  assignee_employee_id uuid references app.employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_brief_deliverables_brief on app.brief_deliverables(brief_id);
create index idx_brief_deliverables_assignee on app.brief_deliverables(assignee_employee_id);

-- Status history (mirrors deal_stage_history; written by trigger only) --------

create table app.brief_status_history (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references app.briefs(id) on delete cascade,
  status text not null,
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  changed_by_employee_id uuid references app.employees(id),
  changed_by_partner_id uuid references app.partners(id)
);

create index idx_brief_status_history_brief on app.brief_status_history(brief_id);

-- Comments (field of visibility: 'shared' = partner-visible, 'internal' = Your Agency) --

create table app.brief_comments (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references app.briefs(id) on delete cascade,
  body text not null,
  visibility app.brief_comment_visibility not null default 'shared',
  author_employee_id uuid references app.employees(id),
  author_partner_id uuid references app.partners(id),
  created_at timestamptz not null default now(),
  constraint brief_comment_single_author_ck check (
    (author_employee_id is not null)::int + (author_partner_id is not null)::int = 1
  )
);

create index idx_brief_comments_brief on app.brief_comments(brief_id);

-- Internal creative brief (Your Agency-only; referenced by deliverables) ----------

create table app.creative_briefs (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null unique references app.briefs(id) on delete cascade,
  internal_notes text,
  internal_deadline date,
  created_by uuid references app.employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Helpers ---------------------------------------------------------------------

-- Which briefs can the current PARTNER access? Coordinators and client
-- viewers see all their org's briefs; submitters only their own.
create or replace function app.partner_can_access_brief(p_brief_id uuid)
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1
    from app.briefs b
    join app.partners p on p.id = app.current_partner_id()
    where b.id = p_brief_id
      and b.org = p.org
      and (p.partner_role in ('coordinator', 'client_viewer')
           or b.submitted_by_partner_id = p.id)
  );
$$;

-- Storage-path variant: folder name may not be a uuid; fail closed.
create or replace function app.partner_can_access_brief_path(p_folder text)
returns boolean
language plpgsql stable security definer
set search_path to 'app', 'public'
as $$
begin
  if p_folder is null or p_folder !~ '^[0-9a-fA-F-]{36}$' then
    return false;
  end if;
  return app.partner_can_access_brief(p_folder::uuid);
end;
$$;

grant execute on function app.partner_can_access_brief(uuid) to authenticated;
grant execute on function app.partner_can_access_brief_path(text) to authenticated;

-- Triggers --------------------------------------------------------------------

create or replace function app.touch_brief_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_briefs_updated_at
  before update on app.briefs
  for each row execute function app.touch_brief_updated_at();
create trigger trg_brief_deliverables_updated_at
  before update on app.brief_deliverables
  for each row execute function app.touch_brief_updated_at();
create trigger trg_creative_briefs_updated_at
  before update on app.creative_briefs
  for each row execute function app.touch_brief_updated_at();

-- Status history writer. SECURITY DEFINER so partner-caused transitions log
-- even though partners have no insert policy on the history table.
create or replace function app.log_brief_status()
returns trigger
language plpgsql security definer
set search_path to 'app', 'public'
as $$
begin
  if tg_op = 'INSERT' then
    insert into app.brief_status_history (brief_id, status, changed_by_employee_id, changed_by_partner_id)
    values (new.id, new.status::text, app.current_employee_id(), app.current_partner_id());
  elsif new.status is distinct from old.status then
    update app.brief_status_history
      set exited_at = now()
      where brief_id = new.id and exited_at is null;
    insert into app.brief_status_history (brief_id, status, changed_by_employee_id, changed_by_partner_id)
    values (new.id, new.status::text, app.current_employee_id(), app.current_partner_id());
  end if;
  return new;
end;
$$;

create trigger trg_briefs_status_history
  after insert or update on app.briefs
  for each row execute function app.log_brief_status();

-- Partner write guard: DB-enforced lock (same discipline as
-- trg_block_employee_self_escalation — the UI is not the boundary).
-- Employees and service-role/cron calls pass through untouched.
create or replace function app.guard_partner_brief_update()
returns trigger
language plpgsql security definer
set search_path to 'app', 'public'
as $$
begin
  if auth.uid() is null or app.is_employee() then
    return new;
  end if;
  -- Caller is a partner (row visibility already RLS-scoped to their org).
  if old.status not in ('submitted', 'pending_info') then
    raise exception 'This brief is locked for edits — comment on it or ask your Your Agency contact.';
  end if;
  if new.status not in ('submitted', 'pending_info', 'ready_for_review') then
    raise exception 'This status change is done by the team.';
  end if;
  if new.locked_at is distinct from old.locked_at
     or new.locked_by_employee_id is distinct from old.locked_by_employee_id
     or new.org is distinct from old.org
     or new.submitted_by_partner_id is distinct from old.submitted_by_partner_id
     or new.submitted_by_employee_id is distinct from old.submitted_by_employee_id then
    raise exception 'That field is not editable.';
  end if;
  return new;
end;
$$;

create trigger trg_guard_partner_brief_update
  before update on app.briefs
  for each row execute function app.guard_partner_brief_update();

-- RLS -------------------------------------------------------------------------

alter table app.briefs enable row level security;
alter table app.deliverable_sla enable row level security;
alter table app.brief_deliverables enable row level security;
alter table app.brief_status_history enable row level security;
alter table app.brief_comments enable row level security;
alter table app.creative_briefs enable row level security;

-- briefs
create policy briefs_select on app.briefs for select
  using (app.is_employee() or app.partner_can_access_brief(id));
create policy briefs_insert_partner on app.briefs for insert
  with check (
    submitted_by_partner_id = app.current_partner_id()
    and exists (
      select 1 from app.partners p
      where p.id = app.current_partner_id()
        and p.org = briefs.org
        and p.partner_role in ('submitter', 'coordinator')
    )
  );
create policy briefs_insert_employee on app.briefs for insert
  with check (app.is_employee() and submitted_by_employee_id = app.current_employee_id());
create policy briefs_update_employee on app.briefs for update
  using (app.is_employee());
create policy briefs_update_partner on app.briefs for update
  using (
    status in ('submitted', 'pending_info')
    and app.partner_can_access_brief(id)
    and exists (
      select 1 from app.partners p
      where p.id = app.current_partner_id()
        and p.partner_role in ('submitter', 'coordinator')
    )
  );
create policy briefs_delete_leadership on app.briefs for delete
  using (app.is_leadership_or_admin());

-- deliverable_sla (internal reference; leadership edits)
create policy deliverable_sla_select on app.deliverable_sla for select
  using (app.is_employee());
create policy deliverable_sla_write on app.deliverable_sla for all
  using (app.is_leadership_or_admin()) with check (app.is_leadership_or_admin());

-- brief_deliverables (partners see progress of briefs they can access; writes internal)
create policy brief_deliverables_select on app.brief_deliverables for select
  using (app.is_employee() or app.partner_can_access_brief(brief_id));
create policy brief_deliverables_insert on app.brief_deliverables for insert
  with check (app.is_employee());
create policy brief_deliverables_update on app.brief_deliverables for update
  using (app.is_employee());
create policy brief_deliverables_delete on app.brief_deliverables for delete
  using (app.is_employee());

-- brief_status_history (read-only timeline; writes only via definer trigger)
create policy brief_status_history_select on app.brief_status_history for select
  using (app.is_employee() or app.partner_can_access_brief(brief_id));

-- brief_comments
create policy brief_comments_select_employee on app.brief_comments for select
  using (app.is_employee());
create policy brief_comments_select_partner on app.brief_comments for select
  using (visibility = 'shared' and app.partner_can_access_brief(brief_id));
create policy brief_comments_insert_employee on app.brief_comments for insert
  with check (app.is_employee() and author_employee_id = app.current_employee_id());
create policy brief_comments_insert_partner on app.brief_comments for insert
  with check (
    author_partner_id = app.current_partner_id()
    and visibility = 'shared'
    and app.partner_can_access_brief(brief_id)
    and exists (
      select 1 from app.partners p
      where p.id = app.current_partner_id()
        and p.partner_role in ('submitter', 'coordinator')
    )
  );
create policy brief_comments_delete_leadership on app.brief_comments for delete
  using (app.is_leadership_or_admin());

-- creative_briefs (Your Agency-only)
create policy creative_briefs_select on app.creative_briefs for select
  using (app.is_employee());
create policy creative_briefs_insert on app.creative_briefs for insert
  with check (app.is_employee());
create policy creative_briefs_update on app.creative_briefs for update
  using (app.is_employee());
create policy creative_briefs_delete on app.creative_briefs for delete
  using (app.is_leadership_or_admin());

-- Storage: briefs bucket ------------------------------------------------------
-- Folder convention: <brief_id>/ga/...        partner + internal files (GA-visible)
--                    <brief_id>/delivered/... deliverables (partner-visible once
--                                             the brief reaches delivered/completed)

insert into storage.buckets (id, name, public)
values ('briefs', 'briefs', false)
on conflict (id) do nothing;

create policy briefs_storage_select on storage.objects for select using (
  bucket_id = 'briefs' and (
    app.is_employee()
    or (
      app.partner_can_access_brief_path((storage.foldername(name))[1])
      and (
        (storage.foldername(name))[2] = 'ga'
        or exists (
          select 1 from app.briefs b
          where b.id::text = (storage.foldername(name))[1]
            and b.status in ('delivered', 'completed')
        )
      )
    )
  )
);

create policy briefs_storage_insert on storage.objects for insert with check (
  bucket_id = 'briefs' and (
    app.is_employee()
    or (
      (storage.foldername(name))[2] = 'ga'
      and app.partner_can_access_brief_path((storage.foldername(name))[1])
      and exists (
        select 1 from app.partners p
        where p.id = app.current_partner_id()
          and p.partner_role in ('submitter', 'coordinator')
      )
    )
  )
);

create policy briefs_storage_delete on storage.objects for delete using (
  bucket_id = 'briefs' and app.is_employee()
);
