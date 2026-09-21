-- Two access-posture decisions (23 Jul 2026), opposite directions on
-- purpose:
--
-- 1. INVOICE VIEWERS ARE HARDCODED — deliberately NOT config-driven.
--    This reverts this morning's config-driven rewrite, on Alex's explicit
--    call: invoices are compensation data, and "even by mistake that access
--    shouldn't open." A config key editable from a web panel is one mistyped
--    email or one compromised superadmin session away from exposing everyone's
--    invoices; a hardcoded list requires a code deploy, which is reviewed and
--    leaves a git trail. The Admin Settings editor for this list is removed in
--    the same commit — a panel must not offer to edit what it doesn't control.
--    Changing the viewers = edit THIS function + INVOICE_VIEWER_EMAILS in
--    js/config.js, deploy both.
--
-- 2. DEAL FLOW FAILS CLOSED — pure leadership.
--    Tara is out (the stored list is already []); the remaining hole was the
--    fallback: if the deal_flow_extra_emails KEY were ever deleted, the old
--    '["bd@youragency.com"]' default would silently re-grant her access. A
--    missing key now means "nobody extra". The config list itself stays, so
--    future extras remain a panel edit — but every failure mode lands on
--    leadership-only.

create or replace function app.is_invoice_viewer()
returns boolean
language sql
stable
security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1 from app.employees e
    where e.auth_user_id = auth.uid()
      and e.is_active
      and lower(e.email) in ('finance@youragency.com', 'am-lead@youragency.com', 'admin@youragency.com')
  );
$$;

-- Nothing reads this key any more; a stale row would only invite someone to
-- believe editing it does something.
delete from app.app_config where key = 'invoice_viewer_emails';

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
                '[]'::jsonb
              )
            ))
          )
      );
$$;
