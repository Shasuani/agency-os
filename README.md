# Agency OS

Internal operations app for a solo web development business in Greece. One
operator, one laptop, one dashboard opened once a day. Background agents do the
work on a schedule, draft messages, and put them in an approval queue — the
owner approves, edits, or skips.

Purpose: **no warm lead is ever forgotten.**

Nothing here has run against real data. `ANTHROPIC_API_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` are the literal string `placeholder`, there are zero
contacts, and no human has read a draft this system produced. Read every claim
in this repo as "the code and its tests say so", never as "it was observed".
**[SETUP.md](./SETUP.md)** is the procedure that changes that; `STATUS.md`
tracks how far it has got.

## The documents

| File | What it is |
|---|---|
| [SPEC.md](./SPEC.md) | The product spec. What the thing is for. |
| [PLAN.md](./PLAN.md) | The working plan — resolved decisions, schema, guardrails, env vars, the ten-step build order. |
| [SETUP.md](./SETUP.md) | The one-time operator procedure: keys, database, brain, Google Cloud, deploys, and the order to turn `DRY_RUN` off in. Every step says how you know it worked. |
| [STATUS.md](./STATUS.md) | What is actually done versus written. The file that exists because "the tests pass" and "it works" are different sentences. |
| [apps/web/DESIGN.md](./apps/web/DESIGN.md) | The design system. If a screen contradicts it, the screen is wrong. |
| [brain/README.md](./brain/README.md) | How to write the business facts the agents draft from. This is the product; the code is scaffolding around it. |
| [scripts/CONTACTS_CSV.md](./scripts/CONTACTS_CSV.md) | The CSV contract for the contact importer. |

`SPEC.md` and `PLAN.md` are the source of truth for decisions. This README only
says what the system is and how to run it locally.

## What it does

Three scheduled jobs and one webhook, all in the worker process:

| | When | What |
|---|---|---|
| **Follow-up agent** | 08:00 Europe/Athens, daily | Selects contacts whose `next_touch_at` has come round, drafts one message each from `brain` + that contact's history, files them as cards. Drafts; sends nothing. Sends one push at the end of the run. |
| **Send queue** | every 60 seconds | Takes approved cards whose `send_after` has arrived and hands them to Gmail, inside the send window, behind every guardrail. Sends; decides nothing. |
| **Inbox agent** | Gmail `users.watch` → Pub/Sub → `POST /webhooks/gmail`, plus a 15-minute sweep as insurance | Reads new mail from a stored history cursor, classifies it, matches or creates the contact, routes it: draft a reply, file a reminder, or stay silent. |

And five screens in the web app: **Today** (`/`, the approval queue),
**`/pipeline`** (contacts, stages, dates), **`/inbox`** (what arrived and what
was decided), **`/brain`** (business facts, kill switch, autonomy, caps, send
window, notification toggle), **`/login`**.

