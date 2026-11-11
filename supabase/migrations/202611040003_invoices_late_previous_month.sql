-- Late invoices file under the month they are for (4 Nov 2026).
-- People are paid on the 1st and 5th for the month just gone, so an invoice
-- uploaded in the first 7 days of a month (IST) is for the previous month.
-- Ruby's 3 Nov re-upload of her October invoice was refused by the 3 Nov pin
-- (202611030001), and the page would otherwise file it under November.
--
-- Only invoices: a reimbursement in the first week is for this month's spend
-- and keeps the current month. Anything older stays refused, as before.

drop policy if exists invoices_insert_own on app.invoices;
create policy invoices_insert_own on app.invoices for insert to public with check (
  employee_id = app.current_employee_id()
  and split_part(file_path, '/', 1) = (app.current_employee_id())::text
  and (
    invoice_month in (
      to_char(now() - interval '12 hours', 'YYYY-MM'),
      to_char(now() + interval '14 hours', 'YYYY-MM')
    )
    or (
      invoice_type = 'invoice'
      and extract(day from (now() at time zone 'Asia/Kolkata')) <= 7
      and invoice_month = to_char((now() at time zone 'Asia/Kolkata') - interval '1 month', 'YYYY-MM')
    )
  )
);
