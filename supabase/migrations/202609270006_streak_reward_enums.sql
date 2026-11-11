-- Streak rewards (27 Sep 2026): a half-day off every 50 streak days.
-- Enum values in their own migration: ADD VALUE cannot be used in the
-- transaction that adds it.
--   leave_type 'SR'  — a streak-reward half-day, its own type so it never
--                       touches PL/CL/SL balances (summaries filter by type).
--   notification kinds for the earner's email and the manager's FYI.
alter type app.leave_type add value if not exists 'SR';
alter type app.notification_kind add value if not exists 'streak_reward_earned';
alter type app.notification_kind add value if not exists 'streak_reward_manager_fyi';
