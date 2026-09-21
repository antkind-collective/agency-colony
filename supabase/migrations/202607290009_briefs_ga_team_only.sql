-- Briefs are visible ONLY to people working on Example Collective (Alex,
-- 29 Jul 2026): brief reviewers (Rhea/Mara + leadership floor) see all;
-- an employee with a deliverable assigned to them sees that brief; everyone
-- else sees nothing. Assignment = access grant.

create or replace function app.is_assigned_to_brief(p_brief_id uuid)
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1 from app.brief_deliverables d
    where d.brief_id = p_brief_id
      and d.assignee_employee_id = app.current_employee_id()
  );
$$;

create or replace function app.can_work_brief(p_brief_id uuid)
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select app.is_brief_reviewer() or app.is_assigned_to_brief(p_brief_id);
$$;

-- Storage-path variant (folder may not be a uuid; fail closed).
create or replace function app.can_work_brief_path(p_folder text)
returns boolean
language plpgsql stable security definer
set search_path to 'app', 'public'
as $$
begin
  if p_folder is null or p_folder !~ '^[0-9a-fA-F-]{36}$' then
    return false;
  end if;
  return app.can_work_brief(p_folder::uuid);
end;
$$;

grant execute on function app.is_assigned_to_brief(uuid) to authenticated;
grant execute on function app.can_work_brief(uuid) to authenticated;
grant execute on function app.can_work_brief_path(text) to authenticated;

-- briefs: reads + writes narrowed from is_employee() to GA-team
alter policy briefs_select on app.briefs
  using (app.can_work_brief(id) or app.partner_can_access_brief(id));
alter policy briefs_update_employee on app.briefs
  using (app.can_work_brief(id));
alter policy briefs_insert_employee on app.briefs
  with check (app.is_brief_reviewer() and submitted_by_employee_id = app.current_employee_id());

-- deliverables: reviewers manage; assignees update their own rows
alter policy brief_deliverables_select on app.brief_deliverables
  using (app.can_work_brief(brief_id) or app.partner_can_access_brief(brief_id));
alter policy brief_deliverables_insert on app.brief_deliverables
  with check (app.is_brief_reviewer());
alter policy brief_deliverables_update on app.brief_deliverables
  using (app.is_brief_reviewer() or assignee_employee_id = app.current_employee_id());
alter policy brief_deliverables_delete on app.brief_deliverables
  using (app.is_brief_reviewer());

-- history, comments, creative briefs
alter policy brief_status_history_select on app.brief_status_history
  using (app.can_work_brief(brief_id) or app.partner_can_access_brief(brief_id));
alter policy brief_comments_select_employee on app.brief_comments
  using (app.can_work_brief(brief_id));
alter policy brief_comments_insert_employee on app.brief_comments
  with check (app.can_work_brief(brief_id) and author_employee_id = app.current_employee_id());
alter policy creative_briefs_select on app.creative_briefs
  using (app.can_work_brief(brief_id));
alter policy creative_briefs_insert on app.creative_briefs
  with check (app.is_brief_reviewer());
alter policy creative_briefs_update on app.creative_briefs
  using (app.can_work_brief(brief_id));

-- storage: briefs bucket narrowed the same way
alter policy briefs_storage_select on storage.objects using (
  bucket_id = 'briefs' and (
    app.can_work_brief_path((storage.foldername(name))[1])
    or (
      app.partner_can_access_brief_path((storage.foldername(name))[1])
      and (
        (storage.foldername(name))[2] = 'ga'
        or exists (
          select 1 from app.briefs b
          where b.id::text = (storage.foldername(name))[1]
            and b.status in ('delivered', 'completed')
        )
      )
    )
  )
);
alter policy briefs_storage_insert on storage.objects with check (
  bucket_id = 'briefs' and (
    app.can_work_brief_path((storage.foldername(name))[1])
    or (
      (storage.foldername(name))[2] = 'ga'
      and app.partner_can_access_brief_path((storage.foldername(name))[1])
      and exists (
        select 1 from app.partners p
        where p.id = app.current_partner_id()
          and p.partner_role in ('submitter', 'coordinator')
      )
    )
  )
);
alter policy briefs_storage_delete on storage.objects using (
  bucket_id = 'briefs' and app.is_brief_reviewer()
);
