-- Employment type decides client visibility. Scope rows only qualify it.
--
-- Before this, visibility keyed off whether a person HAD rows in
-- employee_client_scope, and employment_type was written independently by the
-- profile editor. The two drifted in both directions (1 Sep 2026):
--
--   fractional -> consultant/full-time : stale rows kept restricting them, so
--       widening someone's contract did nothing until an approver re-activated
--       them. Silently too tight.
--   full-time -> fractional : no rows exist, so "unscoped => sees everything"
--       applied and they kept seeing all 26 clients. Silently too loose, and
--       this is the direction that matters — marking someone fractional is
--       exactly when you meant to restrict them.
--
-- Verified before the change: a salaried employee flipped to fractional still
-- read all 26 clients with setup_pending false.
--
-- The rule is now stated once, on the type:
--   fractional    -> sees ONLY clients with an explicit scope row. No rows means
--                    no clients, which fails closed the moment the type is set;
--                    an approver activating them with clients opens it back up.
--   everyone else -> sees every client, scope rows or not.
--
-- Nothing is deleted: a person flipped away from fractional keeps their rows,
-- inert, and flipping back restores exactly the old list. That also retires the
-- separate setup_pending test below, which existed only to fail closed during
-- the window before activation — the type now does that on its own.

create or replace function app.is_client_scoped(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  -- Rows alone no longer mean "scoped" — the contract type does. Keeps this
  -- helper honest for its other job: excluding dedicated people from agency
  -- capacity maths (isCapacityExcluded, js/access.js), where a stale row was
  -- wrongly dropping a full-time person out of the utilization average.
  select exists (
    select 1 from app.employees e
    where e.id = p_employee_id and e.employment_type = 'fractional'
  ) and exists (
    select 1 from app.employee_client_scope s where s.employee_id = p_employee_id
  );
$$;

create or replace function app.can_see_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  select case
    when app.is_leadership_or_admin() then true
    when not app.is_employee() then false
    when coalesce((
      select e.employment_type = 'fractional'
      from app.employees e where e.id = app.current_employee_id()
    ), false) then exists (
      select 1 from app.employee_client_scope s
      where s.employee_id = app.current_employee_id()
        and s.client_id = p_client_id
    )
    else true
  end;
$$;
