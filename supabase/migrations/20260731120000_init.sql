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
