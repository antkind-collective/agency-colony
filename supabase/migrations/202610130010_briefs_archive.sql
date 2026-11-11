-- Briefs archive (13 Oct 2026): "Delete" moves a brief to the
-- archive instead of removing it, so a mistake can be pulled back. archived_at
-- marks a deleted brief; completed briefs sit in the same Archive tab by their
-- status. Only leadership and the account managers who run briefs
-- (is_brief_reviewer) may set or clear it; partners never can, and a deleted
-- brief disappears from Circle. guard_partner_brief_update is redefined from
-- its LIVE definition with only the two new columns added to the locked list.
alter table app.briefs add column if not exists archived_at timestamptz;
alter table app.briefs add column if not exists archived_by uuid references app.employees(id) on delete set null;

create or replace function app_private.guard_brief_archive()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  -- Service role and SQL (no signed-in user) pass; everyone else must be a
  -- brief reviewer to move a brief into or out of the archive.
  if auth.uid() is null then return new; end if;
  if (new.archived_at is distinct from old.archived_at or new.archived_by is distinct from old.archived_by)
     and not app.is_brief_reviewer() then
    raise exception 'Only leadership and account managers can delete or restore a brief.';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_brief_archive() from public, anon, authenticated;
drop trigger if exists trg_guard_brief_archive on app.briefs;
create trigger trg_guard_brief_archive before update of archived_at, archived_by on app.briefs
  for each row execute function app_private.guard_brief_archive();

-- A deleted brief is not shown to the client.
alter policy briefs_select on app.briefs using (
  app.can_view_brief(id) OR (EXISTS (SELECT 1 FROM app.partners p
    WHERE p.id = app.current_partner_id() AND p.org = briefs.org) AND briefs.archived_at IS NULL)
);

CREATE OR REPLACE FUNCTION app.guard_partner_brief_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
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
    -- Approve (completed) or ask for changes (under_revision), 30 Sep 2026.
    if new.status not in ('under_revision', 'completed') then
      raise exception 'From delivered you can approve it or request a revision.';
    end if;
    -- The answer is the status alone: every other column stays as it was
    -- (updated_at is set by trg_briefs_updated_at, which fires first).
    if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
      raise exception 'Brief content is locked — describe the changes in a comment.';
    end if;
  else
    raise exception 'This brief is locked for edits — comment on it or ask your Your Agency contact.';
  end if;

  if new.locked_at is distinct from old.locked_at
     or new.locked_by_employee_id is distinct from old.locked_by_employee_id
     or new.org is distinct from old.org
     or new.submitted_by_partner_id is distinct from old.submitted_by_partner_id
     or new.submitted_by_employee_id is distinct from old.submitted_by_employee_id
     or new.paused_at is distinct from old.paused_at
     or new.pause_reason is distinct from old.pause_reason
     or new.paused_by is distinct from old.paused_by
     or new.archived_at is distinct from old.archived_at
     or new.archived_by is distinct from old.archived_by
     or new.created_at is distinct from old.created_at then
    raise exception 'That field is not editable.';
  end if;
  return new;
end;
$function$;
