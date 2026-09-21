-- Project-based onboarding: declare, then get approved.
--
-- A new joiner now says how they work with Your Agency (full-time / project-based)
-- and which team they're on. Neither is authoritative: both are a REQUEST that
-- Alex or Nadia approves, at which point the person is activated with a
-- capacity and a client scope.
--
-- Why a request and not a direct write:
--  * Department was already being written straight from onboarding and SILENTLY
--    DISCARDED — trg_block_employee_self_escalation reverts department_id for
--    non-leadership updaters, so a new joiner picked their team, saw "saved",
--    and nothing happened. Routing it through approval fixes that bug rather
--    than working around it.
--  * Being project-based has consequences the person can't see (no leave
--    accrual, capacity maths, client gating). They report it; someone confirms.
--
-- The gating problem this closes: app.is_client_scoped() is "has any scope
-- rows", so NO rows meant unscoped meant SEES EVERY CLIENT. A project-based
-- person awaiting setup was therefore at their most exposed exactly when they
-- were least configured. setup_pending makes "declared, not yet configured" a
-- real state that closes client access instead of an absence that opens it.

-- ── Columns ───────────────────────────────────────────────────────────────────
alter table app.employees
  add column if not exists setup_pending boolean not null default false;

-- The team they asked for. Kept separate from department_id so the request is
-- visible next to the current value in the approval queue, and so an unapproved
-- request never silently becomes the truth.
alter table app.employees
  add column if not exists requested_department_id uuid references app.departments(id);

comment on column app.employees.setup_pending is
  'Awaiting approver setup after onboarding. Drives the approval queue + bell for EVERYONE (department_id can only be applied by an approver). Additionally gates client access when employment_type = fractional. Cleared by app.activate_employee_setup().';
comment on column app.employees.requested_department_id is
  'Team chosen during onboarding. A request, not the truth — department_id is only written by app.activate_employee_setup(), because trg_block_employee_self_escalation reverts self-writes to department_id.';

-- Existing people are already set up. Ships as a no-op for all 16.
update app.employees set setup_pending = false where setup_pending is null;

-- ── Who approves ──────────────────────────────────────────────────────────────
-- Alex and Nadia only — NOT leadership-wide. Config-driven so it can change
-- without a deploy, with an in-code fallback if the key is missing/empty.
insert into app.app_config (key, value)
values ('setup_approver_emails', '["admin@youragency.com","am-lead@youragency.com"]'::jsonb)
on conflict (key) do nothing;

create or replace function app.is_setup_approver()
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1
    from app.employees e
    where e.auth_user_id = auth.uid()
      and e.is_active
      and lower(e.email) in (
        select lower(jsonb_array_elements_text(
          coalesce(
            nullif((select value from app.app_config where key = 'setup_approver_emails'), 'null'::jsonb),
            '["admin@youragency.com","am-lead@youragency.com"]'::jsonb
          )
        ))
      )
  );
$$;

-- ── The gate ──────────────────────────────────────────────────────────────────
-- Same as before plus one clause: awaiting-setup AND project-based ⇒ no
-- clients.
--
-- Both halves of that condition matter. "Awaiting approval" and "gated" are
-- deliberately NOT the same thing: everyone who onboards needs an approver
-- (department_id can only be applied by one), but gating client access is only
-- right for someone who declared project-based. A new full-time hire seeing
-- clients on day one is existing behaviour, and blocking them would be a
-- regression nobody asked for.
--
-- Leadership still short-circuits, so a pending leader (Anya's shape) is not
-- gated — this gates employees awaiting configuration, not leaders.
create or replace function app.can_see_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  select case
    when app.is_leadership_or_admin() then true
    when exists (
      select 1 from app.employees e
      where e.id = app.current_employee_id()
        and e.setup_pending
        and e.employment_type = 'fractional'
    ) then false
    when not app.is_client_scoped(app.current_employee_id()) then true
    else exists (
      select 1 from app.employee_client_scope s
      where s.employee_id = app.current_employee_id()
        and s.client_id = p_client_id
    )
  end;
$$;

-- ── Activation ────────────────────────────────────────────────────────────────
-- SECURITY DEFINER because it writes department_id, which the self-escalation
-- trigger reverts for anyone who isn't leadership — and because it must apply
-- the department, capacity, type and scope as ONE atomic act. A half-activated
-- person (scoped but still pending, or pending cleared with no scope) is
-- exactly the leaky in-between state this whole change exists to remove.
create or replace function app.activate_employee_setup(
  p_employee_id uuid,
  p_department_id uuid,
  p_employment_type app.employment_type,
  p_capacity_percent numeric,
  p_client_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path to 'app', 'public'
as $$
begin
  if not app.is_setup_approver() then
    raise exception 'Only a setup approver can activate an employee.';
  end if;
  if p_capacity_percent is null or p_capacity_percent <= 0 or p_capacity_percent > 100 then
    raise exception 'Capacity must be between 1 and 100.';
  end if;
  if p_department_id is null then
    raise exception 'A department is required to activate.';
  end if;
  -- A project-based person with no clients would fall through to "unscoped" and
  -- see everything — the precise hole setup_pending exists to close. Refuse.
  if p_employment_type = 'fractional' and coalesce(array_length(p_client_ids, 1), 0) = 0 then
    raise exception 'A project-based person must be scoped to at least one client.';
  end if;

  update app.employees
     set department_id = p_department_id,
         employment_type = p_employment_type,
         capacity_percent = p_capacity_percent,
         -- Project-based people don't accrue leave (agreed Jul 2026).
         leave_tracking_enabled = (p_employment_type = 'full-time'),
         task_nudge_enabled = (p_employment_type = 'full-time'),
         requested_department_id = null,
         setup_pending = false,
         updated_at = now()
   where id = p_employee_id;

  if not found then
    raise exception 'Employee not found: %', p_employee_id;
  end if;

  -- Replace scope wholesale: activation is the definitive statement of who they
  -- work with, and re-running it must converge rather than accumulate.
  delete from app.employee_client_scope where employee_id = p_employee_id;
  if coalesce(array_length(p_client_ids, 1), 0) > 0 then
    insert into app.employee_client_scope (employee_id, client_id)
    select p_employee_id, unnest(p_client_ids)
    on conflict (employee_id, client_id) do nothing;
  end if;
end;
$$;

revoke all on function app.activate_employee_setup(uuid, uuid, app.employment_type, numeric, uuid[]) from public;
grant execute on function app.activate_employee_setup(uuid, uuid, app.employment_type, numeric, uuid[]) to authenticated;
