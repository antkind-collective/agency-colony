-- S11 (24 Sep 2026): definer RPCs with no client caller lose their
-- signed-in grant.
--
-- All seven below were declared callable in the 17 Sep baseline as "client RPC
-- or RLS policy helper" without that being checked. Traced on 24 Sep: no RLS
-- policy, view, column default or invoker function references any of them; no
-- code in app.js, js/, netlify/functions, scripts/ or _build calls them; and
-- the API edge logs for 18–24 Sep show no /rpc/ call to any of them. Three are
-- called from app.can_work_brief(), a postgres-owned definer that needs no
-- grant. Probed as a Circle partner they leaked nothing (each refuses or
-- answers about the caller), so this is closing the surface, not a leak.
--
-- Kept: app.is_brief_viewer() — scripts/access-parity.mjs (Tuesday audit)
-- calls it as `authenticated` to compare DB and UI gates. It answers about the
-- caller only. Its declaration now says so.
--
-- `from public` alone does not remove an explicit authenticated grant.

revoke execute on function app.current_access_level() from public, anon, authenticated;
revoke execute on function app.current_hire_id() from public, anon, authenticated;
revoke execute on function app.is_allocated_to_org(text) from public, anon, authenticated;
revoke execute on function app.is_assigned_to_brief(uuid) from public, anon, authenticated;
revoke execute on function app.is_client_scoped(uuid) from public, anon, authenticated;
revoke execute on function app.update_my_profile(text, text, app.employment_type, numeric, date, text, text, text, text) from public, anon, authenticated;

delete from app_private.callable_definer_functions
 where signature in (
   app_private.fn_signature('app.current_access_level()'::regprocedure),
   app_private.fn_signature('app.current_hire_id()'::regprocedure),
   app_private.fn_signature('app.is_allocated_to_org(text)'::regprocedure),
   app_private.fn_signature('app.is_assigned_to_brief(uuid)'::regprocedure),
   app_private.fn_signature('app.is_client_scoped(uuid)'::regprocedure),
   app_private.fn_signature('app.update_my_profile(text,text,app.employment_type,numeric,date,text,text,text,text)'::regprocedure)
 );

update app_private.callable_definer_functions
   set reason = 'scripts/access-parity.mjs (Tuesday audit) calls it as authenticated; answers about the caller only (checked 24 Sep 2026)'
 where signature = app_private.fn_signature('app.is_brief_viewer()'::regprocedure);
