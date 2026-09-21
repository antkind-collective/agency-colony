-- Consultant becomes a first-class employment type (31 Aug 2026).
--
-- app.hires.hire_type has offered full-time | fractional | consultant since the
-- hiring pipeline shipped, but app.employees.employment_type only had two
-- values — and nothing carried the hire's type across, so a consultant became
-- salaried the moment they signed in.
--
-- Its own migration on purpose: Postgres cannot use a new enum value in the
-- same transaction that adds it.

alter type app.employment_type add value if not exists 'consultant';
