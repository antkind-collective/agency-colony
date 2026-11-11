-- 10 Nov 2026 (weekday audit, Tue access parity). UI gate = DB rule.
--
-- clients_insert_own_or_leadership let ANY employee insert a client as long
-- as they named themselves account owner. No screen does that:
--   * the client registry's "Add client" is superadmin-only (canAddClients,
--     js/access.js), and
--   * a Closed Won deal creates its client from Deal Flow
--     (createClientFromDeal), which only Deal Flow viewers reach
--     (leadership + deal_flow_extra_emails).
-- Dry run as maya@ (plain employee): inserting 'ZZ Audit Probe Client' with
-- herself as owner was ALLOWED. A client row is the key other rows match by
-- name (partners.org, briefs.org, can_see_org), appears in every pick-list,
-- makes its owner able to add projects, and is read by crons
-- (analytics-upload-reminder, client-status-notify).
--
-- Now: leadership/admin or Deal Flow viewers only, the same two paths the UI
-- has. UPDATE is unchanged (an account owner still archives/unarchives their
-- own client: canArchiveClient; the rename guard still applies). The service
-- role is untouched.

drop policy if exists clients_insert_own_or_leadership on app.clients;
create policy clients_insert_leadership_or_deal_flow on app.clients
  for insert to authenticated
  with check (app.is_leadership_or_admin() or app.is_deal_flow_viewer());
