-- Activate a new joiner ON their start date, not the day their paperwork ends
-- (9 Sep 2026).
--
-- Maya finished everything on 9 Sep but does not start until the 22nd.
-- Activating now would give her leave accrual, task nudges and client access
-- two weeks early; leaving her in Awaiting Setup relies on someone remembering
-- on the day. Neither is right, so the approver decides now and Colony applies
-- it then.
--
-- The authorisation happens when the approver SCHEDULES it. The cron that runs
-- later is executing a decision that was already made and checked, which is why
-- the runner does not re-ask "are you a setup approver" — there is no caller to
-- ask about.

-- ── 1. The work, without the authorisation check ──────────────────────────
-- Lifted verbatim out of activate_employee_setup so the immediate path and the
-- scheduled path cannot drift apart. Every validation stays here: a scheduled
-- activation must be refused for the same reasons an immediate one would be.
create or replace function app.apply_employee_setup(
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
  if p_capacity_percent is null or p_capacity_percent <= 0 or p_capacity_percent > 100 then
    raise exception 'Capacity must be between 1 and 100.';
  end if;
  if p_department_id is null then
    raise exception 'A department is required to activate.';
  end if;
  -- Fractional ONLY. A fractional person with no clients falls through to
  -- "unscoped" and sees everything — the hole setup_pending exists to close.
  -- Consultants are unscoped by design, like any salaried employee.
  if p_employment_type = 'fractional' and coalesce(array_length(p_client_ids, 1), 0) = 0 then
    raise exception 'A fractional person must be scoped to at least one client.';
  end if;

  perform set_config('app.onboarding_sanctioned', 'on', true);

  update app.employees
     set department_id = p_department_id,
         employment_type = p_employment_type,
         capacity_percent = p_capacity_percent,
         leave_tracking_enabled = (p_employment_type <> 'fractional'),
         task_nudge_enabled = (p_employment_type <> 'fractional'),
         requested_department_id = null,
         setup_pending = false,
         updated_at = now()
   where id = p_employee_id;

  if not found then
    raise exception 'Employee not found: %', p_employee_id;
  end if;

  perform set_config('app.onboarding_sanctioned', 'off', true);

  delete from app.employee_client_scope where employee_id = p_employee_id;
  if coalesce(array_length(p_client_ids, 1), 0) > 0 then
    insert into app.employee_client_scope (employee_id, client_id)
    select p_employee_id, unnest(p_client_ids)
    on conflict (employee_id, client_id) do nothing;
  end if;
end;
$$;

-- The RPC the app calls keeps its signature and its guard; only the body moves.
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
  perform app.apply_employee_setup(
    p_employee_id, p_department_id, p_employment_type, p_capacity_percent, p_client_ids);
  -- Scheduling and activating are mutually exclusive: activating by hand
  -- cancels anything pending, or the cron would re-apply it later.
  delete from app.scheduled_activations where employee_id = p_employee_id and applied_at is null;
end;
$$;

-- ── 2. What was decided, and when to do it ────────────────────────────────
create table if not exists app.scheduled_activations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references app.employees(id) on delete cascade,
  activate_on date not null,
  department_id uuid not null references app.departments(id),
  employment_type app.employment_type not null,
  capacity_percent numeric not null,
  client_ids uuid[] not null default '{}',
  scheduled_by uuid references app.employees(id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  last_error text
);

-- One pending schedule per person: scheduling again replaces the decision
-- rather than queueing a second one.
create unique index if not exists scheduled_activations_pending_uq
  on app.scheduled_activations (employee_id) where applied_at is null;

alter table app.scheduled_activations enable row level security;

-- Only setup approvers see or touch these — the payload says what team and
-- capacity someone will get, which is the same sensitivity as the panel itself.
drop policy if exists scheduled_activations_approver on app.scheduled_activations;
create policy scheduled_activations_approver on app.scheduled_activations
  for all using (app.is_setup_approver()) with check (app.is_setup_approver());

-- ── 3. Schedule it ────────────────────────────────────────────────────────
create or replace function app.schedule_employee_setup(
  p_employee_id uuid,
  p_activate_on date,
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
    raise exception 'Only a setup approver can schedule an activation.';
  end if;
  if p_activate_on is null or p_activate_on <= (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Pick a future date — to activate today, just activate.';
  end if;
  -- Validate NOW, against the same rules, so a bad payload is refused while
  -- someone is looking at it rather than failing silently in a cron at 10 AM
  -- on their start date.
  if p_capacity_percent is null or p_capacity_percent <= 0 or p_capacity_percent > 100 then
    raise exception 'Capacity must be between 1 and 100.';
  end if;
  if p_department_id is null then
    raise exception 'A department is required.';
  end if;
  if p_employment_type = 'fractional' and coalesce(array_length(p_client_ids, 1), 0) = 0 then
    raise exception 'A fractional person must be scoped to at least one client.';
  end if;

  delete from app.scheduled_activations where employee_id = p_employee_id and applied_at is null;
  insert into app.scheduled_activations
    (employee_id, activate_on, department_id, employment_type, capacity_percent, client_ids, scheduled_by)
  values
    (p_employee_id, p_activate_on, p_department_id, p_employment_type, p_capacity_percent,
     coalesce(p_client_ids, '{}'), app.current_employee_id());
end;
$$;

create or replace function app.cancel_scheduled_activation(p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path to 'app', 'public'
as $$
begin
  if not app.is_setup_approver() then
    raise exception 'Only a setup approver can cancel an activation.';
  end if;
  delete from app.scheduled_activations where employee_id = p_employee_id and applied_at is null;
end;
$$;

-- ── 4. Run the ones that are due ──────────────────────────────────────────
-- No approver check: the decision was authorised when it was scheduled, and a
-- cron has no caller to check. Dated in IST, the agency clock.
--
-- Skips anyone no longer setup_pending — activated by hand in the meantime, so
-- re-applying would overwrite a more recent decision with an older one.
-- A failure is recorded on the row and does not stop the others.
create or replace function app.run_due_activations()
returns table (employee_id uuid, applied boolean, detail text)
language plpgsql
security definer
set search_path to 'app', 'public'
as $$
declare
  r record;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  for r in
    select s.* from app.scheduled_activations s
    where s.applied_at is null and s.activate_on <= today
    order by s.activate_on
  loop
    if not exists (select 1 from app.employees e where e.id = r.employee_id and e.setup_pending) then
      update app.scheduled_activations
         set applied_at = now(), last_error = 'skipped: already activated'
       where id = r.id;
      employee_id := r.employee_id; applied := false; detail := 'already activated';
      return next;
      continue;
    end if;
    begin
      perform app.apply_employee_setup(
        r.employee_id, r.department_id, r.employment_type, r.capacity_percent, r.client_ids);
      update app.scheduled_activations set applied_at = now(), last_error = null where id = r.id;
      employee_id := r.employee_id; applied := true; detail := 'activated';
      return next;
    exception when others then
      update app.scheduled_activations set last_error = sqlerrm where id = r.id;
      employee_id := r.employee_id; applied := false; detail := sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

revoke all on function app.apply_employee_setup(uuid, uuid, app.employment_type, numeric, uuid[]) from public, anon, authenticated;
revoke all on function app.run_due_activations() from public, anon, authenticated;
grant execute on function app.schedule_employee_setup(uuid, date, uuid, app.employment_type, numeric, uuid[]) to authenticated;
grant execute on function app.cancel_scheduled_activation(uuid) to authenticated;
