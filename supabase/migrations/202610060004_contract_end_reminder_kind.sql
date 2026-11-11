-- Contract end reminder email kind (6 Oct 2026). Its own migration:
-- ADD VALUE cannot be used in the transaction that adds it. Logged by the
-- contract-end-reminder cron (every logged kind must exist here, or the log
-- insert fails silently — db-invariants checks it).
alter type app.notification_kind add value if not exists 'contract_end_reminder';
