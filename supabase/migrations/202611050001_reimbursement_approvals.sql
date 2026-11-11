-- Reimbursement approvals (5 Nov 2026). Monthly invoices stay as they
-- are. A reimbursement now needs the person's manager to approve it:
--   * on upload it is 'pending' and shows in the manager's Colony (no email);
--   * the manager approves it, or sends it back with a note;
--   * on the last day of the month daily-reminders emails every manager who
--     still has some waiting;
--   * Finance sees Approved / Waiting / Sent back on each one.
-- Who approves: the person's direct manager (direct_manager_email, active).
-- With no manager, an inactive one, or themselves as manager: Alex. Alex's
-- own reimbursements have nobody above her, so they are approved on upload.
-- The approver is fixed when the file goes up, so a later manager change
-- doesn't move what is already waiting.
-- Reimbursements uploaded before today count as approved (Alex's ruling).

-- The month-end email logs under its own kind.
alter type app.notification_kind add value if not exists 'reimbursement_month_end';

alter table app.invoices
  add column if not exists approval_status text
    check (approval_status is null or approval_status in ('pending', 'approved', 'sent_back')),
  add column if not exists approver_id uuid references app.employees(id) on delete set null,
  add column if not exists decided_by uuid references app.employees(id) on delete set null,
  add column if not exists decided_at timestamptz,
  add column if not exists decision_note text check (decision_note is null or length(decision_note) <= 300);
create index if not exists invoices_approver_pending_idx on app.invoices(approver_id) where approval_status = 'pending';

-- Grants here are per column. The browser may read the new columns but never
-- write them: INSERT stays limited to the upload columns, and nothing in
-- Colony updates an invoice row from the browser (there is no update policy),
-- so the leftover column UPDATE grant goes. Decisions go through
-- decide_reimbursement below only.
grant select (approval_status, approver_id, decided_by, decided_at, decision_note) on app.invoices to authenticated;
revoke update on app.invoices from authenticated, anon;

create or replace function app_private.reimbursement_approver(p_employee_id uuid)
 returns uuid
 language sql
 stable security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
  select coalesce(
    (select m.id
       from app.employees e
       join app.employees m on lower(m.email) = lower(e.direct_manager_email)
      where e.id = p_employee_id and m.is_active and m.id <> e.id
      limit 1),
    (select id from app.employees where lower(email) = 'admin@youragency.com' limit 1)
  );
$function$;
revoke all on function app_private.reimbursement_approver(uuid) from public, anon, authenticated;

-- Stamps every new row: whatever the browser sends for these columns is
-- overwritten, so nobody can upload a reimbursement as already approved.
create or replace function app_private.stamp_reimbursement_approval()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
begin
  new.decided_by := null;
  new.decided_at := null;
  new.decision_note := null;
  if new.invoice_type = 'reimbursement' then
    new.approver_id := app_private.reimbursement_approver(new.employee_id);
    if new.approver_id = new.employee_id then
      new.approval_status := 'approved';
      new.decided_by := new.employee_id;
      new.decided_at := now();
    else
      new.approval_status := 'pending';
    end if;
  else
    new.approver_id := null;
    new.approval_status := null;
  end if;
  return new;
end;
$function$;
revoke all on function app_private.stamp_reimbursement_approval() from public, anon, authenticated;

drop trigger if exists trg_invoices_stamp_approval on app.invoices;
create trigger trg_invoices_stamp_approval
  before insert on app.invoices
  for each row execute function app_private.stamp_reimbursement_approval();

-- Everything already uploaded counts as approved (decided_at stays null:
-- nobody decided it, it predates approvals).
update app.invoices
   set approval_status = 'approved',
       approver_id = app_private.reimbursement_approver(employee_id)
 where invoice_type = 'reimbursement' and approval_status is null;

-- The approver can read the reimbursements assigned to them, and the files.
drop policy if exists invoices_select_approver on app.invoices;
create policy invoices_select_approver on app.invoices
  for select to authenticated
  using (invoice_type = 'reimbursement' and approver_id = (select app.current_employee_id()));

drop policy if exists storage_invoices_select_approver on storage.objects;
create policy storage_invoices_select_approver on storage.objects
  for select to authenticated
  using (bucket_id = 'invoices' and exists (
    select 1 from app.invoices i
     where i.file_path = storage.objects.name
       and i.invoice_type = 'reimbursement'
       and i.approver_id = (select app.current_employee_id())));

-- Approve, or send back with a note. Only the assigned approver, only while
-- it is waiting.
create or replace function app.decide_reimbursement(p_id uuid, p_approve boolean, p_note text default null)
 returns text
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
declare
  v_me uuid := app.current_employee_id();
  v_row app.invoices%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_me is null then raise exception 'Sign in first.'; end if;
  select * into v_row from app.invoices where id = p_id for update;
  if not found or v_row.invoice_type <> 'reimbursement' then raise exception 'Reimbursement not found.'; end if;
  if v_row.approver_id is distinct from v_me then raise exception 'Only % can decide this one.', coalesce((select full_name from app.employees where id = v_row.approver_id), 'their manager'); end if;
  if v_row.approval_status <> 'pending' then raise exception 'This one has already been decided.'; end if;
  if not p_approve and v_note is null then raise exception 'Add a note saying what to fix.'; end if;
  if length(v_note) > 300 then raise exception 'Keep the note under 300 characters.'; end if;
  update app.invoices
     set approval_status = case when p_approve then 'approved' else 'sent_back' end,
         decided_by = v_me, decided_at = now(), decision_note = v_note
   where id = p_id;
  return case when p_approve then 'approved' else 'sent_back' end;
end;
$function$;
revoke all on function app.decide_reimbursement(uuid, boolean, text) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.decide_reimbursement(uuid,boolean,text)'::regprocedure),
        'Profile "Reimbursements waiting for you": the assigned approver approves or sends back a pending reimbursement')
on conflict do nothing;
grant execute on function app.decide_reimbursement(uuid, boolean, text) to authenticated;
