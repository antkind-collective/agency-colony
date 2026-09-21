-- Internal SECURITY DEFINER helpers are not callable by signed-in users
-- (Thursday Circle-isolation audit, 17 Sep 2026).
--
-- Found by impersonating a Example Collective partner on Circle and calling every
-- read-returning RPC: app.hire_profile_seed('<a hire's name>') returned that
-- hire's home address, and app.apply_employee_setup was callable too — the
-- unguarded half of activation, which rewrites any employee's department,
-- employment type, capacity and client scope.
--
-- Mechanism: 202609160001_security_advisor.sql looped over EVERY definer
-- function and did `grant execute … to authenticated`. That re-opened helpers
-- earlier migrations had closed on purpose:
--   apply_employee_setup, run_due_activations   (202609090001: revoked from authenticated)
--   hire_profile_seed, hire_manager_for_new_employee  (revoked from public;
--     no authenticated grant existed until the loop added one)
-- and left open a set that never had a caller-facing reason to be callable:
--   hire_type_for_new_employee (hire data), ensure_leave_cycle_record and
--   archive_leave_cycle_row (write any employee's leave cycle, no guard),
--   rollover_all_leave_cycles (cron), mapped_access_level_for_email (tells
--   anyone who is admin/leadership).
--
-- Every caller of these is itself SECURITY DEFINER (ensure_employee_profile,
-- activate_employee_setup, run_due_activations, get_leave_*_summary*,
-- ensure_leave_cycle_before_request, enforce_mapped_access_level) or the
-- service-role cron (daily-reminders → rollover_all_leave_cycles,
-- scheduled-activation → run_due_activations). Inside a definer function the
-- privilege check is against the owner, so none of them needs the caller to
-- hold EXECUTE. None is called by app.js/js/, referenced by an RLS policy, a
-- view or an invoker function (checked against the live catalog).
--
-- Rule for the next blanket grant: a definer function gets EXECUTE for
-- authenticated only if the client calls it or a policy references it.
-- tests/db-invariants.test.mjs now fails if any of these is callable again.

revoke all on function app.apply_employee_setup(uuid, uuid, app.employment_type, numeric, uuid[]) from public, anon, authenticated;
revoke all on function app.run_due_activations() from public, anon, authenticated;
revoke all on function app.hire_profile_seed(text) from public, anon, authenticated;
revoke all on function app.hire_manager_for_new_employee(text) from public, anon, authenticated;
revoke all on function app.hire_type_for_new_employee(text) from public, anon, authenticated;
revoke all on function app.ensure_leave_cycle_record(uuid, date) from public, anon, authenticated;
revoke all on function app.archive_leave_cycle_row(uuid) from public, anon, authenticated;
revoke all on function app.rollover_all_leave_cycles(date) from public, anon, authenticated;
revoke all on function app.mapped_access_level_for_email(text) from public, anon, authenticated;

-- The two crons connect as service_role and keep their grants.
grant execute on function app.run_due_activations() to service_role;
grant execute on function app.rollover_all_leave_cycles(date) to service_role;
