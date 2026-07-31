-- Agency OS — one-time database setup.
-- Paste this whole file into the Supabase SQL editor and run it.
-- Generated for operator: kostaskolta@yahoo.com
-- Safe to re-run: every statement is idempotent.

-- ===================== 1/4  schema =====================
-- Agency OS — initial schema
-- Source of truth: PLAN.md §4 (schema), §1 (additions to the spec's schema), §7 (guardrails).
--
-- All timestamps are timestamptz (UTC). Timezone-aware logic (the 08:00 trigger,
-- send windows) resolves Europe/Athens in application code, not in the database.
--
-- Columns/tables marked "ADDED" are the four additions flagged in PLAN.md §1:
--   1. tasks.send_after        — the 2–15 min randomised send delay / local-time window
--   2. contacts.timezone       — needed to compute that window for non-Greek contacts
--   3. settings table          — autonomy levels, kill switch, volume ramp, spend ceiling
--   4. push_subscriptions      — Web Push endpoints
--
-- This migration is idempotent and safe to re-run.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- brain — business facts every agent reads before acting. Editable in the UI.
-- ---------------------------------------------------------------------------
create table if not exists brain (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------
create table if not exists contacts (
  id              uuid primary key default gen_random_uuid(),
  name            text,
  business        text,
  email           text,
  phone           text,
  language        text default 'el',      -- 'el' | 'en'
  city            text,
  country         text default 'GR',
  timezone        text default 'Europe/Athens',  -- ADDED (PLAN §1.2): derived from country/city at creation
  source          text,                   -- nfc_card|referral|inbound|outbound|walk_in
  stage           text default 'new',     -- new|contacted|replied|quoted|won|lost|dormant
  value_estimate  numeric,
  notes           text,
  last_touch_at   timestamptz,
  next_touch_at   timestamptz,
  touch_count     int default 0,
  do_not_contact  boolean default false,
  tags            text[] not null default '{}',   -- ADDED (PLAN §4): what the contact needs or bought
  created_at      timestamptz default now()
);

-- Enum-like text columns. NULL passes a CHECK, so these constrain values without
-- forcing the column to be NOT NULL.
alter table contacts drop constraint if exists contacts_language_check;
alter table contacts add constraint contacts_language_check
  check (language in ('el', 'en'));

alter table contacts drop constraint if exists contacts_source_check;
alter table contacts add constraint contacts_source_check
  check (source in ('nfc_card', 'referral', 'inbound', 'outbound', 'walk_in'));

alter table contacts drop constraint if exists contacts_stage_check;
alter table contacts add constraint contacts_stage_check
  check (stage in ('new', 'contacted', 'replied', 'quoted', 'won', 'lost', 'dormant'));

create index if not exists contacts_next_touch_at_idx on contacts (next_touch_at);
create index if not exists contacts_stage_idx on contacts (stage);

-- Tags are free-form, so there is no CHECK constraint to mirror in the app. GIN
-- is the index for array containment (`tags @> '{ecommerce}'`), which is how the
-- /pipeline tag filter queries them.
create index if not exists contacts_tags_idx on contacts using gin (tags);

-- ---------------------------------------------------------------------------
-- interactions — append-only log of every touch, in both directions.
-- ---------------------------------------------------------------------------
create table if not exists interactions (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid references contacts on delete cascade,
  direction    text,                      -- 'in' | 'out'
  channel      text,                      -- email|phone|in_person|whatsapp|form
  subject      text,
  body         text,
  occurred_at  timestamptz default now(),
  meta         jsonb
);

alter table interactions drop constraint if exists interactions_direction_check;
alter table interactions add constraint interactions_direction_check
  check (direction in ('in', 'out'));

alter table interactions drop constraint if exists interactions_channel_check;
alter table interactions add constraint interactions_channel_check
  check (channel in ('email', 'phone', 'in_person', 'whatsapp', 'form'));

create index if not exists interactions_contact_id_occurred_at_idx
  on interactions (contact_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- tasks — the approval queue.
-- ---------------------------------------------------------------------------
create table if not exists tasks (
  id              uuid primary key default gen_random_uuid(),
  agent           text,
  type            text,                   -- draft_email|reminder|alert
  contact_id      uuid references contacts,
  title           text,
  reasoning       text,
  draft_subject   text,
  draft_body      text,
  final_body      text,
  status          text default 'pending', -- pending|approved|sent|rejected|skipped
  autonomy_level  int default 1,
  send_after      timestamptz,            -- ADDED (PLAN §1.1): 2-15 min randomised send delay
  created_at      timestamptz default now(),
  resolved_at     timestamptz
);

alter table tasks drop constraint if exists tasks_type_check;
alter table tasks add constraint tasks_type_check
  check (type in ('draft_email', 'reminder', 'alert'));

alter table tasks drop constraint if exists tasks_status_check;
alter table tasks add constraint tasks_status_check
  check (status in ('pending', 'approved', 'sent', 'rejected', 'skipped'));

create index if not exists tasks_status_created_at_idx on tasks (status, created_at desc);
create index if not exists tasks_status_send_after_idx on tasks (status, send_after);

-- ---------------------------------------------------------------------------
-- agent_runs — observability. Every agent execution, success or failure.
-- ---------------------------------------------------------------------------
create table if not exists agent_runs (
  id             uuid primary key default gen_random_uuid(),
  agent          text,
  trigger        text,                    -- cron|webhook|manual
  input          jsonb,
  output         jsonb,
  status         text,                    -- ok|error
  error          text,
  model          text,
  input_tokens   int,
  output_tokens  int,
  cost_usd       numeric,
  duration_ms    int,
  created_at     timestamptz default now()
);

alter table agent_runs drop constraint if exists agent_runs_trigger_check;
alter table agent_runs add constraint agent_runs_trigger_check
  check (trigger in ('cron', 'webhook', 'manual'));

alter table agent_runs drop constraint if exists agent_runs_status_check;
alter table agent_runs add constraint agent_runs_status_check
  check (status in ('ok', 'error'));

create index if not exists agent_runs_created_at_idx on agent_runs (created_at desc);

-- ---------------------------------------------------------------------------
-- settings — ADDED (PLAN §1.3). Operational flags, deliberately NOT in `brain`:
-- `brain` is business fact fed to the LLM, these must never leak into prompts.
-- Seeded in seed.sql: kill_switch, autonomy, daily_send_cap, daily_cost_cap, send_window.
-- ---------------------------------------------------------------------------
create table if not exists settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- push_subscriptions — ADDED (PLAN §1.4). Web Push (PWA) endpoints, VAPID.
-- ---------------------------------------------------------------------------
create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  endpoint    text unique not null,
  keys        jsonb not null,
  created_at  timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- RLS — enabled on every table, single permissive policy `auth.uid() is not null`.
-- Single-user app: the Next.js middleware gates on ALLOWED_EMAIL, and the worker
-- uses the service role key, which bypasses RLS entirely.
-- ---------------------------------------------------------------------------
alter table brain enable row level security;
alter table contacts enable row level security;
alter table interactions enable row level security;
alter table tasks enable row level security;
alter table agent_runs enable row level security;
alter table settings enable row level security;
alter table push_subscriptions enable row level security;

drop policy if exists "authenticated" on brain;
create policy "authenticated" on brain
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists "authenticated" on contacts;
create policy "authenticated" on contacts
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists "authenticated" on interactions;
create policy "authenticated" on interactions
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists "authenticated" on tasks;
create policy "authenticated" on tasks
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists "authenticated" on agent_runs;
create policy "authenticated" on agent_runs
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists "authenticated" on settings;
create policy "authenticated" on settings
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists "authenticated" on push_subscriptions;
create policy "authenticated" on push_subscriptions
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

-- ===================== 2/4  RLS ========================
-- Agency OS — tighten RLS from "any authenticated user" to "the operator".
--
-- WHY THIS EXISTS
--
-- 20260731120000_init.sql shipped the policy PLAN.md §4 asks for:
--
--     create policy "authenticated" on contacts
--       for all using (auth.uid() is not null) with check (auth.uid() is not null);
--
-- That policy tests only that a JWT exists. It does not test *whose*. The whole
-- ALLOWED_EMAIL model lives in apps/web (middleware, /auth/callback,
-- requireOperator) — but PostgREST sits on the same public origin as the app and
-- does not run any of it. The anon key is public by construction: it is inlined
-- into the browser bundle. So on a Supabase project with the default
-- email sign-up setting, anybody can:
--
--     POST /auth/v1/signup          -> a JWT with a non-null auth.uid()
--     GET  /rest/v1/contacts?select=*   -> the entire pipeline
--     DELETE /rest/v1/contacts?id=eq... -> `for all` means writes too
--
-- The database has to enforce the same single-user rule the app claims. This
-- migration replaces every table's policy with an identity check.
--
-- WHAT YOU MUST DO AFTER RUNNING IT  (both, not either)
--
--   1. Tell the database who the operator is — the same address as ALLOWED_EMAIL:
--
--        insert into public.settings (key, value)
--        values ('allowed_email', to_jsonb('you@example.com'::text))
--        on conflict (key) do update
--          set value = excluded.value, updated_at = now();
--
--      Until that row exists, is_operator() returns false and every table reads
--      as empty. That is deliberate: this fails closed.
--
--   2. Supabase dashboard -> Authentication -> Sign In / Providers -> Email:
--      turn "Allow new users to sign up" OFF. The app needs exactly one
--      pre-existing user and never creates another. (login/page.tsx passes
--      shouldCreateUser: true so the first sign-in works — do this after it.)
--
--   3. Supabase dashboard -> Authentication -> URL Configuration: list the exact
--      deploy origin(s) under Redirect URLs. No wildcards. This is what stops a
--      magic link being pointed at somebody else's origin.
--
-- The worker is unaffected: it uses the service role key, which bypasses RLS.
--
-- Idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- is_operator() — the one authorisation predicate.
--
-- SECURITY DEFINER so it can read `settings` (which is itself RLS-protected)
-- without the policy recursing into itself. STABLE so the planner may call it
-- once per statement rather than once per row.
--
-- Two sources for the address, checked in order, so a deploy that would rather
-- not keep it in a table can use a database GUC instead:
--   settings.allowed_email        (recommended — one row, editable in /brain later)
--   current_setting('app.allowed_email')   e.g. alter database ... set app.allowed_email = '…'
-- ---------------------------------------------------------------------------
create or replace function public.is_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    lower(nullif(btrim(auth.jwt() ->> 'email'), '')) = lower(
      nullif(
        btrim(
          coalesce(
            (select s.value #>> '{}' from public.settings s where s.key = 'allowed_email'),
            current_setting('app.allowed_email', true)
          )
        ),
        ''
      )
    ),
    false
  );
$$;

comment on function public.is_operator() is
  'True only for the single operator named by settings.allowed_email (mirrors the ALLOWED_EMAIL env var). Fails closed when unset.';

revoke all on function public.is_operator() from public;
grant execute on function public.is_operator() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Policies. RLS is already enabled on all seven tables by the init migration;
-- `enable` is repeated here so this file stands on its own.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'brain',
    'contacts',
    'interactions',
    'tasks',
    'agent_runs',
    'settings',
    'push_subscriptions'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    -- The old, too-permissive policy from 20260731120000_init.sql.
    execute format('drop policy if exists "authenticated" on public.%I', t);
    execute format('drop policy if exists "operator" on public.%I', t);
    execute format(
      'create policy "operator" on public.%I for all using (public.is_operator()) with check (public.is_operator())',
      t
    );
  end loop;
end;
$$;

-- ===================== 3/4  settings seed ==============
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

-- ===================== 4/4  operator ===================
-- Without this row every table reads empty, by design.
insert into settings (key, value) values
  ('allowed_email', to_jsonb('kostaskolta@yahoo.com'::text))
on conflict (key) do update set value = excluded.value, updated_at = now();

-- verify
select 'tables' as check, count(*)::text as result from information_schema.tables where table_schema='public'
union all select 'rls policies', count(*)::text from pg_policies where schemaname='public'
union all select 'operator', coalesce((select value #>> '{}' from settings where key='allowed_email'), 'MISSING');
