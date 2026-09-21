-- app.is_deal_flow_viewer() was a hardcoded name check.
--
-- It read, in full:
--     SELECT lower(e.email) = 'bd@youragency.com' ...
--
-- Two things wrong with that:
--  1. It ignored app_config.deal_flow_extra_emails entirely, so the Admin
--     Settings control that claims to manage Deal Flow access did nothing at
--     the DB level. Removing Tara there left her DB write access intact
--     (deals_insert_dealflow / _update_ / _delete_ all call this function).
--  2. It excluded leadership. That stayed invisible because every write policy
--     ORs it with a separate app.is_leadership_or_admin() policy — so the
--     function being wrong never showed up until 202607230002 used it alone to
--     gate SELECT, at which point leadership could read zero deals and Tara
--     could read all 133.
--
-- Same class of bug as the client-side canAddClients() first-name check fixed
-- in Jul 2026: a hardcoded person instead of a role. A namesake or a rename
-- silently changes who has access.
--
-- Now mirrors the client-side isDealFlowViewer() exactly: leadership/admin, or
-- on the configured list. An explicitly empty list means nobody (matching the
-- config-accessor fix in js/access.js); only a MISSING key falls back to the
-- in-code default, so the two layers can no longer disagree.

create or replace function app.is_deal_flow_viewer()
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
        where e.id = app.current_employee_id()
          and lower(e.email) in (
            select lower(jsonb_array_elements_text(
              coalesce(
                (select value from app.app_config where key = 'deal_flow_extra_emails'),
                '["bd@youragency.com"]'::jsonb
              )
            ))
          )
      );
$$;
