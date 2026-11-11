-- Joiner Slack check (7 Oct 2026: "I don't want to check it manually").
-- The joiner-slack cron asks Slack (read-only app) whether the hire's work
-- email has a member in #youragency-all and #youragency-random; slack_joined_at marks
-- it done and ticks the Slack chip. Written only by the cron (service role).
alter table app.hires add column if not exists slack_joined_at timestamptz;
