-- S6 (25 Sep 2026): a colleague's birth YEAR is theirs and
-- leadership's, not the whole company's.
--
-- employees.date_of_birth stayed selectable by every employee after
-- 202609210001 because the home Birthdays panel lists everyone's birthday. The
-- panel only needs month and day. So:
--   * birthday_md ('MM-DD', generated from date_of_birth) is what the
--     directory and the Birthdays panel read;
--   * date_of_birth is column-revoked from authenticated, like the address and
--     emergency contact, and read through employee_private_details() (self, or
--     leadership/admin), which now returns it too.
-- Writes are unchanged: the profile editor, onboarding and hire details still
-- write date_of_birth. daily-reminders reads it with the service role.
--
-- extract(... from date) is immutable, to_char() is not, hence the lpad form.

alter table app.employees
  add column birthday_md text generated always as (
    lpad(extract(month from date_of_birth)::int::text, 2, '0') || '-' ||
    lpad(extract(day from date_of_birth)::int::text, 2, '0')
  ) stored;

revoke select (date_of_birth) on app.employees from authenticated;
grant select (birthday_md) on app.employees to authenticated;

-- The return type changes, so the function is recreated. Same signature, so
-- its app_private.callable_definer_functions row still applies.
drop function app.employee_private_details(uuid);

create function app.employee_private_details(p_employee_id uuid)
returns table (personal_address text, emergency_contact_name text, emergency_contact_phone text, date_of_birth date)
language sql stable security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select e.personal_address, e.emergency_contact_name, e.emergency_contact_phone, e.date_of_birth
  from app.employees e
  where e.id = p_employee_id
    and (e.id = app.current_employee_id() or app.is_leadership_or_admin());
$$;

revoke all on function app.employee_private_details(uuid) from public, anon, authenticated;
insert into app_private.callable_definer_functions (signature, reason)
values (app_private.fn_signature('app.employee_private_details(uuid)'::regprocedure),
        'profile screen + onboarding check: own address/emergency contact/date of birth, or anyone''s for leadership/admin')
on conflict (signature) do update set reason = excluded.reason;
grant execute on function app.employee_private_details(uuid) to authenticated;
