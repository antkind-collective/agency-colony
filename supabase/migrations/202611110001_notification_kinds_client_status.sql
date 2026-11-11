-- client-status-notify logs under kinds the enum never had, so every insert
-- failed quietly and nothing recorded that these emails went out (audit S24).
-- It now checks notification_log before sending, which needs the rows to exist.
alter type app.notification_kind add value if not exists 'client_archived';
alter type app.notification_kind add value if not exists 'deal_contracted';
