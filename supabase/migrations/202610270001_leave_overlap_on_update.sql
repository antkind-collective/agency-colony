-- Audit 27 Oct 2026 (Tue, access parity, self-write sweep): the overlap guard
-- of 202610260001 ran on INSERT only. An employee's own-row UPDATE policy lets
-- them change start_date / end_date on their own pending leave (the UI never
-- sends dates, only status), and a cancelled leave can be put back to pending.
-- Either way two pending/approved leaves could cover the same day again: dry
-- run as maya@ moved a second pending leave onto the first, allowed. Same for
-- leadership editing dates. Run the same guard when the dates, half-day flag,
-- status or person change. The function is unchanged (it already skips rows
-- that are not pending/approved and excludes the row itself). 0 overlapping
-- pairs exist today, so no current row is blocked from being approved.
drop trigger if exists trg_leave_requests_no_overlap on app.leave_requests;
create trigger trg_leave_requests_no_overlap
  before insert or update of start_date, end_date, is_half_day, status, employee_id on app.leave_requests
  for each row execute function app_private.guard_leave_overlap();
