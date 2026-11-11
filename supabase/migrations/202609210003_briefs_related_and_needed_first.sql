-- Circle brief form, simplified (B3; Alex's plan, Mara's go, 21 Sep 2026):
--   * parent_brief_id: "Request something related" links a follow-up to the
--     brief it came from, instead of starting from scratch (Mira's request).
--   * priority_deliverables: the formats ticked "Needed first" when one brief
--     is wanted in phases (Mira, via Mara).
--
-- Access: both are columns on app.briefs, so the existing RLS policies and
-- partner guard triggers cover them; grants there are table-level and
-- unchanged. The one new risk is a link ACROSS clients: a partner could set
-- parent_brief_id to another org's brief id. The trigger below refuses any
-- parent outside the brief's own org, for everyone, and it runs as the
-- caller, so a parent the caller cannot see counts as missing.

alter table app.briefs
  add column if not exists parent_brief_id uuid references app.briefs(id) on delete set null,
  add column if not exists priority_deliverables text[] not null default '{}';

create index if not exists briefs_parent_idx on app.briefs (parent_brief_id) where parent_brief_id is not null;

-- Needed-first formats must be ones the brief actually asks for.
alter table app.briefs drop constraint if exists briefs_priority_within_requested;
alter table app.briefs add constraint briefs_priority_within_requested
  check (priority_deliverables <@ coalesce(requested_deliverables, '{}'));

-- Internal trigger helper: lives in app_private (no USAGE for signed-in
-- roles; a trigger fires without it). SECURITY INVOKER on purpose.
create or replace function app_private.briefs_parent_same_org()
returns trigger
language plpgsql
security invoker
set search_path = app, public
as $$
declare
  v_parent_org text;
begin
  if new.parent_brief_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.parent_brief_id is not distinct from old.parent_brief_id then
    return new;
  end if;
  if new.parent_brief_id = new.id then
    raise exception 'A brief cannot be related to itself.';
  end if;
  select org::text into v_parent_org from app.briefs where id = new.parent_brief_id;
  if v_parent_org is null or v_parent_org is distinct from new.org::text then
    raise exception 'That related brief was not found.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.briefs_parent_same_org() from public;

-- Named to fire AFTER trg_briefs_partner_org (triggers run in name order), so
-- the org it compares against is the one the server forced, not the client's.
drop trigger if exists trg_briefs_zz_parent_same_org on app.briefs;
create trigger trg_briefs_zz_parent_same_org
  before insert or update of parent_brief_id on app.briefs
  for each row execute function app_private.briefs_parent_same_org();
