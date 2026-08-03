/**
 * Follow-up agent — everything that is decidable without a database or a model.
 *
 * SPEC §4 is a five-step flow, and only two of those steps genuinely need I/O
 * (read the rows, write the task). The rest is arithmetic and policy: is this
 * contact due, how many chases have already been made in their current stage,
 * and what instant does a cadence result turn into. All of that lives here, as
 * pure functions over plain data, for the same reason `cadence.ts` is pure —
 * the rule that decides whether a human gets emailed should be provable without
 * a running system.
 *
 * `followup.ts` is the orchestration: it does the I/O and calls these.
 *
 * ---------------------------------------------------------------------------
 * The touch-count derivation — read this before changing anything
 * ---------------------------------------------------------------------------
 *
 * PLAN §6 step 5, constraint 2, and the header of `cadence.ts`, both say the
 * same thing: `contacts.touch_count` is a **lifetime** counter and `nextTouch`
 * wants a **per-stage** one. Passing it raw is a live bug — a lead touched five
 * times and then quoted arrives as `touchCount: 5`, falls off the end of the
 * three-step quoted sequence, and is marked dormant the day after being quoted.
 *
 * There is no `stage_changed_at` column, so the count is derived from
 * `interactions`. See `deriveStageTouchCount` for the rule and its arithmetic;
 * the short version is:
 *
 *     touchCount = max(0, (outbound interactions since their last reply) - 1)
 *
 * The `- 1` is the part that is easy to get wrong and is not decoration. Both
 * sequences in SPEC §4's table are measured *from* the touch that establishes
 * the stage, not from the stage change itself:
 *
 *   - "New lead, no reply — +3 days" means three days after the first outreach.
 *     That outreach is what moves `new → contacted`, so at the moment it lands
 *     the correct answer is step 0 of the sequence, not step 1.
 *   - "Quoted, no reply — +5 days" means five days after the quote was sent.
 *     The quote is an outbound interaction, and it is what moves the contact to
 *     `quoted`. Counting it as a chase would schedule +10 the day after quoting
 *     and drop a whole step off the most valuable sequence in the table.
 *
 * So the first outbound after the conversation last reset is the *opening*
 * touch, and every one after it is a chase. `touchCount` counts chases.
 *
 * `contacts.touch_count` is still read — but only to be logged alongside the
 * derived figure, so the two can be compared when a schedule looks wrong. It
 * never reaches `nextTouch`.
 */

import { DORMANT_DAYS, nextTouch } from '@agency/core/cadence';
import type { CadenceResult } from '@agency/core/cadence';
import type { Contact, Interaction } from '@agency/core';
import type { SystemBlock } from '@agency/core/llm';
import { partsInZone, zonedTimeToUtc } from '@agency/core/zone';

// The word limit is asked for in the prompt and checked here; it must be one
// number, not two. `followup-prompt.ts` owns it because that is where it is
// written into the system prompt.
import { WORD_LIMIT, isWithinWordLimit } from './followup-prompt.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The hour a follow-up is due, in the operator's timezone.
 *
 * **This is the same 8 as `FOLLOWUP_HOUR` in `apps/web/lib/validation.ts`**, and
 * it must stay the same 8. That module stores a date-only follow-up picked in
 * `/pipeline` at 08:00 local precisely so the morning run picks it up on that
 * morning rather than a day later; this module writes the dates that run
 * produces. Two different hours and half the pipeline silently slips a day.
 *
 * It is re-declared rather than imported because `apps/worker` cannot import
 * from `apps/web` — the same duplication, for the same reason, as
 * `normalizeCadenceTag` in `cadence.ts`. The honest fix is to move the constant
 * into `packages/core`; that is a shared-file change and therefore not this
 * step's to make.
 */
export const FOLLOWUP_HOUR = 8;

