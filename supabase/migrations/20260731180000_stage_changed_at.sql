-- `contacts.stage_changed_at` — when the contact last moved between stages.
--
-- The follow-up agent needs a PER-STAGE touch count (PLAN.md §6 step 5,
-- constraint 2). `contacts.touch_count` is a lifetime counter, and deriving the
-- count from "outbound interactions since the last inbound reply" is not
-- equivalent: a lead chased five times who never replies and is then quoted
-- still arrives deep in the sequence, falls off the end of the three-step quoted
-- cadence, and is marked dormant the day after being quoted — which is exactly
-- the bug the constraint exists to prevent.
--
-- Counting outbound interactions since the stage last changed is the fix, and it
-- needs this column because nothing else records the transition.

alter table contacts add column if not exists stage_changed_at timestamptz;

-- Existing rows: treat the stage as having been set when the contact was
-- created. Wrong only for contacts whose stage moved before this migration,
-- and there are none.
update contacts set stage_changed_at = coalesce(stage_changed_at, created_at, now())
 where stage_changed_at is null;

comment on column contacts.stage_changed_at is
  'When stage last changed. Drives the per-stage touch count in the follow-up agent. Set by the app on every stage transition.';
