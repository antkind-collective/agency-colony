-- Audit 20 Oct 2026 (Tue, access parity): an employee could set their own
-- direct_manager_email through the API. The profile's "Reports To" field is
-- leadership-only (index.html, .leadership-only), and since 14 Oct
-- (202610140003) the column decides who may mark someone out:
-- app_private.is_manager_of() trusts the TARGET's direct_manager_email, and
-- mark_leave_for() inserts the leave already approved. Dry run as maya@:
-- she named rhea@ as her manager, and rhea@ could then mark her out
-- "approved". Not used: the one marked leave is am-lead@ for rhea@, her
-- real manager.
--
-- Fix: the self-escalation trigger resets direct_manager_email for
-- non-leadership updates, like the other leadership-set fields. Onboarding's
-- pick still works (submit_onboarding_profile sets app.onboarding_sanctioned),
-- and the trigger is BEFORE UPDATE only, so ensure_employee_profile's insert
-- is untouched. Redefined from the LIVE definition (last 202610130001).
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
    -- Added 13 Oct 2026 (audit): leadership-set dates and the role label.
    NEW.joined_on := OLD.joined_on;
    NEW.activated_at := OLD.activated_at;
    NEW.role_title := OLD.role_title;
    -- Added 20 Oct 2026 (audit): the manager decides who may mark leave
    -- approved (is_manager_of / mark_leave_for).
    NEW.direct_manager_email := OLD.direct_manager_email;
  END IF;
  RETURN NEW;
END;
$function$;
