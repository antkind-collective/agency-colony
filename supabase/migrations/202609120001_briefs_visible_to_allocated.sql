-- Anyone allocated to the client behind a brief can work its briefs
-- (12 Sep 2026: "all folks who work on Example Collective or allocated on
-- it should see it"). Until now only reviewers, leadership and people with a
-- deliverable assigned could; a writer allocated to the client but not yet assigned
-- saw no Briefs tab at all.
--
-- "Allocated" = any allocation on a project of that client whose period
-- starts within the last five weeks or in the future — the current picture,
-- not the whole history. briefs.org is the client's name (one client today:
-- Example Collective), so the match is by name.

create or replace function app.is_allocated_to_org(p_org text)
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1
    from app.allocations a
    join app.projects p on p.id = a.project_id
    join app.clients c on c.id = p.client_id
    where a.employee_id = app.current_employee_id()
      and lower(btrim(c.name)) = lower(btrim(coalesce(p_org, '')))
      and a.period_start >= current_date - 35
  );
$$;
grant execute on function app.is_allocated_to_org(text) to authenticated;

create or replace function app.can_work_brief(p_brief_id uuid)
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select app.is_brief_reviewer()
      or app.is_assigned_to_brief(p_brief_id)
      or app.is_allocated_to_org((select b.org from app.briefs b where b.id = p_brief_id));
$$;
