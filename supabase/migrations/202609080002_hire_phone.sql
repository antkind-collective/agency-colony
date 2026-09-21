-- Candidate phone number on the hire record (8 Sep 2026).
--
-- Needed for the Google Workspace account request: Example Reseller are sent Name /
-- Email to create / Recovery email / Phone, and the phone was the one field
-- Colony could not fill because the joining checklist never asked for it.
--
-- Backfilled by hand for the two hires already past payroll, since both are
-- about to need Workspace accounts (Asha starts 14 Sep, Maya 24 Sep).

alter table app.hires
  add column if not exists phone text;

comment on column app.hires.phone is
  'Candidate mobile. Collected on the joining checklist and sent to the Workspace reseller when their @youragency.com account is requested.';

update app.hires set phone = '+91 90295 51357'
  where lower(btrim(full_name)) = 'asha rao' and phone is null;

update app.hires set phone = '+91 70124 83834'
  where lower(btrim(full_name)) = 'maya rao' and phone is null;
