-- Invoice email kinds (30 Sep 2026). Enum values in their own
-- migration: ADD VALUE cannot be used in the transaction that adds it.
--
-- invoice_all_received: invoice-reminder has logged this kind since August,
--   but it was never added to the enum, so every insert failed silently.
--   The "already sent this month?" check reads the log, so it never found a
--   send: in a month where everyone uploads before the last day, Blake would
--   get "All invoices received" every morning until month end.
-- birthday_notification: same silent failure in daily-reminders since it was
--   written: the leadership birthday emails send, but none was ever logged.
-- invoice_missed_digest: new. On the 1st, Blake gets who did not upload the
--   previous month's invoice.
alter type app.notification_kind add value if not exists 'invoice_all_received';
alter type app.notification_kind add value if not exists 'invoice_missed_digest';
alter type app.notification_kind add value if not exists 'birthday_notification';
