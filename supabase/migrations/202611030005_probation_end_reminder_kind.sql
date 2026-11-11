-- Probation end reminder email kind (3 Nov 2026). Its own migration:
-- ADD VALUE cannot be used in the transaction that adds it. Logged by the
-- probation-reminder cron (every logged kind must exist here, or the log
-- insert fails silently).
alter type app.notification_kind add value if not exists 'probation_end_reminder';
