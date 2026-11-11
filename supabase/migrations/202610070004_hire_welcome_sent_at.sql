-- Joiner welcome email (7 Oct 2026): two working days before a hire's
-- start date, the hire-welcome cron emails their @youragency.com and personal
-- addresses how to sign in to Colony, the first All Hands, Thirsty Thursdays
-- and the Slack link, so a Monday joiner is ready for Monday's All Hands.
-- welcome_sent_at marks it sent (once per hire) and ticks the checklist row.
-- Written only by the cron (service role); the crew reads it through the
-- existing hires policies. hires_update_crew could set it by hand — harmless.
alter table app.hires add column if not exists welcome_sent_at timestamptz;
