-- spawn_onboarding_checklist had no caller check (Circle audit, 17 Sep 2026).
--
-- It is SECURITY DEFINER and callable by authenticated (app.js calls it from
-- the leadership access editor), and it trusted p_employee_id outright. As a
-- Example Collective partner, calling it for an employee without an active
-- checklist would insert a checklist and set that employee's
-- onboarding_completed = false; the call only stopped on the exclusion
-- constraint because the test employee already had one. onboarding_completed
-- is not one of the columns trg_block_employee_self_escalation protects, and
-- a definer function bypasses the leadership-only INSERT policies on
-- onboarding_checklists anyway.
--
-- Legitimate callers, and only these:
--   * leadership/admin — app.js spawnOnboardingForEmployee, after inserting an
--     employee (employees INSERT is itself leadership-only);
--   * the new employee themselves — ensure_employee_profile() PERFORMs this
--     right after inserting their row with auth_user_id = auth.uid().
-- The ownership test reads auth_user_id directly (not current_employee_id(),
-- which also depends on is_active) so first sign-in cannot be broken by it.
-- Body below is otherwise the live definition, unchanged.

CREATE OR REPLACE FUNCTION app.spawn_onboarding_checklist(p_employee_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
DECLARE
  v_checklist_id uuid;
BEGIN
  IF NOT app.is_leadership_or_admin()
     AND NOT EXISTS (SELECT 1 FROM app.employees e
                     WHERE e.id = p_employee_id AND e.auth_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only leadership can start an onboarding checklist for someone else.';
  END IF;

  INSERT INTO app.onboarding_checklists (employee_id, status)
  VALUES (p_employee_id, 'active')
  RETURNING id INTO v_checklist_id;

  -- Pre-Joining items (leadership tasks)
  INSERT INTO app.onboarding_checklist_items (checklist_id, phase, sort_order, title, description) VALUES
    (v_checklist_id, 'pre_joining', 10, 'Consultant agreement signed', 'Ensure signed agreement is filed in Google Drive.'),
    (v_checklist_id, 'pre_joining', 20, 'NDA signed', 'File in Drive > Signed NDAs. NDAs go through Leo (leo@youragency.com).'),
    (v_checklist_id, 'pre_joining', 30, 'Google Workspace account created', 'Create @youragency.com email via Google Admin.'),
    (v_checklist_id, 'pre_joining', 40, 'Slack workspace invite sent', 'Add to #general, #random, and relevant client channels.'),
    (v_checklist_id, 'pre_joining', 50, 'Add to All Hands recurring invite', 'Thursday All Hands on Google Calendar.'),
    (v_checklist_id, 'pre_joining', 60, 'Add to Thirsty Thursdays recurring invite', 'Google Calendar.');

  -- Day 1 items (auto-completed by new hire actions)
  INSERT INTO app.onboarding_checklist_items (checklist_id, phase, sort_order, title, is_auto, auto_key) VALUES
    (v_checklist_id, 'day_one', 10, 'Profile completed in Colony', true, 'profile_completed'),
    (v_checklist_id, 'day_one', 20, 'Remote Work Policy read and acknowledged', true, 'policy_remote_working_policy');

  -- Week 1 items (leadership + new hire)
  INSERT INTO app.onboarding_checklist_items (checklist_id, phase, sort_order, title, description) VALUES
    (v_checklist_id, 'week_one', 10, 'Welcome message posted in Slack', 'Post in #general with name, role, department.'),
    (v_checklist_id, 'week_one', 20, 'First 1:1 with manager', 'Schedule and complete a 30-min intro meeting.'),
    (v_checklist_id, 'week_one', 30, 'Client assignments briefed', 'Manager briefs on active clients, expectations, key contacts.'),
    (v_checklist_id, 'week_one', 40, 'Department tools set up', 'Provision department-specific tools (Adobe CC, analytics, social tools, etc.).'),
    (v_checklist_id, 'week_one', 50, 'Weekly allocation set in Colony', 'Manager sets initial allocation across assigned client projects.'),
    (v_checklist_id, 'week_one', 60, 'First tasks added to Work Planner', 'New hire adds their first tasks.');

  -- Month 1 items (settling in)
  INSERT INTO app.onboarding_checklist_items (checklist_id, phase, sort_order, title, description) VALUES
    (v_checklist_id, 'month_one', 10, 'First invoice submitted', 'Through Colony Invoice Center. First invoice must include bank details.'),
    (v_checklist_id, 'month_one', 20, '30-day feedback check-in with manager', 'How are things going, any blockers, role clarity.'),
    (v_checklist_id, 'month_one', 30, 'Colony fully adopted', 'Daily task updates in Work Planner, leave requests through Leave Center, allocation visible.');

  -- Mark employee as onboarding
  UPDATE app.employees SET onboarding_completed = false WHERE id = p_employee_id;

  RETURN v_checklist_id;
END;
$function$;
