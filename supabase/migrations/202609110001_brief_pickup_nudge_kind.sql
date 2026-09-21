-- notification_log.kind is an enum; the pickup nudge needs its own value or
-- both its dedupe SELECT and its post-send INSERT fail (the exact trap the
-- deadline reminder hit). Separate migration: ADD VALUE cannot be used in the
-- transaction that adds it.
alter type app.notification_kind add value if not exists 'brief_pickup_nudge';
