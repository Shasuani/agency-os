-- Step 8 (the inbox agent) — two indexes on `interactions`. No new table, no
-- new column, no RLS change: `interactions` already has RLS enabled and the
-- `"operator"` policy from 20260731140000_rls_operator_only.sql, and an index
-- is not a grant.
--
-- ---------------------------------------------------------------------------
-- 1. The duplicate suppression. This is not an optimisation.
-- ---------------------------------------------------------------------------
--
-- Gmail Pub/Sub is at-least-once, and Gmail's own history ranges overlap. The
-- same message id arrives twice as a matter of course: once because Pub/Sub
-- redelivered a notification it did not see acked in ten seconds, and once
-- because two *different* notifications legitimately cover the same message.
-- Deduping on the Pub/Sub `messageId` catches only the first of those.
--
-- So the dedupe key is the Gmail message id, and the claim is the
-- `interactions` row itself: the worker inserts the row BEFORE it calls Haiku,
-- and a `23505` from this index means another delivery already owns that
-- message — no model call, no task, no push. That ordering is the same lesson
-- `send-queue.ts` records for outbound, in the other direction: write the
-- interaction first and let the unique row be the lock. There it exists so a
-- customer cannot receive the same email twice; here it exists so one inbound
-- message cannot produce two task cards and two Anthropic charges.
--
-- The worker also pre-filters the whole batch with one `select` before it
-- fetches anything, which is what saves the HTTP round trip. That check is not
-- a substitute for this index and cannot be: it is a read followed by a write,
-- and two deliveries racing between the two both pass it. Only the unique
-- index is atomic.
--
-- PARTIAL, and the predicate is the load-bearing part. Every outbound row —
-- including every dry-run send, which writes `gmail_message_id: null` — would
-- otherwise be indexed on a NULL. Postgres treats NULLs as distinct in a unique
-- index, so they would not actually collide, but the index would carry a row
-- per outbound message for no purpose. Excluding them keeps the index the size
-- of the inbound mail and states the intent in the schema.
--
-- Safe on existing data: real sends write a distinct Gmail id per row and
-- dry-run sends write null, so nothing currently in the table can violate it.
-- Written as a plain `create unique index` rather than `concurrently` because
-- migrations here run in a transaction and the table is small; revisit if this
-- ever has to be applied to a live table with real volume.

create unique index if not exists interactions_gmail_message_id_key
  on public.interactions ((meta ->> 'gmail_message_id'))
  where meta ->> 'gmail_message_id' is not null;

comment on index public.interactions_gmail_message_id_key is
  'Dedupe key for inbound Gmail. The interactions row is the claim: a 23505 here means another delivery already has this message, so no model call is made.';

-- ---------------------------------------------------------------------------
-- 2. Two queries that are sequential scans today.
-- ---------------------------------------------------------------------------
--
--   /inbox            "inbound, newest first, last N days", capped at 100 rows
--   guardrails.ts     the rolling 24h outbound count, checked before every send
--
-- Both filter on `direction` and order or bound on `occurred_at`, so one
-- composite serves both. The descending order matters for the first: without
-- it the planner can still use the index but has to sort, and `/inbox` is the
-- page whose whole premise is that the top of it is the newest thing.
--
-- The second is the one with teeth. The daily send cap is counted, not locked
-- (`send-queue.ts` is single-flight, so there is exactly one writer), and that
-- count runs immediately before every outbound message. A sequential scan there
-- gets slower every day the table grows, forever, on the one path that is
-- holding a Gmail connection open.

create index if not exists interactions_direction_occurred_at_idx
  on public.interactions (direction, occurred_at desc);

comment on index public.interactions_direction_occurred_at_idx is
  'Serves /inbox (inbound, newest first, windowed) and the guardrails rolling 24h outbound count.';
