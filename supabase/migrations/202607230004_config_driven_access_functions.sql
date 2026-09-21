-- Make every DB access function read the store its Admin Settings panel edits.
--
-- Audit of the Admin Settings page (23 Jul 2026) found two more functions with
-- the is_deal_flow_viewer() disease — hardcoded people where a config read
-- belongs, so the panel that claims to manage access edits something the
-- database never consults:
--
--  1. app.is_invoice_viewer() was a hardcoded 3-email IN-list. The "Invoice
--     viewers" panel edited app_config.invoice_viewer_emails; RLS on invoices
--     read the hardcoded list. Add someone in the panel and they could open
--     the Invoice Center (client check) but see only their own invoices (RLS).
--  2. app.mapped_access_level_for_email() was a hardcoded CASE of 5 people.
--     The "Full Access Users" panel edits app.access_overrides (5 rows, kept
--     manually in sync with the CASE) — and NOTHING in the DB read that table.
--     The trigger that pins access_level on every employee write used the
--     frozen CASE, so promoting someone via the panel would be silently
--     overridden on their next profile save.
--
-- Rules used for both (matching the client accessors exactly, post the
-- config-fix of earlier today):
--   * a MISSING key/empty table falls back to the legacy in-code values
--   * an explicitly stored value — including an emptied list — IS the config
--   * app.superadmin_email() stays hardcoded on purpose: the root of trust
--     must not be editable data, or a compromised superadmin session could
--     mint a new superadmin.
--
-- Safe to trust the stores: app_config and access_overrides writes are both
-- gated by app.is_superadmin() (verified before this migration).

-- 1 ── invoice viewers: config-driven, mirroring client isInvoiceViewer()
--      (list-only; leadership is deliberately NOT implicit here — finance data
--      goes to the named people, matching the client rule).
create or replace function app.is_invoice_viewer()
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1
    from app.employees e
    where e.auth_user_id = auth.uid()
      and e.is_active
      and lower(e.email) in (
        select lower(jsonb_array_elements_text(
          coalesce(
            (select value from app.app_config where key = 'invoice_viewer_emails'),
            '["finance@youragency.com","am-lead@youragency.com","admin@youragency.com"]'::jsonb
          )
        ))
      )
  );
$$;

-- 2 ── enforced access pins: read the table the panel edits, with the legacy
--      CASE as the empty-table failsafe (mirrors client getEnforcedAccessMap,
--      which prefers state.accessOverrides when non-empty else the constant).
create or replace function app.mapped_access_level_for_email(input_email text)
returns app.access_level
language plpgsql
stable
security definer
set search_path to 'app', 'public'
as $$
declare
  v_role text;
begin
  if exists (select 1 from app.access_overrides) then
    select o.role into v_role
      from app.access_overrides o
     where lower(o.email) = lower(coalesce(input_email, ''));
    if v_role in ('admin', 'leadership', 'employee') then
      return v_role::app.access_level;
    end if;
    return null;
  end if;

  -- Failsafe only: table emptied/unreachable. Frozen on purpose.
  return case lower(coalesce(input_email, ''))
    when 'admin@youragency.com' then 'admin'::app.access_level
    when 'strategy-lead@youragency.com' then 'leadership'::app.access_level
    when 'creative-lead@youragency.com' then 'leadership'::app.access_level
    when 'am-lead@youragency.com' then 'leadership'::app.access_level
    when 'ops-lead@youragency.com' then 'leadership'::app.access_level
    else null
  end;
end;
$$;
