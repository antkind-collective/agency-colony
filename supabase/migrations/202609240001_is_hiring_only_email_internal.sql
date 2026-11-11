-- Circle isolation audit, 24 Sep 2026.
--
-- app.is_hiring_only_email(text) is SECURITY DEFINER and was granted to
-- authenticated in 202608030002, then carried into the 17 Sep baseline of
-- app_private.callable_definer_functions as "client RPC or RLS policy helper".
-- It is neither: no policy references it and no client or function code calls
-- it. Its one caller is app.ensure_employee_profile(), itself a definer owned
-- by postgres, which needs no grant to call it.
--
-- What the grant exposed: any signed-in token, a Circle client included,
-- could test an address against the hiring_only_emails list in app_config,
-- which partners otherwise cannot read (probe as mira@example.org:
-- is_hiring_only_email('leo@youragency.com') returned true). A one-bit oracle,
-- LOW, but an internal helper has no business on the client surface.
--
-- `from public` alone does not remove an explicit authenticated grant.

revoke execute on function app.is_hiring_only_email(text) from public, anon, authenticated;

delete from app_private.callable_definer_functions
 where signature = app_private.fn_signature('app.is_hiring_only_email(text)'::regprocedure);
