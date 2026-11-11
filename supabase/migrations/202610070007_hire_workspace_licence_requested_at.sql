-- No free Google Workspace licence (7 Oct 2026). When Google refuses a
-- new account for want of a licence, Colony emails the reseller (Example Reseller) by
-- itself and retries the account every six hours until it goes through. This
-- is when it last asked, so it asks once rather than on every retry.
alter table app.hires
  add column if not exists workspace_licence_requested_at timestamptz;

comment on column app.hires.workspace_licence_requested_at is
  'When Colony last asked the Workspace reseller for a licence for this hire. Set by workspace-provision on a licence refusal; workspace-retry retries while this is set and work_email is empty.';
