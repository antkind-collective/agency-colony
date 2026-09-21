-- What a hire signed in with their Gmail needs to know about their youragency
-- account (11 Sep 2026).
--
-- Asha's checklist told her "All done! You'll hear from the team about your
-- Your Agency account" and stopped. She did what it said: nothing. The screen has
-- to say, in her own case, whether the account has been requested and whether
-- it has ever been used — and a hire cannot read app.employees to find out.
--
-- SECURITY DEFINER, scoped to the caller's own hire row; returns nothing for
-- anyone who is not a hire. "joined" is the same name-match the internal panel
-- uses (hires and employees share no key).

create or replace function app.hire_work_account_status()
returns table (requested_at timestamptz, joined boolean, work_email text)
language sql
stable security definer
set search_path to 'app', 'public'
as $$
  select
    h.workspace_requested_at,
    exists (
      select 1 from app.employees e
      where lower(btrim(e.full_name)) = lower(btrim(h.full_name))
    ) as joined,
    -- first name, lowercased, letters and digits only — mirrors suggestWorkEmail()
    lower(regexp_replace(split_part(btrim(h.full_name), ' ', 1), '[^A-Za-z0-9]', '', 'g')) || '@youragency.com' as work_email
  from app.hires h
  where h.auth_user_id = auth.uid()
    and h.stage <> 'cancelled'
  limit 1;
$$;

revoke all on function app.hire_work_account_status() from public, anon;
grant execute on function app.hire_work_account_status() to authenticated;
