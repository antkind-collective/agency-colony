-- Single generic kind for brief-pipeline emails; the specific event lives in
-- the payload (event, brief_id) rather than one enum value per event.
alter type app.notification_kind add value if not exists 'brief_notify';
