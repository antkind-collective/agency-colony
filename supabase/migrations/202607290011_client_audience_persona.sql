-- Audience Intelligence target personas move from admin JSON config to the
-- CLIENT, editable by the AM who leads that business (29 Jul 2026):
-- "the input should be from the AM who is the lead on the business, not admin."
-- Writes go through an RPC (account owner or leadership), not a blanket
-- clients UPDATE policy — the persona is the only client field an AM may edit.

alter table app.clients add column audience_persona jsonb;

create or replace function app.set_client_audience_persona(p_client_id uuid, p_persona jsonb)
returns void
language plpgsql
security definer
set search_path to 'app', 'public'
as $$
declare
  v_allowed boolean;
begin
  select app.is_leadership_or_admin()
         or exists (
           select 1 from app.clients c
           where c.id = p_client_id
             and c.account_owner_employee_id = app.current_employee_id()
         )
    into v_allowed;
  if not v_allowed then
    raise exception 'Only the client''s account owner or leadership can set its target audience.';
  end if;
  if p_persona is not null and jsonb_typeof(p_persona) <> 'object' then
    raise exception 'Persona must be a JSON object (or null to clear).';
  end if;

  update app.clients
     set audience_persona = p_persona,
         updated_at = now()
   where id = p_client_id;
end;
$$;

grant execute on function app.set_client_audience_persona(uuid, jsonb) to authenticated;

-- Migrate the one existing persona (Example Materials) from app_config into the client row.
update app.clients
   set audience_persona = (
     select value -> 'example materials'
     from app.app_config
     where key = 'analytics_personas_by_client'
   )
 where lower(name) = 'example materials'
   and exists (
     select 1 from app.app_config
     where key = 'analytics_personas_by_client'
       and value ? 'example materials'
   );
