-- S8 (24 Sep 2026): move the citext extension out of `public`
-- (Security Advisor WARN extension_in_public).
--
-- citext is what makes every email column case-insensitive (employees.email,
-- partners.email, hires.personal_email/work_email, …). Moving its schema is a
-- one-line ALTER, but two things depend on finding it BY NAME at run time:
--   1. four definer functions write `citext` in their bodies
--      (ensure_employee_profile — every staff sign-in — prepare_leave_request,
--      enforce_leadership_leave_superadmin, normalize_employee_record);
--   2. every function body resolves the citext `=` operator through its
--      search_path. All 92 functions in app / app_private pin
--      `search_path = app, public` (or pg_catalog); without `extensions` on it,
--      `email = $1` would silently fall back to a CASE-SENSITIVE text compare.
-- So every pinned path that names `public` gains `extensions` in the same
-- transaction. Stored expressions (column defaults, RLS policies, indexes)
-- hold type/operator OIDs and are unaffected. The API roles and postgres
-- already search `public, extensions`.

begin;

alter extension citext set schema extensions;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('app', 'app_private')
       and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=app, public')
  loop
    execute format('alter function %s set search_path = app, public, extensions', f.sig);
  end loop;
end $$;

commit;
