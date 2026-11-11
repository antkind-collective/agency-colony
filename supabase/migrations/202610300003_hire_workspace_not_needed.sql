-- Not every hire needs a @youragency.com account (a Google licence) (Alex,
-- 30 Oct 2026). When this is true, signing does not create one, the welcome
-- email is not sent, and the hire is complete once Finance is notified: no
-- Colony sign-in, activation, meetings or Slack. They invoice by email.
-- Writes follow the existing hires_update_crew policy, like every other
-- hire field.
alter table app.hires add column if not exists workspace_not_needed boolean not null default false;
