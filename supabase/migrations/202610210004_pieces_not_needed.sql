-- 21 Oct 2026 (Alex): "Not needed" in the Copy and Design pickers. Leads
-- (and account managers) may mark a part not needed, or needed again, so a
-- piece never waits on a part it doesn't have. A part marked not needed loses
-- its owner and done mark; a piece must still need at least one of the two.
-- Redefined from the LIVE definition (202610210003).
CREATE OR REPLACE FUNCTION app_private.guard_brief_deliverable_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
declare
  v_signed_in boolean := auth.uid() is not null;
  v_reviewer boolean := auth.uid() is null or app.is_brief_reviewer();
  v_lead boolean := false;
  v_me uuid := app.current_employee_id();
  v_old_status app.deliverable_status := case when tg_op = 'UPDATE' then old.status else null end;
  v_assigned boolean;
  v_done boolean;
begin
  if tg_op = 'UPDATE' then
    v_lead := v_signed_in and app.is_creative_lead(old.brief_id);

    if not v_reviewer then
      -- What the piece is, and which brief it belongs to: account managers only.
      if new.brief_id is distinct from old.brief_id
         or new.title is distinct from old.title
         or new.deliverable_type is distinct from old.deliverable_type
         or new.discipline is distinct from old.discipline
         or new.sla_days is distinct from old.sla_days
         or new.created_at is distinct from old.created_at
         or new.due_at is distinct from old.due_at
         or new.assignee_employee_id is distinct from old.assignee_employee_id then
        raise exception 'Only the account managers can change what a piece is or when it is due.';
      end if;
      -- Leads may mark copy or design not needed, or needed again (Alex,
      -- 21 Oct 2026: so nobody waits on a part the piece doesn't have).
      if (new.needs_copy is distinct from old.needs_copy
          or new.needs_design is distinct from old.needs_design) and not v_lead then
        raise exception 'Only the creative leads and account managers change what a piece needs.';
      end if;
      if (new.copy_assignee_id is distinct from old.copy_assignee_id
          or new.design_assignee_id is distinct from old.design_assignee_id) and not v_lead then
        raise exception 'Only the creative leads and account managers assign people.';
      end if;
      if new.copy_done_at is distinct from old.copy_done_at
         and not (v_lead or v_me = old.copy_assignee_id) then
        raise exception 'Only the person on the copy can mark it done.';
      end if;
      if new.design_done_at is distinct from old.design_done_at
         and not (v_lead or v_me = old.design_assignee_id) then
        raise exception 'Only the person on the design can mark it done.';
      end if;
      if new.status is distinct from old.status then
        if not (v_lead and old.status = 'in_review' and new.status in ('ready_to_share', 'in_progress')) then
          raise exception 'Only the creative lead approves or sends back at lead review, and only the account managers share with the client.';
        end if;
      end if;
    end if;

    -- Stamped here, never written by the app.
    new.lead_approved_at := old.lead_approved_at;
    new.lead_approved_by := old.lead_approved_by;
    new.sent_back_at := old.sent_back_at;
    new.sent_back_by := old.sent_back_by;
    new.shared_by := old.shared_by;
    new.delivered_at := old.delivered_at;
    new.started_at := old.started_at;

    -- A part that isn't needed has no owner and nothing to mark done.
    if not new.needs_copy then new.copy_assignee_id := null; new.copy_done_at := null; end if;
    if not new.needs_design then new.design_assignee_id := null; new.design_done_at := null; end if;
    if not (new.needs_copy or new.needs_design) then
      raise exception 'A piece needs copy, design or both. Remove the piece instead.';
    end if;

    -- A new owner starts fresh.
    if new.copy_assignee_id is distinct from old.copy_assignee_id then new.copy_done_at := null; end if;
    if new.design_assignee_id is distinct from old.design_assignee_id then new.design_done_at := null; end if;
    if new.copy_done_at is not null and old.copy_done_at is null then new.copy_done_at := now(); end if;
    if new.design_done_at is not null and old.design_done_at is null then new.design_done_at := now(); end if;
  else
    -- A new piece starts clean; only account managers insert (policy).
    new.copy_done_at := null; new.design_done_at := null;
    new.lead_approved_at := null; new.lead_approved_by := null;
    new.sent_back_at := null; new.sent_back_by := null;
    new.shared_by := null; new.delivered_at := null; new.started_at := null;
    new.status := 'queued';
  end if;

  -- Moves someone made on purpose.
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'in_progress' and old.status in ('in_review', 'ready_to_share', 'delivered') then
      -- Sent back: the owners pick it up again.
      new.copy_done_at := null; new.design_done_at := null;
      new.lead_approved_at := null; new.lead_approved_by := null;
      new.sent_back_at := now(); new.sent_back_by := v_me;
    elsif new.status = 'ready_to_share' and old.status = 'in_review' then
      new.lead_approved_at := now(); new.lead_approved_by := v_me;
    elsif new.status = 'delivered' then
      new.delivered_at := now(); new.shared_by := v_me;
    end if;
    return new;
  end if;

  -- Otherwise the stage follows the people and the done marks.
  if coalesce(v_old_status, 'queued') in ('queued', 'in_progress') then
    v_assigned := (not new.needs_copy or new.copy_assignee_id is not null)
              and (not new.needs_design or new.design_assignee_id is not null)
              and (new.needs_copy or new.needs_design);
    v_done := v_assigned
              and (not new.needs_copy or new.copy_done_at is not null)
              and (not new.needs_design or new.design_done_at is not null);
    if not v_assigned then
      new.status := 'queued';
    elsif v_done then
      new.status := 'in_review';
    else
      new.status := 'in_progress';
      new.started_at := coalesce(new.started_at, now());
    end if;
  end if;
  return new;
end;
$function$;
