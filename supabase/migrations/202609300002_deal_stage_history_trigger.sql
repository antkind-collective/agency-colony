-- Deal stage history is written by the database (30 Sep 2026).
--
-- It used to be written by the browser after each stage change (three places
-- in app.js). Anything that changed deals.stage another way — Cowork threads,
-- the morning pipeline brief, a SQL fix — left no history: ~85 deals' current
-- stage has no matching row, and Ajinomoto sat in the home feed as "moved to
-- Discovery" after it was lost. Now an AFTER trigger records every change, by
-- whoever makes it; app.js no longer inserts.
--
-- The trigger closes any open row for the deal (exited_at = now) and opens one
-- for the new stage, with changed_by = the signed-in employee (null for the
-- service role). It runs as definer so a deal editor always gets a history
-- row even where the history insert policy is narrower than the deal update
-- policy. It lives in app_private: a trigger fires without USAGE.
--
-- One open row per (deal, stage): a partial unique index. Four duplicate open
-- pairs existed; the older of each is closed first. With the index, a stale
-- browser tab still inserting by hand fails quietly instead of doubling a row.

update app.deal_stage_history h
   set exited_at = n.entered_at
  from app.deal_stage_history n
 where h.deal_id = n.deal_id and h.stage = n.stage
   and h.exited_at is null and n.exited_at is null
   and h.entered_at < n.entered_at;

create unique index if not exists deal_stage_history_one_open
  on app.deal_stage_history (deal_id, stage) where exited_at is null;

create or replace function app_private.deal_stage_history_log()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
begin
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage then
    return new;
  end if;
  if new.stage is null then
    return new;
  end if;
  update app.deal_stage_history
     set exited_at = now()
   where deal_id = new.id and exited_at is null;
  insert into app.deal_stage_history (deal_id, stage, entered_at, changed_by)
  values (new.id, new.stage, now(), app.current_employee_id());
  return new;
end;
$fn$;

drop trigger if exists trg_deals_stage_history on app.deals;
create trigger trg_deals_stage_history
  after insert or update of stage on app.deals
  for each row execute function app_private.deal_stage_history_log();
