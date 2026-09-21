-- "On Pause" for briefs (Rhea via Alex, 7 Sep 2026).
--
-- the client's own communications tracker carries a status Colony has never had:
-- work that is deliberately parked. Three live briefs sit in it today (FAQ
-- Post, GAM Toolkits, AstroAnomalous). We are about to build deadline
-- reminders at T-2 / T-1 / on-the-day, and without this Colony would chase
-- people about work everyone agreed to stop — worse than sending nothing.
--
-- Deliberately NOT a new value on app.brief_status. A paused brief still has
-- a real status: it was paused *from* somewhere, and resuming has to put it
-- back exactly there. Folding pause into the status enum would overwrite that,
-- and would need on_pause wired to and from six other states in the
-- transition table — the kind of combinatorial edit where a missing pair is
-- found months later by a brief that cannot be resumed.
--
-- As a flag it composes instead: every existing transition stays untouched,
-- resume is a no-op on status, and the reminder job filters on one column.

alter table app.briefs
  add column if not exists paused_at timestamptz,
  add column if not exists pause_reason text,
  add column if not exists paused_by uuid references app.employees(id) on delete set null;

-- The three columns move together or not at all: a brief is paused exactly
-- when paused_at is set, and a reason without a pause is a contradiction.
alter table app.briefs drop constraint if exists briefs_pause_chk;
alter table app.briefs add constraint briefs_pause_chk check (
  (paused_at is not null) or (pause_reason is null and paused_by is null)
);

-- Partial index: the reminder job asks "what is live?" on every run, and
-- paused briefs are the rows it must skip.
create index if not exists briefs_paused_idx on app.briefs (paused_at) where paused_at is not null;

comment on column app.briefs.paused_at is
  'Set while a brief is parked. Its status column keeps the stage it was paused from, so resuming restores it exactly. Deadline reminders must skip rows where this is not null.';
