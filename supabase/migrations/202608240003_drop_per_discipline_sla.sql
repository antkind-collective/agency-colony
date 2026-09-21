-- One SLA, not two (24 Aug 2026).
--
-- app.deliverable_sla held per-discipline production estimates (Design 2 days
-- on a carousel, Copy 1) on the assumption that a brief would be split between
-- a writer and a designer inside Colony. It never was: zero rows were ever
-- written to app.brief_deliverables. Alex's call is that the internal and
-- client turnaround are the same number and the creative team handles the
-- split themselves, so the second concept goes rather than lingering as a
-- table nobody can explain. app.client_sla (the signed SLA) is now the only
-- source of turnaround.
--
-- brief_deliverables.discipline stays: it is nullable, already unused, and
-- dropping a column is not worth the migration risk for zero rows.

drop table if exists app.deliverable_sla;
