-- Audit 6 Oct 2026 (Tue, access parity): colleagues' tasks follow client
-- scope, like every other table holding client data (CLAUDE.md, 5 Oct rule).
--
-- daily_tasks_select_all_authenticated was `app.is_employee()`. Every task
-- carries its client in `notes` (the task form's client picker), so a
-- fractional read every colleague's task for every client: asha@ (Save
-- Missing Girls + Example AI) read 5,997 tasks across 21 other clients
-- (titles and descriptions), 128 of them in the live team task view. ruth@
-- 4,045, mara@ 4,655.
--
-- Now: full-time staff and leadership unchanged (`sees_every_client()`);
-- everyone keeps their own tasks; a fractional sees a colleague's task when
-- its tag is one of `app.my_task_tags()`: the names of the clients she can
-- see, plus every tag that names no client at all (internal buckets such as
-- "Pitches/BD" stay as they were).
--
-- Performance: a per-row helper (task id -> can_see_client) cost ~14 ms a
-- row, ~90 s for the table. Every helper here is wrapped in (select …) so it
-- runs once per query. my_task_tags() never returns the name of a client the
-- caller cannot see. An inline EXISTS over app.clients in the policy would be
-- wrong: clients RLS hides out-of-scope clients from a fractional, so their
-- tasks would look untagged.

create or replace function app.my_task_tags()
returns text[]
language sql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
  -- Answers for the CALLER only. Lower-cased, trimmed.
  select case when not app.is_employee() then '{}'::text[] else
    coalesce(array_agg(distinct tag), '{}'::text[]) end
  from (
    select lower(btrim(c.name)) tag from app.clients c where app.can_see_client(c.id)
    union
    select lower(btrim(t.notes)) from app.daily_tasks t
    where t.notes is not null
      and not exists (select 1 from app.clients c
                      where lower(btrim(c.name)) = lower(btrim(t.notes)))
  ) tags;
$fn$;

revoke all on function app.my_task_tags() from public, anon;

insert into app_private.callable_definer_functions(signature, reason) values
  (app_private.fn_signature('app.my_task_tags()'::regprocedure),
   'RLS helper: daily_tasks employee read policy; caller''s visible client names + non-client tags only (audit 6 Oct 2026)')
on conflict do nothing;

grant execute on function app.my_task_tags() to authenticated;

alter policy daily_tasks_select_all_authenticated on app.daily_tasks
  using (
    (select app.is_employee())
    and (
      (select app.sees_every_client())
      or employee_id = (select app.current_employee_id())
      or lower(btrim(coalesce(notes, ''))) = any (coalesce((select app.my_task_tags()), '{}'::text[]))
    )
  );
