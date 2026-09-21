-- Brief pipeline v2 (Rhea's the client feedback, 10 Aug 2026; approved by Alex):
-- 1. the client gate: a submitter's brief sits with Grace (stage 'submitted' =
--    "New brief"); only a COORDINATOR may send it to Your Agency. Coordinator's
--    own submissions skip the gate.
-- 2. 'locked' retires as a visible stage — the partner edit-freeze already
--    binds to stage (submitted/pending_info only), so In creative is frozen
--    by construction.
-- 3. delivered → under_revision → delivered replaces the reopen loop; the client can
--    request the revision themselves.
-- 4. Deliverables can be delivered as Google Drive links (delivery_url).

alter table app.brief_deliverables add column delivery_url text;

-- Partners may now also act on a delivered brief (request revision).
alter policy briefs_update_partner on app.briefs using (
  status in ('submitted', 'pending_info', 'delivered')
  and app.partner_can_access_brief(id)
  and exists (
    select 1 from app.partners p
    where p.id = app.current_partner_id()
      and p.partner_role in ('submitter', 'coordinator')
  )
);

-- Server-side truth for what a partner write may do at each stage.
create or replace function app.guard_partner_brief_update()
returns trigger
language plpgsql security definer
set search_path to 'app', 'public'
as $$
declare
  v_role app.partner_role;
begin
  if auth.uid() is null or app.is_employee() then
    return new;
  end if;
  select partner_role into v_role from app.partners where id = app.current_partner_id();

  if old.status in ('submitted', 'pending_info') then
    if new.status not in ('submitted', 'pending_info', 'ready_for_review') then
      raise exception 'This status change is done by the team.';
    end if;
    -- The the client gate: only a coordinator sends a new brief to Your Agency.
    -- (Resubmitting after a pending-info bounce is open to the submitter —
    -- Grace already approved it once.)
    if new.status = 'ready_for_review' and old.status = 'submitted' and v_role <> 'coordinator' then
      raise exception 'Only your coordinator can send this brief to Your Agency.';
    end if;
  elsif old.status = 'delivered' then
    if new.status <> 'under_revision' then
      raise exception 'From delivered you can only request a revision.';
    end if;
    -- Content is frozen: the revision request may change status alone.
    if new.title is distinct from old.title
       or new.objective is distinct from old.objective
       or new.key_message is distinct from old.key_message
       or new.content_text is distinct from old.content_text
       or new.requested_deliverables is distinct from old.requested_deliverables
       or new.platforms is distinct from old.platforms
       or new.deadline is distinct from old.deadline then
      raise exception 'Brief content is locked — describe the changes in a comment.';
    end if;
  else
    raise exception 'This brief is locked for edits — comment on it or ask your Your Agency contact.';
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

-- Partners can't choose their own entry stage: the server decides.
create or replace function app.guard_partner_brief_insert()
returns trigger
language plpgsql security definer
set search_path to 'app', 'public'
as $$
declare
  v_role app.partner_role;
begin
  if auth.uid() is null or app.is_employee() then
    return new;
  end if;
  select partner_role into v_role from app.partners where id = app.current_partner_id();
  if new.request_type = 'notify_only' then
    new.status := 'submitted';
  else
    new.status := case when v_role = 'coordinator' then 'ready_for_review' else 'submitted' end;
  end if;
  return new;
end;
$$;

create trigger trg_guard_partner_brief_insert
  before insert on app.briefs
  for each row execute function app.guard_partner_brief_insert();

-- The update policy's USING doubles as WITH CHECK by default, which rejected
-- the RESULT of legitimate transitions (approve → ready_for_review, revision
-- → under_revision). Explicit WITH CHECK for the states a partner write may
-- produce; the trigger above enforces which transitions are legal.
alter policy briefs_update_partner on app.briefs with check (
  status in ('submitted', 'pending_info', 'ready_for_review', 'under_revision')
  and app.partner_can_access_brief(id)
  and exists (
    select 1 from app.partners p
    where p.id = app.current_partner_id()
      and p.partner_role in ('submitter', 'coordinator')
  )
);
