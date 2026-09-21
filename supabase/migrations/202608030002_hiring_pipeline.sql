-- New-hire pipeline (approved by email thread 24 Jul 2026; built 3 Aug).
-- Nadia creates the hire → candidate (personal Gmail, invited sign-in) fills
-- details + salary slips → Leo uploads contract → Nadia reviews → Alex
-- signs → Blake runs payroll. PAN/bank data is SENSITIVE: readable only by
-- the hiring crew (setup approvers + hiring_crew_emails config: Leo, Blake)
-- and the candidate's own row — NOT employees at large, NOT leadership-wide.

create type app.hire_type as enum ('full-time', 'fractional', 'consultant');
create type app.hire_stage as enum (
  'invited', 'details_submitted', 'contract_uploaded',
  'reviewed', 'signed', 'payroll_done', 'cancelled'
);

create table app.hires (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  personal_email citext not null,
  start_date date,
  hire_type app.hire_type not null default 'full-time',
  stage app.hire_stage not null default 'invited',
  -- candidate-entered:
  date_of_birth date,
  pan text,
  address text,
  bank_account_name text,
  bank_account_number text,
  bank_ifsc text,
  salary_slips_note text,
  details_submitted_at timestamptz,
  auth_user_id uuid,
  created_by uuid references app.employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hire_email_not_youragency_ck check (personal_email::text not like '%@youragency.com')
);

create index idx_hires_stage on app.hires(stage);
create unique index idx_hires_email_live on app.hires(lower(personal_email::text))
  where stage not in ('payroll_done', 'cancelled');

create table app.hire_stage_history (
  id uuid primary key default gen_random_uuid(),
  hire_id uuid not null references app.hires(id) on delete cascade,
  stage text not null,
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  changed_by_employee_id uuid references app.employees(id)
);

alter table app.hires enable row level security;
alter table app.hire_stage_history enable row level security;

-- Identity ---------------------------------------------------------------

-- Hiring crew: setup approvers (Alex, Nadia + superadmin floor) plus the
-- config list (Leo = legal, Blake = finance). Leo has a @youragency.com
-- email but NO employees row — membership here is by JWT email, so he gets
-- exactly this section and nothing else.
create or replace function app.is_hiring_crew()
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select app.is_setup_approver()
      or lower(coalesce(app.current_request_email(), '')) in (
        select lower(jsonb_array_elements_text(
          coalesce(
            nullif((select value from app.app_config where key = 'hiring_crew_emails'), 'null'::jsonb),
            '["leo@youragency.com","finance@youragency.com"]'::jsonb
          )
        ))
      );
$$;

create or replace function app.current_hire_id()
returns uuid
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select h.id from app.hires h
  where h.auth_user_id = auth.uid()
    and h.stage not in ('cancelled')
  limit 1;
$$;

-- First-login binding for the candidate's personal Gmail (partner pattern).
create or replace function app.ensure_hire_profile()
returns app.hires
language plpgsql security definer
set search_path to 'app', 'public'
as $$
declare
  caller_email text;
  h app.hires%rowtype;
begin
  caller_email := lower(coalesce(
    current_setting('request.jwt.claims', true)::json->>'email',
    auth.email()
  ));
  if caller_email is null or caller_email = '' then
    return null;
  end if;

  select * into h from app.hires
  where auth_user_id = auth.uid() and stage not in ('cancelled');
  if found then return h; end if;

  select * into h from app.hires
  where auth_user_id is null
    and lower(personal_email::text) = caller_email
    and stage not in ('payroll_done', 'cancelled');
  if found then
    update app.hires set auth_user_id = auth.uid(), updated_at = now()
    where id = h.id
    returning * into h;
    return h;
  end if;

  return null;
end;
$$;

-- Candidate submits/updates their details. Only while it's still their turn.
create or replace function app.submit_hire_details(
  p_full_name text,
  p_date_of_birth date,
  p_pan text,
  p_address text,
  p_bank_account_name text,
  p_bank_account_number text,
  p_bank_ifsc text,
  p_salary_slips_note text
)
returns void
language plpgsql security definer
set search_path to 'app', 'public'
as $$
declare
  v_hire_id uuid;
  v_stage app.hire_stage;
  v_name text;
begin
  select id, stage into v_hire_id, v_stage
    from app.hires where auth_user_id = auth.uid() and stage not in ('cancelled')
    limit 1;
  if v_hire_id is null then
    raise exception 'No active hire record for this account.';
  end if;
  if v_stage not in ('invited', 'details_submitted') then
    raise exception 'Your details are locked — the team has taken over from here.';
  end if;
  v_name := btrim(coalesce(p_full_name, ''));
  if array_length(regexp_split_to_array(v_name, '\s+'), 1) < 2 then
    raise exception 'Please enter your full name — first and last.';
  end if;

  update app.hires
     set full_name = v_name,
         date_of_birth = p_date_of_birth,
         pan = upper(btrim(coalesce(p_pan, ''))),
         address = p_address,
         bank_account_name = p_bank_account_name,
         bank_account_number = p_bank_account_number,
         bank_ifsc = upper(btrim(coalesce(p_bank_ifsc, ''))),
         salary_slips_note = p_salary_slips_note,
         details_submitted_at = now(),
         stage = 'details_submitted',
         updated_at = now()
   where id = v_hire_id;
