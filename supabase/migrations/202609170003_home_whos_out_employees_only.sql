-- home_whos_out answers employees only (Circle audit, 17 Sep 2026).
--
-- It is SECURITY DEFINER on purpose: leave_requests RLS is own-or-leadership,
-- and the home feed shows every employee who is out. But it never asked WHO
-- was calling. Impersonating a Example Collective partner, and separately a
-- signed-in Google account on no invite list at all, both got back employee
-- names, work emails, leave types (sick leave included) and dates for any
-- 31-day window. Walking the window reads the whole leave history.
--
-- The only caller is loadHomePulse() in app.js, on the employee home screen.
-- Partners, candidates and hiring-only staff never render that screen, so
-- scoping the rows to app.is_employee() costs them nothing.
-- is_employee() = an active employees row for auth.uid(), which every staff
-- member (setup-pending included) has from their first sign-in.

CREATE OR REPLACE FUNCTION app.home_whos_out(p_from date, p_until date)
 RETURNS TABLE(full_name text, email text, leave_type text, status text, start_date date, end_date date, is_half_day boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
  SELECT e.full_name, e.email, lr.leave_type, lr.status, lr.start_date, lr.end_date, lr.is_half_day
  FROM app.leave_requests lr
  JOIN app.employees e ON e.id = lr.employee_id
  WHERE app.is_employee()
    AND e.is_active
    AND p_until >= p_from
    AND p_until <= p_from + 31               -- sanity-clamp the window
    AND lr.end_date >= p_from
    AND lr.start_date <= p_until
    AND (
      lr.status = 'approved'
      OR (lr.status = 'pending' AND lr.leave_type = 'SL' AND lr.start_date <= current_date)
    )
  ORDER BY lr.start_date, e.full_name;
$function$;
