-- Salary slips are not universally available (11 Aug 2026): some
-- candidates simply never had them (first job, cash-paid, employer never
-- issued). The form gets an explicit "I did not have salary slips" checkbox
-- as a first-class answer — no file and no free-text note required. The note
-- stays as optional context.

alter table app.hires add column no_salary_slips boolean not null default false;

drop function if exists app.submit_hire_details(text, date, text, text, text, text, text, text, text, text);

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
  p_no_salary_slips boolean default false
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
         details_submitted_at = now(),
         stage = 'details_submitted',
         updated_at = now()
   where id = v_hire_id;
end;
$$;

grant execute on function app.submit_hire_details(text, date, text, text, text, text, text, text, text, text, boolean) to authenticated;