/**
 * How early a contact may be selected relative to their `next_touch_at`.
 *
 * The dates this module writes land on exactly 08:00:00 local, and the cron
 * fires at exactly 08:00 local. If the timer drifts two seconds early — or the
 * process starts a moment before the tick it was scheduled for — `next_touch_at
 * <= now` is false for *every* contact due that morning and the whole day is
 * missed silently. Five minutes of grace costs nothing (a contact scheduled for
 * tomorrow is 24 hours away, not five minutes) and removes the failure mode.
 */
export const SELECTION_GRACE_MS = 5 * 60 * 1000;

/**
 * Interactions read per contact for the cadence derivation.
 *
 * SPEC §4 says the *prompt* gets the last 10. The derivation needs enough
 * history to find the contact's last inbound reply, which can sit further back
 * than ten rows on a chatty contact. Fifty is read once and sliced to ten for
 * the prompt, so this costs one query, not two.
 *
 * If a contact somehow has fifty consecutive outbound rows and no reply inside
 * the window, the derived count is a lower bound — and a lower bound of fifty
 * already exhausts every sequence in the table, so the answer (dormant) is the
 * same one the full history would give.
 */
export const INTERACTION_HISTORY_LIMIT = 50;

/** SPEC §4 step 2: "the last 10 interactions". */
export const PROMPT_INTERACTION_LIMIT = 10;

/**
 * Hard ceiling on contacts processed in one run.
 *
 * One Sonnet call per contact, so an import accident or a botched backfill that
 * makes 800 rows due at once is a money event as well as a rate-limit one. The
 * LLM wrapper's daily cost cap is the real backstop; this is the cheap one that
 * fires first and leaves the overflow due tomorrow rather than dropped.
 */
export const MAX_CONTACTS_PER_RUN = 60;

/**
 * Bounds on the model's `suggested_next_touch_days` when it declines to write.
 *
 * The floor stops a `0` from re-considering the same contact every morning
 * forever; the ceiling stops a hallucinated `3650` from quietly deleting a
 * contact from the pipeline. Outside the bounds the cadence table wins.
 */
export const MIN_PUSH_OUT_DAYS = 3;
export const MAX_PUSH_OUT_DAYS = 90;

// ---------------------------------------------------------------------------
// Timezone arithmetic
// ---------------------------------------------------------------------------
//
// This module used to carry a private copy of `partsInZone`, `zoneOffsetMs` and
// `zonedTimeToUtc`, with a comment saying it was duplicated from
// `apps/web/lib/validation.ts` and that if one changed both must. Step 6 needed
// the same arithmetic a third time, from both apps, so it now lives once in
// `packages/core/src/zone.ts` and all three callers import it. The functions
// there are step for step what was here — the same two-pass offset resolution,
// the same hour-24 correction — so this is a move, not a rewrite, and the DST
// cases in `followup-select.test.ts` are what proves it.
//
// `zonedTimeToUtc` is re-exported because `src/index.ts` schedules the daily run
// through it and importing it from the job that defines the hour keeps those two
// facts next to each other.

export { zonedTimeToUtc };

/**
 * `days` calendar days after `from`, at `FOLLOWUP_HOUR` local time.
 *
 * **Calendar days, not `days * 86_400_000`.** Greece observes DST, so two of the
 * intervals in SPEC §4's table straddle a clock change every year. Adding
 * milliseconds puts a +7 landing on a Tuesday 08:00 at Tuesday 07:00 or 09:00,
 * and a 07:00 date is not selected by that morning's 08:00 run — the contact
 * slips a full day, once a year, for reasons nobody would ever find.
 */
export function atFollowupHour(from: Date, days: number, timeZone: string): Date {
  const p = partsInZone(from, timeZone);
  // Date.UTC normalises the rollover: day 30 + 5 becomes the 4th of next month,
  // including across a year boundary.
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedTimeToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    FOLLOWUP_HOUR,
    0,
    timeZone,
  );
}

// ---------------------------------------------------------------------------
// The due-contact predicate
// ---------------------------------------------------------------------------

