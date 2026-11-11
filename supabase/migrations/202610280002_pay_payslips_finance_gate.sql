-- Pay: salary slips, a second lock on Finance, and no deleting a past month's
-- upload (28 Oct 2026, Alex's brief on Blake's request).
--
-- 1. Salary slips. Finance uploads one slip per full-time person per month;
--    each person can read only their own. Files live in the private bucket
--    `payslips` under <employee_id>/; downloads are 60-second signed links.
-- 2. Finance's second lock (replaces the Invoice Center PIN, whose check sat in
--    the page code). Being on the finance list (app.is_invoice_viewer, the
--    hard-coded three) is no longer enough to read anyone else's pay: the
--    browser session must also have entered a 6-digit code emailed to that
--    person within 24 hours. app.finance_gate is written only by the
--    finance-gate function (service role); app.finance_unlocked() checks it
--    against the caller's own session_id from their JWT, so a code entered on
--    one device never opens another.
-- 3. Deleting: a person can delete their own invoice or reimbursement only in
--    the calendar month (IST) they uploaded it. After that, Finance deletes.

-- ── 2. The second lock ──────────────────────────────────────────────────────
create table if not exists app.finance_gate (
  employee_id uuid not null references app.employees(id) on delete cascade,
  session_id uuid not null,
  code_hash text,
  code_expires_at timestamptz,
  attempts int not null default 0,
  sends int not null default 0,
  window_started_at timestamptz not null default now(),
  verified_at timestamptz,
  primary key (employee_id, session_id)
);
alter table app.finance_gate enable row level security;
revoke all on app.finance_gate from public, anon, authenticated;
-- No policies: only the service role (the finance-gate function) touches it.

create or replace function app.finance_unlocked()
 returns boolean
 language sql
 stable security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
  select app.is_invoice_viewer() and exists (
    select 1 from app.finance_gate g
    where g.employee_id = app.current_employee_id()
      and g.session_id::text = coalesce(auth.jwt() ->> 'session_id', '')
      and g.verified_at > now() - interval '24 hours'
  );
$function$;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.finance_unlocked()'::regprocedure),
        'invoices/payslips RLS + storage policies and the Invoices screen: on the finance list AND this session entered the emailed code in the last 24h')
on conflict do nothing;
revoke all on function app.finance_unlocked() from public, anon;
grant execute on function app.finance_unlocked() to authenticated;

-- ── 1. Salary slips ─────────────────────────────────────────────────────────
create table if not exists app.payslips (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references app.employees(id),
  pay_month text not null check (pay_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  file_path text not null,
  file_name text not null,
  file_size_bytes bigint,
  uploaded_by uuid references app.employees(id),
  uploaded_at timestamptz not null default now(),
  emailed_at timestamptz,
  unique (employee_id, pay_month)
);
alter table app.payslips enable row level security;
revoke all on app.payslips from public, anon, authenticated;
grant select on app.payslips to authenticated;
grant insert (employee_id, pay_month, file_path, file_name, file_size_bytes, uploaded_by) on app.payslips to authenticated;
grant update (file_path, file_name, file_size_bytes, uploaded_by, uploaded_at) on app.payslips to authenticated;
grant delete on app.payslips to authenticated;

create policy payslips_select_own_or_finance on app.payslips for select to authenticated
  using (employee_id = app.current_employee_id() or app.finance_unlocked());
create policy payslips_insert_finance on app.payslips for insert to authenticated
  with check (app.finance_unlocked() and split_part(file_path, '/', 1) = employee_id::text);
create policy payslips_update_finance on app.payslips for update to authenticated
  using (app.finance_unlocked())
  with check (app.finance_unlocked() and split_part(file_path, '/', 1) = employee_id::text);
create policy payslips_delete_finance on app.payslips for delete to authenticated
  using (app.finance_unlocked());

insert into storage.buckets (id, name, public) values ('payslips', 'payslips', false)
on conflict (id) do nothing;

create policy storage_payslips_select on storage.objects for select to authenticated
  using (bucket_id = 'payslips' and (
    (storage.foldername(name))[1] = (select e.id::text from app.employees e where e.auth_user_id = auth.uid())
    or app.finance_unlocked()));
create policy storage_payslips_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'payslips' and app.finance_unlocked());
create policy storage_payslips_update on storage.objects for update to authenticated
  using (bucket_id = 'payslips' and app.finance_unlocked())
  with check (bucket_id = 'payslips' and app.finance_unlocked());
create policy storage_payslips_delete on storage.objects for delete to authenticated
  using (bucket_id = 'payslips' and app.finance_unlocked());

-- ── Finance reads everyone's invoices only behind the second lock ───────────
alter policy invoices_select_viewer on app.invoices using (app.finance_unlocked());
alter policy storage_invoices_select_viewer on storage.objects
  using (bucket_id = 'invoices' and app.finance_unlocked());

-- ── 3. Deleting: own uploads in their own month; Finance any time ───────────
alter policy invoices_delete_own on app.invoices
  using (employee_id = app.current_employee_id()
         and date_trunc('month', uploaded_at at time zone 'Asia/Kolkata')
           = date_trunc('month', now() at time zone 'Asia/Kolkata'));
alter policy storage_invoices_delete_own on storage.objects
  using (bucket_id = 'invoices'
         and (storage.foldername(name))[1] = (select e.id::text from app.employees e where e.auth_user_id = auth.uid())
         and date_trunc('month', created_at at time zone 'Asia/Kolkata')
           = date_trunc('month', now() at time zone 'Asia/Kolkata'));
drop policy if exists invoices_delete_finance on app.invoices;
create policy invoices_delete_finance on app.invoices for delete to authenticated
  using (app.finance_unlocked());
drop policy if exists storage_invoices_delete_finance on storage.objects;
create policy storage_invoices_delete_finance on storage.objects for delete to authenticated
  using (bucket_id = 'invoices' and app.finance_unlocked());
