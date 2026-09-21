-- notification_kind for chasing a brief that is stuck awaiting client approval
-- (10 Sep 2026).
--
-- Alice's "Media asset for New York Climate Week" sat unapproved for 36 hours
-- with a Friday deadline. The approval gate worked and all three coordinators
-- were emailed on submission — but that was ONE email at 2am, and nothing
-- chased it afterwards. A brief blocked on the client is the one state where
-- the deadline is burning and Your Agency cannot do anything about it.
--
-- Its own migration: Postgres cannot use a new enum value in the transaction
-- that adds it.

alter type app.notification_kind add value if not exists 'brief_approval_nudge';
