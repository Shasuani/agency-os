# Agency OS — build spec

Internal operations app for a solo web development business in Greece. One operator. Purpose: no warm lead is ever forgotten.

Read this whole file before writing code. Follow the build order. Do not build features listed under "Explicitly out of scope for v1".

## 1. What this is

A dashboard the owner opens once a day on a laptop. Background agents do work on a schedule, draft messages, and put them in an approval queue. The owner approves, edits, or rejects. Nothing is sent to a third party without approval in v1.

It is not a chat app. Chat requires the user to show up. This app does work while he is heads-down on client projects for two weeks at a time.

Success condition for v1: every contact who has ever spoken to him gets followed up on time, without him remembering to do it.

## 2. Stack

| Layer | Choice |
|---|---|
| App | Next.js (App Router), TypeScript |
| Hosting | Vercel |
| DB + auth | Supabase (Postgres) |
| Worker / cron | Separate Node service on Railway (Vercel functions time out) |
| Email | Gmail API (OAuth, his own account) |
| LLM | Anthropic API |
| Styling | Tailwind |

Single repo, two deployables: `apps/web` (Next.js) and `apps/worker` (Node). Shared `packages/core` for db client, types, and agent code.

**Model routing** — cost matters, this runs daily:

- Classification / routing / scoring → `claude-haiku-4-5-20251001`
- Drafting messages, reasoning about a contact → `claude-sonnet-5`
- Do not use Opus anywhere in v1.

Every LLM call goes through one wrapper in `packages/core/llm.ts` that logs model, tokens, latency, and cost to the `agent_runs` table. No raw SDK calls scattered around.

## 3. Data model

This is the important part. Get it right and new agents plug in without a rewrite.

### brain

Business facts every agent reads before acting. Editable in the UI.

```
key         text primary key
value       text not null
updated_at  timestamptz default now()
```

Seed keys: `services`, `pricing`, `tone_of_voice_en`, `tone_of_voice_el`, `case_studies`, `positioning`, `availability`, `retainer_offer`.

### contacts

```
id              uuid pk
name            text
business        text
email           text
phone           text
language        text default 'el'          -- 'el' | 'en'
city            text
country         text default 'GR'
source          text                       -- 'nfc_card' | 'referral' | 'inbound' | 'outbound' | 'walk_in'
stage           text default 'new'
value_estimate  numeric
notes           text
last_touch_at   timestamptz
next_touch_at   timestamptz
touch_count     int default 0
do_not_contact  boolean default false
created_at      timestamptz default now()
```

Stages: `new → contacted → replied → quoted → won | lost | dormant`. `won` contacts become clients and move to a retainer cadence.

Index on `next_touch_at` and `stage`.

### interactions

Append-only log of every touch, in both directions.

```
id          uuid pk
contact_id  uuid references contacts on delete cascade
direction   text          -- 'in' | 'out'
channel     text          -- 'email' | 'phone' | 'in_person' | 'whatsapp' | 'form'
subject     text
body        text
occurred_at timestamptz default now()
meta        jsonb         -- gmail message id, thread id, etc.
```

### tasks

The approval queue. Everything an agent wants the owner to see.

```
id              uuid pk
agent           text        -- 'followup' | 'inbox' | 'finance' | ...
type            text        -- 'draft_email' | 'reminder' | 'alert'
contact_id      uuid null references contacts
title           text
reasoning       text        -- why the agent is proposing this, shown in the card
draft_subject   text
draft_body      text
final_body      text        -- what the owner actually sent, after edits
status          text default 'pending'   -- 'pending' | 'approved' | 'sent' | 'rejected' | 'skipped'
autonomy_level  int default 1
created_at      timestamptz default now()
resolved_at     timestamptz
```

Edits are training data. When `final_body` differs from `draft_body`, that pair gets fed back as a style example on future drafts for that language. Build the storage now even if the feedback loop lands in week 4.

### agent_runs

Observability. Every agent execution, success or failure.

```
id             uuid pk
agent          text
trigger        text        -- 'cron' | 'webhook' | 'manual'
input          jsonb
output         jsonb
status         text        -- 'ok' | 'error'
error          text
model          text
input_tokens   int
output_tokens  int
cost_usd       numeric
duration_ms    int
created_at     timestamptz default now()
```

Without this table, debugging why an agent did something odd three days ago is impossible.

## 4. The follow-up agent (build this first)

Runs daily at 08:00 Europe/Athens.

Flow:

1. Select contacts where `next_touch_at <= now()`, `do_not_contact = false`, stage not in (`won`, `lost`).
2. For each, load the contact row, the last 10 interactions, and the whole brain.
3. One Sonnet call per contact. Returns strict JSON:

```json
{
  "should_contact": true,
  "reason": "Quoted 21 days ago, no reply, was previously enthusiastic",
  "subject": "...",
  "body": "...",
  "suggested_next_touch_days": 14,
  "confidence": "high"
}
```

4. If `should_contact` is false, push `next_touch_at` out and log it. No task created.
5. If true, insert a pending task.
6. One push notification at the end: "4 follow-ups ready."

