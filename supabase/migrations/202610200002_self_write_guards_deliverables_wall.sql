-- Audit 20 Oct 2026 (Tue, access parity, self-write sweep). Three update
-- policies check WHOSE row it is but not WHICH columns change, and the UI
-- never sends the columns below on an update:
--
-- 1. brief_deliverables_update lets the ASSIGNEE update their deliverable with
--    no WITH CHECK beyond "still mine". A non-reviewer assignee could move it
--    to another brief (brief_id), including another client's, where
--    partner_brief_deliverables() shows its title and, once delivered, its
--    Drive link; or rewrite its title / type / SLA. The UI's assignee edits
--    are status, delivery link, delivered_at, assignee, and started_at/due_at
--    when creative starts. Now only brief reviewers change brief_id, title,
--    deliverable_type, discipline, sla_days, created_at.
-- 2. feature_requests_update_own let an employee set author_partner_id /
--    author_name on their own post: it then shows on that client's Circle
--    wall under a client's name, and disappears from Colony's.
-- 3. feature_request_replies_update_own let an employee re-point their reply
--    (feature_request_id) at a client's post, which the insert policy refuses,
--    or set author_partner_id / author_name.
-- The UI only sends request_text / status / request_type / updated_at on posts
-- and never updates replies. Authorship and the thread a reply belongs to are
-- now fixed for every signed-in caller; service role (auth.uid() null) passes.
-- Not used: 0 deliverables exist; every partner-authored post and reply has
-- employee_id null.

create or replace function app_private.guard_brief_deliverable_update()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if auth.uid() is null or app.is_brief_reviewer() then return new; end if;
  if new.brief_id is distinct from old.brief_id
     or new.title is distinct from old.title
     or new.deliverable_type is distinct from old.deliverable_type
     or new.discipline is distinct from old.discipline
     or new.sla_days is distinct from old.sla_days
     or new.created_at is distinct from old.created_at then
    raise exception 'Only brief reviewers can change which brief a deliverable belongs to, or what it is.';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_brief_deliverable_update() from public, anon, authenticated;
drop trigger if exists trg_guard_brief_deliverable_update on app.brief_deliverables;
create trigger trg_guard_brief_deliverable_update before update on app.brief_deliverables
  for each row execute function app_private.guard_brief_deliverable_update();

create or replace function app_private.guard_feature_request_authorship()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if auth.uid() is null then return new; end if;
  if new.employee_id is distinct from old.employee_id
     or new.author_partner_id is distinct from old.author_partner_id
     or new.author_name is distinct from old.author_name
     or new.created_at is distinct from old.created_at then
    raise exception 'Who wrote a post cannot be changed.';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_feature_request_authorship() from public, anon, authenticated;
drop trigger if exists trg_guard_feature_request_authorship on app.feature_requests;
create trigger trg_guard_feature_request_authorship before update on app.feature_requests
  for each row execute function app_private.guard_feature_request_authorship();

create or replace function app_private.guard_feature_reply_authorship()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if auth.uid() is null then return new; end if;
  if new.feature_request_id is distinct from old.feature_request_id
     or new.employee_id is distinct from old.employee_id
     or new.author_partner_id is distinct from old.author_partner_id
     or new.author_name is distinct from old.author_name
     or new.created_at is distinct from old.created_at then
    raise exception 'A reply stays on its post, under its author.';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_feature_reply_authorship() from public, anon, authenticated;
drop trigger if exists trg_guard_feature_reply_authorship on app.feature_request_replies;
create trigger trg_guard_feature_reply_authorship before update on app.feature_request_replies
  for each row execute function app_private.guard_feature_reply_authorship();
