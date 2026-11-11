-- Who is paused, and why, is leadership's to see (12 Oct 2026, after
-- the 12 Oct audit): 202610070009 granted employees.access_paused_at and
-- access_pause_reason to every signed-in user, so every colleague saw the
-- "Paused" chip and its reason in the People directory. The directory now
-- reads the pause from this RPC, which returns rows to leadership only;
-- 202610120002 then revokes the two columns (applied after this code is live,
-- or the directory query would fail for everyone in between).
-- A paused person still learns their own pause through ensure_employee_profile
-- (definer, returns their own row), which the pause screen uses.

create or replace function app.employee_access_pauses()
returns table(employee_id uuid, paused_at timestamptz, reason text)
language sql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select e.id, e.access_paused_at, e.access_pause_reason
  from app.employees e
  where e.access_paused_at is not null
    and e.is_active
    and app.is_leadership_or_admin();
$$;

revoke all on function app.employee_access_pauses() from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.employee_access_pauses()'::regprocedure),
        'app.js loadEmployeeDirectoryFromSupabase: leadership sees who is paused (directory chip, profile Offboard/Resume); returns nothing to anyone else')
on conflict do nothing;
grant execute on function app.employee_access_pauses() to authenticated;