Approving is instant by construction: it writes `send_after` and returns, and the
poller does the rest, so a redeploy between approval and send loses nothing.

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 15 App Router, TypeScript, Tailwind v4 → Vercel |
| Worker / cron | Node service run via `tsx` → Railway. The schedule is in-process and hand-rolled; the header of `apps/worker/src/index.ts` argues out `node-cron` rather than adding it |
| DB + auth | Supabase (Postgres, RLS, single user, password login) |
| Email | Gmail API (OAuth, the owner's own account) |
| LLM | Anthropic API — `claude-sonnet-5` for drafting, `claude-haiku-4-5` for classification |

## Layout

```
agency-os/
├── apps/
│   ├── web/        @agency/web    — Next.js app. Server actions in lib/, screens in app/(app)/
│   └── worker/     @agency/worker — jobs/ (followup, send-queue, inbox, digest, push),
│                                    routes/ (the Gmail webhook), index.ts (schedule + HTTP)
├── packages/
│   └── core/       @agency/core   — db client, types, settings, env, llm wrapper, cadence,
│                                    guardrails, send window, Gmail send + read + MIME
├── brain/          the business facts the agents draft from, as Markdown
├── supabase/       migrations, seed.sql, SETUP_RUN_ME.sql
└── scripts/        operator scripts (not a workspace): seed-brain, import-contacts, llm-probe
```

pnpm workspaces, no Turborepo. ESM throughout, Node 22+. `@agency/core` is
consumed as **TypeScript source** (`"main": "./src/index.ts"`) — Next picks it up
via `transpilePackages`, the worker runs it through `tsx`. There is no build step
for it.

`@agency/core` has a barrel rule: anything that value-imports the Anthropic SDK,
a network client, or the service-role Supabase client is reachable only by
subpath — `@agency/core/llm`, `/gmail`, `/gmail-read`, `/guardrails` — never from
the index.

Three more subpaths exist for the opposite reason. `/cadence`, `/send-window` and
`/zone` are pure leaves that import nothing; they are off the barrel so a Client
Component can reach timezone arithmetic without dragging `@supabase/supabase-js`
in behind it. The header of `packages/core/src/index.ts` argues each one.

## Running it locally

Full procedure, including the database and every credential, is
**[SETUP.md](./SETUP.md)**. The short version once that is done:

```bash
nvm use 22
pnpm install
pnpm dev                      # web on :3000, worker on :3001
curl -s localhost:3001/health
```

`pnpm dev` runs both apps in parallel. The worker asserts
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` at boot and exits 1 if
either is missing, so a successful `/health` is also proof the root `.env` is
being read.

**One `.env`, at the repo root, serves everything** — nothing loads it
implicitly, so each entry point is wired to it explicitly:

| Consumer | How it loads the root `.env` |
|---|---|
| `apps/worker` | `tsx --env-file-if-exists=../../.env` in its `dev`/`start` scripts |
| `apps/web` | `loadRootEnv()` at the top of `apps/web/next.config.ts` — Next reads `.env` from `apps/web/` only and does not walk up |
| `scripts/` | `tsx --env-file-if-exists=.env` in the root `seed` / `import:contacts` scripts |

In production there is no file: Vercel and Railway supply platform variables, and
a value already in the environment always wins over the file. Which variable
belongs to which deploy — and why `SUPABASE_SERVICE_ROLE_KEY` never goes on
Vercel — is the table in SETUP.md §6.1.

Three loopback-only routes drive the jobs by hand, which is how the whole system
is exercised without Pub/Sub, a public URL or an OIDC audience:

```bash
curl -s localhost:3001/jobs/followup/run     # the morning run
curl -s localhost:3001/jobs/send-queue/run   # drain the queue
curl -s localhost:3001/jobs/inbox/run        # read the mailbox
```

All three answer `202` and report their result to the log and to `/health`.
`GET /health` from a non-loopback caller answers with liveness and nothing else;
`POST /webhooks/gmail` is the one route meant to be reachable from the internet
and carries its own two checks.

### Bringing the mailbox up

This section used to live here. It is now **[SETUP.md](./SETUP.md) Phases 4–9** —
sending domain, OAuth client and refresh token, Pub/Sub topic and subscription,
VAPID, the deploy split, and the order to set `DRY_RUN=false` in. The heading is
kept because `STATUS.md` and `PLAN.md` §9 point at it by name.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Every workspace's `dev`, in parallel |
| `pnpm dev:web` / `pnpm dev:worker` | One of them |
| `pnpm typecheck` | `tsc --noEmit` across all workspaces, plus `scripts/` |
| `pnpm test` | Unit tests across all workspaces — currently 1008, 0 failing |
| `pnpm seed` | Loads `brain/*.md` into the `brain` table. Dry run by default; `--commit` writes |
| `pnpm import:contacts <csv>` | Imports contacts. Dry run by default; `--commit` writes |
| `pnpm exec tsx scripts/llm-probe.ts` | One real model call, to prove the key and the `agent_runs` accounting. `--no-db` skips Supabase |

`settings` is seeded by SQL (`supabase/seed.sql`), not by a script — it sits next
to the migrations because that is the one time it needs running.

## Build order

Nine steps, each deployed and used before the next starts. Step 10 is gated.

A ticked box means **the code is written and its tests pass**. It does not mean
the step has been exercised against real data — see the note at the top, and
`STATUS.md`.

- [x] **1 — Foundation.** Monorepo, Supabase project, schema, `brain` seeded, contacts imported.
      *Not done until `brain` holds the owner's real words and real contacts exist.*
- [x] **2 — `/pipeline`.** List, create, edit contacts. Manual `next_touch_at`. Stage dropdown. No AI.
- [x] **3 — Cadence functions.** `packages/core/src/cadence.ts`, pure and unit tested.
- [x] **4 — LLM wrapper.** `llm.ts` + `agent_runs` logging, cost ceiling, retry-once-then-alert.
- [x] **5 — Follow-up agent.** 08:00 Europe/Athens. *Its acceptance criterion — a human reads the drafts — has never been met. SETUP.md Phase 3.*
- [x] **6 — Today page + approve + send.** Task cards, `j`/`k`/`e`/`Enter`, Gmail send with the local-time window and jitter.
- [x] **7 — Notifications.** Web Push subscription + one digest at the end of the morning run.
- [x] **8 — Inbox agent.** Gmail `users.watch` → Pub/Sub → webhook, classify, route, reply in-thread.
- [x] **9 — Edit-as-training-data.** `final_body` vs `draft_body` fed back as style examples.
- [ ] **10 — Lead Research.** Specified separately (kept out of this repo). Deliberately not built.

### Step 10 is specified and deliberately not built

A separate specification (not published in this repo) covers an agent that finds the *next* warm lead
rather than making sure the existing ones are not forgotten. None of it exists in
this repo, and `PLAN.md` §6 gates it on four conditions:

1. Steps 1–9 shipped and in daily use
2. 50+ contacts in the database
3. The follow-up drafts trusted without reading every word
4. A separate sending domain, registered and warmed

**None of the four currently holds.** Cold outreach on the same domain as the
follow-ups poisons the reputation the follow-ups depend on, and a researched
stranger written into `contacts` would be picked up by the step-5 agent and
mailed as though you had met. Both failure modes are argued out in the spec.

No finance, content, trends, design, or legal agents either — not until 50+
contacts are in the database and the daily loop is genuinely in use.

## Conventions

- All timestamps are `timestamptz`, stored as UTC. Anything timezone-aware — the
  08:00 trigger, cadence math, send windows — resolves `Europe/Athens` explicitly
  and never reads the host clock.
- Every LLM call goes through `packages/core/src/llm.ts`. Nothing else imports
  `@anthropic-ai/sdk`.
- Guardrails live in `packages/core/src/guardrails.ts` and are called from the
  **send** path, not the draft path.
- Untrusted text — anything a stranger wrote — is fenced and bounded before it
  reaches a prompt. `apps/worker/src/jobs/prompt-fence.ts`.
- Customer data never reaches a `console.*` call.
- Tests are colocated `*.test.ts` on `node:test` + `node:assert/strict`. No
  network, no database, no API key.
- Web: Tailwind v4 tokens only. No hex, no default-palette classes, no `dark:`
  variants. `apps/web/DESIGN.md` is the rulebook.
- `DRY_RUN=true` is the default. Agents run, drafts are written and cost real
  money; the Gmail *send*, the `users.watch` registration and Web Push are
  stubbed. Those three interact — SETUP.md Phase 9 is the order to switch it off
  in.
- One runtime dependency outside the frameworks: `web-push`, in `apps/worker`.
  Everything Google- or Anthropic-shaped is hand-rolled against `fetch`
  (`packages/core/src/gmail.ts` argues that case for `googleapis`). `web-push` is
  the exception because the alternative is implementing VAPID JWT signing and RFC
  8291 payload encryption by hand, which is cryptography rather than two POSTs.
  It also ships `web-push generate-vapid-keys`.
