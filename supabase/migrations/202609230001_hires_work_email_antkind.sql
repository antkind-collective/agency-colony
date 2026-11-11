-- Security audit, 23 Sep 2026 (server side).
--
-- hires.work_email is the address workspace-group-sync adds to all@youragency.com,
-- the all-staff mailing list. Every hiring-crew member can UPDATE app.hires
-- (hires_update_crew), so any of them could set it to an outside address and
-- the next daily sync would subscribe that address to internal all-hands mail.
-- Colony only ever writes it from workspace-provision, which already insists on
-- @youragency.com. The column now says the same, and lib/workspace-groups.js
-- refuses a non-@youragency.com address as a second layer.
--
-- Live data at the time: 2 rows with a work_email, both @youragency.com.
alter table app.hires drop constraint if exists hires_work_email_youragency;
alter table app.hires add constraint hires_work_email_youragency
  check (work_email is null or work_email ~* '^[a-z0-9._-]+@youragency\.com$');
