-- Security audit 30 Sep 2026 (Wednesday): an employee could change their own
-- email.
--
-- employees_update_own lets a person update their own row, and authenticated
-- holds column UPDATE on `email`. trg_block_employee_self_escalation resets
-- the sensitive columns for non-leadership callers, but `email` was not among
-- them. Verified live inside a rolled-back transaction: as maya@,
-- `update app.employees set email = 'maya.alias@youragency.com'` succeeded.
--
-- Why it matters: is_brief_reviewer, is_invoice_viewer and is_superadmin
-- decide by employees.email (looked up by auth_user_id), not by the JWT.
-- Today the unique index on email stops anyone taking a listed address,
-- because every listed person has a row. But a listed address with no row
-- (a new reviewer typed into app_config before they sign in, or a
-- deleted row) would be one self-edit away from that role. It also lets a
-- person squat a future hire's address: ensure_employee_profile links a
-- first sign-in to an existing row by email. And it lets a person redirect
-- every email Colony sends about them.
--
-- No screen writes email, not even for leadership (app.js profile save and
-- onboarding never send it). So the DB rule now matches the UI: only
-- leadership/admin, or a sanctioned onboarding step, may change it.
--
-- Redefined from the LIVE definition (30 Sep 2026); the only change is the
-- `NEW.email` line.

CREATE OR REPLACE FUNCTION app.trg_block_employee_self_escalation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
BEGIN
  -- If the updater is NOT leadership/admin, block changes to sensitive columns
  IF NOT app.is_leadership_or_admin()
     AND coalesce(current_setting('app.onboarding_sanctioned', true), '') <> 'on' THEN
    NEW.access_level := OLD.access_level;
    NEW.is_active := OLD.is_active;
    NEW.leave_tracking_enabled := OLD.leave_tracking_enabled;
    NEW.department_id := OLD.department_id;
    NEW.approver_emails := OLD.approver_emails;
    -- Added Jul 2026: these decide client visibility and capacity maths.
    NEW.setup_pending := OLD.setup_pending;
    NEW.requested_department_id := OLD.requested_department_id;
    NEW.employment_type := OLD.employment_type;
    NEW.capacity_percent := OLD.capacity_percent;
    NEW.task_nudge_enabled := OLD.task_nudge_enabled;
    -- Added 15 Sep 2026: the job title.
    NEW.job_title := OLD.job_title;
    -- Added 30 Sep 2026 (audit): role helpers match on employees.email.
    NEW.email := OLD.email;
  END IF;
  RETURN NEW;
END;
$function$;