/**
 * What the orchestrator should do about a contact it decided not to draft for.
 *
 *  - `none`             leave the row alone. It stays due, which for a contact
 *                       with no email address is the point (see below).
 *  - `clear_next_touch` set `next_touch_at = null`. Nothing is ever scheduled
 *                       for this contact again until a human schedules it.
 *  - `alert`            file a pending `alert` task. Data the agent cannot act
 *                       on, which SPEC §8 says must never be swallowed.
 */
export type ScreenAction = 'none' | 'clear_next_touch' | 'alert';

export type ScreenResult =
  | { due: true }
  | { due: false; reason: string; action: ScreenAction };

/**
 * Is this contact one the agent should draft for right now?
 *
 * Re-checks, in code, three things the selection query already filters on. That
 * is not redundancy for its own sake: the query is written once in
 * `followup.ts` against PostgREST, where `stage <> 'lost'` silently drops rows
 * whose stage is NULL (three-valued logic), and a filter that is wrong in the
 * quiet direction is exactly the bug this application exists to not have. These
 * assertions are the ones that are unit-testable.
 *
 * **A contact with no email address is skipped, and their date is deliberately
 * NOT pushed out.** `apps/web/lib/validation.ts` promises that a name and a
 * follow-up date is enough to enter a contact, and says so because the commonest
 * contact in this pipeline is an NFC card with a name and a phone number. The
 * date on such a row is still worth having — it lifts them to the top of
 * `/pipeline` on the morning they are due, which is a reminder for the operator
 * even when the agent has nothing to send. Pushing it out would take that
 * reminder away every single morning until the address is filled in. Leaving it
 * costs one row in a query and no model call.
 */
export function screenContact(
  contact: Pick<
    Contact,
    'stage' | 'do_not_contact' | 'next_touch_at' | 'email'
  >,
  now: Date,
  graceMs: number = SELECTION_GRACE_MS,
): ScreenResult {
  if (contact.do_not_contact === true) {
    return {
      due: false,
      reason: 'do_not_contact is set',
      action: 'clear_next_touch',
    };
  }

  if (contact.stage === 'lost') {
    return { due: false, reason: 'stage is lost', action: 'clear_next_touch' };
  }

  // NULL stage passes the database CHECK constraint and fails every union in
  // types.ts. `nextTouch` has no rule for it and would return `stop`, which
  // would quietly clear the date on a row whose real problem is that somebody's
  // import forgot a column. Surface it instead.
  if (contact.stage === null) {
    return { due: false, reason: 'stage is missing', action: 'alert' };
  }

  if (contact.next_touch_at === null) {
    return { due: false, reason: 'no follow-up scheduled', action: 'none' };
  }

  const dueAt = new Date(contact.next_touch_at);
  if (Number.isNaN(dueAt.getTime())) {
    return {
      due: false,
      reason: `next_touch_at is not a valid timestamp: ${contact.next_touch_at}`,
      action: 'alert',
    };
  }

  if (dueAt.getTime() > now.getTime() + graceMs) {
    return { due: false, reason: 'not due yet', action: 'none' };
  }

  if (!hasEmailAddress(contact)) {
    return {
      due: false,
      reason: 'no email address — left due as a reminder in /pipeline',
      action: 'none',
    };
  }

  return { due: true };
}

/**
 * Can an email actually be drafted to this contact?
 *
 * Deliberately loose. The real address validation is in
 * `apps/web/lib/validation.ts` on the write path, and re-litigating RFC 5322
 * here would only produce a second, subtly different opinion. This answers the
 * one question the agent needs: is there something in the column at all.
 */
export function hasEmailAddress(contact: Pick<Contact, 'email'>): boolean {
  return typeof contact.email === 'string' && contact.email.trim().includes('@');
}

// ---------------------------------------------------------------------------
// Per-stage touch count — PLAN §6 step 5, constraint 2
// ---------------------------------------------------------------------------

