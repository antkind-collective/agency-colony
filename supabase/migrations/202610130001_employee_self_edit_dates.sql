-- Access-parity audit, 13 Oct 2026: the profile editor lets only leadership
-- set "Joined Your Agency" (canEditGuarded, aef2d9f), but the database let any
-- employee PATCH their own joined_on, activated_at and role_title. joined_on
-- feeds work anniversaries and the secret page; activated_at feeds Home's
-- "joined" list (693f21d); role_title is written with access_level by
-- leadership only. None grants access, but a self-edit showed false data to
-- every colleague. The self-escalation trigger now resets them too.
-- Redefined from the LIVE definition (last changed 202609300003, the email line).
-- activated_at is still stamped on activation: trg_employee_stamp_activated
-- runs after this trigger (BEFORE triggers fire in name order).
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
  END IF;
  RETURN NEW;
END;
$function$;
