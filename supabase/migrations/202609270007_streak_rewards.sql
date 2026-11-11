-- Streak rewards (27 Sep 2026).
--
-- Every 50 consecutive streak days (50, 100, 150, …) earns a half-day off.
-- It is its own leave type ('SR'), never added to annual leave: PL carries
-- forward and belongs to the employment terms, and a reward mixed into it
-- could never be told apart again. Use it or lose it: 90 days.
--
-- Who writes what:
--   * app.streak_rewards rows are written ONLY by the streak-rewards cron
--     (service role). Streaks are computed server-side from task_activity with
--     the same rules as js/streaks.js; the browser never grants itself leave.
--   * Taking one is an ordinary leave request of type SR, approved by the
--     usual approver. The trigger below insists it is a single half-day and
--     claims the earliest-expiring unused reward that is still valid on the
--     leave date; rejecting or cancelling the request releases it.
--
-- Access: RLS on. Any active employee may READ rows (the home feed
-- celebrates who earned one; a milestone is not private). Nobody signed in may
-- insert, update or delete: there are no write policies and no grants beyond
-- select. The trigger function lives in app_private (a trigger fires without
-- USAGE) and runs as definer so it can mark a reward claimed.

create table if not exists app.streak_rewards (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references app.employees(id) on delete cascade,
  milestone int not null check (milestone > 0 and milestone % 50 = 0),
  streak_started_on date not null,
  earned_on date not null,
  expires_on date not null,
  days numeric(3,1) not null default 0.5 check (days = 0.5),
  leave_request_id uuid references app.leave_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (employee_id, milestone, streak_started_on),
  check (expires_on > earned_on)
);
create index if not exists streak_rewards_employee_idx on app.streak_rewards (employee_id, expires_on);

alter table app.streak_rewards enable row level security;

drop policy if exists streak_rewards_select on app.streak_rewards;
create policy streak_rewards_select on app.streak_rewards
  for select to authenticated
  using (app.is_employee());

revoke all on app.streak_rewards from anon, authenticated;
grant select on app.streak_rewards to authenticated;

-- Claim / release -------------------------------------------------------------
create or replace function app_private.streak_reward_claim()
returns trigger
language plpgsql
security definer
set search_path to 'app', 'public', 'extensions'
as $fn$
declare
  v_reward uuid;
begin
  -- Not (or no longer) a streak reward: release anything it was holding.
  if new.leave_type <> 'SR' then
    if tg_op = 'UPDATE' and old.leave_type = 'SR' then
      update app.streak_rewards set leave_request_id = null where leave_request_id = new.id;
    end if;
    return null;
  end if;

  -- Released: a rejected or cancelled SR request frees its reward.
  if new.status in ('rejected', 'cancelled') then
    update app.streak_rewards set leave_request_id = null where leave_request_id = new.id;
    return null;
  end if;

  if not coalesce(new.is_half_day, false) or new.start_date <> new.end_date then
    raise exception 'A streak reward is a single half-day: pick one date and tick Half day.';
  end if;

  -- Already holding one: it must still be valid on the (possibly moved) date.
  select id into v_reward from app.streak_rewards where leave_request_id = new.id;
  if v_reward is not null then
    if exists (select 1 from app.streak_rewards where id = v_reward and new.start_date > expires_on) then
      raise exception 'That streak reward expires before this date. Pick an earlier date.';
    end if;
    return null;
  end if;

  select r.id into v_reward
  from app.streak_rewards r
  where r.employee_id = new.employee_id
    and r.leave_request_id is null
    and r.expires_on >= new.start_date
  order by r.expires_on, r.earned_on
  limit 1
  for update;

  if v_reward is null then
    raise exception 'No unused streak reward covers that date. Rewards are earned every 50 streak days and last 90 days.';
  end if;

  update app.streak_rewards set leave_request_id = new.id where id = v_reward;
  return null;
end;
$fn$;

revoke all on function app_private.streak_reward_claim() from public, anon, authenticated;

drop trigger if exists trg_leave_requests_zz_streak_reward on app.leave_requests;
create trigger trg_leave_requests_zz_streak_reward
  after insert or update of status, start_date, end_date, is_half_day, leave_type on app.leave_requests
  for each row execute function app_private.streak_reward_claim();
