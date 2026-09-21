-- The address Colony created for the hire (11 Sep 2026). Until now the work
-- address was only ever a suggestion computed from the first name; once Colony
-- creates the account itself, the real one must be recorded so the checklist,
-- the switch-account card and the panel all say the same thing.
alter table app.hires add column if not exists work_email citext;
comment on column app.hires.work_email is 'The @youragency.com address created for this hire. Never the password — that is generated, emailed once, and discarded.';
