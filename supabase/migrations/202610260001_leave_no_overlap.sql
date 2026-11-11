-- 26 Oct 2026: Carmen showed twice under "On leave today". Nadia marked her
-- out sick at 06:03:15 and again at 06:03:24 (the form still held today's
-- date after the first save), and nothing refused leave that overlaps leave
-- the person already has: not for a manager marking someone out, not for
-- anyone applying for themselves. The duplicate also took a second day off
-- her balance. Now any new pending or approved leave that overlaps the
-- person's existing pending or approved leave is refused. Two half days on
-- the same date are allowed (a morning and an afternoon).
create or replace function app_private.guard_leave_overlap()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
begin
  if new.status not in ('pending', 'approved') then return new; end if;
  if exists (
    select 1 from app.leave_requests o
    where o.employee_id = new.employee_id
      and o.id <> new.id
      and o.status in ('pending', 'approved')
      and o.start_date <= new.end_date and o.end_date >= new.start_date
      and not (o.is_half_day and new.is_half_day and o.start_date = new.start_date)
  ) then
    raise exception 'There is already leave on these dates.';
  end if;
  return new;
end;
$function$;
revoke all on function app_private.guard_leave_overlap() from public, anon, authenticated;

drop trigger if exists trg_leave_requests_no_overlap on app.leave_requests;
create trigger trg_leave_requests_no_overlap
  before insert on app.leave_requests
  for each row execute function app_private.guard_leave_overlap();
