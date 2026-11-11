-- Only leadership names a hire's hiring manager (14 Oct 2026). The
-- hiring manager can activate the hire (can_activate_hire), so a crew member
-- who is not leadership (finance@) could name themselves on any hire and switch
-- its access on. Crew keep editing every other term (CTC breakup, dates).
-- Opening a hire was already leadership / setup approvers only.
create or replace function app_private.guard_hiring_manager()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $$
begin
  if auth.uid() is null or app.is_leadership_or_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if coalesce(btrim(new.hiring_manager_email), '') <> '' then
      raise exception 'Only leadership can choose the hiring manager.';
    end if;
  elsif lower(coalesce(new.hiring_manager_email, '')) is distinct from lower(coalesce(old.hiring_manager_email, '')) then
    raise exception 'Only leadership can choose the hiring manager.';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_hiring_manager() from public, anon, authenticated;
drop trigger if exists trg_guard_hiring_manager on app.hire_offer_terms;
create trigger trg_guard_hiring_manager before insert or update on app.hire_offer_terms
  for each row execute function app_private.guard_hiring_manager();
