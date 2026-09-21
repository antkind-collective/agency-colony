-- Partners: external (client-side) users of Colony — e.g. Example Collective.
-- Invite-only: rows are created by leadership in Admin Settings; first sign-in
-- binds auth_user_id via ensure_partner_profile(). Partners are NOT employees —
-- employees.email is CHECK-bound to @youragency.com, partners.email is CHECK-bound
-- to NOT @youragency.com, so the two populations cannot overlap.

create type app.partner_role as enum ('coordinator', 'submitter', 'client_viewer');

create table app.partners (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  email citext not null unique,
  full_name text not null,
  org text not null default 'Example Collective',
  partner_role app.partner_role not null default 'submitter',
  is_active boolean not null default true,
  created_by uuid references app.employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partner_email_not_youragency_ck check (email::text not like '%@youragency.com')
);

alter table app.partners enable row level security;

-- Identity helpers -----------------------------------------------------------

create or replace function app.is_employee()
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select app.current_employee_id() is not null;
$$;

create or replace function app.current_partner_id()
returns uuid
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select p.id
  from app.partners p
  where p.auth_user_id = auth.uid()
    and p.is_active
  limit 1;
$$;

create or replace function app.is_partner()
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select app.current_partner_id() is not null;
$$;

-- RLS ------------------------------------------------------------------------

create policy partners_select_own on app.partners for select
  using (auth_user_id = auth.uid());
create policy partners_select_employees on app.partners for select
  using (app.is_employee());
create policy partners_insert_leadership on app.partners for insert
  with check (app.is_leadership_or_admin());
create policy partners_update_leadership on app.partners for update
  using (app.is_leadership_or_admin());
create policy partners_delete_leadership on app.partners for delete
  using (app.is_leadership_or_admin());

-- First-login binding: match the invited row by email, bind auth_user_id.
-- Returns the partner row, or NULL when no invite exists (client signs out).
create or replace function app.ensure_partner_profile()
returns app.partners
language plpgsql security definer
set search_path to 'app', 'public'
as $$
declare
  caller_email text;
  p app.partners%rowtype;
begin
  caller_email := lower(coalesce(
    current_setting('request.jwt.claims', true)::json->>'email',
    auth.email()
  ));
  if caller_email is null or caller_email = '' then
    return null;
  end if;

  select * into p from app.partners
  where auth_user_id = auth.uid() and is_active;
  if found then
    return p;
  end if;

  select * into p from app.partners
  where auth_user_id is null
    and lower(email::text) = caller_email
    and is_active;
  if found then
    update app.partners
    set auth_user_id = auth.uid(), updated_at = now()
    where id = p.id
    returning * into p;
    return p;
  end if;

  return null;  -- no invite: caller is not a partner
end;
$$;

grant execute on function app.is_employee() to authenticated;
grant execute on function app.current_partner_id() to authenticated;
grant execute on function app.is_partner() to authenticated;
grant execute on function app.ensure_partner_profile() to authenticated;
