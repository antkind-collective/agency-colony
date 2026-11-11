-- Brief viewers are read-only (27 Sep 2026).
--
-- "Brief viewers" (app_config.brief_viewer_emails: Dev, Ben; Carmen
-- next, to review the the client workflow) were folded into app.can_work_brief, so
-- the list meant "work on every brief": update briefs, comment, edit the
-- creative brief, upload files. A viewer now SEES every brief and changes
-- none of them.
--
-- Split:
--   app.can_work_brief(id)  = reviewer, assigned to a deliverable, or allocated
--                              to the brief's client. Every WRITE policy.
--   app.can_view_brief(id)  = can_work_brief OR viewer. Every READ policy.
-- A viewer who is also allocated to the client (or assigned) still works on
-- that client's briefs through can_work_brief, as before.
--
-- Access: can_view_brief / can_view_brief_path are RLS policy helpers, so
-- authenticated needs EXECUTE; both answer only about the caller. Declared in
-- app_private.callable_definer_functions before the grant, as guard_access_ddl
-- requires.

create or replace function app.can_work_brief(p_brief_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select app.is_brief_reviewer()
      or app.is_assigned_to_brief(p_brief_id)
      or app.is_allocated_to_org((select b.org from app.briefs b where b.id = p_brief_id));
$$;

create or replace function app.can_view_brief(p_brief_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $$
  select app.can_work_brief(p_brief_id) or app.is_brief_viewer();
$$;

create or replace function app.can_view_brief_path(p_folder text)
returns boolean
language plpgsql
stable security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if p_folder is null or p_folder !~ '^[0-9a-fA-F-]{36}$' then
    return false;
  end if;
  return app.can_view_brief(p_folder::uuid);
end;
$$;

revoke all on function app.can_view_brief(uuid) from public, anon;
revoke all on function app.can_view_brief_path(text) from public, anon;

insert into app_private.callable_definer_functions(signature, reason) values
  (app_private.fn_signature('app.can_view_brief(uuid)'::regprocedure),
   'RLS read policies on briefs and their child tables; answers about the caller only (27 Sep 2026)'),
  (app_private.fn_signature('app.can_view_brief_path(text)'::regprocedure),
   'briefs storage read policy; answers about the caller only (27 Sep 2026)')
on conflict do nothing;

grant execute on function app.can_view_brief(uuid) to authenticated;
grant execute on function app.can_view_brief_path(text) to authenticated;

-- Reads: view. (Writes keep can_work_brief and so drop viewers.)
alter policy briefs_select on app.briefs
  using (app.can_view_brief(id) or exists (
    select 1 from app.partners p
    where p.id = app.current_partner_id() and p.org = briefs.org));

alter policy brief_deliverables_select on app.brief_deliverables
  using (app.can_view_brief(brief_id) or app.partner_can_access_brief(brief_id));

alter policy brief_status_history_select on app.brief_status_history
  using (app.can_view_brief(brief_id) or app.partner_can_access_brief(brief_id));

alter policy brief_comments_select_employee on app.brief_comments
  using (app.can_view_brief(brief_id));

alter policy creative_briefs_select on app.creative_briefs
  using (app.can_view_brief(brief_id));

alter policy briefs_storage_select on storage.objects
  using ((bucket_id = 'briefs') and (
    app.can_view_brief_path((storage.foldername(name))[1])
    or (app.partner_can_access_brief_path((storage.foldername(name))[1])
        and (((storage.foldername(name))[2] = 'ga')
             or exists (select 1 from app.briefs b
                        where b.id::text = (storage.foldername(objects.name))[1]
                          and b.status = any (array['delivered'::app.brief_status, 'completed'::app.brief_status]))))));
