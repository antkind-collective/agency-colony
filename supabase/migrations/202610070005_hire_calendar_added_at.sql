-- Joiners are added to All Hands and Thirsty Thursday by Colony after their
-- first successful sign-in (7 Oct 2026: "we will stick to Colony doing
-- it" rather than inviting all@, which also holds counsel and ex-staff).
-- calendar_added_at marks it done (once per hire) and ticks the checklist row.
-- Written only by the joiner-calendar cron (service role).
alter table app.hires add column if not exists calendar_added_at timestamptz;
