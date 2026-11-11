-- 21 Oct 2026 (Alex; Rhea's "Proposed Workflow: Brief Management & Task
-- Assignment in Colony"). A brief is split into pieces (brief_deliverables);
-- each piece needs copy, design or both, and carries one owner per part.
--
--   queued       To assign: a part it needs has nobody yet
--   in_progress  Assigned; the owners are working (or it was sent back)
--   in_review    Every part it needs is marked done: the creative lead checks
--   ready_to_share  The lead approved: Rhea or Mara checks
--   delivered    Shared with the client (only now does Circle show it)
--
-- Who does what:
--   * Account managers (app.is_brief_reviewer) split the brief, add and
--     remove pieces, and approve to share or send back. Either one is enough.
--   * Creative leads per client (app_config.creative_leads, org -> emails;
--     the client = Dev, art, and Vera, copy) assign copy AND design, to
--     anyone or themselves, and approve or send back at lead review.
--   * An owner marks only their own part done and adds the piece's link.
-- The stage moves by itself (this trigger): assigned -> in progress, all parts
-- done -> lead review. Sending back clears the done marks. Who approved,
-- when it was sent back, and when it was shared are stamped here, never
-- written by the app.
-- No piece row has ever existed (0 rows on 21 Oct), so nothing migrates.

alter table app.brief_deliverables
  add column if not exists needs_copy boolean not null default false,
  add column if not exists needs_design boolean not null default false,
  add column if not exists copy_assignee_id uuid references app.employees(id) on delete set null,
  add column if not exists design_assignee_id uuid references app.employees(id) on delete set null,
  add column if not exists copy_done_at timestamptz,
  add column if not exists design_done_at timestamptz,
  add column if not exists lead_approved_at timestamptz,
  add column if not exists lead_approved_by uuid references app.employees(id) on delete set null,
  add column if not exists sent_back_at timestamptz,
  add column if not exists sent_back_by uuid references app.employees(id) on delete set null,
  add column if not exists shared_by uuid references app.employees(id) on delete set null;

-- Who leads creative for the client, by client name (the briefs.org value).
insert into app.app_config(key, value)
values ('creative_leads', '{"Example Collective": ["dev@youragency.com", "vera@youragency.com"]}'::jsonb)
on conflict (key) do nothing;

-- Is the caller a creative lead for this brief's client? Referenced by the
-- update policy, so it lives in app and authenticated may execute it.
create or replace function app.is_creative_lead(p_brief_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
  select exists (
    select 1
    from app.briefs b
    join app.employees e on e.auth_user_id = auth.uid()
      and e.is_active and e.access_paused_at is null
    where b.id = p_brief_id
      and lower(e.email) in (
        select lower(jsonb_array_elements_text(coalesce(
          (select value -> b.org from app.app_config where key = 'creative_leads'), '[]'::jsonb)))));
$function$;
revoke all on function app.is_creative_lead(uuid) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.is_creative_lead(uuid)'::regprocedure),
        'brief_deliverables_update policy and the brief drawer: may the caller assign and lead-review pieces of this brief (creative_leads by client)')
on conflict do nothing;
grant execute on function app.is_creative_lead(uuid) to authenticated;

-- Owners and leads can update a piece; the trigger decides what they may change.
drop policy if exists brief_deliverables_update on app.brief_deliverables;
create policy brief_deliverables_update on app.brief_deliverables for update using (
  app.is_brief_reviewer()
  or app.is_creative_lead(brief_id)
  or app.current_employee_id() in (assignee_employee_id, copy_assignee_id, design_assignee_id)
);

-- Redefined from the LIVE definition (audit 20 Oct, 202610200002), widened
-- for the piece workflow.
create or replace function app_private.guard_brief_deliverable_update()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
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
         or new.needs_copy is distinct from old.needs_copy
         or new.needs_design is distinct from old.needs_design
         or new.due_at is distinct from old.due_at
         or new.assignee_employee_id is distinct from old.assignee_employee_id then
        raise exception 'Only the account managers can change what a piece is or when it is due.';
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

drop trigger if exists trg_guard_brief_deliverable_update on app.brief_deliverables;
create trigger trg_guard_brief_deliverable_update
  before insert or update on app.brief_deliverables
  for each row execute function app_private.guard_brief_deliverable_update();

-- The client sees a piece only once it is shared (Rhea: "the client
-- receives only the approved deliverable"), and never who made it. Redefined
-- from the LIVE definition; the column list must match the table's row type.
create or replace function app.partner_brief_deliverables()
 returns setof app.brief_deliverables
 language sql
 stable security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
  -- Answers for the CALLER only; empty for anyone who is not a partner.
  select d.id, d.brief_id, d.title, d.discipline, d.deliverable_type, d.status,
         d.sla_days, d.started_at, d.due_at, d.delivered_at,
         null::uuid as assignee_employee_id,
         d.created_at, d.updated_at,
         d.delivery_url,
         d.needs_copy, d.needs_design,
         null::uuid, null::uuid, null::timestamptz, null::timestamptz,
         null::timestamptz, null::uuid, null::timestamptz, null::uuid, null::uuid
  from app.brief_deliverables d
  where app.partner_can_access_brief(d.brief_id)
    and d.status = 'delivered'
  order by d.created_at;
$function$;

-- Being given a piece, or leading creative for the client, lets you open and
-- work that brief, as the old single assignee did. Found in the dry run: a
-- designer not allocated to the client could be assigned a piece she could not see.
-- Redefined from the LIVE definition (202609150002).
create or replace function app.is_assigned_to_brief(p_brief_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
  select exists (
    select 1 from app.brief_deliverables d
    where d.brief_id = p_brief_id
      and app.current_employee_id() in (d.assignee_employee_id, d.copy_assignee_id, d.design_assignee_id)
  ) or app.is_creative_lead(p_brief_id);
$function$;
