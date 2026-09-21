-- Partners cannot read app.employees (Phase 0 lockdown), so comment author
-- names are denormalized at insert time instead of joined at read time.
alter table app.brief_comments add column author_name text;
