-- Decouple the 11 AM task nudge from leave tracking.
--
-- task-nudge selected its cohort with `.eq('leave_tracking_enabled', true)`, so
-- "doesn't need a daily nudge" was accidentally spelled "has no leave balance".
-- Two unrelated facts wearing one flag: it is why Anya is out of the nudge
-- today (a side effect of her leave being off, not a decision), and why turning
-- leave off for a fractional person silently also unsubscribes them.
--
-- Backfilled FROM leave_tracking_enabled, so today's cohort is preserved
-- exactly and this ships as a strict no-op. The flags can now move apart.

alter table app.employees
  add column if not exists task_nudge_enabled boolean not null default true;

update app.employees set task_nudge_enabled = leave_tracking_enabled;

comment on column app.employees.task_nudge_enabled is
  'Receives the 11 AM local-time task nudge (netlify/functions/task-nudge.js). Independent of leave_tracking_enabled — do not re-couple them.';
