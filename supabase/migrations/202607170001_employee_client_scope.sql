-- Client scoping: restrict a person to specific clients.
--
-- Colony assumed every employee works on every client. Project-based/fractional
-- people (an AM dedicated to one client) should only see their client. This adds
-- the concept; it is a NO-OP for anyone without scope rows, i.e. everyone today.
--
-- Design notes:
--  * Purpose-built table rather than reusing client_standing_allocations: that
--    is a leadership-authored Scope & Coverage artifact whose RLS
--    (is_leadership_or_admin) would make it unreadable by the very person being
--    gated -- a chicken-and-egg for the policies below.
--  * Helpers are SECURITY DEFINER so the clients policy can consult the scope
--    table without recursing through that table's own RLS.
--  * access_level stays orthogonal: leadership always sees everything, so a
--    scoped leader (fractional, on one project) is unrestricted here while
--    still being scoped for capacity purposes.

create table if not exists app.employee_client_scope (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references app.employees(id) on delete cascade,
  client_id uuid not null references app.clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (employee_id, client_id)
);

create index if not exists idx_employee_client_scope_employee on app.employee_client_scope(employee_id);
create index if not exists idx_employee_client_scope_client on app.employee_client_scope(client_id);

alter table app.employee_client_scope enable row level security;

-- You can read your own scope (the clients policy needs it); leadership manages all.
drop policy if exists employee_client_scope_select on app.employee_client_scope;
create policy employee_client_scope_select on app.employee_client_scope
  for select to authenticated
  using (employee_id = app.current_employee_id() or app.is_leadership_or_admin());

drop policy if exists employee_client_scope_write_leadership on app.employee_client_scope;
create policy employee_client_scope_write_leadership on app.employee_client_scope
  for all to authenticated
  using (app.is_leadership_or_admin())
  with check (app.is_leadership_or_admin());

-- Does this employee have any client scope at all?
create or replace function app.is_client_scoped(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1 from app.employee_client_scope s where s.employee_id = p_employee_id
  );
$$;

-- May the CURRENT caller see this client?
-- Unscoped callers (and callers with no employee profile, e.g. mid-bootstrap)
-- get the pre-existing "see everything" behaviour, so this is a no-op for them.
create or replace function app.can_see_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  select app.is_leadership_or_admin()
      or not app.is_client_scoped(app.current_employee_id())
      or exists (
        select 1 from app.employee_client_scope s
        where s.employee_id = app.current_employee_id()
          and s.client_id = p_client_id
      );
$$;

-- ── Swap the blanket read policies ────────────────────────────────────────────
-- The front end needs no changes: every client picker builds from state.clients
-- (a plain select on clients), so RLS narrows them automatically.
--
-- NOTE: projects is deliberately NOT gated. save_my_allocations hangs every
-- allocation-project under a synthetic client named 'Internal'; gating projects
-- by client would hide those and break a scoped person's own allocations.

drop policy if exists clients_select_all on app.clients;
create policy clients_select_all on app.clients
  for select to authenticated
  using (app.can_see_client(id));

drop policy if exists analytics_select_all on app.client_analytics;
create policy analytics_select_all on app.client_analytics
  for select
  using (app.can_see_client(client_id));

drop policy if exists scope_items_select_all on app.client_scope_items;
create policy scope_items_select_all on app.client_scope_items
  for select to authenticated
  using (app.can_see_client(client_id));

-- Readable by all authenticated: the home "Hours Allocated" stat is NOT
-- leadership-gated, so every viewer must compute the same capacity exclusion.
-- Safe: rows carry client_id only, and a scoped user can't resolve ids for
-- clients they can't see (clients RLS above). Writes stay leadership-only.
drop policy if exists employee_client_scope_select on app.employee_client_scope;
create policy employee_client_scope_select on app.employee_client_scope
  for select to authenticated
  using (true);
