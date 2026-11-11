-- Legal approves the submitted details before drafting (7 Oct 2026).
--
-- Until now the candidate hitting Submit was itself the trigger: hire-notify
-- mailed Leo "please draft the engagement agreement" the moment the form was
-- sent, so a draft could be built on details nobody had looked at. The gate goes
-- to Legal rather than the hiring lead because the hiring lead cannot verify a
-- PAN or a bank account in any meaningful way — only that the boxes are filled.
-- Leo is the one who needs them correct, so the check sits with the person who
-- needs it: a readiness check, not a second pair of eyes.
--
-- A timestamp rather than a new hire_stage: the stage enum and its transition
-- map are the audited path, and "awaiting approval" is not something we need to
-- filter the list by. Who and when come for free.

alter table app.hires
  add column if not exists details_approved_at timestamptz,
  add column if not exists details_approved_by uuid references app.employees(id);

comment on column app.hires.details_approved_at is
  'When Legal confirmed the submitted details are usable for the agreement. Null means the draft should not be started yet.';
comment on column app.hires.details_approved_by is
  'The employee who approved. Set together with details_approved_at.';

-- Hires that already moved past details keep a truthful history: they were
-- never approved, because the step did not exist. Only the ones already drafted
-- or beyond are backfilled, so live hires still get a real approval.
update app.hires
   set details_approved_at = details_submitted_at
 where details_submitted_at is not null
   and details_approved_at is null
   and stage in ('contract_uploaded', 'reviewed', 'signed', 'payroll_done');
