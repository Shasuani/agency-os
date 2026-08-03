# Agency OS — Build Plan (v1)

Derived from the build spec. This file is the working plan: resolved decisions, file layout, schema, and a step-by-step build order with acceptance criteria for each step.

**Rule:** ship each step before starting the next. Steps 1–9 are v1. Step 10 is specified but gated — see §6. Nothing else from "Explicitly out of scope for v1" gets built.

**The rule was not followed.** All nine steps are written; none has been run
against real data. §6 carries a per-step State note and every place the build
diverged from this plan. `STATUS.md` carries the blockers.

---

## 1. Resolved decisions

Things the spec left open. Each was decided in favour of "simplest thing that works for one operator."

| Question | Decision | Why |
|---|---|---|
| Monorepo tooling | pnpm workspaces, no Turborepo | Two deployables, one shared package. Turbo is overhead. |
| Cron | Long-running Node service on Railway with `node-cron` | One deployable, one process. Railway cron jobs spawn separate containers and complicate shared state. The worker also hosts the Gmail webhook endpoint. |
| Auth | Supabase magic link, single allowed email in `ALLOWED_EMAIL` env var, checked in Next.js middleware | Single user. No roles, no invites. |
| Timezone | Store all timestamps as `timestamptz` (UTC). Cadence math and the 08:00 trigger use `Europe/Athens` explicitly. | Greece observes DST; "08:00" must mean 08:00 local year-round. |
| Gmail OAuth | Refresh token in `GMAIL_REFRESH_TOKEN` env var on the worker | One account, one token. A token table for a single user is ceremony. Re-auth = update the env var. |
| Autonomy levels + kill switch storage | New `settings` table (key/jsonb), not `brain` | `brain` is business facts fed to the LLM. Operational flags are a different thing and shouldn't leak into prompts. |
| Random 2–15 min send delay | New `send_after timestamptz` column on `tasks`. Worker polls every 60s for `status='approved' AND send_after <= now()`. | Approving must return instantly. Delay needs durable scheduling, not a `setTimeout`. |
| Push notifications | Web Push (PWA) with VAPID keys, subscriptions in a `push_subscriptions` table | Spec says PWA is enough. No APNs, no third-party service. |
| LLM structured output | `output_config.format` with a JSON Schema — not prompt-and-hope | The API guarantees schema-valid output. One retry on validation failure, then an alert task. |
| Rate limits | Enforced at **send time** in the worker, by counting `interactions` rows | Single source of truth. Draft-time checks can go stale between draft and approve. |
| Send timing | Fixed rule (business hours in recipient's timezone), not an optimisation agent | The send-time studies are bulk-marketing data and contradict each other. The real reason to respect local time is that 3am delivery reads as a bot. See §7.1. |
| Daily volume | Ramped, stored in `settings`, not a constant 40 | A new domain sending 40/day from day one lands in spam permanently. See §7.1. |
| Cost ceiling | Daily `cost_usd` cap in `settings`; agents halt and file an alert when breached | Cheapest insurance against a loop bug burning money at 3am. |

**Two rows of that table are now wrong. Both are argued in §6 rather than here,
so the original decision and the reason it was overturned stay side by side:**

- **Cron.** There is no `node-cron`. The worker schedules in process with an
  explicit timezone, which is what the row actually asked for. See §6 step 7.
- **Auth.** Magic links do not work with mail clients that open links in an
  embedded browser; login is `signInWithPassword`. See §6 step 2.

### Additions to the spec's schema

Five things the spec's flow needs but its DDL doesn't have. Flagged explicitly rather than smuggled in:

1. `tasks.send_after timestamptz` — the send delay / local-time window.
2. `contacts.timezone text` — needed to compute that window for non-Greek contacts.
3. `contacts.tags text[]` — what the contact needs or bought. See §4.1.
4. `settings` table — autonomy levels, kill switch, volume ramp, spend ceiling.
5. `push_subscriptions` table — Web Push endpoints.

---

## 2. Model routing

Verified against current model IDs. **The spec's Haiku ID is correct but is the dated form; the alias is shorter and equivalent.**

| Job | Model ID | Notes |
|---|---|---|
| Classification, routing, scoring | `claude-haiku-4-5` | Alias for `claude-haiku-4-5-20251001`. $1/$5 per MTok. 200K context, 64K max output. Does **not** support `output_config.effort` — omit it. |
| Drafting, reasoning about a contact | `claude-sonnet-5` | $3/$15 per MTok (intro $2/$10 through 2026-08-31). 1M context, 128K max output. |

No Opus anywhere in v1, per spec.

**Two things to get right on `claude-sonnet-5`:**

- Adaptive thinking is **on by default** when `thinking` is omitted. For short drafting calls that's wasted spend and can crowd `max_tokens`. Set it explicitly: `thinking: { type: "disabled" }` for drafting, or `output_config: { effort: "low" }` if some reasoning helps.
- Non-default `temperature` / `top_p` / `top_k` are **rejected with a 400**. Steer with prompting only.

### Structured output — the one pattern to use everywhere

Every agent call that returns JSON uses `output_config.format`. No regex, no `JSON.parse` on prose, no "respond with only JSON" pleading.

```ts
const FOLLOWUP_SCHEMA = {
  type: "object",
  properties: {
    should_contact: { type: "boolean" },
    reason: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
    suggested_next_touch_days: { type: "integer" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "should_contact",
    "reason",
    "subject",
    "body",
    "suggested_next_touch_days",
    "confidence",
  ],
  additionalProperties: false,
} as const;

const response = await client.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 2000,
  thinking: { type: "disabled" },
  system: buildSystemPrompt(brain, contact),
  messages: [{ role: "user", content: renderContactContext(contact, interactions) }],
  output_config: { format: { type: "json_schema", schema: FOLLOWUP_SCHEMA } },
});
```

Schema constraints worth knowing before designing one: `enum`, `const`, `anyOf`, `$ref` are supported; `minLength` / `maximum` / `minItems` are **not**, and recursive schemas are **not**. Every object needs `additionalProperties: false`. Enforce the 120-word limit in the prompt and validate it in code — the schema can't.

First request with a new schema pays a one-time compile cost, then it's cached for 24h.

### Prompt caching

The `brain` block is identical across every contact in a daily run. Put it first in the system prompt with `cache_control: { type: "ephemeral" }`, put the per-contact context after it. Cache reads are ~0.1× input price, so a 40-contact run pays the full brain cost once instead of 40 times.

Verify it's working: `response.usage.cache_read_input_tokens` should be non-zero from the second contact onward. If it stays zero, something volatile (a timestamp, a contact name) has leaked into the cached prefix.

---

## 3. Repo layout

```
agency-os/
├── package.json                 # pnpm workspaces root
├── pnpm-workspace.yaml
├── .env.example
├── PLAN.md
├── SPEC.md
├── apps/
│   ├── web/                     # Next.js App Router → Vercel
│   │   ├── app/
│   │   │   ├── page.tsx                 # / — Today
│   │   │   ├── inbox/page.tsx
│   │   │   ├── pipeline/page.tsx
│   │   │   ├── brain/page.tsx
│   │   │   ├── content/page.tsx         # stub
│   │   │   ├── money/page.tsx           # stub
│   │   │   └── api/
│   │   │       ├── tasks/[id]/approve/route.ts
│   │   │       ├── tasks/[id]/skip/route.ts
│   │   │       └── tasks/[id]/route.ts   # PATCH — save edit
│   │   ├── components/
│   │   │   ├── task-card.tsx
│   │   │   ├── metric-tile.tsx
│   │   │   └── keyboard-provider.tsx     # j/k/e/Enter
│   │   └── middleware.ts                 # single-user auth gate
│   └── worker/                  # Node service → Railway
│       ├── src/
│       │   ├── index.ts                  # cron registration + http server
│       │   ├── jobs/followup.ts
│       │   ├── jobs/send-queue.ts        # polls approved tasks every 60s
│       │   ├── jobs/digest.ts
│       │   └── routes/gmail-webhook.ts
└── packages/
    └── core/
        ├── db.ts                # supabase client + typed queries
        ├── types.ts             # generated from schema
        ├── llm.ts               # THE wrapper — all model calls go here
        ├── cadence.ts           # pure functions, unit tested
        ├── gmail.ts             # send + read, stubbed under DRY_RUN
        ├── guardrails.ts        # rate limit, do_not_contact, kill switch
        └── prompts/
            ├── followup.ts
            └── classify.ts
```

---

## 4. Schema

Spec DDL plus the four additions from §1. One migration file to start.

```sql
create table brain (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz default now()
);

create table contacts (
  id              uuid primary key default gen_random_uuid(),
  name            text,
  business        text,
  email           text,
  phone           text,
  language        text default 'el',      -- 'el' | 'en'
  city            text,
  country         text default 'GR',
  timezone        text default 'Europe/Athens',  -- ADDED: derived from country/city at creation
  source          text,                   -- nfc_card|referral|inbound|outbound|walk_in
  stage           text default 'new',     -- new|contacted|replied|quoted|won|lost|dormant
  value_estimate  numeric,
  notes           text,
  last_touch_at   timestamptz,
  next_touch_at   timestamptz,
  touch_count     int default 0,
  do_not_contact  boolean default false,
  tags            text[] not null default '{}',   -- ADDED: see §4.1
  created_at      timestamptz default now()
);
create index on contacts (next_touch_at);
create index on contacts (stage);
create index on contacts using gin (tags);

create table interactions (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid references contacts on delete cascade,
  direction    text,                      -- 'in' | 'out'
  channel      text,                      -- email|phone|in_person|whatsapp|form
  subject      text,
  body         text,
  occurred_at  timestamptz default now(),
  meta         jsonb
);
create index on interactions (contact_id, occurred_at desc);

create table tasks (
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
  send_after      timestamptz,            -- ADDED: 2-15 min randomised send delay
  created_at      timestamptz default now(),
  resolved_at     timestamptz
);
create index on tasks (status, created_at desc);
create index on tasks (status, send_after);

create table agent_runs (
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
create index on agent_runs (created_at desc);

-- ADDED
create table settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz default now()
);
-- seed:
--   kill_switch      false
--   autonomy         {"draft_email": 1, "reminder": 1, "alert": 1}
--   daily_send_cap   10          -- ramps 10 → 20 → 30 → 40 over four weeks, see §7.1
--   daily_cost_cap   2.00        -- USD; agents halt and file an alert above this
--   send_window      {"days": [2,3,4], "start_hour": 9, "end_hour": 16}

-- ADDED
create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  endpoint    text unique not null,
  keys        jsonb not null,
  created_at  timestamptz default now()
);
```

Seed `brain` keys: `services`, `pricing`, `tone_of_voice_en`, `tone_of_voice_el`, `case_studies`, `positioning`, `availability`, `retainer_offer`.

RLS: enable on every table. The worker uses the service role key and bypasses it.

**Correction (found during step 2).** An earlier draft of this plan specified the
policy as `auth.uid() is not null`. That is not sufficient and was replaced in
`20260731140000_rls_operator_only.sql`. The anon key is public by construction and
Supabase projects allow sign-ups by default, so *any* stranger could mint a valid
JWT and read the whole `contacts` table straight through PostgREST — where none of
the app's `ALLOWED_EMAIL` checks run, because those live in Next.js middleware and
Server Actions. The policy is now a `security definer` function `public.is_operator()`
comparing `auth.jwt() ->> 'email'` against `settings.allowed_email`, and it fails
closed when that row is unset.

---

## 4.1 Tags — what the contact needs or bought

`contacts.tags text[]`, GIN-indexed, free-form.

**No CHECK constraint, deliberately** — unlike `stage`, `source` and `language`.
The work this business does is not a closed set: websites, apps, e-commerce, NFC
cards, and whatever is sold next. A dropdown that cannot express the next thing
is worse than a free-text field. The UI offers `SUGGESTED_TAGS` so spelling stays
consistent enough for filtering, but anything can be typed.

**Normalised on every write path** — form, CSV import, Server Action:
lowercased, whitespace and underscores collapsed to single hyphens,
de-duplicated, max 20 tags of 32 chars. `Web App`, `web app` and `web_app` all
become `web-app`, so the filter never splits one tag into three.

**Not the same thing as `source`,** and they are easy to conflate:

| Column | Answers | Example |
|---|---|---|
| `source` | How they arrived | `nfc_card`, `referral`, `walk_in` |
| `tags` | What they need or bought | `ecommerce`, `redesign`, `nfc-card` |

Someone can arrive via an NFC card and want an e-commerce site. Keeping them
apart matters at step 5: §4's cadence table treats "bought an NFC card" specially
(+14 days, check-in plus web upsell), and inferring that from `source` is the
wrong signal — `source` records the introduction, not the purchase.

**Why this isn't cosmetic.** The follow-up agent reads the whole contact row
before drafting. `tags: ["ecommerce", "redesign"]` tells it what the conversation
was actually about, which changes the draft materially.

---

## 5. The LLM wrapper contract

`packages/core/llm.ts` exports one function. Nothing else in the codebase imports `@anthropic-ai/sdk`.

```ts
type CallOpts = {
  agent: string;              // 'followup' | 'inbox' | ...
  trigger: 'cron' | 'webhook' | 'manual';
  model: 'claude-sonnet-5' | 'claude-haiku-4-5';
  system: SystemBlock[];      // cache_control set on the brain block
  user: string;
  schema: object;             // JSON Schema — required, no unstructured calls
  maxTokens?: number;
};

export async function call<T>(opts: CallOpts): Promise<T>;
```

Responsibilities, all of them:

- Sets `thinking: { type: "disabled" }` on Sonnet unless explicitly overridden.
- Omits `output_config.effort` on Haiku (unsupported → 400).
- Never passes `temperature` / `top_p` / `top_k` (rejected on both models).
- Writes one `agent_runs` row per call: model, `usage.input_tokens`, `usage.output_tokens`, computed `cost_usd`, `duration_ms`, and the parsed output.
- On schema-validation failure or an API error: retry **once**, then write an `agent_runs` row with `status='error'` and create an `alert` task. Never swallow.
- Checks `response.stop_reason` before reading content — `refusal` and `max_tokens` are both handled, not assumed away.
- **Before every call**, sums `cost_usd` from `agent_runs` for the current day. Over `settings.daily_cost_cap`, it throws, files one alert task, and makes no further calls until the next day. A retry loop that burns money silently overnight is the failure mode this exists to prevent.

Cost table for the calculation (per million tokens): Sonnet 5 $3 in / $15 out; Haiku 4.5 $1 in / $5 out.

---

## 6. Build order

Nine steps. Each is deployed and used before the next starts.

**Status of this section, 2026-08-03.** The rule above was not followed. Code for
all nine steps exists; none of it has been run against real data. Each step below
carries a **State** note distinguishing "written and tested" from "done", and a
**Divergence** note wherever the implementation deliberately departed from what
this plan says. The divergence notes are the point: this file is the record of
decisions, and a decision that is not written here gets re-argued later.
`STATUS.md` carries the blockers and the numbers; this section carries the
reasoning.

Nothing in the original step text below has been deleted, including the parts
that turned out to be wrong.

### Step 1 — Foundation
Repo, pnpm workspaces, Supabase project, schema migration applied, `brain` seeded with real content, contacts imported from CSV.

*Done when:* real contacts are queryable in Supabase and `brain` has actual services and pricing text in it, not placeholders.

**State: partially done.** Repo, workspaces and Supabase project exist. Two
migrations (`init`, `rls_operator_only`) are applied and verified against real
Postgres. `brain` is **not** seeded with real content — 5 of 8 keys hold the
owner's words, `tone_of_voice_el` holds rules but no voice, and the three
deliberately-empty keys are correct as they are. No CSV has been imported; there
are 0 contacts. By its own acceptance criterion this step is not done.

**Divergence: one migration file became five.** §4 says "one migration file to
start". `20260731140000_rls_operator_only` is documented in §4's Correction.
Three more were added later and each is load-bearing:

- `20260731180000_stage_changed_at` — see §6 step 5, constraint 2.
- `20260803120000_inbox_dedupe_and_indexes` — the unique partial index on
  `interactions.meta->>'gmail_message_id'`. Step 8's exactly-once claim *is* this
  index; see step 8 below.
- `20260803160000_contacts_email_unique` — a partial unique index on
  `lower(btrim(email))`. §4's DDL has no uniqueness on `contacts.email`, which
  was a gap rather than a decision: `do_not_contact` and the 48-hour cooldown are
  recorded per *row* while the address identifies a *person*, so two rows are two
  ways to mail someone who has said no. Rejected objection: shared `info@`
  mailboxes. They share an inbox, so they should share the cooldown.

All three are idempotent. All three are in `SETUP.md` §1.4 and in
`supabase/SETUP_RUN_ME.sql`, which they were not when they were written — that
omission is recorded in `STATUS.md` blocker 0. (They were briefly listed in
`README.md` §4; that section no longer exists — the setup procedure moved to
`SETUP.md` in full.)

### Step 2 — `/pipeline`
List, create, edit contacts. Manual `next_touch_at`. Stage dropdown. No AI.

*Done when:* the owner can add a contact met yesterday and set a follow-up date, from the deployed app.

**State: written and tested; acceptance unmet.** There is no deployed app — no
Vercel project and no Railway service exist — and no contact has been added.

**Divergence: password auth, not magic links.** §1's table says "Supabase magic
link". It does not work here and will not be made to. The PKCE code-verifier
cookie is written by the browser that *requested* the link, and mail clients open
links in their own embedded browser, so the callback arrives without the verifier
and fails; free-tier email rate limits (~2/hour) make it undebuggable on top.
`signInWithPassword` against a single `ALLOWED_EMAIL`. Do not revert this.

### Step 3 — Cadence functions
`packages/core/cadence.ts`. Pure functions, no I/O, unit tested against the spec's table.

```ts
nextTouch(stage: Stage, touchCount: number, source: Source): { days: number } | { dormant: true }
```

Cases from the spec: new lead +3/+7/+14→dormant; quoted +5/+10/+21; nfc_card +14; won +30; delivered +30; dormant +90.

*Done when:* tests pass for every row of the cadence table, including the transitions to dormant.

**State: done.** This is the only step whose acceptance criterion is fully met,
and it is met because the criterion is a test rather than an observation. That is
worth noticing rather than celebrating: every step after this one has a criterion
that requires the system to actually run, and none of those have been met.

### Step 4 — LLM wrapper
`llm.ts` + `agent_runs` logging. Prove it with one throwaway script that classifies a string and writes a run row.

*Done when:* a call appears in `agent_runs` with correct token counts and a cost within a cent of hand-calculation.

Verify with `pnpm exec tsx scripts/llm-probe.ts` — it prints the usage, the
computed cost, the same figure by hand, and the difference. `--no-db` exercises
the request shape with only an `ANTHROPIC_API_KEY`, before Supabase exists.

**`llm.ts` is not exported from the `@agency/core` barrel**, deliberately. It
value-imports the Anthropic SDK, and apps/web's Server Components import the
barrel for `appTimezone` — so re-exporting it put the whole SDK into the Next.js
server bundle for an app that never calls a model, and made an LLM call
reachable from a Server Action by autocomplete. The worker imports
`@agency/core/llm` explicitly, the same arrangement as `@agency/core/cadence`.

**Cost is cache-aware and date-aware.** Cache writes bill at 1.25x input and
reads at 0.1x, which matters because §2 puts the whole brain behind a cache
breakpoint — ignoring it would over-report by roughly the size of the brain on
every call after the first. Sonnet 5's introductory rate ($2/$10 vs $3/$15)
expires 2026-09-01, so the rate is derived from when the call happened rather
than hard-coded; a row written today still reads correctly next year.

**State: written and tested; acceptance unmet.** No call has ever been made.
`ANTHROPIC_API_KEY` is the literal string `placeholder`, `agent_runs` has 0 rows,
and the "cost within a cent of hand-calculation" check has never been run.
`scripts/llm-probe.ts` exists to run it and has never been run.

**Divergence: the cost cap's day boundary is `appTimezone()`, not UTC.** §5 says
"sums `cost_usd` for the current day" without saying whose day. UTC would move
the reset to 02:00 or 03:00 Athens time, i.e. into the middle of the night the
cap exists to protect. It also now *refuses* rather than under-counting when the
cost query is truncated or errors: an unreadable spend history is not the same as
zero spend, and treating it as zero is how a cap fails open.

### Step 5 — Follow-up agent (dry run, on cron)
The flow from spec §4. Runs 08:00 Europe/Athens. Dry-run mode on.

Prompt assembly rules, enforced in code where possible:
- System prompt built from `brain` — nothing hardcoded.
- Contact's language: Greek contacts get Greek, formal (πληθυντικός ευγενείας) unless prior interactions show otherwise.
- Under 120 words. No corporate filler. One ask per message.
- Never invent facts, prices, or timelines absent from `brain` or `interactions`.
- Nothing genuine to say → `should_contact: false`.

*Done when:* a real morning run produces pending tasks whose drafts the owner would actually send, and skipped contacts have `next_touch_at` pushed out with a logged reason.

**Four constraints inherited from step 3.** The cadence functions are correct; these are all about how step 5 must *call* them.

1. **The selection query in SPEC §4 contradicts the cadence table.** It says
   `stage not in ('won','lost')`, but three of the six cadence rows — NFC card
   +14, delivered +30, active client +30 — are all `won` contacts. Filtering
   `won` out suppresses half the table and the retainer cadence never runs. Query
   `do_not_contact = false and stage <> 'lost'` instead, or record excluding
   `won` as a deliberate decision.

2. **`contacts.touch_count` is a lifetime counter; `nextTouch` wants a
   per-stage one.** Passing it straight through is a live bug: a lead touched
   five times and then quoted arrives as `touchCount: 5`, falls off the end of
   the three-step quoted sequence, and is marked dormant the day after being
   quoted. Either reset the counter on stage change, or derive it by counting
   `interactions` since the stage last changed. Do not pass `touch_count` raw.

3. **Wrap each contact individually.** `nextTouch` throws a `RangeError` on a
   corrupt `touchCount` (negative, fractional, NaN) rather than guessing. That is
   the right call for one contact and a disaster for a batch: an unwrapped loop
   means one bad row aborts the whole 08:00 run and *everybody* is missed that
   day. Per-contact try/catch, and a failure files an alert task per SPEC §8.

4. **`contacted` and `replied` are not rows in the spec table.** Step 3 folds
   both into the new-lead +3/+7/+14 sequence — a reasonable reading, but a
   reading. Confirm a contact who has actually replied should run at that pace.

**State: written and tested; acceptance unmet, and it is the criterion that
matters most.** No morning run has produced a draft, because there is no API key
and there are no contacts. Nobody has read a draft this system wrote. Until that
happens, steps 6–9 are scaffolding around an unevaluated thing.

**Four amendments made after steps 6–8 existed.** None of these were visible when
step 5 was written alone; each is a consequence of another agent sharing the same
tables.

1. **`next_touch_at` is re-anchored after the send, not at draft time.** The
   draft-time write used the interval from *before* the touch it was filing, so
   the cadence collapsed inward — and it collapsed even with same-day approval,
   which is the common case, not an edge one. A fourth post-send write now
   re-anchors on the message that actually left, using the touch count including
   the new row, and only ever outward.
2. **An open draft of any kind suppresses the next morning's follow-up.** The
   selection query originally looked for a pending task from the follow-up agent.
   With step 8 in place, an approved-but-unsent draft and a pending *inbox reply*
   are both reasons not to draft again — otherwise the morning run writes a
   follow-up to someone whose question is sitting unanswered in the queue.
3. **Contacts with no usable email are excluded in the query.** They used to be
   selected, fail, and keep their date — permanently occupying the head of an
   oldest-first list. They now keep their `/pipeline` reminder without blocking
   anyone. Separately, a full run that drafts *nothing* files an alert, so a
   silently-empty morning is no longer indistinguishable from a quiet one.
4. **Inbound `interactions` bodies and subjects are fenced in the prompt.**
   Before step 8, every `interactions` row was operator-entered and the follow-up
   prompt rendered them raw. Step 8 made those rows a stranger's text without the
   prompt changing. Bodies, subjects and the `From:` display name are now
   length-bounded, flattened and marker-stripped at every prompt site, and the
   display name is capped where it is written as well as where it is read.

### Step 6 — Today page + approve + send
Metric tiles, task cards, three buttons, keyboard shortcuts (j/k/e/Enter). Gmail send with the local-time window and jitter (§7.1). `DRY_RUN` off.

Three tiles, not four: **needs you, open leads, done today**. The spec's fourth tile is "unpaid", but invoice generation is out of scope for v1 and `/money` is a stub, so the number has no source. A hand-entered figure goes stale in a week and then lies every morning. Add it when money tracking is real.

Before the first live send: SPF/DKIM/DMARC verified, `daily_send_cap` at 10, compliance footer wired with all four elements.

Design direction, per spec: dense, quiet, high information density, keyboard-first. A restrained palette and one characterful typeface for numbers and headings. Visual weight lives on the task cards and nowhere else. The daily loop completes in 90 seconds without touching the mouse.

Empty state is a success state: "Nothing needs you. 9 things handled."

*Done when:* the owner approves a real follow-up from the laptop and the recipient receives it.

**State: written and tested; acceptance unmet. `DRY_RUN` is still `true` and no
message has ever been sent to anybody.** The line above says "`DRY_RUN` off" and
that has not happened, deliberately — turning it off before a draft has been read
means the first thing this system does with a real customer is something nobody
has checked. The pre-send list in this step (SPF/DKIM/DMARC verified,
`daily_send_cap` at 10, footer wired) is also unmet: no sending domain has been
configured. See `STATUS.md` blocker 8.

**Divergence 1: Server Actions, not `app/api/tasks/[id]/*` route handlers.** §3's
layout sketches three route handlers for approve / skip / edit. They are
`approveTask`, `saveDraft`, `rejectTask` and `skipTask` in
`apps/web/lib/task-actions.ts`. A route handler for a same-origin button is a
fetch wrapper, a JSON contract and a second auth check to keep in sync; a Server
Action is the mutation. There are no `app/api` routes in the web app at all.

**Divergence 2: no `/content` and `/money` stubs.** §3's layout lists both. They
were not built. A nav entry leading to an empty page is a promise, and this step's
own reasoning already deleted the "unpaid" tile for exactly that reason — a
number with no source lies every morning. Build them when there is something
behind them.

**Divergence 3: the send window is per-agent.** See §7.1's amendment.

**Divergence 4: `sendEmail` is the `sendRaw` §7 says does not exist.** See §7's
amendment. This one is a weakening of a stated guarantee, not a refinement of it,
and it is recorded so that nobody reads §7's guardrail table and believes the
property holds by construction.

### Step 7 — Notifications
Web Push subscription + one daily digest after the morning run. One notification, not per-task.

*Done when:* "4 follow-ups ready" arrives once, at a sane hour.

**State: written and tested; acceptance unmet.** No VAPID keypair exists, so no
browser has ever subscribed, so no notification has ever been delivered. With no
`push_subscriptions` rows `sendPush` is a logged no-op, which means this step
fails *quietly* if the keys are set on Railway but the operator never clicks
"Enable notifications" in `/brain`. iOS Safari cannot subscribe at all until
there is a web app manifest, and there is not one.

**Divergence: the digest is not a scheduled job.** The obvious implementation is
a second timer at, say, 08:30. It is wrong, and the reason generalises: two
independent timers cannot be ordered. A slow morning — forty contacts, a Sonnet
call each, one retry — runs past any fixed offset, and the operator gets "0
follow-ups ready" at 08:30 followed by four cards appearing at 08:34. Nothing
errors; the notification is simply a lie, and the first lie is what teaches
somebody to ignore the next one.

`runDigest` is therefore called at the end of `runFollowupJob`, on the success
path **and** the failure path. The failure path is the more important half:
"the morning run failed" is the single most important thing this system can tell
its operator, and a fixed-time digest would have said nothing at all.

**Divergence: no `node-cron`.** §1's table names it. The worker schedules in
process with `scheduleDailyAt` in `apps/worker/src/index.ts` — which is what §1
actually asked for, an in-process schedule with an explicit timezone rather than
the host clock. `node-cron` is not in `pnpm-lock.yaml`, the step that would have
introduced it was not allowed to run an install, and declaring a dependency that
is not installed is worse than not declaring one.

### Step 8 — Inbox agent
Gmail `users.watch` → Pub/Sub → webhook on the worker. Match sender to contact or create one with `source: 'inbound'`. Classify with Haiku into one of: `new_lead | interested | question | objection | not_interested | scheduling | invoice | spam | not_business`. Write an `interactions` row regardless of class.

Routing:
- `not_interested` → stage `lost`, `do_not_contact = true`, **no notification**
- `spam` / `not_business` → log only
- everything else → Sonnet draft + pending task
- `new_lead` / `interested` → immediate push; everything else waits for the digest

The quiet handling matters as much as the loud handling. Twenty pings a day and the app gets muted.

*Done when:* a real inbound reply lands as a classified task, and a rejection silently closes the contact.

**State: written and tested; acceptance unmet, and this is the step furthest from
being testable by hand.** Nothing Google-shaped exists: no GCP project, no OAuth
client, no Pub/Sub topic, no push subscription. No inbound message has ever been
classified. `STATUS.md` blockers 5 and 6 are the procedure.

**Divergence 1: `GMAIL_REFRESH_TOKEN` needs a second scope.** §8's env list is
unchanged in shape, but the token behind it is not: this step calls
`users.watch`, `users.history.list` and `users.messages.get`, so the token must
be reissued with `https://www.googleapis.com/auth/gmail.readonly` alongside
`gmail.send`. A send-only token does not fail at startup — it fails on the first
read, with a 403.

**Divergence 2: two env vars this plan did not list.** `GMAIL_WEBHOOK_AUDIENCE`
and `GMAIL_PUBSUB_SERVICE_ACCOUNT`, added to §8. §8 listed
`GMAIL_WEBHOOK_SECRET` and stopped, and a shared secret in a query string is not
sufficient authentication for a publicly-routable endpoint that triggers paid
model calls. The route verifies the Pub/Sub OIDC token — issuer, audience and
service-account email — *and* the shared secret.

**Divergence 3: exactly-once is a database index, not application logic.** The
claim rests entirely on the unique partial index from
`20260803120000_inbox_dedupe_and_indexes`: the interaction row is inserted
*before* Haiku is called, and a `23505` is read as "another delivery already
claimed this message". Without the index there is no `23505` and the claim
degrades silently to a read followed by a write. Recorded here because the
property lives in a migration file rather than in the code that depends on it.

**Divergence 4: replies are threaded without a new column.** `tasks` has no
thread column and gets none. The send queue joins the inbound `interactions` row
on `meta->>'task_id'` to recover `gmail_thread_id` and `rfc_message_id`, which
step 8 already writes. If that read fails the message goes out unthreaded rather
than being held: a reply in the wrong thread is a nuisance, a customer's answer
stuck in a queue is not.

**Divergence 5: `dormant` is a promotable stage.** The routing rules above do not
say which stages a reply may promote *from*. `dormant` was initially excluded
alongside `quoted` and `won` — wrongly. A dormant contact who writes back is the
clearest possible signal of renewed interest, and leaving the stage alone left
them on the 90-day dormant heartbeat despite having just made contact. The
promotion also re-dates the contact; it is the one place in the system allowed to
pull `next_touch_at` *inward*.

**Divergence 6: the kill switch is checked after watch renewal.** §7 says the
kill switch is checked "at the top of every cron job". For this job that is
wrong: Gmail expires a watch after seven days and serves only about a week of
history, so a pause that also stops renewing the watch and moving the cursor
means unpausing silently begins with a gap of permanently lost mail. Watch
renewal and cursor bootstrap now run first, and the switch is checked immediately
after — before anything is read, classified or charged. One alert card is filed
once the cursor has been sitting for four days, which is inside the week and
leaves time to act.

### Step 9 — Edit-as-training-data
When `final_body` differs from `draft_body`, feed the pair back as a style example on future drafts for that language. Storage exists from step 1; this step wires the loop.

*Done when:* an edited draft measurably shifts the next draft's register in the same language.

**State: written and tested; acceptance unmet, and the criterion as written
cannot be met.** No draft exists, so no draft has been edited, so there are no
pairs to feed back. Beyond that, "measurably shifts register" names no
measurement and there is no metric in the code that could produce one. Read it as
the honest thing it can be: after five or six real edits in a language, the owner
reads the next draft in that language and says whether it moved toward him.
That judgement is the acceptance test. It is subjective, and pretending otherwise
would be worse.

**Divergence: examples go in the uncached per-contact block, never in the brain
prefix.** §2 puts the whole brain behind a `cache_control` breakpoint at the end
of `system[0]`, which pays for itself only while that prefix is byte-identical
across a run. Style examples are language-scoped and a morning run mixes
languages, so putting them in `system[0]` would invalidate the cache on every
switch and silently undo §2's saving — with no error and nothing in the output to
notice. They live in `system[1]`.

**A data flow that was reviewed and deliberately left alone.** This step puts one
contact's message text into another contact's prompt. That text is the
*operator's own outbound writing*, held by the operator, processed on the
operator's account, to write the operator's next message: one controller, one
purpose, no third party. Redacting it would remove the signal — register and
sentence shape do not survive noun removal — so the alternative is not a safer
feature but no feature. If this ever must change, the exit is to scope examples
by `tasks.agent` or by contact. Never to redact.

**v1 ends here.** No finance, content, trends, design, or legal agents until 50+ contacts are in the database and the daily loop is genuinely in use.

### Step 10 — Lead Research agent (specified, gated, not started)

Where the *next* warm lead comes from, rather than making sure existing ones
aren't forgotten. Full spec in **[LEAD_RESEARCH.md](./LEAD_RESEARCH.md)**.

This revises `SPEC.md` §10, which put cold outbound out of scope for v1. It stays
out of scope for v1 — this is step 10, after v1 ships.

**Do not start until all four are true:**

1. Steps 1–9 shipped and in daily use
2. 50+ contacts in the database
3. The follow-up drafts are trusted without reading every word
4. A **separate sending domain** is registered and warmed

**Two things that must not be got wrong**, both documented at length in the spec:

- **A separate sending domain.** Cold outreach produces spam complaints; warm
  follow-ups produce replies. Share a domain between them and the complaints
  poison the reputation the follow-ups depend on — mail to real customers starts
  landing in spam and the app silently stops working.
- **A separate `prospects` table.** A researched lead written into `contacts`
  with a `next_touch_at` gets picked up by the step-5 agent, which drafts
  outreach to a stranger who never met you — appearing in the morning queue
  looking exactly like a real follow-up. Promotion into `contacts` is an explicit
  button press, never a status flag.

Three questions need real answers before any code: where the Lead Hunter sources
candidates and whether those terms permit it, the legality of cold B2B email in
Greece specifically, and the profiling obligations that come with long-term
intelligence profiles.

---

## 7. Guardrails — implementation notes

All of these live in `packages/core/guardrails.ts` and are called from the send path, not the draft path.

| Guardrail | Implementation |
|---|---|
| No send without an approved task | The Gmail send function takes a `taskId`, re-reads the row, and throws unless `status = 'approved'`. There is no other send path and no `sendRaw` export. |
| Daily volume cap | `count(interactions) where direction='out' and channel='email' and occurred_at > now() - 24h` against `settings.daily_send_cap`. Ramped, not fixed at 40 — see §7.1. |
| Max 1 per contact per 48h | Same query scoped to `contact_id` |
| Compliance footer | Appended in the send function, not in the LLM draft — the model can't forget it and the owner can't edit it out. Contains **four** things, not just the opt-out: opt-out line, sender identity, physical business address, privacy policy link. All four are GDPR requirements for B2B email in the EU. |
| Daily cost ceiling | Checked in the LLM wrapper before every call against `settings.daily_cost_cap`. |
| `do_not_contact` | Checked at send time, immediately before the Gmail call. Permanent — never cleared by an agent. |
| Kill switch | `settings.kill_switch`. Checked at the top of every cron job and every send. Toggle in `/brain`. |
| Retry once then alert | In the LLM wrapper and the job runner. An error never disappears silently. |
| Dry run | `DRY_RUN=true` default in development. Agents run, tasks are created, Gmail send is stubbed and logged. |

**Amendment (found reviewing step 6). The first row overstates what was built,
and the gap is worth naming precisely.** `sendEmail` does take a `taskId` — and
uses it only in its log lines. It never touches the database. The re-read, the
`do_not_contact` check, the suppression tag, the autonomy level and both rate
limits all live in `assertSendAllowed` in `guardrails.ts`, which is a **separate
function the caller has to remember to call**, and `@agency/core/gmail` is a
published subpath.

It is built that way because moving the re-read into the send function would make
`packages/core/gmail` import the service-role Supabase client, which is exactly
the coupling the barrel rule exists to prevent — and because the decision half is
pure and unit-testable while the I/O half is not.

The cost is real: **"no exceptions, no quick send path" now holds by discipline,
not by construction.** There is one caller today and it calls `assertSendAllowed`
first. A future "send now" button that imports `sendEmail` directly would mail a
customer with no approved task, no opt-out check and no rate limit. The header of
`packages/core/src/gmail.ts` states this at the call site, which is the only place
it can actually stop somebody.

**Amendment: `daily_send_cap: 0` means paused, and says so.** A cap of 0 used to
produce "the cap has been reached, it will retry tomorrow", which is a promise
the code cannot keep — tomorrow's cap is also 0. It now says sending is paused
and names `/brain`. This matters because a cap of 0 is the recommended way to
bring the webhook up with nothing able to leave (see §6 step 8 and the `DRY_RUN`
note in `STATUS.md`).

**Autonomy ladder:** built now, locked at level 1. Nothing leaves the system to a third party above level 1 in v1. After 20 approvals of a task type with no edit, the UI surfaces a promotion prompt to level 2 — the prompt is built, the promotion is not enabled.

---

## 7.1 Send windows and deliverability

Two separate concerns that both live in the send path.

### Send window — when a message actually leaves

Approving a task doesn't send it; it sets `send_after` and the worker's 60-second poller does the rest. `send_after` is computed as: **the next slot inside the recipient's local business hours, plus 2–15 minutes of jitter.** Default window is Tue–Thu, 09:00–16:00 in `contacts.timezone`, stored in `settings.send_window`.

For Greek contacts this is almost always "in the next few minutes" — the owner works the same hours they do. It matters for contacts abroad, where the point is not open rates but that **a message arriving at 03:00 local reads as a machine**, and the whole value of these drafts is that they read as him.

Deliberately *not* an optimisation agent. The send-time literature is bulk-marketing data, the studies contradict each other on which days win, and the honest ones concede that timing never rescues a bad email. Revisit in six months when `interactions` holds enough real reply data to measure something; until then a fixed rule captures nearly all the value at zero cost.

`timezone` is derived from `country`/`city` on contact creation and defaults to `Europe/Athens`.

**Amendment (step 8). The window is per-agent: an inbox reply keeps the hours and
drops the days.** Everything argued above is about *outbound* mail nobody asked
for — the reason a fixed rule is enough is that the recipient is not waiting.
A reply is the opposite case. Applied unchanged, the Tue–Thu window answers a
question asked on Thursday evening on the following Tuesday: five days, visibly
("Sends Tuesday from 09:00."), with no override anywhere in the code.
`windowForAgent` keeps the configured `start_hour`/`end_hour` for
`agent = 'inbox'` — 03:00 still reads as a machine, and that argument survives —
and drops the day restriction. This plan never decided it; step 8 inherited it.
It is decided now.

### Deliverability ramp — how much leaves per day

A new domain sending 40 messages on day one lands in spam and stays there. `settings.daily_send_cap` ramps:

| Week | Cap/day |
|---|---|
| 1 | 10 |
| 2 | 20 |
| 3 | 30 |
| 4+ | 40 |

Bumped manually in `/brain` — four edits over a month, not worth automating.

Before the first send, non-negotiable: **SPF, DKIM and DMARC configured on the domain.** Google Workspace sets these up, but they must be verified as live — without them the ramp accomplishes nothing.

The favourable part of this situation is worth stating: these are follow-ups to people who have actually met him, so they generate real replies, and replies are the strongest positive reputation signal Gmail has. This is not cold outbound and should not perform like it.

### GDPR position

Follow-up to someone who handed over a business card is the easy case — Article 6(1)(f) legitimate interest, no prior consent needed for B2B. The obligations are the footer contents listed in §7, all four of them.

One flag to carry: **Germany requires prior consent for B2B commercial email** under UWG, unlike Greece, France, or the UK. If German companies enter the pipeline, that's a per-contact flag that suppresses automated follow-up, not something the footer solves. Not built in v1 — noted so it isn't discovered the hard way.

---

## 8. Environment variables

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=      # worker only

# Auth
ALLOWED_EMAIL=

# Anthropic
ANTHROPIC_API_KEY=

# Gmail
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
GMAIL_PUBSUB_TOPIC=             # full resource name: projects/<project-id>/topics/<topic>
GMAIL_WEBHOOK_SECRET=
GMAIL_WEBHOOK_AUDIENCE=         # ADDED (step 8): must equal the subscription's OIDC audience
GMAIL_PUBSUB_SERVICE_ACCOUNT=   # ADDED (step 8): the email claim in the subscription's OIDC token

# Web Push
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# Compliance footer (GDPR — all four elements required)
BUSINESS_NAME=
BUSINESS_ADDRESS=               # physical address, required on every outbound email
PRIVACY_POLICY_URL=

# Behaviour
DRY_RUN=true                    # default true in development
TZ=Europe/Athens
```

`GMAIL_REFRESH_TOKEN` must carry **both** `gmail.send` and
`https://www.googleapis.com/auth/gmail.readonly` from step 8 onward. A send-only
token starts fine and fails on the first mailbox read. See §6 step 8.

**`DRY_RUN` stays one flag, deliberately.** It gates `users.watch`, the Gmail
send and Web Push together, which means the webhook path cannot be brought up
without also arming real outbound mail. Splitting it into `DRY_RUN_WATCH` and
`DRY_RUN_SEND` was proposed and rejected: the watch stub exists for a stated
reason — there is one Gmail account, so a dev machine registering a watch
*diverts the production mailbox's notifications* — and a second flag is new
config surface for a problem that already has two answers. `daily_send_cap: 0`
(§7) or the kill switch (§6 step 8, now watch-safe) both bring the webhook up
with nothing able to leave. The procedure is written into `README.md` instead of
coded around.

---

## 9. Open questions for the owner

None block step 1. Answer them before the step they gate.

1. **Gmail Pub/Sub topic** (gates step 8) — needs a Google Cloud project with Pub/Sub enabled. Worth setting up early; the OAuth consent screen can take a day to sort out.

   **Still open, and now written up.** This one line was the entire guidance and
   it was not enough — it omits the topic's required resource-name format, the
   `roles/pubsub.publisher` grant to `gmail-api-push@system.gserviceaccount.com`
   (whose absence produces a 403 that looks like a scope problem), the push
   subscription's OIDC audience and service account, and the `gmail.readonly`
   scope. `README.md` §"Bringing the mailbox up" is the procedure. It was written
   from the code rather than from experience and has never been followed, so
   expect it to be wrong somewhere the first time.
2. **Brain content** (gates step 5) — now lives in `brain/*.md`, one file per key, edited as plain text and loaded with `pnpm seed`. See `brain/README.md`. The follow-up agent drafts *entirely* from `brain`. `services`, `positioning`, `pricing` and the two `tone_of_voice` entries are the highest-leverage text in the system; they are effectively the agent's model of what the business sells and how it talks.

   Two specifics settled in discussion, still to be written up:
   - **Scope is broader than websites.** Apps, e-commerce, NFC cards — the through-line is helping people get online and make money from it, or get an idea built. If `services` says "web development," the agent will pitch a website to someone who came about an app.
   - **If there are distinct segments** (a taverna wanting bookings vs. someone with an app idea), name them explicitly. The register for those two is completely different and the agent will otherwise flatten both into one voice.

   This text has to be the owner's own words.
3. **CSV shape** (gates step 1) — whatever the existing contacts live in now. Column mapping is written once the file exists.
4. **Physical business address** (gates step 6) — required in the compliance footer of every outbound email. Registered address is fine. **Still open.** `BUSINESS_NAME`, `BUSINESS_ADDRESS` and `PRIVACY_POLICY_URL` are all unset; the send function refuses without them, dry run included. The privacy URL also has to resolve to a page that is actually published somewhere, and nothing decides where that page is hosted.

5. **The sending domain** (gates the first live send, added after step 6) — SPF, DKIM and DMARC must be configured and verified live. §7.1 calls this non-negotiable and never says on which domain. No domain has been chosen. This is the one blocker that cannot be undone by fixing it later: mail that lands in spam teaches Gmail that mail from this domain belongs in spam, which is precisely what the `daily_send_cap` ramp exists to avoid buying.
