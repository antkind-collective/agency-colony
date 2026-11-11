-- Audit 3 Nov 2026 (Tue, access parity, self-write sweep): an employee could
-- file their own invoice or reimbursement under ANY month. invoices_insert_own
-- checked whose row it was and whose folder the file sat in, not which month.
-- The UI only ever sends the current month (currentInvoiceMonth(), app.js),
-- but a direct API insert as maya@ for '2026-07' was ALLOWED. Finance works
-- one month at a time, so a backdated claim lands in a month already settled,
-- and a future-dated one escapes the own-month delete rule's intent.
--
-- The month must now be the caller's current month. The browser picks it from
-- its local clock, so any month a timezone from UTC-12 to UTC+14 is in right
-- now is accepted: in practice, exactly the current month, plus the next or
-- previous one only in the hours around midnight on the 1st.
-- Every existing row has invoice_month = its upload month (checked 3 Nov).

drop policy if exists invoices_insert_own on app.invoices;
create policy invoices_insert_own on app.invoices for insert to public with check (
  employee_id = app.current_employee_id()
  and split_part(file_path, '/', 1) = (app.current_employee_id())::text
  and invoice_month in (
    to_char(now() - interval '12 hours', 'YYYY-MM'),
    to_char(now() + interval '14 hours', 'YYYY-MM')
  )
);
