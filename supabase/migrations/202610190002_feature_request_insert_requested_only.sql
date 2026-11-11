-- Audit 19 Oct 2026 (data layer), same class as 202610190001: an employee or
-- a client could insert a Bugs & Features / feedback post already 'done' or
-- 'archived'. A client post born closed never reaches Alex's every-2-days
-- reminder (lib/client-feedback-reminder.js skips closed posts). Both walls
-- insert without a status (default 'requested'), so only the API reached it.
-- Redefined from the LIVE definitions; only the status condition is added.
alter policy feature_requests_insert_own on app.feature_requests
  with check (employee_id = app.current_employee_id() and status = 'requested');

alter policy feature_requests_insert_partner on app.feature_requests
  with check (employee_id is null and author_partner_id = app.current_partner_id()
              and app.current_partner_id() is not null and status = 'requested');
