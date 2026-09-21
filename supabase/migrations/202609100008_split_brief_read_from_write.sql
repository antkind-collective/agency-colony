-- Seeing a colleague's brief is not permission to change it (10 Sep 2026).
--
-- The previous migration widened app.partner_can_access_brief() so everyone in
-- a client org can see that org's requests, which is what Alex asked for. But
-- that one function was ALSO the gate on three write paths — editing a brief,
-- commenting on it, and uploading attachments to it. Widening reads silently
-- widened writes, so any submitter could have edited a colleague's brief.
--
-- One function cannot answer two different questions. Reads keep the widened
-- rule; writes get their own, carrying the ORIGINAL wording unchanged: the
-- author, or a coordinator/client_viewer. The extra role checks inside each
-- policy are left exactly as they were.

create or replace function app.partner_can_edit_brief(p_brief_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1
    from app.briefs b
    join app.partners p on p.id = app.current_partner_id()
    where b.id = p_brief_id
      and b.org = p.org
      and (p.partner_role in ('coordinator', 'client_viewer')
           or b.submitted_by_partner_id = p.id)
  );
$$;

create or replace function app.partner_can_edit_brief_path(p_folder text)
returns boolean
language plpgsql
stable security definer
set search_path to 'app', 'public'
as $$
begin
  if p_folder is null or p_folder !~ '^[0-9a-fA-F-]{36}$' then
    return false;
  end if;
  return app.partner_can_edit_brief(p_folder::uuid);
end;
$$;

-- 1. Editing a brief.
drop policy if exists briefs_update_partner on app.briefs;
create policy briefs_update_partner on app.briefs
  for update
  using (
    status = any (array['submitted', 'pending_info', 'delivered']::app.brief_status[])
    and app.partner_can_edit_brief(id)
    and exists (select 1 from app.partners p
                 where p.id = app.current_partner_id()
                   and p.partner_role = any (array['submitter', 'coordinator']::app.partner_role[]))
  )
  with check (
    status = any (array['submitted', 'pending_info', 'ready_for_review', 'under_revision']::app.brief_status[])
    and app.partner_can_edit_brief(id)
    and exists (select 1 from app.partners p
                 where p.id = app.current_partner_id()
                   and p.partner_role = any (array['submitter', 'coordinator']::app.partner_role[]))
  );

-- 2. Commenting. Held at the old rule rather than widened with reads: that is
-- a separate call for Alex to make, not a side effect of this one.
drop policy if exists brief_comments_insert_partner on app.brief_comments;
create policy brief_comments_insert_partner on app.brief_comments
  for insert
  with check (
    author_partner_id = app.current_partner_id()
    and visibility = 'shared'::app.brief_comment_visibility
    and app.partner_can_edit_brief(brief_id)
    and exists (select 1 from app.partners p
                 where p.id = app.current_partner_id()
                   and p.partner_role = any (array['submitter', 'coordinator']::app.partner_role[]))
  );

-- 3. Uploading attachments. Reading them stays widened (a brief you can see,
-- you can read the files of); putting files INTO someone else's brief does not.
drop policy if exists briefs_storage_insert on storage.objects;
create policy briefs_storage_insert on storage.objects
  for insert
  with check (
    bucket_id = 'briefs'
    and (
      app.can_work_brief_path((storage.foldername(name))[1])
      or (
        (storage.foldername(name))[2] = 'ga'
        and app.partner_can_edit_brief_path((storage.foldername(name))[1])
        and exists (select 1 from app.partners p
                     where p.id = app.current_partner_id()
                       and p.partner_role = any (array['submitter', 'coordinator']::app.partner_role[]))
      )
    )
  );
