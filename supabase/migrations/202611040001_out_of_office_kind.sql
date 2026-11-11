-- Out-of-office FYI email kind (4 Nov 2026). Its own migration: ADD
-- VALUE cannot be used in the transaction that adds it. Logged by ooo-notify.
alter type app.notification_kind add value if not exists 'out_of_office';
