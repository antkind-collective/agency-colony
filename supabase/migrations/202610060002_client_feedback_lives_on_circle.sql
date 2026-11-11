-- Client feedback lives on Circle, and among staff it is Alex's alone
-- (6 Oct 2026; closes S16).
--
-- Both walls share app.feature_requests: a client post is a row with
-- author_partner_id set. The 10 Sep split kept Your Agency's internal posts off
-- Circle, but only in that direction. The employee read policy was
-- `app.is_employee()`, and Colony's Bugs & Features wall loads every row, so
-- the client's 12 posts and the 24 replies on them sat on the internal wall for every
-- employee, fractionals included.
--
-- Now, for staff, a client post, its replies and every write to it belong to
-- the superadmin (Alex) only. She handles them on Circle (reply + mark
-- fixed); Colony's wall also filters them out in the UI. The partner policies
-- are unchanged: a client still reads their own org's wall.
--
-- Redefined from the LIVE definitions (6 Oct), per "Several sessions, one repo".
-- The nested EXISTS over feature_requests runs under the caller's RLS, which
-- is the right direction here: a row the caller cannot see counts as "not
-- internal", so the reply stays hidden.

alter policy feature_requests_select_all on app.feature_requests
  using (app.is_employee() and (author_partner_id is null or app.is_superadmin()));

alter policy feature_requests_update_own_or_leadership on app.feature_requests
  using ((employee_id = app.current_employee_id())
         or (app.is_leadership_or_admin() and (author_partner_id is null or app.is_superadmin())))
  with check ((app.is_leadership_or_admin() and (author_partner_id is null or app.is_superadmin()))
              or ((employee_id = app.current_employee_id()) and (status = 'requested'::app.feature_request_status)));

alter policy feature_requests_delete_own_or_leadership on app.feature_requests
  using ((app.is_leadership_or_admin() and (author_partner_id is null or app.is_superadmin()))
         or ((employee_id = app.current_employee_id()) and (status = 'requested'::app.feature_request_status)));

alter policy feature_request_replies_select_all on app.feature_request_replies
  using (app.is_employee() and (app.is_superadmin() or exists (
    select 1 from app.feature_requests fr
    where fr.id = feature_request_replies.feature_request_id and fr.author_partner_id is null)));

alter policy feature_request_replies_insert_own on app.feature_request_replies
  with check (employee_id = app.current_employee_id() and (app.is_superadmin() or exists (
    select 1 from app.feature_requests fr
    where fr.id = feature_request_replies.feature_request_id and fr.author_partner_id is null)));

-- The every-2-days reminder to Alex (netlify/functions/client-feedback-reminder.js).
alter type app.notification_kind add value if not exists 'client_feedback_reminder';
