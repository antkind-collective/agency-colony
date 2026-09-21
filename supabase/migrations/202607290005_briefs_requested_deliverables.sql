-- Partners declare WHAT they need as part of the brief ("Deliverable(s) |
-- What needs to be created?" in the SLA doc's checklist). Reviewers turn these
-- into real app.brief_deliverables rows at lock time — partners can't write
-- that table directly.
alter table app.briefs add column requested_deliverables text[] not null default '{}';
