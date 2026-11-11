-- Fixed-term contracts (6 Oct 2026). Fractional and consultant hires
-- can have an end date; it is optional, and full-time hires never have one.
-- NULL = ongoing. Lives on app.hire_offer_terms, the crew-only table, so a
-- candidate never sees it and the existing RLS (is_hiring_crew) and table
-- grants cover it. The contract-end-reminder cron emails the setup
-- approvers 30 days before it.
alter table app.hire_offer_terms add column if not exists contract_end_date date;

-- A full-time hire is never fixed-term; the end date must follow the start.
create or replace function app_private.hire_contract_end_check()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
declare
  v_hire app.hires%rowtype;
begin
  if new.contract_end_date is null then
    return new;
  end if;
  select * into v_hire from app.hires where id = new.hire_id;
  if v_hire.hire_type = 'full-time' then
    raise exception 'Full-time hires are ongoing; only fractional and consultant hires have an end date.';
  end if;
  if v_hire.start_date is not null and new.contract_end_date <= v_hire.start_date then
    raise exception 'The end date must be after the start date.';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_hire_contract_end_check on app.hire_offer_terms;
create trigger trg_hire_contract_end_check
  before insert or update of contract_end_date on app.hire_offer_terms
  for each row execute function app_private.hire_contract_end_check();
