-- the client closes its own delivered briefs; two Your Agency Gmail logins go quiet
-- (Alex + Mara, Slack, 30 Sep 2026; docs/OPEN.md C3 + C4).
--
-- 1. From "delivered" a partner who may write the brief (its submitter, or a
--    coordinator of the org: app.partner_can_edit_brief, unchanged) can now
--    APPROVE it (-> completed) as well as request a revision. Your Agency no
--    longer clicks Complete; a delivered brief nobody answers is completed
--    by the brief-auto-complete cron after 7 days. Content stays frozen
--    either way. Guard and policy are redefined from their LIVE definitions;
--    only the delivered branch and the WITH CHECK status list change.
-- 2. app.partners.email_opt_out: a client-side login that receives no Circle
--    emails. On for owner.personal@ and client.person2@ (Your Agency people who
--    approve on the client's behalf and already get the internal emails). Partners
--    can read their own row but only leadership updates partners (unchanged).

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
    -- Content is frozen: either answer may change status alone.
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
$function$;

alter policy briefs_update_partner on app.briefs
  with check ((status = any (array['submitted'::app.brief_status, 'pending_info'::app.brief_status, 'ready_for_review'::app.brief_status, 'under_revision'::app.brief_status, 'completed'::app.brief_status]))
    and app.partner_can_edit_brief(id)
    and (exists (select 1 from app.partners p
                 where p.id = app.current_partner_id()
                   and p.partner_role = any (array['submitter'::app.partner_role, 'coordinator'::app.partner_role]))));

alter table app.partners add column if not exists email_opt_out boolean not null default false;
update app.partners set email_opt_out = true
 where lower(email) in ('owner.personal@example.com', 'client.person2@example.com');
