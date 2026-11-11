-- Pitches/BD belongs to Misc/Bizdev, not "Internal" (27 Sep 2026).
--
-- "Internal" is a synthetic parent the allocation writers use for names that
-- match no client; it should not read as a client anywhere. Its one live
-- project was Pitches/BD (Alex's 50% every week since March), which is why
-- the home card still showed Internal at 50% after 202609270002.
--
-- The PROJECT moves (id kept) rather than merging into Misc/Bizdev's own
-- project: saving a week re-resolves the line by name, and a vanished
-- "Pitches/BD" would be recreated under Internal on the next save. Under
-- Misc/Bizdev it now resolves to the real client (resolve_project_for_name).
-- 57 allocation rows ride along unchanged; no daily tasks reference it.
-- Reversible: update back to the Internal client id.

create table if not exists app_private.pitches_bd_move_20260927 as
  select p.* from app.projects p
  where p.id = 'c767672a-0679-476a-a6c5-cc271345fd98';

update app.projects
   set client_id = (select id from app.clients where name = 'Misc/Bizdev' limit 1)
 where id = 'c767672a-0679-476a-a6c5-cc271345fd98'
   and exists (select 1 from app.clients where name = 'Misc/Bizdev');
