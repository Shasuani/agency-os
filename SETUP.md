# SETUP — from placeholder keys to a morning loop that runs for real

This is the one-time procedure. Everything in it is manual, most of it happens
in a browser, and none of it has ever been performed: the repo's two most
important secrets are currently the literal string `placeholder`, the database
holds zero contacts, and no human has read a draft this system produced.
`STATUS.md` tracks that gap. This file closes it.

Read every "how you know it worked" line as the actual end of the step. A setup
guide whose steps cannot be verified is a guide that fails silently, and this
system has several failures that are silent by construction — a missing unique
index does not raise anything, a Pub/Sub IAM grant that was never made looks
like an expired OAuth token, and a `push_subscriptions` table with no rows makes
every notification a logged no-op.

## The order, and why it is this order

Cheap and reversible first. A wrong Anthropic key costs you a retry; a wrong
DNS record costs you two days; publishing an OAuth consent screen for a
restricted Gmail scope costs you weeks and cannot be rushed. So the phases below
put everything you can undo in an afternoon before anything you cannot.

Two things are slow and should be **started early even though they appear late
in the dependency order**:

| Slow thing | Realistic time | Start it at |
|---|---|---|
| DKIM/SPF/DMARC propagation and Google's own DKIM activation | up to 48 hours after you publish the TXT record | Phase 4, in parallel with Phase 3 |
| OAuth consent screen, if the account is **not** Google Workspace | days to weeks — `gmail.readonly` is a restricted scope and publishing needs a security assessment | Phase 5, and read 5.2 before you touch anything else there |
| Domain warm-up (the send cap ramp 10 → 20 → 30 → 40) | four weeks of real sending | Phase 9, and it never accelerates |

| Phase | What it gets you | Rough time |
|---|---|---|
| 0 | A machine that can run the tests | 10 min |
| 1 | A database, an operator, a login | 30 min |
| 2 | An agent that can think — key, brain, contacts | 1 h + your writing |
| 3 | **The acceptance test for step 5, which has never been run** | 1 h, mostly reading |
| 4 | A sending domain that authenticates | 30 min + up to 48 h waiting |
| 5 | Gmail API access with both scopes | 1–2 h |
| 6 | Two deploys, and the variable split | 1 h |
| 7 | The webhook: topic, subscription, OIDC identity | 45 min |
| 8 | Push notifications on your own devices | 15 min |
| 9 | `DRY_RUN=false`, in the one safe order | 30 min, then four weeks of ramp |

Phases 0–3 need nothing Google-shaped at all. If you only ever do those, you
still find out whether the drafts are any good, which is the question this whole
project is a bet on.

---

## Phase 0 — the machine

### 0.1 Node 22

Every `package.json` here declares `engines: { "node": ">=22" }`. This machine's
default is currently Node 20.19.6, which makes every `pnpm` command print
`WARN Unsupported engine` and is the wrong thing to build on.

```bash
nvm use 22
node -v
```

**Worked when:** `node -v` prints `v22.x` and a subsequent `pnpm install` prints
no `Unsupported engine` line.

(The specific flag the worker's `dev`/`start` scripts depend on,
`--env-file-if-exists`, exists from Node 20.16 and 22.9. The `>=22` in
`engines` is the constraint that matters; do not run on 20 because the flag
happens to work there.)

