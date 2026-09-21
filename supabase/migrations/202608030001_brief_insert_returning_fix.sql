-- Rhea's first real partner submission failed: "new row violates
-- row-level security policy for table briefs". The INSERT passed its WITH
-- CHECK — the failure was the RETURNING step, which re-checks the SELECT
-- policy on the new row. That policy called partner_can_access_brief(id),
-- which looks the brief up in app.briefs — and the command snapshot doesn't
-- contain the row still being inserted, so the lookup found nothing and the
-- read was denied. Fix: judge the row by its own columns, no self-lookup.
-- (partner_can_access_brief stays for child tables — deliverables/comments/
-- history — where the parent brief already exists.)

alter policy briefs_select on app.briefs using (
  app.can_work_brief(id)
  or exists (
    select 1 from app.partners p
    where p.id = app.current_partner_id()
      and p.org = briefs.org
      and (p.partner_role in ('coordinator', 'client_viewer')
           or briefs.submitted_by_partner_id = p.id)
  )
);

-- Rhea's intake additions (3 Aug 2026):
-- "Partners to be tagged" — names, handles, links the client wants credited/tagged.
alter table app.briefs add column partners_to_tag text;

-- 'Caption' and 'Emailer' as requestable deliverables. SLA days are
-- placeholders pending team confirmation (leadership-editable table).
insert into app.deliverable_sla (discipline, deliverable_type, label, sla_days) values
  ('Copy',   'caption', 'Caption', 1),
  ('Copy',   'emailer', 'Emailer', 2),
  ('Design', 'emailer', 'Emailer', 2)
on conflict (discipline, deliverable_type) do nothing;
