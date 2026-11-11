-- The first-weeks steps on the hire (202610080006) are removed (8 Oct
-- 2026): a hire ends when they join Slack. Their RPCs had no caller left, and
-- a declared RPC must have one, so they go, with the columns they wrote.
-- Drop first, then remove the declarations (guard_access_ddl checks after
-- each statement that every callable definer function is declared).
drop function if exists app.tick_hire_followup(uuid, text, boolean);
drop function if exists app.hire_followup_signals();
delete from app_private.callable_definer_functions
 where signature in ('app.tick_hire_followup(uuid,text,boolean)', 'app.hire_followup_signals()')
    or signature like 'app.tick_hire_followup(%' or signature like 'app.hire_followup_signals(%';
alter table app.hires
  drop column if exists first_one_on_one_at,
  drop column if exists clients_briefed_at,
  drop column if exists tools_set_up_at,
  drop column if exists checkin_30_at;
