-- The secret page's cover lists everyone who found it, in order (Alex,
-- 9 Oct 2026). secret_discovery also returns the finders (employee id, first
-- name, when). Redefined from the LIVE definition; only 'finders' added.
CREATE OR REPLACE FUNCTION app.secret_discovery(p_mark boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
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
    'first_at', (select min(found_at) from app.secret_discoveries),
    'finders', coalesce((select jsonb_agg(jsonb_build_object('id', d.employee_id, 'name', split_part(coalesce(nullif(btrim(e.full_name), ''), 'Someone'), ' ', 1), 'at', d.found_at) order by d.found_at, d.employee_id)
                         from app.secret_discoveries d join app.employees e on e.id = d.employee_id), '[]')
  ) into r;
  return r;
end;
$function$;