export type StageTouchCount = {
  /** What to pass to `nextTouch`. Always a non-negative integer. */
  touchCount: number;
  /** Outbound interactions since the anchor, before the opening touch is removed. */
  outboundSinceAnchor: number;
  /** `reply` — their last inbound message. `none` — they have never replied. */
  anchorKind: 'reply' | 'stage_change' | 'none';
  anchorAt: string | null;
  /** Interaction rows the derivation could actually read (bad timestamps excluded). */
  countedInteractions: number;
  /** `contacts.touch_count`, carried for logging only. Never used in the maths. */
  lifetimeTouchCount: number | null;
  /** One sentence, written for whoever is reading `agent_runs` in three days. */
  explanation: string;
};

/**
 * Touches already made **in the contact's current stage**, derived from
 * `interactions`.
 *
 * The rule, and the reasoning for each half of it:
 *
 * **Anchor: the contact's most recent inbound interaction.** Both sequences in
 * SPEC §4's table describe the same situation — "no reply" — so the thing being
 * counted is *consecutive unanswered outbound touches*. A reply is what ends a
 * run of them. This is also why `cadence.ts` can fold `replied` into the
 * new-lead sequence without a special case: a contact who has just replied has
 * zero unanswered touches, so they land on step 0 (+3 days) by arithmetic
 * rather than by rule.
 *
 * If they have never replied, there is nothing to anchor to and every outbound
 * interaction on file counts.
 *
 * **The opening touch does not count as a chase.** See the module header: the
 * intervals in the table are measured from the outreach or the quote that
 * *established* the stage, so at the moment that message goes out the correct
 * answer is step 0. Hence `max(0, outbound - 1)`.
 *
 * Worked through the whole of both sequences:
 *
 *   stage    outbound-since-reply   touchCount   nextTouch
 *   new      0                      0            +3   (card handed over, chase in 3)
 *   contacted 1 (the outreach)      0            +3
 *   contacted 2                     1            +7
 *   contacted 3                     2            +14
 *   contacted 4                     3            dormant
 *   replied  0                      0            +3   (they replied; clock resets)
 *   quoted   1 (the quote)          0            +5
 *   quoted   2                      1            +10
 *   quoted   3                      2            +21
 *   quoted   4                      3            dormant
 *
 * **The known soft spot**, stated rather than hidden: a contact imported from a
 * CSV with `touch_count: 12` and no `interactions` rows derives to 0 and gets
 * the most aggressive interval in the table. The alternative is passing the
 * lifetime counter through, which is the bug this function exists to prevent
 * and whose failure mode is a *quoted* lead going dormant the morning after
 * being quoted — a warm lead forgotten, which is the one thing SPEC §1 says
 * this system must not do. Between "followed up sooner than ideal" and "never
 * followed up again", this errs toward the first. The lifetime counter is
 * carried into the log so the discrepancy is visible when it happens.
 *
 * Never throws, and never returns a value `nextTouch` would reject: the result
 * is a clamped array length. The per-contact `try/catch` in `followup.ts` is
 * still mandatory (PLAN §6 step 5, constraint 3) — it is there for the database,
 * the model, and rows that are malformed in ways this function does not see.
 */
