-- The joining checklist has asked for a mobile number since 8 Sep 2026, marks it
-- required, and the client refuses to submit without one. It was never saved.
--
-- 202609080002_hire_phone.sql added app.hires.phone and hand-backfilled Asha's
-- number, but did not touch app.submit_hire_details — the only path a candidate
-- can write their own row (hires_update_crew is crew-only). So the RPC had no
-- p_phone parameter and its UPDATE never set the column: every candidate since
-- has typed a number that went nowhere. Sivabalan S (7 Oct) is the first whose
-- blank phone was noticed.
--
-- Drop first: adding a parameter makes a new overload rather than replacing the
-- old one, and two candidate signatures is how PostgREST picks the wrong one.

-- guard_access_ddl requires every SECURITY DEFINER function reachable by a
-- signed-in user to be declared by name with a reason. Retire the old signature
-- and declare the new one in the same migration, so the guard never sees an
-- undeclared function.
delete from app_private.callable_definer_functions
 where signature = 'app.submit_hire_details(text,date,text,text,text,text,text,text,text,text,boolean,date,text)';

insert into app_private.callable_definer_functions (signature, reason)
values ('app.submit_hire_details(text,date,text,text,text,text,text,text,text,text,boolean,date,text,text)',
        'client RPC: the candidate writes their own hire row — hires_update_crew is crew-only. Gained p_phone 7 Oct 2026.')
on conflict (signature) do update set reason = excluded.reason;

drop function if exists app.submit_hire_details(text, date, text, text, text, text, text, text, text, text, boolean, date, text);

create or replace function app.submit_hire_details(
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
  p_start_date date default null,
  p_permanent_address text default null,
  p_phone text default null
) returns void
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $function$
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
         permanent_address = nullif(btrim(coalesce(p_permanent_address, '')), ''),
         bank_account_name = p_bank_account_name,
         bank_account_number = p_bank_account_number,
         bank_ifsc = upper(btrim(coalesce(p_bank_ifsc, ''))),
         salary_slips_note = p_salary_slips_note,
         no_salary_slips = coalesce(p_no_salary_slips, false),
         tax_regime = p_tax_regime,
         tax_declarations_note = nullif(btrim(coalesce(p_tax_declarations_note, '')), ''),
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

-- The drop took the grants with it; the candidate calls this as `authenticated`.
grant execute on function app.submit_hire_details(text, date, text, text, text, text, text, text, text, text, boolean, date, text, text) to authenticated, service_role;
