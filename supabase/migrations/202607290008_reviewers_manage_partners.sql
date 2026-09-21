-- Partner onboarding moves to the account leads (29 Jul 2026): brief
-- reviewers (Rhea, Mara via app_config brief_reviewer_emails) manage the
-- partner list themselves. Leadership/superadmin still qualify. Mirrors the
-- config-driven is_setup_approver() pattern.

create or replace function app.is_brief_reviewer()
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  select app.is_leadership_or_admin()
      or exists (
        select 1
        from app.employees e
        where e.auth_user_id = auth.uid()
          and e.is_active
          and lower(e.email) in (
            select lower(jsonb_array_elements_text(
              coalesce(
                nullif((select value from app.app_config where key = 'brief_reviewer_emails'), 'null'::jsonb),
                '["rhea@youragency.com","mara@youragency.com"]'::jsonb
              )
            ))
          )
      );
$$;

grant execute on function app.is_brief_reviewer() to authenticated;

alter policy partners_insert_leadership on app.partners with check (app.is_brief_reviewer());
alter policy partners_update_leadership on app.partners using (app.is_brief_reviewer());
-- Delete stays leadership-only (deactivate is the normal path).