export function deriveStageTouchCount(input: {
  contact: Pick<Contact, 'touch_count' | 'stage_changed_at'>;
  interactions: readonly Pick<Interaction, 'direction' | 'occurred_at'>[];
}): StageTouchCount {
  const lifetimeTouchCount =
    typeof input.contact.touch_count === 'number' ? input.contact.touch_count : null;

  // Rows whose occurred_at will not parse are dropped rather than guessed at. A
  // touch with no time cannot be placed on either side of the anchor, and
  // assuming "recent" would inflate the count toward dormancy.
  const timed: { direction: string | null; at: number }[] = [];
  let unusable = 0;
  for (const row of input.interactions) {
    const at = row.occurred_at === null ? Number.NaN : new Date(row.occurred_at).getTime();
    if (Number.isNaN(at)) {
      unusable += 1;
      continue;
    }
    timed.push({ direction: row.direction, at });
  }

  // The anchor is the LATER of two events: the last inbound reply, and the last
  // stage change.
  //
  // Anchoring on the reply alone was the original bug (PLAN.md §6 step 5,
  // constraint 2): a lead chased five times who never replies and is then quoted
  // still counts all five chases, starts the three-step quoted cadence already
  // past its end, and is marked dormant the day after being quoted. Moving
  // between stages is a fresh conversation and restarts the count, which is what
  // "per-stage touch count" means.
  let anchorAtMs: number | null = null;
  let anchorKindResolved: 'reply' | 'stage_change' | 'none' = 'none';

  for (const row of timed) {
    if (row.direction !== 'in') continue;
    if (anchorAtMs === null || row.at > anchorAtMs) {
      anchorAtMs = row.at;
      anchorKindResolved = 'reply';
    }
  }

  const stageChangedRaw = input.contact.stage_changed_at;
  const stageChangedMs =
    typeof stageChangedRaw === 'string' ? new Date(stageChangedRaw).getTime() : Number.NaN;
  if (!Number.isNaN(stageChangedMs) && (anchorAtMs === null || stageChangedMs > anchorAtMs)) {
    anchorAtMs = stageChangedMs;
    anchorKindResolved = 'stage_change';
  }

  const outboundSinceAnchor = timed.filter(
    (row) => row.direction === 'out' && (anchorAtMs === null || row.at > anchorAtMs),
  ).length;

  // The opening touch — the outreach or the quote that established the stage —
  // is not a chase. See the module header.
  const touchCount = Math.max(0, outboundSinceAnchor - 1);

  const anchorKind = anchorKindResolved;
  const anchorAt = anchorAtMs === null ? null : new Date(anchorAtMs).toISOString();

  const lifetimeNote =
    lifetimeTouchCount === null || lifetimeTouchCount === touchCount
      ? ''
      : ` (contacts.touch_count is ${lifetimeTouchCount} lifetime, not used)`;
  const unusableNote = unusable === 0 ? '' : ` ${unusable} interaction(s) had no usable timestamp.`;

  const explanation =
    anchorKind === 'stage_change'
      ? `${outboundSinceAnchor} outbound touch(es) since they moved stage on ${anchorAt}, ` +
        `so ${touchCount} chase(s) in this stage${lifetimeNote}.${unusableNote}`
      : anchorKind === 'reply'
      ? `${outboundSinceAnchor} outbound touch(es) since their last reply on ${anchorAt}, ` +
        `so ${touchCount} chase(s) in this stage${lifetimeNote}.${unusableNote}`
      : `Never replied; ${outboundSinceAnchor} outbound touch(es) on file, ` +
        `so ${touchCount} chase(s) in this stage${lifetimeNote}.${unusableNote}`;

  return {
    touchCount,
    outboundSinceAnchor,
    anchorKind,
    anchorAt,
    countedInteractions: timed.length,
    lifetimeTouchCount,
    explanation,
  };
}

// ---------------------------------------------------------------------------
// Cadence result → the next next_touch_at
// ---------------------------------------------------------------------------

/**
 * What the orchestrator writes back to the contact row.
 *
 * `at === null` means clear the column: nothing is scheduled. `becomesDormant`
 * carries the stage change, so the write site does not have to re-read the
 * cadence result to know whether to set it.
 */
export type NextTouchPlan = {
  at: Date | null;
  days: number | null;
  becomesDormant: boolean;
  reason: string;
};

/**
 * Turn a `CadenceResult` into the instant to store in `contacts.next_touch_at`.
 *
 * The `dormant` case schedules +90 rather than clearing the date, on the
 * explicit instruction in `cadence.ts`'s `DORMANT_DAYS`: a contact moved to
 * dormant with a null `next_touch_at` is never selected again, and dormant is
 * supposed to mean quiet, not deleted.
 *
 * The `stop` case does clear it. That variant means `lost`, or a suppression
 * tag, or a stage no rule covers — all of which are "do not schedule", not
 * "schedule later".
 */
