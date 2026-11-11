-- S7 (7 Oct 2026): Colony reminds the people with no emergency contact
-- on file, from Colony, before access pauses after the deadline.
alter type app.notification_kind add value if not exists 'emergency_contact_reminder';
