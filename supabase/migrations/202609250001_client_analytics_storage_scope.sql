-- Weekday audit, 25 Sep 2026 (Friday, storage buckets).
--
-- The client-analytics bucket was gated on app.is_employee() alone, while the
-- app.client_analytics table is gated on app.can_see_client(client_id) (and
-- writes also on app.is_analytics_uploader()). So a client-scoped fractional
-- employee who reads 0 analytics rows could still list and download every
-- client's raw export: asha@ (scoped to 1 client) read all 140 objects across
-- 6 client folders. Any employee could also upload into or delete from any
-- client's folder.
--
-- Objects are stored at '<client id>/<timestamp>_<file name>' (app.js upload
-- paths); all 6 live folders are client ids. The bucket now follows the table:
-- read = can_see_client(folder), write/delete = uploader + can_see_client.
-- CASE guards the uuid cast so a malformed path is refused, never an error.

drop policy if exists analytics_storage_select on storage.objects;
drop policy if exists analytics_storage_insert on storage.objects;
drop policy if exists analytics_storage_delete on storage.objects;

create policy analytics_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'client-analytics'
    and case when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
             then app.can_see_client(((storage.foldername(name))[1])::uuid)
             else false end
  );

create policy analytics_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'client-analytics'
    and app.is_analytics_uploader()
    and case when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
             then app.can_see_client(((storage.foldername(name))[1])::uuid)
             else false end
  );

create policy analytics_storage_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'client-analytics'
    and app.is_analytics_uploader()
    and case when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
             then app.can_see_client(((storage.foldername(name))[1])::uuid)
             else false end
  );