export function planNextTouch(
  result: CadenceResult,
  from: Date,
  timeZone: string,
): NextTouchPlan {
  switch (result.kind) {
    case 'schedule':
      return {
        at: atFollowupHour(from, result.days, timeZone),
        days: result.days,
        becomesDormant: false,
        reason: result.reason,
      };
    case 'dormant':
      return {
        at: atFollowupHour(from, DORMANT_DAYS, timeZone),
        days: DORMANT_DAYS,
        becomesDormant: true,
        reason: result.reason,
      };
    case 'stop':
      return { at: null, days: null, becomesDormant: false, reason: result.reason };
  }
}

/**
 * The push-out for SPEC §4 step 4 — "`should_contact` false → push
 * `next_touch_at` out".
 *
 * The spec does not say how far, and the model is the only thing in the run
 * that knows *why* it declined ("their site launches in a fortnight, there is
 * nothing to say until then"), so `suggested_next_touch_days` is honoured —
 * bounded, and with the cadence interval as the fallback for anything outside
 * the bounds or not a whole number.
 *
 * **A skip does not consume a step of the sequence.** No outbound interaction
 * is written, so the next run derives the same `touchCount` and the same
 * cadence step. That is the intended behaviour: a follow-up the agent declined
 * to write should not push a live lead one step closer to dormant.
 */
export function planPushOut(
  cadence: CadenceResult,
  suggestedDays: number | null,
  from: Date,
  timeZone: string,
): NextTouchPlan {
  const fallback = cadence.kind === 'schedule' ? cadence.days : DORMANT_DAYS;
  const days = clampPushOutDays(suggestedDays, fallback);
  const honoured = suggestedDays !== null && Math.round(suggestedDays) === days;
  return {
    at: atFollowupHour(from, days, timeZone),
    days,
    becomesDormant: false,
    reason: honoured
      ? `Skipped; the agent asked to look again in ${days} days.`
      : `Skipped; next look in ${days} days (cadence default — the agent's ` +
        `suggestion of ${String(suggestedDays)} was outside ${MIN_PUSH_OUT_DAYS}–${MAX_PUSH_OUT_DAYS}).`,
  };
}

/**
 * Re-anchor `next_touch_at` on the message that actually left.
 *
 * ---------------------------------------------------------------------------
 * The bug this exists to close, because it is not obvious from either end
 * ---------------------------------------------------------------------------
 *
 * `followup.ts` writes `next_touch_at = draft time + cadence.days` on the draft
 * branch, and it has to: a card left unapproved for three days would otherwise
 * breed a duplicate every morning. But the interval it uses is the one derived
 * from the touches that had *already* happened — for a `contacted` lead with
 * one outreach on file that is step 0, +3 — and the draft it is filing is the
 * touch that moves them to step 1, +7. Nothing anywhere re-computed the date
 * once the message left, so the schedule collapsed in two separate ways:
 *
 *   - Even with same-morning approval, chase 2 was drafted three days after
 *     chase 1 rather than seven. Every interval in SPEC §4's table was being
 *     served one step early, permanently.
 *   - When the approval delay exceeded the interval — an approval on Thursday
 *     that the seeded `[2,3,4]` send window schedules for the following Tuesday
 *     — the contact came due before the message had even gone out, so the next
 *     chase was drafted the morning after the previous one landed.
 *
 * The interval in the table is measured from the touch, so it has to be
 * computed from the touch. That is what this does, at the one point in the
 * system that knows a message really left.
 *
 * ---------------------------------------------------------------------------
 * Three deliberate limits
 * ---------------------------------------------------------------------------
 *
 * **Only `schedule`.** A `dormant` or `stop` result is a *stage* decision, and
 * moving a contact between stages is the follow-up agent's job — it owns the
 * `contacts.stage` write and the alert that goes with it. Returning null leaves
 * the existing date in place, the agent reaches the contact on it, and it makes
 * the same decision it would have made anyway. Nothing is lost but a few days.
 *
 * **Never earlier than the date already stored.** This runs after a send, and a
 * send can happen days after the draft; the stored date may already have been
 * pushed further out by `inbox.ts`'s `pushNextTouch` because the contact wrote
 * back in the meantime. Pulling a date in is how a live conversation gets a
 * cold nudge on top of it. Pushing it out is always safe.
 *
 * **The interactions passed in must already include the row just written.** The
 * count is what makes the step advance; deriving it from a snapshot taken
 * before the send would reproduce the bug this function is closing.
 */
