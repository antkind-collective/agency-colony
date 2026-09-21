-- The candidate confirms their own start date (24 Aug 2026).
--
-- start_date was only ever set by whoever created the hire, and optionally —
-- so it was routinely blank when Blake needed it for the payroll month and
-- Leo for the contract. The joining form now asks the candidate for it, and
-- their answer wins (they are the one holding the offer letter). Passing NULL
-- leaves whatever the creator entered untouched.

drop function if exists app.submit_hire_details(text, date, text, text, text, text, text, text, text, text, boolean);

create function app.submit_hire_details(
  p_full_name text,
  p_date_of_birth date,
  p_pan text,
  p_address text,
  p_bank_account_name text,
  p_bank_account_number text,
  p_bank_ifsc text,
  p_salary_slips_note text,
  p_tax_regime text,
  p_tax_declarations_note text,
  p_no_salary_slips boolean default false,
  p_start_date date default null
)
returns void
language plpgsql security definer
set search_path to 'app', 'public'
as $$
declare
  v_hire_id uuid;
  v_stage app.hire_stage;
  v_name text;
begin
  select id, stage into v_hire_id, v_stage
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
  if p_tax_regime is null or p_tax_regime not in ('old', 'new') then
    raise exception 'Please choose your income tax regime — Old or New.';
  end if;
  if p_tax_regime = 'old' and btrim(coalesce(p_tax_declarations_note, '')) = '' then
    raise exception 'The Old regime needs your HRA / 80C / 80D declarations.';
  end if;

  update app.hires
     set full_name = v_name,
         date_of_birth = p_date_of_birth,
         pan = upper(btrim(coalesce(p_pan, ''))),
         address = p_address,
         bank_account_name = p_bank_account_name,
         bank_account_number = p_bank_account_number,
         bank_ifsc = upper(btrim(coalesce(p_bank_ifsc, ''))),
         salary_slips_note = p_salary_slips_note,
         no_salary_slips = coalesce(p_no_salary_slips, false),
         tax_regime = p_tax_regime,
         tax_declarations_note = nullif(btrim(coalesce(p_tax_declarations_note, '')), ''),
         start_date = coalesce(p_start_date, start_date),
         details_submitted_at = now(),
         stage = 'details_submitted',
         updated_at = now()
   where id = v_hire_id;
end;
$$;

grant execute on function app.submit_hire_details(text, date, text, text, text, text, text, text, text, text, boolean, date) to authenticated;
