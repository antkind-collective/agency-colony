-- When a hire's @youragency.com account was added to the all@youragency.com group
-- (21 Sep 2026). Null means not yet: workspace-group-sync retries those
-- daily, so an add that failed at account creation is not forgotten.
--
-- Access: unchanged. A column on app.hires, whose RLS already limits rows to
-- the hiring crew and the candidate's own row; grants there are table-level.
alter table app.hires add column if not exists all_group_added_at timestamptz;
