-- notification_kind value for the brief deadline reminders (step 5 of
-- Rhea's workflow doc; also Carmen's board request).
--
-- Its own migration by necessity: Postgres will not let a new enum value be
-- used in the same transaction that adds it.
--
-- Found by dry-running the cron before it was allowed to send anything, and
-- the failure mode was the bad one. notification_log.kind is an enum, so
-- without this the dedupe SELECT errors and the post-send INSERT errors —
-- after the email has gone. Nothing would ever land in the log, so nothing
-- would ever be deduped, and every assignee would be chased about the same
-- deliverable every single working day until someone noticed.

alter type app.notification_kind add value if not exists 'brief_deadline_reminder';
