-- Who found the secret page, and in what order (8 Oct 2026: "tell the
-- person you're the first to discover it, or the Xth"). One row per person,
-- written only by app.secret_discovery(true) for the caller. The maker
-- (superadmin) is never counted, so the first finder is a real first.
create table if not exists app.secret_discoveries (
  employee_id uuid primary key references app.employees(id) on delete cascade,
  found_at timestamptz not null default now()
);
alter table app.secret_discoveries enable row level security;
revoke all on app.secret_discoveries from public, anon, authenticated;

-- p_mark true: the caller just opened the page, so record them (once).
-- Returns their place, how many have found it, and who was first.
create or replace function app.secret_discovery(p_mark boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
declare
  me uuid := app.current_employee_id();
  maker boolean := app.is_superadmin();
  r jsonb;
begin
  if me is null or not app.is_employee() then return null; end if;
  if p_mark and not maker then
    insert into app.secret_discoveries(employee_id) values (me) on conflict do nothing;
  end if;
  select jsonb_build_object(
    'maker', maker,
    'found', exists (select 1 from app.secret_discoveries where employee_id = me),
    'rank', (select n from (select employee_id, row_number() over (order by found_at, employee_id) n from app.secret_discoveries) x where employee_id = me),
    'total', (select count(*) from app.secret_discoveries),
    'first_name', (select split_part(coalesce(nullif(btrim(e.full_name), ''), 'Someone'), ' ', 1) from app.secret_discoveries d join app.employees e on e.id = d.employee_id order by d.found_at, d.employee_id limit 1),
    'first_at', (select min(found_at) from app.secret_discoveries)
  ) into r;
  return r;
end;
$$;
revoke all on function app.secret_discovery(boolean) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.secret_discovery(boolean)'::regprocedure),
        'Secret page: records the caller as a finder (once) and returns their place, the count and the first finder''s first name; null unless is_employee().')
on conflict do nothing;
grant execute on function app.secret_discovery(boolean) to authenticated;
