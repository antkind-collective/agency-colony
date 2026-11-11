-- 3 Nov 2026 (Alex's go, after the audit's note): on the feedback walls a
-- post's or reply's author_name was the caller's to set. Circle shows it as
-- the author (partners can't read app.employees), so a client could post on
-- their own org's wall as a colleague, or as Alex; created_at could be
-- backdated. Same class as brief comments (202611030002).
--
-- Now a signed-in insert is stamped by the database, in the formats the app
-- already writes:
--   client:  "<full name> (<org>)"          (Circle's post and reply box)
--   staff:   first + last word of full name (displayPersonName in app.js;
--            Colony shows staff from the employees join, so this only
--            changes what a client reads on a staff reply)
-- and created_at = now(). fr_single_author_ck / frr_single_author_ck already
-- stop a row naming both an employee and a partner. Existing rows are not
-- touched. The service role (no auth.uid()) is untouched.

create or replace function app_private.wall_author_name()
returns text
language sql
stable
security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select coalesce(
    (select case
              when array_length(t, 1) is null then null
              when array_length(t, 1) = 1 then t[1]
              else t[1] || ' ' || t[array_length(t, 1)]
            end
       from (select regexp_split_to_array(btrim(e.full_name), '\s+') as t
               from app.employees e where e.id = app.current_employee_id()
                and nullif(btrim(e.full_name), '') is not null) x),
    (select coalesce(nullif(btrim(p.full_name), ''), 'Partner')
            || coalesce(' (' || nullif(btrim(p.org), '') || ')', '')
       from app.partners p where p.id = app.current_partner_id()),
    'Your Agency'
  );
$$;
revoke all on function app_private.wall_author_name() from public, anon, authenticated;

create or replace function app_private.stamp_wall_author()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.employee_id is not null and new.employee_id = app.current_employee_id())
     or (new.author_partner_id is not null and new.author_partner_id = app.current_partner_id()) then
    new.author_name := app_private.wall_author_name();
  end if;
  new.created_at := now();
  return new;
end;
$$;
revoke all on function app_private.stamp_wall_author() from public, anon, authenticated;

drop trigger if exists trg_stamp_feature_request_author on app.feature_requests;
create trigger trg_stamp_feature_request_author before insert on app.feature_requests
  for each row execute function app_private.stamp_wall_author();
drop trigger if exists trg_stamp_feature_reply_author on app.feature_request_replies;
create trigger trg_stamp_feature_reply_author before insert on app.feature_request_replies
  for each row execute function app_private.stamp_wall_author();
