-- `contacts.email` is unique, case- and whitespace-insensitively, when it is
-- set at all. One index, no new column, no RLS change.
--
-- ---------------------------------------------------------------------------
-- The decision, because "two contacts may share an address" is a defensible
-- position and this is why it was not taken
-- ---------------------------------------------------------------------------
--
-- Every part of this system that decides whether a human may be emailed keys on
-- the CONTACT ROW, and every part that decides which row a human is keys on the
-- ADDRESS. Two rows carrying one address puts those two facts in disagreement,
-- and each disagreement is a way to write to somebody who should not be written
-- to:
--
--   * `do_not_contact` is a column on one row. `guardrails.ts` checks the row
--     the task points at. So an opt-out recorded against row A does not stop the
--     follow-up agent selecting row B and emailing the same mailbox — which is
--     the one failure in this repo with a legal edge to it.
--   * The 48-hour per-contact cooldown counts `interactions` by `contact_id`.
--     Two rows are two budgets for one inbox, so the person receives two
--     messages in a window the rule says should hold one.
--   * `apps/worker/src/jobs/inbox.ts` already knows about this. `chooseContact`
--     picks one row deterministically and `closeDuplicates` sets
--     `do_not_contact = true` on the rest — a destructive auto-repair that
--     exists only because the invariant was not enforced, and that only runs if
--     the person happens to write in. Nothing repairs the rows of somebody who
--     never replies.
--
-- The case for allowing duplicates is two people at one business sharing
-- `info@`. That case argues the other way on inspection: they share a mailbox,
-- so every message to it reaches both, so the cooldown and the opt-out SHOULD be
-- shared. What is genuinely wanted there is one contact row with two names in
-- it, not two rows racing each other.
--
-- ---------------------------------------------------------------------------
-- PARTIAL, and the predicate is the load-bearing part
-- ---------------------------------------------------------------------------
--
-- `apps/web/lib/validation.ts` promises that a name and a follow-up date are
-- enough to enter a contact, because the commonest contact in this pipeline is
-- an NFC card with a name and a phone number. Those rows have no address, and
-- Postgres treats NULLs in a unique index as distinct — so they would not
-- actually collide — but the empty string is not NULL and two of those WOULD.
-- Excluding both states the intent in the schema instead of relying on a
-- three-valued-logic detail.
--
-- ---------------------------------------------------------------------------
-- lower(btrim(...)), because that is how the address is matched everywhere else
-- ---------------------------------------------------------------------------
--
-- `senderAddress` in the inbox agent trims and lowercases before it looks
-- anybody up, and `matchOrCreateContact` falls back to `ilike` when the exact
-- match finds nothing. An index on the raw column would let ` Maria@Example.gr `
-- and `maria@example.gr` both exist and would leave the matcher choosing between
-- them, which is the state this is here to end.
--
-- Free to add today: there are no rows. It is not free later, and that is the
-- reason it is being added now rather than when the first duplicate appears.

create unique index if not exists contacts_email_unique
  on public.contacts (lower(btrim(email)))
  where email is not null and btrim(email) <> '';

comment on index public.contacts_email_unique is
  'One contact row per email address. do_not_contact and the 48h cooldown are per row, so two rows sharing an address are two ways to email one person after they said no.';
