-- Deal Flow: gate READS, which were never gated.
--
-- app.deals has been `FOR SELECT USING (true)` since the module shipped
-- (f0dfc9f, 20 Mar 2026 — commit titled "soft launch, superadmin-only"). The
-- restriction was only ever enforced in the UI: isDealFlowViewer() hides the
-- nav item and screen. Every INSERT/UPDATE/DELETE policy correctly calls
-- app.is_deal_flow_viewer() or app.is_leadership_or_admin(); not one SELECT
-- policy did. So any authenticated employee could read the entire pipeline
-- through the API — 133 deals, with company names, stages, amounts, notes,
-- next steps and deadlines.
--
-- (The Apr 2026 audit, 64af622, touched these policies to add TO authenticated;
-- before that they defaulted to PUBLIC, so `anon` — whose key ships in the
-- client bundle — could read deals without logging in. That fixed the role but
-- left the predicate as `true`.)
--
-- Gating on is_deal_flow_viewer() rather than hardcoding leadership: it already
-- means "leadership/admin OR on the deal_flow_extra_emails list", it is what
-- every write policy on this table uses, and it keeps the DB honest with the
-- Admin Settings control instead of having two rules that can drift. With that
-- list currently empty, this is leadership-only — what Alex asked for.

drop policy if exists deals_select on app.deals;
create policy deals_select on app.deals
  for select to authenticated
  using (app.is_deal_flow_viewer());

-- Stage history leaks the same information a row at a time (which deal moved to
-- which stage, when). Its writes are already gated; its reads were not.
drop policy if exists stage_history_select on app.deal_stage_history;
create policy stage_history_select on app.deal_stage_history
  for select to authenticated
  using (app.is_deal_flow_viewer());
