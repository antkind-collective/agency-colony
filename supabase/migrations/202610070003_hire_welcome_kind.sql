-- Joiner welcome email kind (7 Oct 2026). Its own migration: ADD VALUE
-- cannot be used in the transaction that adds it.
alter type app.notification_kind add value if not exists 'hire_welcome';
