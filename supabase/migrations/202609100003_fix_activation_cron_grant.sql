-- The scheduled-activation cron could not call its own function (10 Sep 2026).
--
-- Yesterday's migration revoked run_due_activations from public/anon/
-- authenticated so no signed-in user could activate anyone by calling it
-- directly. That was right, but it also removed the default PUBLIC grant the
-- cron was relying on: the Netlify function connects as `service_role`, which
-- had no grant of its own. Every run since has died with
-- "permission denied for function run_due_activations".
--
-- Nothing was due yet, so nothing was actually missed — but Maya activates on
-- 24 Sep, and on that morning it would have failed the same way, in a heartbeat
-- log nobody reads.
--
-- service_role is the backend key only. Granting to it does not widen what any
-- signed-in user can do; the revokes from anon/authenticated stand.

grant execute on function app.run_due_activations() to service_role;

-- Same shape, same trap: apply_employee_setup is the unguarded half of
-- activation. It is only ever reached through a security-definer caller today,
-- so it needs no grant — this comment exists so nobody adds one by reflex.
