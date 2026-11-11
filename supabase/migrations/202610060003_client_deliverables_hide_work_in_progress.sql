-- Clients see a deliverable's Drive link only once it is delivered, and never
-- who at Your Agency is working on it (S17, Alex, 6 Oct 2026).
--
-- brief_deliverables_select let a partner read every column of their org's
-- deliverables. Circle draws "Open in Drive" only when status = 'delivered',
-- but the API returned delivery_url from the moment a reviewer pasted it: a
-- client reading the table directly saw work in progress early, plus
-- assignee_employee_id. The table was empty when this was found, so nothing
-- was exposed.
--
-- Row rules cannot hide a column for some rows, so partners lose the table and
-- read app.partner_brief_deliverables() instead: their own org's rows only,
-- delivery_url null until delivered, assignee always null. Same row shape as
-- the table, so Circle's code reads it unchanged. Staff keep the table
-- (can_view_brief).

create or replace function app.partner_brief_deliverables()
returns setof app.brief_deliverables
language sql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
  -- Answers for the CALLER only; empty for anyone who is not a partner.
  select d.id, d.brief_id, d.title, d.discipline, d.deliverable_type, d.status,
         d.sla_days, d.started_at, d.due_at, d.delivered_at,
         null::uuid as assignee_employee_id,
         d.created_at, d.updated_at,
         case when d.status = 'delivered' then d.delivery_url end as delivery_url
  from app.brief_deliverables d
  where app.partner_can_access_brief(d.brief_id)
  order by d.created_at;
$fn$;

revoke all on function app.partner_brief_deliverables() from public, anon;

insert into app_private.callable_definer_functions(signature, reason) values
  (app_private.fn_signature('app.partner_brief_deliverables()'::regprocedure),
   'Circle: a partner''s own org deliverables, Drive link only once delivered, no assignee; called from loadBriefsData (S17, 6 Oct 2026)')
on conflict do nothing;

grant execute on function app.partner_brief_deliverables() to authenticated;

alter policy brief_deliverables_select on app.brief_deliverables
  using (app.can_view_brief(brief_id));
