-- S14 closed (5 Oct 2026: "fix S14 immediately"). Projects and
-- allocations follow client scope, like the rest of a client's data.
--
-- projects and allocations were readable by every employee
-- (`app.is_employee()`), so a fractional scoped to one client (asha@, Save
-- Missing Girls) read all 25 projects and all 787 allocation rows: every
-- client the agency works for, and who works on which, at what percent.
-- Now a fractional reads projects of the clients she can see
-- (`can_see_client`), her own allocations, and colleagues' allocations to those
-- clients. Full-time staff and leadership read everything, as before.
-- Writes are unchanged (own rows / leadership; allocation saves go through the
-- definer RPCs, which already check can_see_client since 202609280002).

-- Caller-level shortcut: true for leadership and non-fractional employees
-- (exactly where can_see_client is true for every client). Wrapped in
-- (select …) in the policy so it runs once per query, not once per row: the
-- per-row check alone took a full-time read of allocations from 87 to 780 ms.
create or replace function app.sees_every_client()
returns boolean
language sql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
  select app.is_leadership_or_admin() or (
    app.is_employee() and not coalesce((
      select e.employment_type = 'fractional'
      from app.employees e where e.id = app.current_employee_id()
    ), false));
$fn$;

revoke all on function app.sees_every_client() from public, anon;

insert into app_private.callable_definer_functions(signature, reason) values
  (app_private.fn_signature('app.sees_every_client()'::regprocedure),
   'RLS helper: allocations employee read policy shortcut; answers about the CALLER only (S14, 5 Oct 2026)')
on conflict do nothing;

grant execute on function app.sees_every_client() to authenticated;

create or replace function app.can_see_project(p_project_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
  -- Answers for the CALLER only.
  select exists (
    select 1 from app.projects p
    where p.id = p_project_id and app.can_see_client(p.client_id)
  );
$fn$;

revoke all on function app.can_see_project(uuid) from public, anon;

insert into app_private.callable_definer_functions(signature, reason) values
  (app_private.fn_signature('app.can_see_project(uuid)'::regprocedure),
   'RLS helper: allocations employee read policy; answers about the CALLER only (S14, 5 Oct 2026)')
on conflict do nothing;

grant execute on function app.can_see_project(uuid) to authenticated;

alter policy projects_select_all on app.projects
  using (app.is_employee() and app.can_see_client(client_id));

alter policy allocations_select_all_authenticated on app.allocations
  using ((select app.is_employee()) and (
    (select app.sees_every_client())
    or employee_id = (select app.current_employee_id())
    or app.can_see_project(project_id)));
