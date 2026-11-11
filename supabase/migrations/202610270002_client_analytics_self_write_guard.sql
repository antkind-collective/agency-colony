-- Audit 27 Oct 2026 (Tue, access parity, self-write sweep): every employee
-- passes analytics_update (is_analytics_uploader() = is_employee(), needed so
-- any viewer can save the AI insight cache), and its WITH CHECK pins neither
-- who uploaded a report nor which client it belongs to. So an employee could
-- PATCH uploaded_by to a colleague (Analytics shows "by <name>" from it) or
-- move a client's report to another client they can see. The app never does
-- either: an upload upserts with uploaded_by = the uploader, on the same
-- (client_id, report_type), and the insight cache update sends one column.
-- Now a signed-in caller can only re-stamp a report as their own and cannot
-- change its client or type; the service role (website-analytics-sync, which
-- writes uploaded_by null) is unaffected.
create or replace function app_private.guard_client_analytics_update()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
begin
  if auth.uid() is null then return new; end if;
  if new.client_id is distinct from old.client_id or new.report_type is distinct from old.report_type then
    raise exception 'A report stays with its client. Upload it again for the other one.';
  end if;
  if new.uploaded_by is distinct from old.uploaded_by
     and new.uploaded_by is distinct from app.current_employee_id() then
    raise exception 'A report can only be re-stamped as uploaded by you.';
  end if;
  return new;
end;
$function$;
revoke all on function app_private.guard_client_analytics_update() from public, anon, authenticated;

drop trigger if exists trg_client_analytics_guard_update on app.client_analytics;
create trigger trg_client_analytics_guard_update
  before update on app.client_analytics
  for each row execute function app_private.guard_client_analytics_update();
