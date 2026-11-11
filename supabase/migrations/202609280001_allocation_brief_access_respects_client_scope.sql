-- Weekday audit, 28 Sep 2026 (Monday, data layer).
--
-- app.can_work_brief() lets anyone allocated to a brief's client (in the last
-- 35 days) read and work that brief, via app.is_allocated_to_org(). Employees
-- write their own allocations (save_my_allocations / resolve_internal_project
-- are SECURITY DEFINER and resolve ANY client by name; the allocations insert
-- policy only checks employee_id = self). So a client-scoped fractional
-- employee could allocate herself 5% to a client outside her scope and then
-- read that client's briefs, comments and brief files: asha@ (scoped to Save
-- Missing Girls) went from 0 to all 9 Example Collective briefs, 14 brief files
-- and 9 comments in a rolled-back probe.
--
-- An allocation now only counts toward brief access for a client the caller
-- can see (app.can_see_client: leadership, non-fractional employees -> every
-- client; fractional -> their employee_client_scope). No live fractional holds
-- an allocation outside their scope, so nobody loses access they should have.

create or replace function app.is_allocated_to_org(p_org text)
returns boolean
language sql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select exists (
    select 1
    from app.allocations a
    join app.projects p on p.id = a.project_id
    join app.clients c on c.id = p.client_id
    where a.employee_id = app.current_employee_id()
      and lower(btrim(c.name)) = lower(btrim(coalesce(p_org, '')))
      and a.period_start >= current_date - 35
      and app.can_see_client(c.id)
  );
$$;
