-- The superadmin is always a setup approver.
--
-- Context: the client-side config accessors used to fall back to their in-code
-- default whenever a stored list was EMPTY, which made an empty list
-- unrepresentable — you could never remove the last entry from any config list.
-- Fixing that (js/access.js) makes `[]` meaningful, which is correct but
-- introduces a lockout: emptying setup_approver_emails would leave NOBODY able
-- to run app.activate_employee_setup(), so no new joiner could ever be
-- activated, and the only route back would be raw SQL.
--
-- The superadmin can already edit app_config, so granting them this implicitly
-- removes a trap without widening access to anyone else. Verified before
-- adding: with the list emptied, is_setup_approver() returned false even for
-- the superadmin.

create or replace function app.is_setup_approver()
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  select app.is_superadmin()
      or exists (
        select 1
        from app.employees e
        where e.auth_user_id = auth.uid()
          and e.is_active
          and lower(e.email) in (
            select lower(jsonb_array_elements_text(
              coalesce(
                nullif((select value from app.app_config where key = 'setup_approver_emails'), 'null'::jsonb),
                '["admin@youragency.com","am-lead@youragency.com"]'::jsonb
              )
            ))
          )
      );
$$;
