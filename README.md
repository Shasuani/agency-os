# Agency OS

Internal operations app for a solo web development business in Greece. One operator, one laptop, one dashboard opened once a day. Background agents do the work on a schedule, draft messages, and put them in an approval queue — the owner approves, edits, or skips.

Purpose: **no warm lead is ever forgotten.**

`SPEC.md` is the product spec. `PLAN.md` is the working plan — resolved decisions, schema, guardrails, env vars, and the step-by-step build order. Both are the source of truth; this README only tells you how to run the thing.

## Stack

| Layer | Choice |
|---|---|
| App | Next.js (App Router), TypeScript, Tailwind → Vercel |
| Worker / cron | Node service, `node-cron`, run via `tsx` → Railway |
| DB + auth | Supabase (Postgres, magic link, single user) |
| Email | Gmail API (OAuth, the owner's own account) |
| LLM | Anthropic API — `claude-sonnet-5` for drafting, `claude-haiku-4-5` for classification |

## Layout

```
agency-os/
├── apps/
│   ├── web/        @agency/web    — Next.js app
│   └── worker/     @agency/worker — cron jobs + Gmail webhook
└── packages/
    └── core/       @agency/core   — db client, types, llm wrapper, cadence, guardrails
```

pnpm workspaces, no Turborepo. ESM throughout, Node 22+. `@agency/core` is consumed as **TypeScript source** (`"main": "./src/index.ts"`) — Next.js picks it up via `transpilePackages`, the worker runs it through `tsx`. There is no build step for it.

## Build order

Nine steps. Each one is deployed and used before the next starts. Stop at 9.

- [ ] **1 — Foundation.** Repo, pnpm workspaces, Supabase project, schema migration applied, `brain` seeded with real content, contacts imported from CSV.
      *Scaffold is in place; the step is not done until `brain` holds the owner's real words and the CSV import has actually run.*
- [ ] **2 — `/pipeline`.** List, create, edit contacts. Manual `next_touch_at`. Stage dropdown. No AI.
- [ ] **3 — Cadence functions.** `packages/core/src/cadence.ts`, pure and unit tested.
- [ ] **4 — LLM wrapper.** `llm.ts` + `agent_runs` logging, cost ceiling, retry-once-then-alert.
- [ ] **5 — Follow-up agent.** 08:00 Europe/Athens on cron, dry run on.
- [ ] **6 — Today page + approve + send.** Task cards, `j`/`k`/`e`/`Enter`, Gmail send with the local-time window and jitter. `DRY_RUN` off.
- [ ] **7 — Notifications.** Web Push subscription + one daily digest after the morning run.
- [ ] **8 — Inbox agent.** Gmail `users.watch` → Pub/Sub → webhook, classify, route.
- [ ] **9 — Edit-as-training-data.** Feed `final_body` vs `draft_body` back as style examples.

No finance, content, trends, design, or legal agents until 50+ contacts are in the database and the daily loop is genuinely in use.

## Setup

Run these in order, from the repo root. **Steps 2 and 3 are manual and cannot be automated** — creating the Supabase project and copying its credentials happens in a browser, by hand, and the credentials never get committed.

**1. Install dependencies.**

```bash
pnpm install
```

**2. Create the Supabase project (manual, in a browser).**

Go to <https://supabase.com/dashboard> → **New project**. Pick the region closest to Greece (`eu-central-1`), set a database password, and wait for it to provision.

Then, in the same dashboard, three settings that are part of the security model and are **not** in the repo:

- **Authentication → URL Configuration → Redirect URLs.** Add the exact deploy origin(s), e.g. `https://your-app.vercel.app/auth/callback` and `http://localhost:3000/auth/callback`. No wildcards. This list is what stops a magic link being pointed at somebody else's origin.
- **Authentication → Sign In / Providers → Email → "Allow new users to sign up".** Turn this **off** — *after* your first successful sign-in. This app needs exactly one user and never creates a second. Leaving it on means anyone can mint a JWT against the public anon key.
- The `anon` key is public by design (it ships in the browser bundle). Everything that protects the data is RLS — see setup step 4.

**3. Copy the credentials into `.env` (manual).**

```bash
cp .env.example .env
```

Then in the Supabase dashboard, **Settings → API**, copy:

- Project URL → `NEXT_PUBLIC_SUPABASE_URL`
- `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `service_role` `secret` key → `SUPABASE_SERVICE_ROLE_KEY`

Set `ALLOWED_EMAIL` to the one email address allowed to sign in. Leave everything else empty for now — each remaining variable is annotated in `.env.example` with the build step that needs it. `.env` is gitignored; keep it that way.

**One `.env`, at the root, serves everything** — nothing in this repo loads it implicitly, so each entry point is wired to it explicitly:

| Consumer | How it loads the root `.env` |
|---|---|
| `apps/worker` | `tsx --env-file-if-exists=../../.env` in its `dev`/`start` scripts |
| `apps/web` | `loadRootEnv()` at the top of `apps/web/next.config.ts` — Next.js reads `.env` from `apps/web/` only and does **not** walk up to the workspace root |
| `scripts/` | `tsx --env-file-if-exists=.env` in the root `seed` / `import:contacts` scripts |

In production there is no file: Vercel and Railway supply these as platform variables, and a value already present in the environment always wins over the file. (`--env-file-if-exists` needs Node 22.9+.)

**4. Apply the schema migration, then the settings seed.**

Open the Supabase dashboard → **SQL Editor** and run three files, in this order:

1. `supabase/migrations/20260731120000_init.sql` — creates `brain`, `contacts`, `interactions`, `tasks`, `agent_runs`, `settings` and `push_subscriptions`, plus their indexes and CHECK constraints.
2. `supabase/migrations/20260731140000_rls_operator_only.sql` — replaces the initial "any authenticated user" RLS policy with `is_operator()`, which matches the JWT's email against one address. **Not optional.** Without it, anyone holding the public anon key can sign up and read and write every contact directly through PostgREST, because none of the app's `ALLOWED_EMAIL` checks run there.
3. `supabase/seed.sql` — inserts the `settings` rows: `kill_switch`, `autonomy`, `daily_send_cap`, `daily_cost_cap`, `send_window`.

Then tell the database who the operator is — the same address as `ALLOWED_EMAIL`:

```sql
insert into public.settings (key, value)
values ('allowed_email', to_jsonb('you@example.com'::text))
on conflict (key) do update set value = excluded.value, updated_at = now();
```

Until that row exists `is_operator()` returns false and every table reads as empty. That is deliberate — it fails closed. The worker is unaffected either way: it uses the service role key, which bypasses RLS.

All three files are idempotent and safe to re-run. Skipping the seed is not fatal — reads fall back to `SETTING_DEFAULTS` in `packages/core/src/settings.ts` — but there is then nothing in the table for the operator to edit in `/brain`.

**5. Seed `brain`.**

```bash
pnpm seed             # dry run — prints what would change, writes nothing
pnpm seed --commit    # write it
```

Dry run is the default, on purpose. `brain` has exactly one seeder, `scripts/seed-brain.ts`, and it is re-runnable: edit the `BRAIN` constant, dry run, commit. A key still holding the shipped placeholder will not overwrite different content already in the database (`--force` overrides).

These seeds are only useful once they contain the owner's real words — `services`, `positioning`, `pricing` and the two `tone_of_voice` entries are what the follow-up agent drafts from, and placeholders produce placeholder emails.

**6. Import contacts from CSV.**

```bash
pnpm import:contacts <path-to-csv>             # dry run
pnpm import:contacts <path-to-csv> --commit    # write it
```

Dry run is the default here too, and it prints every contact it would insert, every duplicate it would skip and every rejected row with a reason. Column mapping and the full CSV contract live in `scripts/CONTACTS_CSV.md`. Keep the CSV outside the repo, or use a filename covered by `.gitignore` — it is personal data.

**7. Verify.**

```bash
pnpm typecheck
pnpm dev
curl localhost:3001/health
```

`pnpm dev` runs both apps in parallel. The worker asserts `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` at boot and exits 1 if either is missing, so a successful `/health` response is also proof that the root `.env` is being loaded.

Step 1 is done when real contacts are queryable in Supabase and `brain` holds actual services and pricing text, not placeholders.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Runs every workspace's `dev` in parallel |
| `pnpm dev:web` | Next.js app only |
| `pnpm dev:worker` | Worker only |
| `pnpm typecheck` | `tsc --noEmit` across all workspaces, plus `scripts/` (which is not a workspace) |
| `pnpm test` | Unit tests across all workspaces |
| `pnpm seed` | Seeds `brain`. Dry run by default; `--commit` writes |
| `pnpm import:contacts <csv>` | Imports contacts from a CSV. Dry run by default; `--commit` writes |

`settings` is seeded by SQL (`supabase/seed.sql`, setup step 4), not by a script — it sits next to the migration because that is the one time it needs running.

## Conventions

- All timestamps are `timestamptz`, stored as UTC. Anything timezone-aware — the 08:00 trigger, cadence math, send windows — uses `Europe/Athens` explicitly.
- Every LLM call goes through `packages/core/src/llm.ts`. Nothing else imports `@anthropic-ai/sdk`.
- Guardrails live in `packages/core/src/guardrails.ts` and are called from the **send** path, not the draft path.
- `DRY_RUN=true` is the default in development: agents run, tasks are created, Gmail send is stubbed and logged.
