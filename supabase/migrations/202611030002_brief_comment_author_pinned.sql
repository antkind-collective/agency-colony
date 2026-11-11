-- Audit 3 Nov 2026 (Tue, access parity, self-write sweep; carried from 20 Oct):
-- a brief comment's author_name was the caller's to set. The brief thread
-- shows author_name ahead of the real author (app.js renderBriefComments,
-- `c.author_name || …`), in Colony and on Circle, so anyone allowed to
-- comment on a brief could post under someone else's name: an employee as a
-- client's coordinator, or a client as an Your Agency reviewer. created_at was
-- open the same way (a comment could be backdated). Setting both author ids
-- was already refused by brief_comment_single_author_ck.
-- Dry run as grace@ (the client coordinator) on a the client brief: a comment as
-- 'Rhea Kapoor' dated 2026-01-01 was ALLOWED.
--
-- Now a signed-in insert is stamped with the caller's real identity and the
-- time: the employee path clears author_partner_id, the partner path clears
-- author_employee_id, author_name is the caller's own full name (the UI
-- already sends exactly this; every existing row matches), created_at = now().
-- The service role (no auth.uid()) is untouched. The insert policies still
-- decide who may comment at all.

create or replace function app_private.stamp_brief_comment_author()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
declare
  me_emp uuid := app.current_employee_id();
  me_partner uuid := app.current_partner_id();
begin
  if auth.uid() is null then return new; end if;
  if me_emp is not null and new.author_employee_id = me_emp then
    new.author_partner_id := null;
    select coalesce(nullif(btrim(e.full_name), ''), 'Your Agency') into new.author_name
      from app.employees e where e.id = me_emp;
  elsif me_partner is not null and new.author_partner_id = me_partner then
    new.author_employee_id := null;
    select coalesce(nullif(btrim(p.full_name), ''), 'Partner') into new.author_name
      from app.partners p where p.id = me_partner;
  end if;
  new.created_at := now();
  return new;
end;
$$;
revoke all on function app_private.stamp_brief_comment_author() from public, anon, authenticated;
drop trigger if exists trg_stamp_brief_comment_author on app.brief_comments;
create trigger trg_stamp_brief_comment_author before insert on app.brief_comments
  for each row execute function app_private.stamp_brief_comment_author();
