-- 21 Oct 2026: Rhea's "Captions" link went in twice, 4 seconds apart. The
-- Add link button stayed live while the first insert was saving (fixed in the
-- app too). The database now refuses the same link twice in the same place on
-- a brief. A trigger, not a unique index, because that first duplicate is
-- still there until Rhea removes it with the new Remove button.
create or replace function app_private.guard_brief_link_duplicate()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
begin
  if exists (select 1 from app.brief_links l
             where l.brief_id = new.brief_id and l.folder = new.folder and l.url = new.url) then
    raise exception 'That link is already on this brief.';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_brief_link_duplicate on app.brief_links;
create trigger trg_guard_brief_link_duplicate
  before insert on app.brief_links
  for each row execute function app_private.guard_brief_link_duplicate();