export function planNextTouchAfterSend(input: {
  contact: Pick<Contact, 'stage' | 'source' | 'tags' | 'touch_count' | 'stage_changed_at' | 'next_touch_at'>;
  /** Including the outbound row for the message that just went out. */
  interactions: readonly Pick<Interaction, 'direction' | 'occurred_at'>[];
  sentAt: Date;
  timeZone: string;
}): { at: Date; days: number; reason: string } | null {
  const stage = input.contact.stage;
  if (stage === null) return null;

  const touch = deriveStageTouchCount({
    contact: input.contact,
    interactions: input.interactions,
  });

  const cadence = nextTouch({
    stage,
    touchCount: touch.touchCount,
    source: input.contact.source,
    tags: input.contact.tags,
  });

  if (cadence.kind !== 'schedule') return null;

  const at = atFollowupHour(input.sentAt, cadence.days, input.timeZone);

  const currentRaw = input.contact.next_touch_at;
  const current = typeof currentRaw === 'string' ? new Date(currentRaw).getTime() : Number.NaN;
  if (!Number.isNaN(current) && current >= at.getTime()) return null;

  return {
    at,
    days: cadence.days,
    reason: `Next touch re-anchored to the message that left: +${cadence.days} days. ${cadence.reason}`,
  };
}

export function clampPushOutDays(suggested: number | null, fallbackDays: number): number {
  const fallback = Math.min(
    MAX_PUSH_OUT_DAYS,
    Math.max(MIN_PUSH_OUT_DAYS, Math.round(fallbackDays)),
  );
  if (suggested === null || !Number.isFinite(suggested)) return fallback;
  const rounded = Math.round(suggested);
  if (rounded < MIN_PUSH_OUT_DAYS || rounded > MAX_PUSH_OUT_DAYS) return fallback;
  return rounded;
}

// ---------------------------------------------------------------------------
// The model's answer
// ---------------------------------------------------------------------------

/**
 * SPEC §4 step 3 after validation.
 *
 * Not `FollowupDraft` from `./followup-prompt.ts` — that type is the *schema*,
 * what the model is asked for. This is what survived being checked: strings are
 * trimmed, and `suggested_next_touch_days` is nullable because a number the
 * model did not return, or returned as `Infinity`, must be expressible as
 * "absent" rather than silently becoming `0` days.
 */
export type ParsedDraft = {
  should_contact: boolean;
  reason: string;
  subject: string;
  body: string;
  suggested_next_touch_days: number | null;
  confidence: 'low' | 'medium' | 'high';
};

export type DraftParse =
  | { ok: true; draft: ParsedDraft }
  | { ok: false; problem: string };

/**
 * Validate the model's JSON before anything is written from it.
 *
 * `output_config.format` already guarantees the shape (PLAN §2), so in the
 * normal case none of this fires. It exists because the one thing the schema
 * cannot express is the interesting failure: `should_contact: true` with an
 * empty body. That is a task card the operator opens, finds blank, and stops
 * trusting the queue over — worth an alert rather than an insert.
 *
 * The 120-word rule is *not* checked here. See `draftWordCount`.
 */
