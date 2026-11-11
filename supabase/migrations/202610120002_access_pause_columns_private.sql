-- Close employees.access_paused_at / access_pause_reason to signed-in users
-- (12 Oct 2026). Leadership reads them through
-- app.employee_access_pauses() (202610120001). Apply only once the app.js that
-- stops selecting these columns is live.
revoke select (access_paused_at, access_pause_reason) on app.employees from authenticated;
