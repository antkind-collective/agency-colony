-- notification_log.kind is an enum; the quick-request reminder (27 Sep 2026)
-- needs its own value or its dedupe SELECT and post-send INSERT fail.
-- Separate migration: ADD VALUE cannot be used in the transaction that adds it.
alter type app.notification_kind add value if not exists 'quick_request_nudge';