export function parseDraft(value: unknown): DraftParse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problem: 'Model output was not a JSON object.' };
  }
  const raw = value as Record<string, unknown>;

  if (typeof raw['should_contact'] !== 'boolean') {
    return { ok: false, problem: 'should_contact was missing or not a boolean.' };
  }
  const shouldContact = raw['should_contact'];

  const reason = typeof raw['reason'] === 'string' ? raw['reason'].trim() : '';
  const subject = typeof raw['subject'] === 'string' ? raw['subject'].trim() : '';
  const body = typeof raw['body'] === 'string' ? raw['body'].trim() : '';

  if (shouldContact && body === '') {
    return { ok: false, problem: 'should_contact was true but the body was empty.' };
  }
  if (shouldContact && subject === '') {
    return { ok: false, problem: 'should_contact was true but the subject was empty.' };
  }
  if (!shouldContact && reason === '') {
    return { ok: false, problem: 'should_contact was false with no reason given.' };
  }

  const suggestedRaw = raw['suggested_next_touch_days'];
  const suggested =
    typeof suggestedRaw === 'number' && Number.isFinite(suggestedRaw) ? suggestedRaw : null;

  const confidenceRaw = raw['confidence'];
  const confidence =
    confidenceRaw === 'low' || confidenceRaw === 'medium' || confidenceRaw === 'high'
      ? confidenceRaw
      : 'low';

  return {
    ok: true,
    draft: {
      should_contact: shouldContact,
      reason,
      subject,
      body,
      suggested_next_touch_days: suggested,
      confidence,
    },
  };
}

/**
 * PLAN §2: "Enforce the 120-word limit in the prompt and validate it in code —
 * the schema can't."
 *
 * Validated, deliberately **not** enforced by discarding the draft — which is
 * where this parts company with the suggestion in `followup-prompt.ts`'s
 * `isWithinWordLimit` doc comment. Rejecting a 130-word draft means either the
 * follow-up does not happen at all that morning, or a second Sonnet call is
 * spent asking again; the operator gets an alert card instead of a message
 * about a real contact they can trim in ten seconds. SPEC's ranking is explicit
 * that a *filler* follow-up is worse than none, and length is not filler. The
 * overrun goes into the task's reasoning so it is visible on the card, and into
 * `agent_runs` as the signal that the prompt needs tightening.
 */
export function draftLengthNote(body: string): string | null {
  if (isWithinWordLimit(body)) return null;
  return `Draft runs over the ${WORD_LIMIT}-word limit — trim it before sending.`;
}

// ---------------------------------------------------------------------------
// Prompt cache structure
// ---------------------------------------------------------------------------

/**
 * Is the system prompt shaped so prompt caching can actually work?
 *
 * PLAN §2: the `brain` block is identical for every contact in a run, so it goes
 * **first** with a cache breakpoint and the per-contact context goes after it.
 * Get the order wrong and nothing errors — the run simply pays full input price
 * forty times over and the only evidence is a number in a billing dashboard.
 *
 * `call()` returns the parsed output and not `usage`, so
 * `cache_read_input_tokens` cannot be asserted from here. The structural check
 * is the next best thing and it catches the mistake that actually gets made:
 * a per-contact block accidentally placed ahead of the cached one.
 */
export function cacheBreakpointIssue(system: readonly SystemBlock[]): string | null {
  if (system.length === 0) return 'System prompt has no blocks.';
  const first = system[0];
  if (first === undefined || first.cache !== true) {
    return 'The first system block is not cached — the brain must come first and carry cache:true (PLAN §2).';
  }
  const lastCached = system.reduce(
    (index, block, i) => (block.cache === true ? i : index),
    -1,
  );
  if (lastCached > 0 && lastCached === system.length - 1 && system.length > 1) {
    return 'The last system block is cached — per-contact content must come after the cache breakpoint, not before it (PLAN §2).';
  }
  return null;
}
