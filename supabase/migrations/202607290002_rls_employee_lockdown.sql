-- Lockdown before partner logins exist: every USING (true) SELECT policy dates
-- from the all-internal era, when "authenticated" could only mean an Your Agency
-- employee. With partner sign-in, "authenticated" is no longer "employee" —
-- re-scope all of them to app.is_employee(). Partners get access only through
-- partner-specific policies on the brief tables (separate migration).

alter policy access_overrides_select_all        on app.access_overrides         using (app.is_employee());
alter policy allocations_select_all_authenticated on app.allocations            using (app.is_employee());
alter policy app_config_select_all              on app.app_config               using (app.is_employee());
alter policy daily_tasks_select_all_authenticated on app.daily_tasks            using (app.is_employee());
alter policy departments_select_all             on app.departments              using (app.is_employee());
alter policy employee_client_scope_select       on app.employee_client_scope    using (app.is_employee());
alter policy employees_select_all_authenticated on app.employees                using (app.is_employee());
alter policy feature_request_replies_select_all on app.feature_request_replies  using (app.is_employee());
alter policy feature_request_upvotes_select_all on app.feature_request_upvotes  using (app.is_employee());
alter policy feature_requests_select_all        on app.feature_requests         using (app.is_employee());
alter policy leave_cycle_policy_select_all      on app.leave_cycle_policy       using (app.is_employee());
alter policy all_view_policy_versions           on app.policy_document_versions using (app.is_employee());
alter policy all_view_policies                  on app.policy_documents         using (app.is_employee());
alter policy projects_select_all                on app.projects                 using (app.is_employee());
alter policy public_holidays_select_all         on app.public_holidays          using (app.is_employee());
alter policy daily_cleanup_log_select           on app.system_daily_cleanup_log using (app.is_employee());

-- Only non-SELECT policy that wasn't identity-bound.
alter policy daily_cleanup_log_insert           on app.system_daily_cleanup_log with check (app.is_employee());

-- Storage: the two buckets whose policies said "any authenticated".
-- (invoices bucket already folder-binds to app.employees; untouched.)
alter policy analytics_storage_select on storage.objects
  using (bucket_id = 'client-analytics' and app.is_employee());
alter policy analytics_storage_insert on storage.objects
  with check (bucket_id = 'client-analytics' and app.is_employee());
alter policy analytics_storage_delete on storage.objects
  using (bucket_id = 'client-analytics' and app.is_employee());
alter policy fa_storage_select on storage.objects
  using (bucket_id = 'feature-attachments' and app.is_employee());
alter policy fa_storage_insert on storage.objects
  with check (bucket_id = 'feature-attachments' and app.is_employee());

-- can_see_client: the "not scoped => sees every client" default was safe when
-- every caller was an employee. A partner (or any non-employee JWT) has no
-- employee row, so it fell into that branch and saw ALL clients. Fail closed
-- for non-employees before any scope logic runs.
create or replace function app.can_see_client(p_client_id uuid)
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select case
    when app.is_leadership_or_admin() then true
    when not app.is_employee() then false
    when exists (
      select 1 from app.employees e
      where e.id = app.current_employee_id()
        and e.setup_pending
        and e.employment_type = 'fractional'
    ) then false
    when not app.is_client_scoped(app.current_employee_id()) then true
    else exists (
      select 1 from app.employee_client_scope s
      where s.employee_id = app.current_employee_id()
        and s.client_id = p_client_id
    )
  end;
$$;
