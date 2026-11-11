-- A task can only point at a project the caller can see (11 Oct 2026).
--
-- daily_tasks.project_id was checked nowhere: create_daily_task is SECURITY
-- DEFINER and inserted any p_project_id, and the insert/update policies only
-- checked employee_id. No task uses project_id today (0 of 6.3k; the client is
-- the `notes` tag, which "Suggest from tasks" counts), so nothing was opened.
-- But a fractional could pin a task to another client's project, and anything
-- that later reads project_id for allocations or reports would trust it.
--
-- Redefined from the LIVE definition (pg_get_functiondef, 11 Oct), per
-- "Several sessions, one repo". Grants and the declaration are unchanged.
-- The client tag itself is not restricted: the task form offers only the
-- caller's clients, and an out-of-scope tag opens nothing (allocation saves go
-- through resolve_client_project, which refuses clients outside scope).

CREATE OR REPLACE FUNCTION app.create_daily_task(p_task_date date, p_task_title text, p_project_id uuid DEFAULT NULL::uuid, p_status app.task_status DEFAULT 'in_progress'::app.task_status, p_notes text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_deadline date DEFAULT NULL::date)
 RETURNS app.daily_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
DECLARE
  requester_employee_id uuid;
  inserted_row app.daily_tasks%rowtype;
BEGIN
  requester_employee_id := app.current_employee_id();

  IF requester_employee_id IS NULL THEN
    RAISE EXCEPTION 'Employee profile not found. Please complete account bootstrap.';
  END IF;

  -- A task may only point at a project the caller can see (audit follow-up,
  -- 11 Oct 2026). Same words whether it is missing or out of scope.
  IF p_project_id IS NOT NULL AND NOT app.can_see_project(p_project_id) THEN
    RAISE EXCEPTION 'That project is not available.' USING errcode = 'P0001';
  END IF;

  INSERT INTO app.daily_tasks (
    employee_id,
    task_date,
    task_title,
    project_id,
    status,
    notes,
    description,
    deadline
  )
  VALUES (
    requester_employee_id,
    p_task_date,  -- pass null through for weekly tasks
    nullif(trim(p_task_title), ''),
    p_project_id,
    coalesce(p_status, 'in_progress'),
    nullif(p_notes, ''),
    nullif(trim(coalesce(p_description, '')), ''),
    p_deadline
  )
  RETURNING * INTO inserted_row;

  RETURN inserted_row;
END;
$function$;

alter policy daily_tasks_insert_own_or_leadership on app.daily_tasks
  with check (((employee_id = app.current_employee_id()) or app.is_leadership_or_admin())
              and (project_id is null or app.can_see_project(project_id)));

alter policy daily_tasks_update_own_or_leadership on app.daily_tasks
  using ((employee_id = app.current_employee_id()) or app.is_leadership_or_admin())
  with check (((employee_id = app.current_employee_id()) or app.is_leadership_or_admin())
              and (project_id is null or app.can_see_project(project_id)));
