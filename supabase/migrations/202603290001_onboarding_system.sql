-- =============================================================================
-- Colony Onboarding System
-- Adds: onboarding checklists, policy documents (with version history),
--        policy acknowledgments, employee profile fields, notifications
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. New enum types
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_phase' AND typnamespace = 'app'::regnamespace) THEN
    CREATE TYPE app.onboarding_phase AS ENUM ('pre_joining', 'day_one', 'week_one', 'month_one');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_checklist_status' AND typnamespace = 'app'::regnamespace) THEN
    CREATE TYPE app.onboarding_checklist_status AS ENUM ('active', 'completed');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. New notification kinds
-- ---------------------------------------------------------------------------
ALTER TYPE app.notification_kind ADD VALUE IF NOT EXISTS 'new_employee_joined';
ALTER TYPE app.notification_kind ADD VALUE IF NOT EXISTS 'onboarding_welcome';
ALTER TYPE app.notification_kind ADD VALUE IF NOT EXISTS 'policy_update_reminder';

-- ---------------------------------------------------------------------------
-- 3. New employee profile columns (for onboarding profile completion)
-- ---------------------------------------------------------------------------
ALTER TABLE app.employees ADD COLUMN IF NOT EXISTS emergency_contact_name text;
ALTER TABLE app.employees ADD COLUMN IF NOT EXISTS emergency_contact_phone text;
ALTER TABLE app.employees ADD COLUMN IF NOT EXISTS personal_address text;
ALTER TABLE app.employees ADD COLUMN IF NOT EXISTS photo_url text;
ALTER TABLE app.employees ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT true;
-- Default true so existing employees are not treated as onboarding.
-- New employees created via the onboarding flow will have this set to false.

-- ---------------------------------------------------------------------------
-- 4. Policy Documents — editable by admin, readable by all
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.policy_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key text NOT NULL UNIQUE,
  title text NOT NULL,
  content_html text NOT NULL DEFAULT '',
  version text NOT NULL DEFAULT '1',
  reminder_month int,                          -- month (1-12) for annual update reminder
  last_updated_by_employee_id uuid REFERENCES app.employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.policy_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "all_view_policies" ON app.policy_documents
  FOR SELECT USING (true);

CREATE POLICY "admin_manage_policies" ON app.policy_documents
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM app.employees e
      WHERE e.auth_user_id = auth.uid()
        AND e.is_active = true
        AND e.access_level = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Policy Document Versions — history of past versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.policy_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_document_id uuid NOT NULL REFERENCES app.policy_documents(id) ON DELETE CASCADE,
  version text NOT NULL,
  content_html text NOT NULL,
  updated_by_employee_id uuid REFERENCES app.employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policy_versions_doc_idx
  ON app.policy_document_versions (policy_document_id, created_at DESC);

ALTER TABLE app.policy_document_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "all_view_policy_versions" ON app.policy_document_versions
  FOR SELECT USING (true);

CREATE POLICY "admin_manage_policy_versions" ON app.policy_document_versions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM app.employees e
      WHERE e.auth_user_id = auth.uid()
        AND e.is_active = true
        AND e.access_level = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- 6. Policy Acknowledgments — permanent audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.policy_acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES app.employees(id) ON DELETE CASCADE,
  policy_key text NOT NULL,
  policy_version text,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_policy_ack_per_employee UNIQUE (employee_id, policy_key)
);

ALTER TABLE app.policy_acknowledgments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employees_view_own_acks" ON app.policy_acknowledgments
  FOR SELECT USING (employee_id = app.current_employee_id());

CREATE POLICY "employees_create_own_acks" ON app.policy_acknowledgments
  FOR INSERT WITH CHECK (employee_id = app.current_employee_id());

CREATE POLICY "leadership_view_all_acks" ON app.policy_acknowledgments
  FOR SELECT USING (app.is_leadership_or_admin());

-- ---------------------------------------------------------------------------
-- 7. Onboarding Checklists — one active per employee
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.onboarding_checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES app.employees(id) ON DELETE CASCADE,
  status app.onboarding_checklist_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_active_checklist_per_employee
    EXCLUDE USING btree (employee_id WITH =) WHERE (status = 'active')
);

ALTER TABLE app.onboarding_checklists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employees_view_own_checklist" ON app.onboarding_checklists
  FOR SELECT USING (employee_id = app.current_employee_id());

CREATE POLICY "leadership_view_all_checklists" ON app.onboarding_checklists
  FOR SELECT USING (app.is_leadership_or_admin());

