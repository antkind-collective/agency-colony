-- Audit 19 Oct 2026 (data layer): an employee could POST their own leave
-- straight into app.leave_requests already approved (status 'approved',
-- decided_by = themselves). leave_requests_insert_own checked only whose row
-- it was; prepare_leave_request forces approval only for the superadmin and
-- never resets a requested status. The app submits through
-- submit_leave_request() (status defaults to pending) and managers through
-- mark_leave_for(); both are SECURITY DEFINER and skip these policies, so the
-- direct-insert path is used by nothing and only the API reached it.
-- Same gap, 14 Oct column: setting marked_by_employee_id on your own request
-- skipped the 3+ day SL certificate rule, on insert or on a pending update.
-- Both policies redefined from their LIVE definitions; only the new
-- conditions are added. The superadmin's own direct insert stays possible
-- (prepare_leave_request approves it before this check runs).
alter policy leave_requests_insert_own on app.leave_requests
  with check (
    employee_id = app.current_employee_id()
    and app.is_leave_tracking_enabled_for_employee(employee_id)
    and marked_by_employee_id is null
    and (app.is_superadmin()
         or (status = 'pending' and decided_by_employee_id is null and decided_at is null))
  );

alter policy leave_requests_update_own_pending_or_leadership on app.leave_requests
  with check (
    app.is_superadmin()
    or exists (
      select 1 from app.employees me
      where me.id = app.current_employee_id()
        and lower(me.email::text) in (select lower(a.a::text) from unnest(leave_requests.approver_emails) a(a)))
    or (employee_id = app.current_employee_id()
        and status = any (array['pending'::app.leave_status, 'cancelled'::app.leave_status])
        and decided_by_employee_id is null and decided_at is null
        and marked_by_employee_id is null)
  );