Prompting rules for the drafting call:

- System prompt is assembled from brain, not hardcoded.
- Write in the contact's language. Greek contacts get Greek, formal register (πληθυντικός ευγενείας) unless prior interactions show otherwise.
- Short. Under 120 words. No corporate filler, no "I hope this email finds you well."
- One clear ask per message.
- Never invent facts, prices, or timelines not present in brain or interactions.
- If there is nothing genuine to say, return `should_contact: false`. A skipped follow-up is better than a filler one.

Cadence defaults (`packages/core/cadence.ts`, pure functions, unit tested):

| Situation | Next touch |
|---|---|
| New lead, no reply | +3 days, then +7, then +14, then dormant |
| Quoted, no reply | +5 days, then +10, then +21 |
| Bought an NFC card | +14 days (check-in + web upsell) |
| Won / active client | +30 days |
| Project delivered | +30 days (referral + testimonial ask) |
| Dormant | +90 days |

## 5. The inbox agent (build second)

Gmail `users.watch` → Pub/Sub → webhook. On each new message:

1. Match sender against contacts. If no match, create a contact with `source: 'inbound'`.
2. Classify with Haiku, strict JSON, one of: `new_lead | interested | question | objection | not_interested | scheduling | invoice | spam | not_business`
3. Write an `interactions` row regardless.
4. Route:
   - `not_interested` → set stage `lost`, `do_not_contact = true`, no notification
   - `spam` / `not_business` → log only
   - everything else → draft a reply with Sonnet, create a pending task
   - `new_lead` / `interested` → immediate push notification, everything else waits for the daily digest

The silent handling of `not_interested` matters as much as the loud handling of hot leads. If the app pings 20 times a day it gets muted and the project dies.

## 6. UI

Six routes: `/` (Today), `/inbox`, `/pipeline`, `/content`, `/money`, `/brain`. Only `/`, `/inbox`, `/pipeline`, and `/brain` exist in v1. The other two are stubs.

Today is the only page that matters. Top row: four metric tiles (needs you, open leads, unpaid, done today). Below: pending task cards, newest first. Below that: a collapsed "handled without you" list.

Task card: agent badge, contact name + context line, the reasoning in one sentence, the draft body in an editable textarea, three buttons — approve and send, save edit, skip. Approving sends via Gmail with a random 2–15 minute delay.

**Design direction.** This is an internal tool used every morning by one person, so it should feel like a fast instrument rather than a marketing site: dense, quiet, high information density, keyboard-first. Give it a real point of view rather than default shadcn-on-white — pick a restrained palette and one characterful typeface for numbers and headings, and let the task cards be the one place with any visual weight. Keyboard shortcuts are a feature, not a nicety: `j`/`k` to move between cards, `e` to edit, `Enter` to approve. The daily loop should be completable in 90 seconds without a mouse.

Empty state on Today is a success state, not a blank: "Nothing needs you. 9 things handled." Say what happened, don't apologise for the emptiness.

## 7. Autonomy ladder

Every task type has a level, stored in config, promoted manually by the owner.

| Level | Behaviour |
|---|---|
| 0 | Ask before drafting |
| 1 | Draft, wait for approval ← everything starts here |
| 2 | Send, then notify |
| 3 | Do silently, log only |

Hard rule for v1: nothing leaves the system to a third party above level 1. Build the ladder, ship it locked at 1. After the owner has approved a given task type 20 times without editing, the UI surfaces a prompt offering promotion to level 2.

## 8. Guardrails

- No message sends without an approved task row. No exceptions, no "quick send" path.
- Rate limit: max 40 outbound emails/day, max 1 message per contact per 48h.
- Every outbound email includes a plain-text opt-out line. `do_not_contact` is permanent and checked at send time, not just at draft time.
- Kill switch in `/brain`: one toggle that pauses every cron and blocks all sends.
- If an agent run errors, it retries once, then creates an alert task. It never silently swallows the failure.
- Dry-run mode via env var: agents run, tasks are created, Gmail send is stubbed. Default to dry-run in development.

## 9. Build order

Do not skip ahead. Each step should be deployed and used before the next starts.

1. Repo, Supabase project, schema migration, seeded brain, contact import from CSV
2. `/pipeline` — list, create, edit contacts. Manual `next_touch_at`. No AI yet.
3. Cadence functions + unit tests
4. LLM wrapper + `agent_runs` logging
5. Follow-up agent, dry-run, on a cron
6. `/` Today page + task cards + approve flow + Gmail send
7. Push notifications, one daily digest
8. Gmail read + classify + inbox agent
9. Edit-as-training-data feedback loop

Stop at 9. Do not add finance, content, trends, design, or legal agents until there are 50+ contacts in the database and the daily loop is genuinely being used.

## 10. Explicitly out of scope for v1

Multi-tenancy. Auth beyond a single Supabase user. Billing. A design agent. A trends feed. Cold outbound sequencing. Invoice generation. Anything with the word "dashboard analytics" in it. A mobile app — the PWA is enough.

If a decision would only matter for a second user, make the simple choice and move on. This is a tool for one person until proven otherwise.
