-- The hiring checklist page (11 Sep 2026).
--
-- Compensation and scope must exist from the moment a hire is opened: the
-- contract and the payroll setup both stalled on questions nobody had been
-- asked. Offer terms already hold CTC and scope; what was missing is a fee for
-- people who invoice, and the clients a fractional will be scoped to.
alter table app.hire_offer_terms
  add column if not exists monthly_fee numeric,
  add column if not exists scoped_client_ids uuid[] not null default '{}';
comment on column app.hire_offer_terms.monthly_fee is 'Fixed monthly fee for consultants and fractionals. Employees carry ctc_annual instead; never both.';
comment on column app.hire_offer_terms.scoped_client_ids is 'For fractionals: the clients they will be scoped to at activation. Named at open so activation needs no second decision.';

-- Anyone in leadership can open a hire and work the checklist (11 Sep
-- 2026: "Nadia is no longer HR ... anybody in leadership can open a hire").
-- This widens who can READ hire rows, PAN and bank included, from the crew
-- (Alex, Nadia, Leo, Blake) to leadership. Stated plainly here because it
-- is a boundary change, not a UI one.
create or replace function app.is_hiring_crew()
returns boolean language sql stable security definer set search_path to 'app', 'public'
as $$
  select app.is_setup_approver()
      or app.is_leadership_or_admin()
      or lower(coalesce(app.current_request_email(), '')) in (
        select lower(jsonb_array_elements_text(
          coalesce(nullif((select value from app.app_config where key = 'hiring_crew_emails'), 'null'::jsonb),
                   '["leo@youragency.com","finance@youragency.com"]'::jsonb)))
      );
$$;
drop policy if exists hires_insert_approver on app.hires;
create policy hires_insert_leadership on app.hires for insert
  with check ((app.is_setup_approver() or app.is_leadership_or_admin()) and created_by = app.current_employee_id());
