-- Fix Jo Park's CL leave: shorten from Mar 9-13 (5 days) to Mar 9-11 (3 days).

update app.leave_requests
set end_date = '2026-03-11',
    updated_at = now()
where start_date = '2026-03-09'
  and end_date = '2026-03-13'
  and leave_type = 'CL'
  and status = 'approved'
  and employee_id = (
    select id from app.employees where lower(full_name) like '%jo%' limit 1
  );
