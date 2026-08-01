# Where the build actually stands

Last updated: 2026-08-01

This file exists because a lot of the project's real state lived only in a chat
window, and chat windows get truncated. `PLAN.md` says what we decided and why.
This says what is *done*, what is *blocked*, and on what.

---

## The one-line version

**All the code for steps 1–5 is written and tested. None of it has run against
real data.** The database is live and empty. The agent has never drafted a
message, because it has no API key and no contacts.

```
contacts: 0 | brain: 0 | tasks: 0 | agent_runs: 0 | settings: 6
```

---

## Done

| Step | What | Commit |
|---|---|---|
| 1 | Monorepo scaffold — pnpm workspaces, web + worker + core | `2c063a9` |
| 2 | `/pipeline` — contact list, create, edit, tags, keyboard nav | `e3da3a0` |
| 3 | Cadence functions — `nextTouch()`, pure, no I/O | `d1f1a3f` |
| 4 | LLM wrapper — model routing, cost ceiling, structured output | `52fa7e2` |
| 5 | Follow-up agent — selection + drafting, `DRY_RUN` by default | `9d70131` |
| — | Brain content moved out of TypeScript into `brain/*.md` | `19a9cc4` |

159 tests, 0 failures. Working tree clean.

Live on Supabase: all three migrations applied, RLS enforced via
`public.is_operator()`, verified end-to-end against real Postgres — an attacker
holding the (public) anon key gets 0 rows and rejected writes.

Login works. Password auth, not magic link — see "Why not magic links" below.

## Not done

- **Step 6** — Today page + Gmail send. Deliberately not started.
- **Steps 7–9** — see `PLAN.md` §6.
- **Step 10** — Lead Research agent. Specified in `LEAD_RESEARCH.md`, gated.

---

## Blocked on, in the order that unblocks the most

### 1. `ANTHROPIC_API_KEY` — currently the literal string `placeholder`

Without it the follow-up agent cannot draft anything. This is the single
blocker on seeing the system do its actual job.

### 2. `SUPABASE_SERVICE_ROLE_KEY` — also `placeholder`

The worker cannot start without it. It is the only credential that bypasses
RLS.

> **This key must never be set on the Vercel project.** Railway worker only.
> Anything holding it can read and write every row regardless of who is asking.

### 3. `brain/tone_of_voice_el.md` — has rules, has no voice

5 of 8 brain keys have content. The three empty ones (`case_studies`,
`availability`, `retainer_offer`) are empty *on purpose* — an empty brain key
makes the agent stay quiet on that subject rather than invent a claim it would
then state to a real customer. That is correct behaviour and needs no fix.

`tone_of_voice_el.md` is different. It is the file that decides whether every
Greek draft reads like you or like a translated robot, and it cannot be written
by anyone but you. Paste in two or three emails you have actually sent. Not
polished ones — real ones.

Then: `pnpm seed --commit`

### 4. No contacts

Once 1–3 are done, add a handful of real contacts through `/pipeline` and let
the agent draft against them with `DRY_RUN=true`. **Read the drafts.** That is
the acceptance criterion for step 5 and it has not been met.

---

## Security follow-ups, still outstanding

- **Rotate the Supabase database password.** It was pasted into a chat
  transcript. Value is not repeated here on purpose.
- **Change the app login password.** Same reason. It was machine-generated for
  first login and was never meant to be permanent.
- **Turn off "Allow new users to sign up"** in Supabase Auth settings. Safe to
  do now that the operator account exists. Until it is off, anyone can create an
  account — `is_operator()` stops them reading anything, but there is no reason
  to leave the door open.

---

## Two decisions worth remembering, because they were expensive

### Why not magic links

The spec called for magic-link login. It does not work here. The PKCE
code-verifier cookie is written by the browser that *requested* the link, and
mail clients — Yahoo's in particular — open links in their own embedded browser.
The callback then arrives without the verifier and fails. Free-tier email rate
limits (~2/hour) make debugging it worse. We use `signInWithPassword` instead.

Do not "fix" this by reverting to magic links.

### Why `contacts.stage_changed_at` exists

A lead chased five times and then quoted was entering the 3-step quoted cadence
already past its end, and got marked dormant the day after being quoted. The
touch count was a lifetime counter; the cadence needs a per-stage one. Nothing
recorded *when* the stage last changed, so there was nothing to count from.

Found by a test, not in production. The test that guards it is
`apps/worker/src/jobs/followup-select.test.ts`, first case.

---

## The honest note

We broke our own rule. `PLAN.md` says ship each step before starting the next.
We are five steps deep with zero contacts and zero drafts ever read. Every
acceptance criterion from step 3 onward is unverified against reality.

The fix is not more code. It is roughly twenty minutes of setup — two keys, one
file of your own writing, a few contacts — after which step 5 can actually be
judged. Step 6 should wait until at least one draft has been read and either
approved or found wanting.
