-- Agency OS — seed data (operational settings only)
-- Source of truth: PLAN.md §4 (settings seed values), §7.1 (send window, ramp).
--
-- Run this in the Supabase SQL Editor immediately after the migration in
-- supabase/migrations/. README setup step 4.
--
-- Idempotent: `on conflict do nothing`, so re-running never overwrites a value
-- the owner has since edited in /brain.
--
-- `brain` is NOT seeded here. It has exactly one seeder — scripts/seed-brain.ts,
-- run as `pnpm seed --commit` — because that content gets rewritten repeatedly
-- as the owner improves it, and two seeders competing over the same eight keys
-- means one of them silently loses. See README setup step 5.

-- ---------------------------------------------------------------------------
-- settings — exactly the rows commented in PLAN.md §4.
-- Operational flags only. These are never fed to the LLM: `brain` is business
-- fact for the prompt, `settings` is machinery, and mixing them leaks machinery
-- into drafts.
--
-- These five keys are mirrored in packages/core/src/settings.ts as
-- SETTING_DEFAULTS, which is what a read falls back to when a row is absent.
-- Change one, change the other.
-- ---------------------------------------------------------------------------
insert into settings (key, value) values

  -- pauses every cron job and blocks all sends. Toggle in /brain.
  ('kill_switch', 'false'::jsonb),

  -- autonomy ladder, locked at level 1 in v1: draft, wait for approval.
  ('autonomy', '{"draft_email": 1, "reminder": 1, "alert": 1}'::jsonb),

  -- ramps 10 -> 20 -> 30 -> 40 over four weeks, see PLAN.md §7.1.
  -- Bumped manually in /brain. Starts at 10 before the first live send.
  ('daily_send_cap', '10'::jsonb),

  -- USD/day. Agents halt and file an alert task above this.
  ('daily_cost_cap', '2.00'::jsonb),

  -- Tue-Thu 09:00-16:00 in contacts.timezone.
  -- days = JS Date#getDay() numbers: 0 = Sunday .. 6 = Saturday, so [2,3,4] is
  -- Tue/Wed/Thu. NOT ISO weekday numbers — they agree Mon-Sat and disagree on
  -- Sunday (ISO 7 vs JS 0), and settings.ts validates the 0-6 range.
  ('send_window', '{"days": [2, 3, 4], "start_hour": 9, "end_hour": 16}'::jsonb)

on conflict (key) do nothing;
