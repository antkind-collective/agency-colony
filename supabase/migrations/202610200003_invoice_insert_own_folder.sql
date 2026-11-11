-- Audit 20 Oct 2026 (Tue, self-write sweep): invoices_insert_own pinned the
-- row's employee_id but not its file_path. Storage reads are folder-scoped
-- (storage_invoices_select_own), so a forged path read nothing. But an
-- employee could file an invoice row pointing at a colleague's PDF, and
-- invoice viewers would then download that colleague's invoice as theirs.
-- The app always uploads to '<employee_id>/…' (all 141 rows do). The insert
-- now requires the row's file to sit in the caller's own folder.
alter policy invoices_insert_own on app.invoices
  with check (
    employee_id = app.current_employee_id()
    and split_part(file_path, '/', 1) = (app.current_employee_id())::text
  );
