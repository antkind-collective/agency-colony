-- 29 Oct 2026 (weekday audit): an employee could set their own invoice's
-- uploaded_at on insert (authenticated held table-wide INSERT). The UI never
-- sends it, but by API it could be backdated (Finance's Invoices screen shows
-- it as the upload day) or forward-dated into a later month, which the
-- 28 Oct "delete only in the IST month you uploaded it" rule
-- (invoices_delete_own) reads, so the row could be deleted after its month.
-- Now authenticated may insert only the columns the upload sends; id and
-- uploaded_at take their defaults. The service role is unaffected. No UPDATE
-- policy exists on app.invoices, so updates already match no rows.

revoke insert on app.invoices from authenticated;
grant insert (employee_id, invoice_month, invoice_type, file_name, file_path, file_size_bytes, notes)
  on app.invoices to authenticated;