CREATE POLICY "leadership_manage_checklists" ON app.onboarding_checklists
  FOR ALL USING (app.is_leadership_or_admin());

-- ---------------------------------------------------------------------------
-- 8. Onboarding Checklist Items — flat list grouped by phase
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.onboarding_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id uuid NOT NULL REFERENCES app.onboarding_checklists(id) ON DELETE CASCADE,
  phase app.onboarding_phase NOT NULL,
  sort_order int NOT NULL DEFAULT 100,
  title text NOT NULL,
  description text,
  is_auto boolean NOT NULL DEFAULT false,       -- true = auto-checked by new hire actions
  auto_key text,                                -- 'profile_completed', 'policy_remote_working', 'policy_leave'
  is_completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  completed_by_employee_id uuid REFERENCES app.employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checklist_items_checklist_idx
  ON app.onboarding_checklist_items (checklist_id, phase, sort_order);

ALTER TABLE app.onboarding_checklist_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employees_view_own_items" ON app.onboarding_checklist_items
  FOR SELECT USING (
    checklist_id IN (SELECT id FROM app.onboarding_checklists WHERE employee_id = app.current_employee_id())
  );

CREATE POLICY "leadership_view_all_items" ON app.onboarding_checklist_items
  FOR SELECT USING (app.is_leadership_or_admin());

CREATE POLICY "leadership_manage_items" ON app.onboarding_checklist_items
  FOR ALL USING (app.is_leadership_or_admin());

-- Allow new hires to update their own auto-items (for auto-check on profile/policy)
CREATE POLICY "employees_update_own_auto_items" ON app.onboarding_checklist_items
  FOR UPDATE USING (
    is_auto = true
    AND checklist_id IN (SELECT id FROM app.onboarding_checklists WHERE employee_id = app.current_employee_id())
  );

-- ---------------------------------------------------------------------------
-- 9. Helper function: Spawn onboarding checklist for an employee
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.spawn_onboarding_checklist(p_employee_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  v_checklist_id uuid;
BEGIN
  -- Create the checklist
  INSERT INTO app.onboarding_checklists (employee_id, status)
  VALUES (p_employee_id, 'active')
  RETURNING id INTO v_checklist_id;

  -- Pre-Joining items (leadership tasks)
  INSERT INTO app.onboarding_checklist_items (checklist_id, phase, sort_order, title, description) VALUES
    (v_checklist_id, 'pre_joining', 10, 'Consultant agreement signed', 'Ensure signed agreement is filed in Google Drive.'),
    (v_checklist_id, 'pre_joining', 20, 'NDA signed', 'File in Drive > Signed NDAs. NDAs go through Leo (user@youragency.com).'),
    (v_checklist_id, 'pre_joining', 30, 'Google Workspace account created', 'Create @youragency.com email via Google Admin.'),
    (v_checklist_id, 'pre_joining', 40, 'Slack workspace invite sent', 'Add to #general, #random, and relevant client channels.'),
    (v_checklist_id, 'pre_joining', 50, 'Add to All Hands recurring invite', 'Thursday All Hands on Google Calendar.'),
    (v_checklist_id, 'pre_joining', 60, 'Add to Thirsty Thursdays recurring invite', 'Google Calendar.');

  -- Day 1 items (auto-completed by new hire actions)
  INSERT INTO app.onboarding_checklist_items (checklist_id, phase, sort_order, title, is_auto, auto_key) VALUES
    (v_checklist_id, 'day_one', 10, 'Profile completed in Colony', true, 'profile_completed'),
    (v_checklist_id, 'day_one', 20, 'Remote Working Policy read and acknowledged', true, 'policy_remote_working_policy'),
    (v_checklist_id, 'day_one', 30, 'Leave Policy read and acknowledged', true, 'policy_leave_policy_2026');

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
$$;

-- ---------------------------------------------------------------------------
-- 10. Seed policy documents (placeholder — admin pastes real content)
-- ---------------------------------------------------------------------------
INSERT INTO app.policy_documents (policy_key, title, content_html, version, reminder_month)
VALUES
  ('remote_working_policy', 'Your Agency Remote Work Policy',
   '<h2>Your Agency Remote Working Policy</h2><p>Content will be added by admin. Please open Admin Settings &gt; Policy Documents to paste the full policy.</p>',
   '2026-03', 12),
  ('leave_policy_2026', 'Your Agency Leave Policy',
   '<h2>Your Agency Leave Policy 2026</h2><p>Content will be added by admin. Please open Admin Settings &gt; Policy Documents to paste the full policy.</p>',
   '2026', 12)
ON CONFLICT (policy_key) DO NOTHING;
