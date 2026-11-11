-- 22 Oct 2026 (Alex; _youragency_ops/Agreements/Colony-NDA-brief.md). NDAs in
-- Colony: the "NDAs" button on Clients opens the NDA list. Someone starts an
-- NDA with who it's with and what it's for; either the other side fills in
-- their company details through a one-time link, or we do. Colony then makes
-- the Papersign draft from the mutual NDA template, the person who started it
-- presses Send, Alex signs first, the other side signs, and the signed PDF is
-- filed in Legal > Signed NDAs.
--
-- Who: app_config.nda_crew_emails (all account managers, Nadia, Sam, Maya,
-- Alex). Nobody else sees a row. Every write goes through the nda-action and
-- nda-intake functions (service role), which check the caller or the link;
-- signed-in users only read.
--
-- The link: a random 32-byte token; only its SHA-256 lives here. It works
-- once, for 7 days, and only for its own NDA.

insert into app.app_config(key, value) values
  ('nda_crew_emails', '["ops-lead@youragency.com","carmen@youragency.com","mara@youragency.com","rhea@youragency.com","ruby@youragency.com","am-lead@youragency.com","strategy-lead@youragency.com","maya@youragency.com","admin@youragency.com"]'::jsonb),
  -- Template, folder and filing, by id (never path: see papersign-draft.js).
  ('nda_papersign', '{"template_id":"6abe3f1de5d6278857021ea6","folder_id":10001129096,"drive_folder_id":"1OJmkFb446LQBh99m7fPkyoFKCxVhaP-W"}'::jsonb),
  -- Real sends wait for Leo's OK on the template wording (22 Oct 2026).
  -- Until this is true, only TEST NDAs (both signers Alex) can be sent.
  ('nda_live', 'false'::jsonb)
on conflict (key) do nothing;

create or replace function app.is_nda_crew()
 returns boolean
 language sql
 stable security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
  select exists (
    select 1 from app.employees e
    where e.auth_user_id = auth.uid()
      and e.is_active and e.access_paused_at is null
      and lower(e.email) in (
        select lower(jsonb_array_elements_text(coalesce(
          (select value from app.app_config where key = 'nda_crew_emails'), '[]'::jsonb)))));
$function$;
revoke all on function app.is_nda_crew() from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.is_nda_crew()'::regprocedure),
        'ndas RLS, the NDAs button on Clients and the nda-action function: is the caller on nda_crew_emails (active, unpaused)')
on conflict do nothing;
grant execute on function app.is_nda_crew() to authenticated;

create table if not exists app.ndas (
  id uuid primary key default gen_random_uuid(),
  with_name text not null check (length(with_name) between 1 and 120),
  purpose text not null check (length(purpose) between 1 and 300),
  effective_date date not null default (now() at time zone 'Asia/Kolkata')::date,
  client_id uuid references app.clients(id) on delete set null,
  status text not null default 'awaiting_details'
    check (status in ('awaiting_details', 'ready', 'sent', 'signed', 'cancelled')),
  -- Their side, from the link or typed by us.
  party_name text check (party_name is null or length(party_name) <= 160),
  party_type text,
  party_address text check (party_address is null or length(party_address) <= 300),
  signatory_name text check (signatory_name is null or length(signatory_name) <= 120),
  signatory_title text check (signatory_title is null or length(signatory_title) <= 120),
  signatory_email text check (signatory_email is null or length(signatory_email) <= 200),
  details_by text check (details_by in ('them', 'us')),
  details_at timestamptz,
  -- The one-time link.
  intake_token_hash text unique,
  intake_expires_at timestamptz,
  -- Papersign and filing.
  papersign_document_id text unique,
  draft_error text,
  sent_at timestamptz,
  sent_by uuid references app.employees(id) on delete set null,
  signed_at timestamptz,
  signed_file_path text,
  drive_file_id text,
  drive_link text,
  created_by uuid references app.employees(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ndas_created_idx on app.ndas(created_at desc);

alter table app.ndas enable row level security;
drop policy if exists ndas_select on app.ndas;
create policy ndas_select on app.ndas for select using (app.is_nda_crew());
-- No insert/update/delete policies: writes go through the functions only.
-- New app tables get every privilege by default; take them all back first.
revoke all on app.ndas from anon, authenticated;
-- Per column, so the token hash never leaves the server (a table-wide grant
-- would include it; select('*') on ndas fails by design).
grant select (id, with_name, purpose, effective_date, client_id, status,
  party_name, party_type, party_address, signatory_name, signatory_title, signatory_email,
  details_by, details_at, intake_expires_at, papersign_document_id, draft_error,
  sent_at, sent_by, signed_at, signed_file_path, drive_file_id, drive_link,
  created_by, created_at, updated_at) on app.ndas to authenticated;

-- Signed PDFs: private bucket, crew may read.
insert into storage.buckets (id, name, public) values ('ndas', 'ndas', false)
on conflict (id) do nothing;
drop policy if exists ndas_storage_select on storage.objects;
create policy ndas_storage_select on storage.objects for select
  using (bucket_id = 'ndas' and app.is_nda_crew());
