-- Partners cannot write Your Agency's own fields on a brief (audit, 1 Oct 2026).
--
-- guard_partner_brief_update froze a brief's content and its ownership
-- columns, but not the staff-side ones. Live, as alice@ (the client submitter),
-- inside a rolled-back transaction, one "Approve delivery" update also set
-- paused_at + pause_reason (pause is a staff flag: js/briefs.js, paused_by =
-- an employee), backdated created_at to 2020, and changed priority and notes.
-- The same held from delivered -> under_revision (since 202608100002) and on
-- partner inserts. Circle never sends any of these: its approve/revise
-- buttons send status alone and collectBriefForm() has no pause, created_at
-- or lock fields, so the UI is unaffected.
--
-- 1. Update guard, for partners: paused_at / pause_reason / paused_by /
--    created_at join the "not editable" list on every branch, and from
--    delivered the update may change status (and the trigger-set updated_at)
--    and nothing else. Redefined from the LIVE definition (= 202609300004).
-- 2. Insert guard, for partners: a new brief starts unpaused, unlocked, with
--    no staff submitter, dated now.

create or replace function app.guard_partner_brief_update()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
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
     or new.created_at is distinct from old.created_at then
    raise exception 'That field is not editable.';
  end if;
  return new;
end;
$function$;

create or replace function app.guard_partner_brief_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
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
  -- Your Agency's own fields (1 Oct 2026): never set by a client.
  new.paused_at := null;
  new.pause_reason := null;
  new.paused_by := null;
  new.locked_at := null;
  new.locked_by_employee_id := null;
  new.submitted_by_employee_id := null;
  new.created_at := now();
  return new;
end;
$function$;
