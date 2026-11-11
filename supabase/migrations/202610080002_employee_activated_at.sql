-- "Siva joined Art" showed on the home page the night he first signed in,
-- four days before he starts (8 Oct 2026). Home dated "joined" from
-- employees.created_at, which is the first sign-in. Joining is the day their
-- access is switched on, so record that on the employee and date it from there.

alter table app.employees add column if not exists activated_at timestamptz;
comment on column app.employees.activated_at is 'When setup_pending went false: the day they actually joined. Home''s "joined" item reads this.';
grant select (activated_at) on app.employees to authenticated;

create or replace function app_private.stamp_employee_activated()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if old.setup_pending and not new.setup_pending and new.activated_at is null then
    new.activated_at := now();
  end if;
  return new;
end;
$$;
revoke all on function app_private.stamp_employee_activated() from public, anon, authenticated;
drop trigger if exists trg_employee_stamp_activated on app.employees;
create trigger trg_employee_stamp_activated
  before update of setup_pending on app.employees
  for each row execute function app_private.stamp_employee_activated();

-- Everyone already active joined when their row appeared; close enough for
-- history, and it keeps old "joined" items where they were.
update app.employees set activated_at = created_at where activated_at is null and not setup_pending;
