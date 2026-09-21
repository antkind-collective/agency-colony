-- Named brief viewers (15 Sep 2026: "give Sid ... also"). People who
-- work the the client briefs without being reviewers: they see and work every brief
-- like someone allocated to the client, but get none of the reviewer
-- powers (lock/unlock, partner admin) or the reviewer reminder emails.
-- Reviewers stay brief_reviewer_emails; this list is additive.

insert into app.app_config (key, value)
values ('brief_viewer_emails', '["dev@youragency.com","max@youragency.com"]'::jsonb)
on conflict (key) do update set value = excluded.value;

create or replace function app.is_brief_viewer()
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1 from app.employees e
    where e.auth_user_id = auth.uid() and e.is_active
      and lower(e.email) in (
        select lower(jsonb_array_elements_text(
          coalesce(nullif((select value from app.app_config where key = 'brief_viewer_emails'), 'null'::jsonb), '[]'::jsonb)))
      )
  );
$$;
grant execute on function app.is_brief_viewer() to authenticated;

create or replace function app.can_work_brief(p_brief_id uuid)
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select app.is_brief_reviewer()
      or app.is_brief_viewer()
      or app.is_assigned_to_brief(p_brief_id)
      or app.is_allocated_to_org((select b.org from app.briefs b where b.id = p_brief_id));
$$;