**What actually breaks on Node 20, observed rather than inferred:** the worker
boots fine, `/health` answers, all three jobs register — and then the first
send-queue tick, sixty seconds later, dies with `Node.js detected but native
WebSocket not found` from `@supabase/supabase-js`. Every job that touches the
database fails the same way. It fails closed (the tick logs "the kill switch
could not be read — nothing will be sent" and sends nothing), so nothing is
damaged, but a successful boot on Node 20 proves less than it appears to. The
same boot on Node 22 gets past client construction and fails only on the
unreachable database, which is the expected result with dummy credentials.

### 0.2 Install and prove the tree is intact

```bash
pnpm install
pnpm typecheck
pnpm test
```

**Worked when:** `typecheck` prints `Done` for all three workspaces, and `test`
reports **1008 passing, 0 failing** (core 410, web 131, worker 467). Any other
number means you are not setting up the tree this document was written against.

---

## Phase 1 — database, operator, login

### 1.1 Create the Supabase project

<https://supabase.com/dashboard> → **New project**. Region `eu-central-1`
(closest to Greece). Set a database password and **store it in a password
manager, not in a chat window** — see the security follow-ups in `STATUS.md` for
why that sentence is there.

Provisioning takes two to five minutes.

**Worked when:** the project dashboard loads and **Settings → API** shows a
Project URL and two keys.

### 1.2 Three auth settings that are part of the security model

None of these are in the repo, and two of them are the difference between a
single-user app and a public one.

- **Authentication → URL Configuration → Redirect URLs.** Add the exact origins,
  no wildcards: `http://localhost:3000/auth/callback` now, and the Vercel origin
  in Phase 6.
- **Authentication → Sign In / Providers → Email → Allow new users to sign up.**
  Leave it **on** until you have signed in once, then turn it **off**. This app
  needs exactly one user and never creates a second. The anon key is public by
  design — it ships in the browser bundle — so "anyone can sign up" means
  "anyone can mint a JWT against your project".
- Login is **password**, not magic link. The PKCE verifier cookie is written by
  the browser that requested the link, and mail clients open links in their own
  embedded browser, so the callback arrives without it. `STATUS.md` records this
  at length. Do not "fix" it back to magic links.

**Worked when:** the redirect list contains your localhost callback and nothing
with a `*` in it.

### 1.3 The root `.env`

```bash
cp .env.example .env
```

Fill in, from **Settings → API**:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` `public` key |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` `secret` key |
| `ALLOWED_EMAIL` | the one address allowed to sign in |
| `DRY_RUN` | `true` — leave it there until Phase 9 |
| `TZ` | `Europe/Athens` |

Leave the rest empty. Each remaining variable is annotated in `.env.example`
with the phase that needs it.

One `.env` at the repo root serves everything, and nothing loads it implicitly:
the worker gets it from `tsx --env-file-if-exists=../../.env`, the web app from
`loadRootEnv()` in `apps/web/next.config.ts` (Next only reads `apps/web/.env` and
does not walk up), the operator scripts from `tsx --env-file-if-exists=.env`.

**Worked when:**

```bash
pnpm dev:worker
```

logs `worker alive` with `jobs_registered: 3`. The worker asserts
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` at boot and exits 1
naming whichever is missing, so a successful boot is also proof the root `.env`
is being read.

```bash
curl -s localhost:3001/health
```

From loopback this returns the full document: `dry_run: true`, `timezone`, three
jobs with `next_run_at`, and `followup` / `sendQueue` / `inbox` each with a null
`last_run`. From anywhere else it returns three fields and nothing else, which is
deliberate — see Phase 6.

### 1.4 Apply the migrations, the settings seed, and the operator row

**Short way:** Supabase dashboard → **SQL Editor** → paste the whole of
`supabase/SETUP_RUN_ME.sql` → Run.

**Long way**, the same thing file by file, in this order — the order matters,
each one assumes the last:

1. `supabase/migrations/20260731120000_init.sql` — the seven tables.
2. `supabase/migrations/20260731180000_stage_changed_at.sql` — adds
   `contacts.stage_changed_at`. **Fails loudly if skipped:** PostgREST answers
   `PGRST204` on every `/pipeline` stage edit and on the first contact the inbox
   agent creates.
3. `supabase/migrations/20260731140000_rls_operator_only.sql` — replaces
   "any authenticated user" with `is_operator()`. **Without it, anyone holding
   the public anon key can read and write every contact through PostgREST**,
   because none of the app's `ALLOWED_EMAIL` checks run there.
4. `supabase/migrations/20260803120000_inbox_dedupe_and_indexes.sql` — the unique
   partial index on `interactions.meta->>'gmail_message_id'`. **Fails silently if
   skipped.** The inbox agent's exactly-once claim *is* that index: it inserts
   the interaction row before it calls the model and reads `23505` as "another
   delivery already has this message". No index, no `23505`, and the claim
   degrades to a read followed by a write.
5. `supabase/migrations/20260803160000_contacts_email_unique.sql` — one contact
   row per address. `do_not_contact` and the 48-hour cooldown are recorded per
   *row* while the address is what identifies a *person*, so two rows are two
   ways to email someone who said no.
6. `supabase/seed.sql` — the `settings` rows: `kill_switch`, `autonomy`,
   `daily_send_cap`, `daily_cost_cap`, `send_window`.

Then tell the database who the operator is — the same address as `ALLOWED_EMAIL`:

```sql
insert into public.settings (key, value)
values ('allowed_email', to_jsonb('you@example.com'::text))
on conflict (key) do update set value = excluded.value, updated_at = now();
```

Until that row exists `is_operator()` returns false and every table reads empty.
That is deliberate: it fails closed. The worker is unaffected — it uses the
service role key, which bypasses RLS entirely.

**Worked when:** the verification query at the end of `SETUP_RUN_ME.sql` returns
your operator address and `yes` for all three of the late additions. Run it on
its own at any time:

```sql
select 'contacts.stage_changed_at' as check,
  case when exists (select 1 from information_schema.columns
    where table_schema='public' and table_name='contacts' and column_name='stage_changed_at')
  then 'yes' else 'MISSING' end as result
union all select 'interactions_gmail_message_id_key',
  case when exists (select 1 from pg_indexes where schemaname='public'
    and indexname='interactions_gmail_message_id_key') then 'yes' else 'MISSING' end
union all select 'contacts_email_unique',
  case when exists (select 1 from pg_indexes where schemaname='public'
    and indexname='contacts_email_unique') then 'yes' else 'MISSING' end
union all select 'settings rows', count(*)::text from settings;
```

Three `yes` and **six** settings rows: the five from `seed.sql` plus
`allowed_email`. A seventh, `gmail_watch`, appears in Phase 5 when the inbox
agent first stores a cursor — so six now, seven after 5.4. A `MISSING` here is
the single most consequential thing on this page, because two of the three do not
announce themselves at runtime.

Every file is idempotent and safe to re-run, **with one exception you must edit
first.** `SETUP_RUN_ME.sql` ends with an `allowed_email` insert that carries a
real address, hard-coded, under `on conflict do update`. That is not a
placeholder: run it unedited and `is_operator()` resolves to somebody else, so
every table reads empty for you and the app looks broken with nothing in the log
to say why. Change the address to yours before the first run, and change it again
in the file — not just in the database — or the next re-run silently puts the old
one back.

### 1.5 Sign in, then close the door

```bash
pnpm dev
```

Open <http://localhost:3000>, sign in with `ALLOWED_EMAIL` and the password you
set in the Supabase dashboard (Authentication → Users → the user → reset
password, if you have not set one).

Then go back and turn **Allow new users to sign up** off.

**Worked when:** `/pipeline` renders an empty list rather than an auth error, and
a second browser attempting to sign up is refused.

**Also do now, from `STATUS.md`'s outstanding list:** rotate the Supabase
database password and change the app login password. Both were generated during
development and both have been in a chat transcript.

---

## Phase 2 — the agent can think

### 2.1 `ANTHROPIC_API_KEY`

Currently the literal string `placeholder`. This is the single blocker on seeing
the system do its actual job.

<https://console.anthropic.com> → API keys. Put it in `.env`. Set a spend limit
on the console side too; `settings.daily_cost_cap` (default `$2.00/day`) is the
application's ceiling, not the account's.

**Worked when:**

```bash
pnpm exec tsx scripts/llm-probe.ts --no-db
```

returns a parsed classification of a Greek sentence. That mode needs no
database. Then the full path, which writes the row the cost cap reads:

```bash
pnpm exec tsx scripts/llm-probe.ts
```

and in SQL:

```sql
select model, input_tokens, output_tokens, cost_usd, created_at
from agent_runs order by created_at desc limit 3;
```

One row, token counts non-zero, `cost_usd` around `$0.00002` on Haiku. If
`agent_runs` is empty the wrapper never got to the database, which is a Supabase
problem and not an Anthropic one.

### 2.2 `brain/` — the part only you can write

Eight files in `brain/`. The follow-up agent reads all of them before writing a
single message and is not allowed to state anything that is not in them or in
the contact's own history. That rule is what stops it inventing your price.

Five of the eight have content. Three (`case_studies`, `availability`,
`retainer_offer`) are empty **on purpose** — an empty key makes the agent stay
quiet on that subject rather than invent a claim it would then have to defend in
a real conversation. Leave them empty until you have something true.

`brain/tone_of_voice_el.md` is the one that is not optional and not writable by
anyone else. It has rules and no voice. Most of your customers are Greek, so
most drafts come out of this file, and the difference between "sounds like you"
and "sounds like a translated robot" is decided here and nowhere else.

The fastest way to write it is not to write it: find two or three emails you have
actually sent to customers and paste them under **Παραδείγματα από εμένα**. Not
polished ones. Real ones.

```bash
pnpm seed             # dry run — prints what would change, writes nothing
pnpm seed --commit    # write it
```

HTML comments are stripped before writing, so the `<!-- guidance -->` in those
files never reaches a model.

**Worked when:**

```sql
select key, length(value) as chars from brain order by key;
```

returns eight rows, and `tone_of_voice_el` is materially longer than it was —
it should carry your actual sentences, not just the five bullet rules.

### 2.3 Real contacts

Either through `/pipeline` → **New contact**, or from a CSV:

```bash
pnpm import:contacts <path-to-csv>             # dry run: prints inserts, skips, rejects
pnpm import:contacts <path-to-csv> --commit
```

The column contract is `scripts/CONTACTS_CSV.md`, and the mapping in it is a
proposal written before a real CSV existed — expect to edit the `MAPPING`
constant in `scripts/import-contacts.ts` once. Keep the CSV outside the repo or
name it `contacts.csv`/`*.local.csv`, which `.gitignore` covers. It is personal
data.

Start with five to ten people you actually know. The agent selects on
`next_touch_at <= now`, so set a date of today or earlier on at least three of
them or the next phase will correctly draft nothing.

**Worked when:**

```sql
select count(*) filter (where next_touch_at <= now()) as due, count(*) as total
from contacts where do_not_contact = false;
```

`due` is at least 3.

---

## Phase 3 — the acceptance test that has never been run

This is the point of the project. Everything before it is plumbing and
everything after it is delivery. `PLAN.md` §6's criterion for step 5 is that a
human reads the drafts and finds them worth sending, and that has not happened
once.

### 3.1 Trigger the morning run by hand

The cron fires at 08:00 Europe/Athens. You do not have to wait for it:

```bash
curl -s localhost:3001/jobs/followup/run
```

This route is loopback-only and answers `202` immediately — a run is one Sonnet
call per due contact, up to `MAX_CONTACTS_PER_RUN` (60, in
`apps/worker/src/jobs/followup-select.ts`), and holding the socket open for it
would report a failure for a run that was still working.

**It costs real money.** One Sonnet call per due contact. `daily_cost_cap`
(`$2.00`) halts the run and files an alert card if you exceed it, which is
several hundred drafts, so it is a backstop and not a budget.

`DRY_RUN` is deliberately not consulted anywhere in `followup.ts`. Drafting is
real in every mode; only *sending* is stubbed. So this phase produces genuine
drafts and genuine Anthropic charges with `DRY_RUN=true`.

**Worked when:** `curl -s localhost:3001/health` shows

```json
"followup": { "running": false, "last_run": { "status": "ok",
  "summary": { "considered": 5, "drafted": 4, "skipped": 1, "failed": 0 } } }
```

`drafted` greater than zero. `failed` greater than zero means read the worker log
— every failure is one structured JSON line. `drafted: 0` with
`considered: 0` means no contact was due; go back to 2.3.

### 3.2 Read them

Open <http://localhost:3000>. That is Today. `j`/`k` to move between cards, `e` to
edit, `Enter` to approve, `s` to skip, `r` to reject.

Read every draft out loud, in the language it was written in. The question is not
"is this grammatical" — it will be. The question is: **would you send this, as
it stands, to this person?**

- If yes: step 5 is done, for the first time, and you can trust the rest of the
  document.
- If it is close but the register is off: that is `tone_of_voice_el.md`, and it
  is fixable in ten minutes.
- If it states something you would not say — a price, a timeline, a claim about
  past work — that came from a `brain` file. Find it and correct the file, not
  the draft.

### 3.3 The re-run loop

Drafting has already pushed the contact's `next_touch_at` forward, and a contact
with an open `pending` or `approved` draft is suppressed from selection
entirely — both on purpose, both there to stop the same person being mailed
twice. So a second run against the same contact needs three things, in order:

1. Reject the card on Today (this leaves the contact's date alone).
2. In `/pipeline`, set that contact's next touch date back to today.
3. Edit the `brain` file, `pnpm seed --commit`, then trigger the run again.

### 3.4 What a dry-run approval actually does — read before you approve one

Under `DRY_RUN=true`, `sendEmail` builds the entire MIME message, applies the
compliance footer, enforces the size limit and the Greek encoding, and then does
not open a socket. **Everything else is real:** the caller still writes the
`interactions` row, still moves `contacts.last_touch_at`, still marks the task
`sent`, and the send still counts against `daily_send_cap` and still trips the
48-hour per-contact cooldown.

Which means: a draft you approve in dry run **can never be sent for real**, and
the person is in a 48-hour cooldown from an email that does not exist.

That is the intended behaviour — the arithmetic is what needs exercising, not the
socket — but it means you should approve exactly one, to watch the send path
work, and reject the rest.

**Worked when:** the worker log shows one line with `dry_run: true`, a
`raw_bytes` count and a language, and:

```sql
select direction, channel, occurred_at, meta from interactions
order by occurred_at desc limit 1;
```

shows a `direction: out` row. The task's status is `sent`.

---

## Phase 4 — a sending domain that authenticates

Start this now; the waiting is the expensive part. `PLAN.md` §7.1: "Before the
first live send: SPF/DKIM/DMARC verified." A new domain sending at the top of
the ramp from day one lands in spam permanently, and no amount of good writing
recovers from that.

This assumes Google Workspace on your own domain, because Gmail's
`users.messages.send` fills `From:` from the authenticated account — there is no
sender variable in this repo and there deliberately is not one. If you are
sending from an `@gmail.com` address, SPF/DKIM/DMARC are Google's and there is
nothing for you to publish; skip to 4.2 and accept that the address says gmail.

### 4.1 The three records

**SPF** — one TXT record on the apex, and exactly one; two SPF records is a
permanent error, not a warning:

```
v=spf1 include:_spf.google.com ~all
```

**DKIM** — Google Admin console → **Apps → Google Workspace → Gmail →
Authenticate email**. Generate a **2048-bit** key, publish the TXT record it
gives you at the host it names (usually `google._domainkey`), then come back and
press **Start authentication**. Google says this can take up to 48 hours to
begin signing; it is usually an hour, but plan for the 48.

**DMARC** — TXT at `_dmarc`, starting permissive so you can read reports before
you enforce anything:

```
v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com; adkim=s; aspf=s
```

Move to `p=quarantine` and then `p=reject` after a couple of weeks of clean
reports. Going straight to `p=reject` with a misconfigured SPF silently
blackholes your own mail.

**Worked when:** the records resolve —

```bash
dig +short TXT yourdomain.com | grep spf
dig +short TXT google._domainkey.yourdomain.com
dig +short TXT _dmarc.yourdomain.com
```

— and, the check that actually counts, you send a normal email from that account
to any `@gmail.com` address and use **Show original**. The header block must read
`SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`. Anything less than three passes and the
first live send is a coin flip.

### 4.2 The three GDPR variables

`gmail.ts` refuses to build a message without all three — **including under dry
run**, because a dry run whose only difference from production is that it would
have failed is not a dry run.

| Variable | What |
|---|---|
| `BUSINESS_NAME` | the sender identity in the footer |
| `BUSINESS_ADDRESS` | a real physical address — a legal requirement on every commercial message in the EU |
| `PRIVACY_POLICY_URL` | a URL that resolves to a real published page |

A placeholder here is a false statement to a customer, which is why the code
refuses rather than substituting one.

**Worked when:** `curl -sI "$PRIVACY_POLICY_URL"` returns `200`, and a dry-run
send (3.4) succeeds instead of throwing.

### 4.3 Leave the ramp alone

`settings.daily_send_cap` is seeded at `10` and is meant to stay there for the
first week: 10 → 20 → 30 → 40 over four weeks, bumped by hand in `/brain`. The
field is on the operations form with the precondition next to it.

---

## Phase 5 — Gmail API access

### 5.1 Project and APIs

Google Cloud console → new project. Enable both the **Gmail API** and the
**Cloud Pub/Sub API**.

**Worked when:** both appear under **APIs & Services → Enabled APIs**.

### 5.2 The consent screen — read this before clicking anything

This choice decides whether you do the rest of Phase 5 once, or once a week.

- **User type: Internal.** Available only if the account is Google Workspace.
  No verification, no review, and refresh tokens do not expire. Choose this if
  you can.
- **User type: External, in Testing.** Works immediately, and the refresh token
  **expires after seven days**. Fine for a first run-through; not a thing to
  build a daily loop on.
- **User type: External, published.** `https://www.googleapis.com/auth/gmail.readonly`
  is a *restricted* scope. Publishing means Google's verification process,
  including a security assessment. Weeks, not days, and it cannot be hurried.

If you are on External/Testing, add your own Gmail address under **Test users**
or nothing works at all.

**Worked when:** the consent screen summary shows the user type you intended and
lists both scopes.

### 5.3 OAuth client

**Credentials → Create credentials → OAuth client ID.** Desktop is simplest for
one user; pick Web if you intend to use the OAuth Playground (see 5.4), and add
`https://developers.google.com/oauthplayground` as an authorised redirect URI.

Copy into `.env`:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

### 5.4 `GMAIL_REFRESH_TOKEN` — with both scopes

**Two scopes, both required, both used:**

```
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.readonly
```

There is no OAuth script in this repo. Use the OAuth Playground with your own
credentials (gear icon → **Use your own OAuth credentials**), select both scopes,
authorise as the sending account, exchange the code for tokens. Whatever route
you take, the authorisation URL must carry `access_type=offline` and
`prompt=consent` or you get an access token and no refresh token.

A token minted for `gmail.send` alone is the classic first-run failure here, and
it is a *value* change with no *name* change, so nothing in the code can catch it
at boot. It surfaces as a `403` on the first read.

**Worked when:** the token response's `scope` field contains both URLs — and
then, the real check, the worker uses it. With `DRY_RUN=true` still set:

```bash
curl -s localhost:3001/jobs/inbox/run
```

`users.watch` is stubbed under dry run, but `users.getProfile` is not, so this
call genuinely authenticates against Gmail and stores the first cursor:

```sql
select value from settings where key = 'gmail_watch';
```

`{"history_id": "12345678", "expiration": null, ...}` with a real `history_id`
means the readonly scope is present and working. A `403` in the worker log means
it is not, and the alert card it files says which scope to add.

### 5.5 The Pub/Sub topic

Create a topic. `GMAIL_PUBSUB_TOPIC` must be its **full resource name**:

```
projects/<project-id>/topics/<topic-name>
```

`users.watch` rejects a bare topic name. The variable's description in
`.env.example` now states the format; earlier versions did not.

### 5.6 The grant everybody misses

Grant `roles/pubsub.publisher` **on that topic** to:

```
gmail-api-push@system.gserviceaccount.com
```

That account is Gmail itself. Without the grant, `users.watch` answers `403` —
and a `403` from Gmail looks exactly like a scope problem, which is what this
repo used to tell you it was. The message in `gmail-read.ts` now names this grant
first and the scope second, precisely because this is the more likely cause.

**Worked when:**

```bash
gcloud pubsub topics get-iam-policy projects/<project-id>/topics/<topic-name>
```

lists `serviceAccount:gmail-api-push@system.gserviceaccount.com` with
`roles/pubsub.publisher`.

---

## Phase 6 — deploy, and the variable split

### 6.1 Which variable goes where

This table is the security boundary. The middle column is not a suggestion.

| Variable | Vercel (web) | Railway (worker) | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | yes | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | — | public by design, RLS applies |
| `SUPABASE_SERVICE_ROLE_KEY` | **never** | yes | see below |
| `ALLOWED_EMAIL` | yes | yes | worker uses it as the VAPID subject and to recognise its own sends |
| `ANTHROPIC_API_KEY` | — | yes | |
| `GOOGLE_CLIENT_ID` / `_SECRET` | — | yes | |
| `GMAIL_REFRESH_TOKEN` | — | yes | |
| `GMAIL_PUBSUB_TOPIC` | — | yes | |
| `GMAIL_WEBHOOK_SECRET` | — | yes | |
| `GMAIL_WEBHOOK_AUDIENCE` | — | yes | |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT` | — | yes | |
| `VAPID_PUBLIC_KEY` | yes | yes | the one variable that goes on both |
| `VAPID_PRIVATE_KEY` | **never** | yes | anything holding it can push to your lock screen as this app |
| `BUSINESS_NAME` / `_ADDRESS` / `PRIVACY_POLICY_URL` | — | yes | |
| `DRY_RUN` | — | yes | |
| `TZ` | yes | yes | |

**`SUPABASE_SERVICE_ROLE_KEY` never goes on Vercel.** It bypasses row-level
security completely: anything holding it reads and writes every contact, every
draft and every setting regardless of who is signed in. The web app is built to
work without it — `apps/web/lib/supabase/server.ts` uses the anon key under RLS
on purpose, and `next.config.ts`'s `WEB_ENV_ALLOWLIST` deliberately does not
carry the name — so setting it on Vercel would add no capability the app uses,
and would put the one key that defeats every access rule into a process whose job
is rendering HTML to a browser.

`VAPID_PUBLIC_KEY` is the only name on both lists, and it is safe there because
it is a public key: the browser receives it in the clear on every subscribe call.
It is in `WEB_ENV_ALLOWLIST`, which is the only reason the web app can see it.

### 6.2 Railway — the worker

New service from this repo.

- **Build:** `pnpm install` (there is no build step; `@agency/core` is consumed
  as TypeScript source and `tsx` runs it).
- **Start:** `pnpm --filter @agency/worker start`
- **Node:** 22.x. Pin it (`NIXPACKS_NODE_VERSION=22` or an `engines`-respecting
  builder). The start script passes `--env-file-if-exists`.
- Variables: the whole right-hand column above.

**Worked when:** from the internet,

```bash
curl -s https://<worker-host>/health
```

returns exactly three fields — `status`, `service`, `uptime_s`. If it returns the
schedule, the timezone, or `last_run` counts, the loopback split is broken and
you are publishing your pipeline volume and raw PostgREST error strings to
anyone who finds the hostname.

For the real document, get onto the box (`railway ssh`) and curl localhost:

```bash
curl -s localhost:$PORT/health
```

Three jobs registered: `followup` (daily 08:00), `send-queue` (60s),
`inbox-sweep` (15 min), plus `routes.gmail_webhook`.

Also confirm `/jobs/*` is refused from outside:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-host>/jobs/followup/run
```

`403`. Anything else and a stranger can spend your Anthropic budget with an
`<img>` tag.

### 6.3 Vercel — the web app

New project from this repo. Root directory is the **repo root**, not `apps/web`.
Build command `pnpm --filter @agency/web build`. Variables: the left-hand column.

**Worked when:** the deploy succeeds, the origin loads the login page, you can
sign in, and `/pipeline` shows the contacts you added in Phase 2.

### 6.4 Close the loop on auth

Back in Supabase → **Authentication → URL Configuration**, add
`https://<your-vercel-origin>/auth/callback`.

---

## Phase 7 — the webhook

Needs the worker's public hostname from Phase 6.

### 7.1 The shared secret

```bash
openssl rand -hex 32
```

Set it as `GMAIL_WEBHOOK_SECRET` on Railway. It is compared in constant time
against the `token` query parameter.

### 7.2 The service account Pub/Sub signs as

Create a service account (any name; `pubsub-gmail-push` is fine). Its `email` is
what the route verifies. Where the subscription requires it, grant that account
`roles/iam.serviceAccountTokenCreator`.

Set `GMAIL_PUBSUB_SERVICE_ACCOUNT` to that email, exactly.

### 7.3 The push subscription

On the topic from 5.5, create a **push** subscription:

- **Endpoint:** `https://<worker-host>/webhooks/gmail?token=<GMAIL_WEBHOOK_SECRET>`
- **Enable authentication:** on, with the service account from 7.2
- **Audience:** any stable string — the endpoint URL without the query string is
  the conventional choice. Whatever you type here goes verbatim into
  `GMAIL_WEBHOOK_AUDIENCE`.

Both checks exist because neither is sufficient alone. The secret appears in the
subscription config, in any proxy log that records query strings, and in shell
history; it proves the caller once knew a secret. The OIDC token proves the
caller *is* that Google service account, right now, signed by Google, and
expiring. They are checked in that order because the secret costs one hash and
no I/O.

If any of the three webhook variables is unset the route answers `503` to every
delivery and logs which one, once. An open webhook that creates contacts and
spends Anthropic money is not a thing that ships on by default.

**Worked when:** in the Pub/Sub console, use **Publish message** on the topic
with any body. The worker log records the delivery. A `204` with a "not a Gmail
notification" line is a pass — the auth checks ran and the payload was simply not
one Gmail sent. A `403` names which check failed; a `503` names the missing
variable.

Note that no real Gmail notification will arrive yet, because `users.watch` is
still stubbed under `DRY_RUN=true`. That is Phase 9.

---

## Phase 8 — push notifications

### 8.1 The VAPID keypair

```bash
pnpm --filter @agency/worker exec web-push generate-vapid-keys
```

`web-push` is the one runtime dependency outside the frameworks, and this
generator is part of why. Private key → Railway only. Public key → Railway **and**
Vercel.

### 8.2 Subscribe each browser

Open `/brain` on every device you want notified and press **Enable
notifications**. Nothing else creates a `push_subscriptions` row, and until one
exists `sendPush` is a logged no-op — the system looks like it is working and no
notification ever arrives.

Each browser subscribes separately. There is **no web app manifest**, so iOS
Safari cannot subscribe at all; this is a known gap, documented in
`apps/web/public/sw.js`, and it means the phone in your pocket is not currently a
target.

**Worked when:**

```sql
select count(*), max(created_at) from push_subscriptions;
```

is at least 1, and the next follow-up run produces a notification. The digest is
sent at the end of the morning run rather than by a second timer — deliberately,
because two independent timers cannot be ordered and you would otherwise get
"0 follow-ups ready" at 08:30 followed by four cards at 08:34.

---

## Phase 9 — turning `DRY_RUN` off, in this order

`DRY_RUN` is one global flag and it gates three things at once: the Gmail send,
the `users.watch` registration, and Web Push. There is no `DRY_RUN_SEND` /
`DRY_RUN_WATCH` split, and that was a decision rather than an omission — the
watch stub exists because a developer's machine registering a watch would divert
the production mailbox's notifications to whatever topic that developer happened
to have set, and a second flag is more configuration surface for a problem that
already has an answer.

The answer is the send cap. This order brings the entire inbound path up with
nothing able to leave:

### 9.1 Set `daily_send_cap` to `0`

In `/brain` → operations. `0` is a documented value meaning "sending is paused":
every send is refused with a sentence saying exactly that, while the inbox agent
still reads, classifies and drafts normally.

**Worked when:** `select value from settings where key='daily_send_cap';` is `0`,
and the card for an approved draft says sending is paused rather than promising
a retry.

### 9.2 Set `DRY_RUN=false` on Railway and redeploy

Nothing else changes.

### 9.3 Confirm the watch registered

Wait for the 15-minute sweep, or force it from the box:

```bash
curl -s localhost:$PORT/jobs/inbox/run
```

**Worked when:**

```sql
select value from settings where key = 'gmail_watch';
```

now has a **non-null `expiration`**, roughly seven days out in epoch
milliseconds. A null expiration here means `users.watch` did not succeed — check
5.6 first, then 5.4.

### 9.4 Send yourself an email

From any other account, to the mailbox. Within seconds:

**Worked when:** the worker log shows a webhook delivery and a classification;

```sql
select direction, occurred_at, meta->>'gmail_message_id' as msg
from interactions where direction = 'in' order by occurred_at desc limit 1;
```

returns your message; `/inbox` shows it with its classification; and if it looked
like a real enquiry, a reply card is waiting on Today with a subject beginning
`Re:`.

This is the first moment the whole chain — Gmail → Pub/Sub → OIDC → webhook →
classify → draft → card → push — has ever run. Expect something in it to be
wrong. Every failure files an alert card on Today rather than only appearing in
`/health`, because nobody looks at `/health` when nothing appears to be wrong.

### 9.5 Raise the cap, and send one real message

Set `daily_send_cap` to `10`. Approve one draft, to somebody who will forgive an
oddity.

**Worked when:** the message is in the Gmail **Sent** folder; it carries the
compliance footer; if it was a reply it is **in the same thread** as their
message rather than a new conversation; and

```sql
select occurred_at, meta->>'gmail_message_id', meta->>'gmail_thread_id'
from interactions where direction = 'out' order by occurred_at desc limit 1;
```

has both ids populated.

### 9.6 The ramp

10 for week 1, then 20, 30, 40. Four weeks. It does not accelerate, and the
reason is in Phase 4: reputation is earned per-day and lost permanently.

---

## Phase 10 — what "it runs for real" looks like

08:00 Europe/Athens: the follow-up agent drafts, then one push. You open Today,
read, approve or edit or skip. Approving writes `send_after` and returns
instantly; the 60-second poller sends inside the window. Inbound mail arrives via
the webhook within seconds and via the 15-minute sweep if a notification is lost.

For the first week, read `/health` once a day over `railway ssh` and check
`followup.last_run.failed`, `sendQueue.last_run.refused` and
`inbox.last_run.failed` are all zero. After that, the alert cards on Today are
the interface — every silent failure in this system has been given a card
precisely so that reading `/health` is not a daily obligation.

---

## Step 10 — Lead Research is specified and deliberately not built

`LEAD_RESEARCH.md` is a complete specification for an agent that finds the *next*
warm lead rather than making sure the existing ones are not forgotten. **None of
it exists in this repo, and building it now would be a mistake.**

`PLAN.md` §6 gates it on four conditions:

1. Steps 1–9 shipped and in daily use
2. 50+ contacts in the database
3. The follow-up drafts trusted without reading every word
4. A **separate sending domain**, registered and warmed

**None of the four holds today.** Nothing has been in daily use, there are zero
contacts, no draft has been read at all let alone trusted, and there is one
domain.

Two things in that spec must not be got wrong, and both are reasons to wait
rather than reasons to hurry:

- **A separate sending domain.** Cold outreach produces spam complaints; warm
  follow-ups produce replies. Share a domain and the complaints poison the
  reputation the follow-ups depend on — mail to real customers starts landing in
  spam and this app silently stops working.
- **A separate `prospects` table.** A researched stranger written into `contacts`
  with a `next_touch_at` gets picked up by the step-5 agent, which then drafts
  outreach to someone who never met you, appearing in the morning queue looking
  exactly like a real follow-up. Promotion into `contacts` is an explicit button
  press, never a status flag.

Three questions also need real answers before any code: where the candidates come
from and whether those terms permit it, the legality of cold B2B email in Greece
specifically, and the profiling obligations that come with keeping long-term
intelligence on people.

---

## First-run failures, and what they actually mean

| Symptom | Cause | Fix |
|---|---|---|
| `PGRST204` on a stage edit or a new inbound contact | `20260731180000_stage_changed_at.sql` not applied | Phase 1.4 |
| Two identical cards for one customer email | `20260803120000_inbox_dedupe_and_indexes.sql` not applied — fails silently | Phase 1.4 |
| Every table reads empty in the browser | no `settings.allowed_email` row, or RLS migration applied without it | Phase 1.4 |
| `403` from `users.watch` | almost always the missing `roles/pubsub.publisher` grant, not the scope | Phase 5.6 |
| `403` from `history.list` / `messages.get` | refresh token minted for `gmail.send` only | Phase 5.4 |
| Webhook answers `503` to everything | one of the three webhook variables is unset; the log names it | Phase 7 |
| Webhook answers `403` | secret mismatch, wrong audience, or wrong service account | Phase 7.3 |
| No notification ever arrives | no `push_subscriptions` row, or iOS Safari (no manifest) | Phase 8.2 |
| Refresh token stops working after 7 days | External/Testing consent screen | Phase 5.2 |
| Send refused with "sending is paused" | `daily_send_cap` is `0` | Phase 9.1, on purpose |
| Agent halts with a cost alert card | `daily_cost_cap` reached | raise it in `/brain`, or find the loop |
| Everything stops at once | `kill_switch` is on. The watch is still renewed and the cursor still anchored — mail is not lost while it is on | `/brain` |

---

## The honest note

Everything above is written from the code, not from experience. No part of Phases
4 through 9 has been performed against a real Google project, a real domain or a
real recipient. The steps are derived from what the source does and each one
names the file that fails when it is skipped, which is the best that can be said
for a procedure nobody has walked.

Expect it to be wrong somewhere the first time. When it is, correct this file
before you correct anything else — the next person to read it is you, in six
months, with no memory of which console tab any of this lived in.
