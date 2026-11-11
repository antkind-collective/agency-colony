-- Activate failed for every hire (9 Oct 2026): "cannot cast type
-- hire_type to employment_type". Two enums with the same labels still need a
-- text hop. Redefined from the LIVE definition; only that line changed.
CREATE OR REPLACE FUNCTION app.activate_hire(p_hire_id uuid, p_activate_on date DEFAULT NULL::date)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
declare
  h app.hires%rowtype;
  t app.hire_offer_terms%rowtype;
  e app.employees%rowtype;
  dept uuid;
  etype app.employment_type;
  cap numeric;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not app_private.can_activate_hire(p_hire_id) then
    raise exception 'Only the hiring manager or Alex can switch on Colony access.';
  end if;
  select * into h from app.hires where id = p_hire_id;
  if not found then raise exception 'No such hire.'; end if;
  select * into t from app.hire_offer_terms where hire_id = p_hire_id;
  if h.work_email is null then raise exception 'They have no @youragency.com account yet.'; end if;
  select * into e from app.employees where lower(email::text) = lower(h.work_email) and is_active limit 1;
  if not found then raise exception 'They haven''t signed in to Colony yet.'; end if;
  if not e.setup_pending then raise exception 'Their Colony access is already on.'; end if;

  select id into dept from app.departments where name = t.department limit 1;
  dept := coalesce(dept, e.requested_department_id, e.department_id);
  if dept is null then raise exception 'No team on the hire. Add one in its terms first.'; end if;
  etype := coalesce(h.hire_type::text, 'full-time')::app.employment_type;
  cap := case when etype = 'fractional' then 50 else 100 end;
  if etype = 'fractional' and coalesce(array_length(t.scoped_client_ids, 1), 0) = 0 then
    raise exception 'A fractional hire needs at least one client in its terms before activating.';
  end if;

  delete from app.scheduled_activations where employee_id = e.id and applied_at is null;
  if p_activate_on is null or p_activate_on <= today then
    perform app_private.apply_employee_setup(e.id, dept, etype, cap, coalesce(t.scoped_client_ids, '{}'));
    return 'activated';
  end if;
  insert into app.scheduled_activations
    (employee_id, activate_on, department_id, employment_type, capacity_percent, client_ids, scheduled_by)
  values (e.id, p_activate_on, dept, etype, cap, coalesce(t.scoped_client_ids, '{}'), app.current_employee_id());
  update app.hires set activation_scheduled_on = p_activate_on, updated_at = now() where id = p_hire_id;
  return 'scheduled';
end;
$function$;
