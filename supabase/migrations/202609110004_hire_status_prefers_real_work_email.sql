-- Once Colony creates the account, the switch-account card must show the
-- address that actually exists, not the first-name guess.
create or replace function app.hire_work_account_status()
returns table (requested_at timestamptz, joined boolean, work_email text)
language sql stable security definer set search_path to 'app', 'public'
as $$
  select
    h.workspace_requested_at,
    exists (select 1 from app.employees e where lower(btrim(e.full_name)) = lower(btrim(h.full_name))) as joined,
    coalesce(h.work_email::text,
      lower(regexp_replace(split_part(btrim(h.full_name), ' ', 1), '[^A-Za-z0-9]', '', 'g')) || '@youragency.com') as work_email
  from app.hires h
  where h.auth_user_id = auth.uid() and h.stage <> 'cancelled'
  limit 1;
$$;
