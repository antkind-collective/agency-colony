-- Everything Legal needs to draft an employment agreement in one pass
-- (Leo's checklist, 24 Aug 2026). Colony held 4 of his 11 fields; the rest
-- had nowhere to live, so he had to email and wait each time.
--
-- Split by WHO KNOWS the answer:
--   candidate  → permanent address (we only ever asked for one address, and
--                they filled it with their current one)
--   Your Agency    → designation, department, CTC, notice period, scope of work —
--                all agreed at offer, long before the candidate submits
--   Blake     → CTC breakup, which stays OUT of Colony deliberately: it is
--                worked out per hire and travels in the stage email, where the
--                action points are addressed to him first and Leo second.
--
-- Offer terms are a SEPARATE table, not columns on app.hires, because a
-- candidate can read their own hires row (hires_select_crew allows
-- auth_user_id = auth.uid()). RLS is row-level, so the only way to keep
-- compensation off their screen is to keep it out of that row.

alter table app.hires add column permanent_address text;

create table app.hire_offer_terms (
  hire_id                  uuid primary key references app.hires(id) on delete cascade,
  designation              text,
  department               text,
  ctc_annual               numeric(12, 2),
  ctc_currency             text not null default 'INR',
  -- Two options is enough (24 Aug 2026).
  notice_period_days       integer check (notice_period_days in (30, 60)),
  scope_of_work            text,
  hiring_manager_email     citext,
  updated_at               timestamptz not null default now(),
  updated_by_employee_id   uuid references app.employees(id) on delete set null
);

comment on table app.hire_offer_terms is
  'Offer terms for a pending hire — designation, department, CTC, notice period, scope. Crew-only (Leo, Blake, Alex, Nadia): deliberately NOT on app.hires, which the candidate can read.';

alter table app.hire_offer_terms enable row level security;

-- is_hiring_crew() already resolves to exactly the right four people: it
-- includes setup approvers (Alex, Nadia) plus the hiring_crew_emails list
-- (Leo, Blake). Candidates are not in it, which is the whole point.
create policy hire_offer_terms_crew on app.hire_offer_terms for all
  using (app.is_hiring_crew()) with check (app.is_hiring_crew());

create trigger trg_hire_offer_terms_updated_at
  before update on app.hire_offer_terms
  for each row execute function app.set_updated_at();

-- Candidate submission gains permanent address.
drop function if exists app.submit_hire_details(text, date, text, text, text, text, text, text, text, text, boolean, date);

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
  p_start_date date default null,
  p_permanent_address text default null
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
         permanent_address = nullif(btrim(coalesce(p_permanent_address, '')), ''),
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

grant execute on function app.submit_hire_details(text, date, text, text, text, text, text, text, text, text, boolean, date, text) to authenticated;
