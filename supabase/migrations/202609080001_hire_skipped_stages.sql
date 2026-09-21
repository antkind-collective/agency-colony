-- Skipping a hiring stage that happened offline (8 Sep 2026).
--
-- Real case: Dev's contract was signed outside Colony, so "upload contract
-- draft" and "review" were never going to happen here. Without a way past them
-- the record sits at the wrong stage forever, which is exactly how his hire
-- looked untouched for two weeks while he was already working.
--
-- The stage is recorded as SKIPPED rather than just advanced. Walking a hire
-- through upload → reviewed → signed to tidy the board would assert that a
-- contract was drafted, reviewed and signed inside Colony when no document
-- exists here — a false record, which is worse than an obviously incomplete
-- one. This column is what keeps "we did this elsewhere" distinguishable from
-- "we did this".
--
-- app.hire_stage_history already records WHEN each stage was entered and left,
-- but it is written by a trigger and has nowhere to hang an explanation, so
-- the fact lives on the hire itself.

alter table app.hires
  add column if not exists skipped_stages text[] not null default '{}';

comment on column app.hires.skipped_stages is
  'Stages passed over because the work happened outside Colony. A stage listed here was never completed in the app — do not read the current stage as proof the earlier ones were done.';
