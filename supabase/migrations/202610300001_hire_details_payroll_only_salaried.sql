-- 30 Oct 2026: a fractional or consultant hire could not submit the joining
-- form. The form has hidden the tax regime and salary slips from them since
-- 7 Oct (they invoice), but this function still refused anything without an
-- Old/New regime, so the first such hire after that (Manisha Chhabria,
-- fractional, invited 30 Oct) would have met an error about a question she
-- could not see. Payroll's questions are now required, and stored, only for
-- full-time hires. Redefined from the live definition (30 Oct).

CREATE OR REPLACE FUNCTION app.submit_hire_details(p_full_name text, p_date_of_birth date, p_pan text, p_address text, p_bank_account_name text, p_bank_account_number text, p_bank_ifsc text, p_salary_slips_note text, p_tax_regime text, p_tax_declarations_note text, p_no_salary_slips boolean DEFAULT false, p_start_date date DEFAULT NULL::date, p_permanent_address text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public', 'extensions'
AS $function$
declare
  v_hire_id uuid;
  v_stage app.hire_stage;
  v_name text;
  v_salaried boolean;
begin
  select id, stage, coalesce(hire_type, 'full-time') = 'full-time' into v_hire_id, v_stage, v_salaried
    from app.hires where auth_user_id = auth.uid() and stage not in ('cancelled')
    limit 1;
  if v_hire_id is null then
    raise exception 'No active hire record for this account.';
  end if;
  if v_stage not in ('invited', 'details_submitted') then
    raise exception 'Your details are locked — the team has taken over from here.';
  end if;
  v_name := btrim(coalesce(p_full_name, ''));
  if array_length(regexp_split_to_array(v_name, '\s+'), 1) < 2 then
    raise exception 'Please enter your full name — first and last.';
  end if;
  -- Payroll's questions are for employees only: a fractional or consultant
  -- invoices, and the form hides them (7 Oct 2026), so they are not required.
  if v_salaried and (p_tax_regime is null or p_tax_regime not in ('old', 'new')) then
    raise exception 'Please choose your income tax regime — Old or New.';
  end if;
  if v_salaried and p_tax_regime = 'old' and btrim(coalesce(p_tax_declarations_note, '')) = '' then
    raise exception 'The Old regime needs your HRA / 80C / 80D declarations.';
  end if;

  update app.hires
     set full_name = v_name,
         date_of_birth = p_date_of_birth,
         pan = upper(btrim(coalesce(p_pan, ''))),
         address = p_address,
         permanent_address = nullif(btrim(coalesce(p_permanent_address, '')), ''),
         bank_account_name = p_bank_account_name,
         bank_account_number = p_bank_account_number,
         bank_ifsc = upper(btrim(coalesce(p_bank_ifsc, ''))),
         salary_slips_note = case when v_salaried then p_salary_slips_note end,
         no_salary_slips = case when v_salaried then coalesce(p_no_salary_slips, false) else false end,
         tax_regime = case when v_salaried then p_tax_regime end,
         tax_declarations_note = case when v_salaried then nullif(btrim(coalesce(p_tax_declarations_note, '')), '') end,
         start_date = coalesce(p_start_date, start_date),
         -- Keep an existing number if a blank somehow arrives, so a resubmit
         -- cannot wipe one that is already on file.
         phone = coalesce(nullif(btrim(coalesce(p_phone, '')), ''), phone),
         details_submitted_at = now(),
         stage = 'details_submitted',
         updated_at = now()
   where id = v_hire_id;
end;
$function$;
