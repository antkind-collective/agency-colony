-- Access-parity audit, 13 Oct 2026: app.spawn_onboarding_checklist(uuid) has no
-- caller left. The old onboarding checklist was retired on 8 Oct (6115e11,
-- 202610080006): app.js's spawnOnboardingForEmployee() is no longer called
-- anywhere, and no policy or function calls the RPC. A declared RPC must have
-- a real caller, so signed-in users lose EXECUTE (it still let an employee
-- open a checklist for themselves). The function itself is kept, so a later
-- revival is a grant away. Revoke first, then remove the declaration
-- (guard_access_ddl checks after each statement).
revoke all on function app.spawn_onboarding_checklist(uuid) from public, anon, authenticated;
delete from app_private.callable_definer_functions
 where signature = app_private.fn_signature('app.spawn_onboarding_checklist(uuid)'::regprocedure);
