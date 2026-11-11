-- 26 Oct 2026 (Alex, on audit item S20): "remove all fractional employees
-- from NDA access". Fractionals see only their own clients everywhere else in
-- Colony; NDAs are not split by client, so fractionals get none. Mara and
-- Ruby leave the list, and is_nda_crew itself refuses anyone fractional, so a
-- fractional added to the list later still gets nothing. Redefined from the
-- LIVE definition (202610220001).
update app.app_config
   set value = (select coalesce(jsonb_agg(x), '[]'::jsonb)
                from jsonb_array_elements_text(value) x
                where lower(x) not in ('mara@youragency.com', 'ruby@youragency.com'))
 where key = 'nda_crew_emails';

create or replace function app.is_nda_crew()
 returns boolean
 language sql
 stable security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
  select exists (
    select 1 from app.employees e
    where e.auth_user_id = auth.uid()
      and e.is_active and e.access_paused_at is null
      and e.employment_type::text <> 'fractional'
      and lower(e.email) in (
        select lower(jsonb_array_elements_text(coalesce(
          (select value from app.app_config where key = 'nda_crew_emails'), '[]'::jsonb)))));
$function$;
