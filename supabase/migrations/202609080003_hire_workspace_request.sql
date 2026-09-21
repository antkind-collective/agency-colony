-- The missing link between "payroll done" and the person appearing in Colony
-- (8 Sep 2026).
--
-- Nothing turns a hire into an employee: an employee row is only created when
-- the person first signs in with their @youragency.com address, which cannot happen
-- until someone asks the Workspace reseller (Example Reseller) to create that account.
-- That request lived entirely in one person's inbox, so a hire sat reading
-- "Hiring complete" while the actual next step had not been taken and nothing
-- anywhere said so. Maya and Asha were both in exactly that state.
--
-- Stamped when the request goes out, so the panel can tell three states apart:
-- account not asked for yet / asked and waiting for them to sign in / joined.
--
-- The credentials themselves are deliberately NOT modelled. Example Reseller replies
-- with a plaintext password and a human forwards it; Colony must never hold,
-- relay or store that.

alter table app.hires
  add column if not exists workspace_requested_at timestamptz;

comment on column app.hires.workspace_requested_at is
  'When the @youragency.com account was requested from the Workspace reseller. Colony never stores the credentials that come back — a human forwards those.';
