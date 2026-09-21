-- Contracts through Papersign (11 Sep 2026).
-- Colony copies a template into a filled draft (Leo reviews it there), sends
-- it on approval, and files the signed PDF when Papersign says it is complete.
alter table app.hire_offer_terms
  add column if not exists papersign_draft_id text,
  add column if not exists papersign_sent_at timestamptz,
  add column if not exists papersign_completed_at timestamptz;
comment on column app.hire_offer_terms.papersign_draft_id is 'The Papersign document Colony created from the template for this hire. Draft until sent; completed when both have signed.';
-- Which Papersign template serves which hire type, and the signer keys those
-- templates define. Set once templates exist:
--   {"full-time":  {"document_id":"…","signer_hire_key":"hire","signer_agency_key":"youragency"},
--    "consultant": {...}, "fractional": {...}}
insert into app.app_config (key, value) values ('papersign_templates', '{}'::jsonb) on conflict (key) do nothing;
