-- Analytics uploads open to every employee (11 Aug 2026; asked by
-- Ivy, Copy dept): anyone on the team can upload SM metrics — the gate
-- was leadership/admin + AM only (202606150001). Client-side mirror:
-- canUploadAnalytics() in js/access.js.
--
-- Widening the audience brings in client-scoped employees, so the write
-- policies now also require can_see_client(client_id) — matching the SELECT
-- policy — a scoped employee can't write analytics for a client they can't
-- see. Outsiders stay out: is_employee() is false for partners and hire
-- candidates, and can_see_client() fails closed for non-employees.

create or replace function app.is_analytics_uploader()
returns boolean
language sql
stable
security definer
set search_path = app, public
as $$
  select app.is_employee();
$$;

drop policy if exists analytics_insert on app.client_analytics;
create policy analytics_insert on app.client_analytics
  for insert
  with check (app.is_analytics_uploader()
              and uploaded_by = app.current_employee_id()
              and app.can_see_client(client_id));

drop policy if exists analytics_update on app.client_analytics;
create policy analytics_update on app.client_analytics
  for update
  using (app.is_analytics_uploader() and app.can_see_client(client_id))
  with check (app.is_analytics_uploader() and app.can_see_client(client_id));

drop policy if exists analytics_delete on app.client_analytics;
create policy analytics_delete on app.client_analytics
  for delete
  using (app.is_analytics_uploader() and app.can_see_client(client_id));