end;
$$;

grant execute on function app.is_hiring_crew() to authenticated;
grant execute on function app.current_hire_id() to authenticated;
grant execute on function app.ensure_hire_profile() to authenticated;
grant execute on function app.submit_hire_details(text, date, text, text, text, text, text, text) to authenticated;

-- Stage history via definer trigger (candidate transitions log too).
create or replace function app.log_hire_stage()
returns trigger
language plpgsql security definer
set search_path to 'app', 'public'
as $$
begin
  if tg_op = 'INSERT' then
    insert into app.hire_stage_history (hire_id, stage, changed_by_employee_id)
    values (new.id, new.stage::text, app.current_employee_id());
  elsif new.stage is distinct from old.stage then
    update app.hire_stage_history set exited_at = now()
      where hire_id = new.id and exited_at is null;
    insert into app.hire_stage_history (hire_id, stage, changed_by_employee_id)
    values (new.id, new.stage::text, app.current_employee_id());
  end if;
  return new;
end;
$$;

create trigger trg_hires_stage_history
  after insert or update on app.hires
  for each row execute function app.log_hire_stage();

create or replace function app.touch_hire_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger trg_hires_updated_at
  before update on app.hires
  for each row execute function app.touch_hire_updated_at();

-- RLS ---------------------------------------------------------------------

create policy hires_select_crew on app.hires for select
  using (app.is_hiring_crew() or auth_user_id = auth.uid());
create policy hires_insert_approver on app.hires for insert
  with check (app.is_setup_approver() and created_by = app.current_employee_id());
create policy hires_update_crew on app.hires for update
  using (app.is_hiring_crew());
create policy hires_delete_approver on app.hires for delete
  using (app.is_setup_approver());
-- Candidates have NO direct write policy — their only write path is
-- submit_hire_details(), which validates stage and fields.

create policy hire_stage_history_select on app.hire_stage_history for select
  using (app.is_hiring_crew() or exists (
    select 1 from app.hires h where h.id = hire_id and h.auth_user_id = auth.uid()
  ));

-- Leo must never be auto-provisioned as an employee. Backstop in the
-- employee bootstrap (client routing also diverts him before it runs).
create or replace function app.is_hiring_only_email(p_email text)
returns boolean
language sql stable security definer
set search_path to 'app', 'public'
as $$
  select lower(coalesce(p_email, '')) in (
    select lower(jsonb_array_elements_text(
      coalesce(
        nullif((select value from app.app_config where key = 'hiring_only_emails'), 'null'::jsonb),
        '["leo@youragency.com"]'::jsonb
      )
    ))
  );
$$;
grant execute on function app.is_hiring_only_email(text) to authenticated;

-- Storage: hires bucket. Crew everything; candidate only their slips folder.
-- Folders: <hire_id>/slips/... (candidate uploads)
--          <hire_id>/contract/... (draft + signed, crew only)
insert into storage.buckets (id, name, public)
values ('hires', 'hires', false)
on conflict (id) do nothing;

create or replace function app.candidate_owns_hire_path(p_folder text)
returns boolean
language plpgsql stable security definer
set search_path to 'app', 'public'
as $$
begin
  if p_folder is null or p_folder !~ '^[0-9a-fA-F-]{36}$' then
    return false;
  end if;
  return exists (
    select 1 from app.hires h
    where h.id = p_folder::uuid and h.auth_user_id = auth.uid()
  );
end;
$$;
grant execute on function app.candidate_owns_hire_path(text) to authenticated;

create policy hires_storage_select on storage.objects for select using (
  bucket_id = 'hires' and (
    app.is_hiring_crew()
    or (
      app.candidate_owns_hire_path((storage.foldername(name))[1])
      and (storage.foldername(name))[2] = 'slips'
    )
  )
);
create policy hires_storage_insert on storage.objects for insert with check (
  bucket_id = 'hires' and (
    app.is_hiring_crew()
    or (
      app.candidate_owns_hire_path((storage.foldername(name))[1])
      and (storage.foldername(name))[2] = 'slips'
    )
  )
);
create policy hires_storage_delete on storage.objects for delete using (
  bucket_id = 'hires' and app.is_hiring_crew()
);

-- New notification kind for the pipeline's emails.
alter type app.notification_kind add value if not exists 'hire_notify';
