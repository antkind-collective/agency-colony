-- A colleague's home address and emergency contact are theirs and
-- leadership's, not the whole company's (Monday data-layer audit, 21 Sep 2026).
--
-- employees_select_all_authenticated is USING (app.is_employee()) and
-- authenticated held table-wide SELECT, so every employee could read every
-- colleague's personal_address, emergency_contact_name and
-- emergency_contact_phone. It got worse on 15 Sep (202609150001):
-- ensure_employee_profile now seeds personal_address from the HIRE record,
-- which only the hiring crew can read, and the People directory query selected
-- personal_address for every active employee into every employee's browser.
-- Probe as maya@ before this migration: 2 colleagues' home addresses, 15
-- emergency phones.
--
-- RLS is row-level, so the columns are closed with column privileges:
-- authenticated keeps SELECT on every other column (the directory, policies
-- such as leave_requests' approver check and policy_documents' admin check
-- read only those) and INSERT/UPDATE/DELETE are unchanged, so the profile
-- editor still writes all three. Reads go through employee_private_details(),
-- which answers only for the caller themselves or leadership/admin.
--
-- Consequence to remember: a NEW column on app.employees is not selectable by
-- authenticated until it is granted by name here-style. That is deliberate
-- (closed by default); tests/db-invariants.test.mjs pins the three columns.
--
-- date_of_birth stays readable: the home Birthdays panel shows everyone's
-- birthday by design. Whether the birth YEAR should be hidden is open for
-- Alex (docs/OPEN.md S6).

revoke select on app.employees from authenticated;

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'app' and table_name = 'employees'
    and column_name not in ('personal_address', 'emergency_contact_name', 'emergency_contact_phone');
  execute format('grant select (%s) on app.employees to authenticated', cols);
end $$;

create or replace function app.employee_private_details(p_employee_id uuid)
returns table (personal_address text, emergency_contact_name text, emergency_contact_phone text)
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select e.personal_address, e.emergency_contact_name, e.emergency_contact_phone
  from app.employees e
  where e.id = p_employee_id
    and (e.id = app.current_employee_id() or app.is_leadership_or_admin());
$$;

revoke all on function app.employee_private_details(uuid) from public, anon, authenticated;
insert into app_private.callable_definer_functions (signature, reason)
values (app_private.fn_signature('app.employee_private_details(uuid)'::regprocedure),
        'profile screen + onboarding check: own address/emergency contact, or anyone''s for leadership/admin')
on conflict (signature) do nothing;
grant execute on function app.employee_private_details(uuid) to authenticated;
