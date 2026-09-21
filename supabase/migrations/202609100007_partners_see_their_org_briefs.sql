-- Everyone in a client org sees that org's requests (Mira Holt, 9 Sep 2026;
-- Alex's call, 10 Sep 2026).
--
-- Mira raised it herself: "I would like to see the status of other requests
-- by other teammates, and I don't seem to find it." She could not, because a
-- `submitter` saw only briefs they had raised — one of five, in her case.
-- Coordinators and client_viewers already saw everything.
--
-- The point of Circle is shared visibility of a shared campaign, so the split
-- is removed: org membership is the boundary now, for every partner role.
--
-- What this does NOT change, deliberately:
--  * The org boundary itself. A partner still sees only their own org.
--  * Who may ACT. Raising, approving and editing are unchanged — only reading
--    widens. The the client approval gate still lets a coordinator alone send a brief
--    to Your Agency.
--  * Internal discussion. brief_comments are split 'shared' vs internal and
--    partners have only ever seen 'shared'; that policy is untouched, so
--    widening here cannot expose an internal note.
--
-- brief_deliverables and brief_comments both route through this function, so
-- they follow automatically rather than needing their own edits.

create or replace function app.partner_can_access_brief(p_brief_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1
    from app.briefs b
    join app.partners p on p.id = app.current_partner_id()
    where b.id = p_brief_id
      and b.org = p.org
  );
$$;

-- The briefs table's own policy repeats the rule rather than calling the
-- function, so it has to be widened in step or the two disagree.
drop policy if exists briefs_select on app.briefs;
create policy briefs_select on app.briefs
  for select
  using (
    app.can_work_brief(id)
    or exists (
      select 1 from app.partners p
      where p.id = app.current_partner_id()
        and p.org = briefs.org
    )
  );
