-- A deleted (archived) brief is closed to the client everywhere, not only on
-- the briefs list (audit 14 Oct 2026: the client could still read an archived brief's
-- status history through the API). Every partner path to a brief's child rows
-- goes through partner_can_access_brief: brief_status_history and
-- brief_comments policies, storage briefs/<id>/ files, partner_brief_deliverables.
-- Redefined from the LIVE definition with one condition added.
CREATE OR REPLACE FUNCTION app.partner_can_access_brief(p_brief_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
  select exists (
    select 1
    from app.briefs b
    join app.partners p on p.id = app.current_partner_id()
    where b.id = p_brief_id
      and b.org = p.org
      and b.archived_at is null
  );
$function$;
