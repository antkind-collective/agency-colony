-- Registrations now come read-only from Rishi's media dashboard Google Sheet
-- (lib/registrations.js), not the Jotform API (5 Nov 2026). The key
-- table from 202611050002 was never used (0 rows): drop it. The
-- 'registrations' report type stays.
drop table if exists app.registration_sources;
