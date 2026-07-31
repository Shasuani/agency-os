/**
 * Cadence — when the next touch is due.
 *
 * SPEC §4's table, and nothing else:
 *
 *   | New lead, no reply    | +3 days, then +7, then +14, then dormant |
 *   | Quoted, no reply      | +5 days, then +10, then +21              |
 *   | Bought an NFC card    | +14 days (check-in + web upsell)         |
 *   | Won / active client   | +30 days                                 |
 *   | Project delivered     | +30 days (referral + testimonial ask)    |
 *   | Dormant               | +90 days                                 |
 *
 * **Pure by construction.** No clock, no `Date`, no database, no LLM, no
 * randomness. The caller supplies the whole world as arguments and turns the
 * returned `days` into a timestamp itself. That is the entire point of this
 * module: the rule that decides whether a human gets emailed is testable
 * without a running system, and it produces the same answer at 03:00 in a cron
 * job as it does in a unit test.
 *
 * `reason` is part of the contract, not a comment. It is rendered on the task
 * card in `/` (Today) and written to `agent_runs.output`, so "why did it pick
 * 21 days" is answerable three days later without re-deriving it.
 *
 * ---------------------------------------------------------------------------
 * Two things the spec's table does not say, decided here
 * ---------------------------------------------------------------------------
 *
 * **1. "Project delivered" is not a stage.** The vocabulary is
 * `new|contacted|replied|quoted|won|lost|dormant` (types.ts, mirroring
 * `contacts_stage_check`). A delivered project is represented as **stage `won`
 * plus the tag `delivered`** — see `DELIVERED_TAG`.
 *
 * Why a tag and not a new stage: delivery is not a position in the pipeline.
 * A client whose project shipped is still won, and stays won while the next
 * project is discussed; a `delivered` stage would have to be un-set to sell
 * them anything, and the pipeline board would gain a column that is really a
 * property of the relationship. Adding a stage also means a migration and a
 * CHECK-constraint change, which is not what step 3 is. Tags already exist for
 * exactly this ("what the contact needed or bought", PLAN §4.1) and are read by
 * the drafting agent at step 5 anyway.
 *
 * The rejected alternative: an eighth stage `delivered`, sitting after `won`.
 * It is defensible and it would make the transition explicit and queryable in
 * one column. It was rejected for the reasons above — the cost is a migration
 * and a permanently more awkward `won`.
 *
 * Note that `delivered` and plain `won` both schedule +30 days, so the choice
 * changes no arithmetic. It changes the `reason`, and the reason is what the
 * step-5 prompt turns into a referral-and-testimonial ask rather than a
 * retainer check-in. Same interval, different email.
 *
 * **2. "Bought an NFC card" is a tag, not a source.** Keyed off the tag
 * `nfc-card` (`NFC_CARD_TAG`), never off `source === 'nfc_card'`.
 *
 * PLAN §4.1 is explicit and it is right: `source` records how someone
 * *arrived*, `tags` record what they *needed or bought*. Somebody can be handed
 * an NFC card at a meetup and hire you for an e-commerce site — `source` is
 * `nfc_card`, but they never bought a card, and a "how's the card working out?"
 * check-in would land as a message written by a machine that does not know who
 * it is talking to. The inverse is just as common: an existing client who
 * arrived by referral later buys ten cards for their staff. Source says
 * `referral` forever; the purchase is a tag.
 *
 * `source` is therefore accepted in `CadenceInput` — PLAN §6's sketch has it,
 * dropping it would be a second gratuitous divergence from that sketch, and a
 * future rule may want it — and deliberately never read. That is a decision,
 * not an oversight.
 *
 * Fail-safe check on this choice: an old contact imported with
 * `source='nfc_card'` and no tags falls through to the plain `won` rule and is
 * scheduled at +30 instead of +14. Later, not sooner — a missed upsell, not an
 * unwanted email. The failure mode points the safe way.
 *
 * ---------------------------------------------------------------------------
 * What `touchCount` means — read this before calling
 * ---------------------------------------------------------------------------
 *
 * `touchCount` is **touches already made in the contact's current stage**, so
 * `0` selects the first step of a sequence.
 *
 * `contacts.touch_count` is a *lifetime* counter. Passing it straight in is a
 * bug: a lead touched five times and then quoted would arrive here with
 * `touchCount: 5`, fall off the end of `QUOTED_SEQUENCE`, and be marked dormant
 * the day after being quoted — the single worst thing this system could do. The
 * caller (step 5) must reset the counter when `stage` changes, or derive a
 * per-stage count from `interactions`. This is flagged rather than papered over
 * because the schema currently has no column that carries it.
 *
 * A negative, fractional, `NaN` or infinite `touchCount` **throws**
 * `RangeError` rather than clamping. Clamping a `-1` to step 0 silently
 * produces the *most aggressive* schedule in the table (+3 days) off data that
 * is known to be broken, and nothing anywhere would ever report it. A throw is
 * caught by the job runner's retry-once-then-file-an-alert path (SPEC §8), so
 * corrupt data becomes a card the operator sees instead of an email a stranger
 * receives.
 *
 * ---------------------------------------------------------------------------
 * Three notes for whoever writes the caller (step 5)
 * ---------------------------------------------------------------------------
 *
 * **A. SPEC §4's selection query excludes `won`, and this module does not.**
 * SPEC §4 step 1 says "stage not in (`won`, `lost`)", and SPEC §3 says "`won`
 * contacts become clients and move to a retainer cadence" — but three of the
 * six rows of SPEC §4's own cadence table live on the `won` side: NFC card
 * (+14), project delivered (+30) and active client (+30). Implement that query
 * literally and half the table never executes: clients silently never get a
 * check-in, and nothing fails, because this function is happy to return +30 in
 * a test that never runs against the database.
 *
 * This is a contradiction inside the spec, not a bug here. The intervals above
 * are the ones the table gives. The caller's query should therefore be
 * `do_not_contact = false and stage <> 'lost'` — `lost` is the only stage this
 * module refuses outright, and the retainer cadence *is* the `won` rows. If the
 * operator would rather keep clients out of the daily agent entirely, that is a
 * legitimate choice, but it must be a decision recorded somewhere, not an
 * accident of copying the query.
 *
 * **B. The signature is not the one-liner in PLAN §6.** PLAN §6 step 3 sketches
 * `nextTouch(stage, touchCount, source): { days } | { dormant: true }`. What is
 * implemented is `nextTouch(input: CadenceInput): CadenceResult` — one object
 * parameter, a fourth field `tags`, a third `stop` variant, and `reason` on
 * every variant. The extra field is decision 2 below (a purchase is a tag);
 * `stop` is needed because `lost` and suppressed contacts must be expressible
 * as "never", which neither `{ days }` nor `{ dormant: true }` can say; and
 * `reason` is what step 5's prompt and the Today card actually render. PLAN §6
 * has not been updated to match — doing so is a documentation task for the
 * operator, in the style of the "Correction (found during step 2)" note in
 * PLAN §4.
 *
 * **C. A suppression tag here does not set `contacts.do_not_contact`.** See
 * `SUPPRESSION_TAGS`.
 */

import type { Source, Stage } from './types';

// ---------------------------------------------------------------------------
// The table, as named constants so tests assert against names, not magic numbers
// ---------------------------------------------------------------------------

/** "New lead, no reply — +3 days, then +7, then +14, then dormant." */
export const LEAD_SEQUENCE = [3, 7, 14] as const satisfies readonly number[];

/** "Quoted, no reply — +5 days, then +10, then +21." */
export const QUOTED_SEQUENCE = [5, 10, 21] as const satisfies readonly number[];

/** "Bought an NFC card — +14 days (check-in + web upsell)." */
export const NFC_CHECK_IN_DAYS = 14;

/** "Won / active client — +30 days." */
export const ACTIVE_CLIENT_DAYS = 30;

/** "Project delivered — +30 days (referral + testimonial ask)." */
export const DELIVERED_DAYS = 30;

/**
 * "Dormant — +90 days."
 *
 * Also the interval the caller should write to `next_touch_at` at the moment it
 * acts on a `{ kind: 'dormant' }` result: `CadenceResult` carries no `days` on
 * that variant, and a contact moved to dormant with a null `next_touch_at`
 * never gets selected again. Dormant means quiet, not deleted.
 */
export const DORMANT_DAYS = 90;

/** The tag that marks a `won` contact whose project has shipped. See the header. */
export const DELIVERED_TAG = 'delivered';

/** The tag that marks a contact who actually bought an NFC card. See the header. */
export const NFC_CARD_TAG = 'nfc-card';

/**
 * Tags that stop scheduling outright, whatever the stage says.
 *
 * `contacts.do_not_contact` is the real, permanent flag and is checked again at
 * send time in guardrails.ts — this is not a replacement for it. It is a second
 * lock on the same door, for the cases where an opt-out was recorded as a tag
 * (a CSV import, a note typed during a phone call) before anyone thought to
 * flip the boolean. Suppression is the one direction where being wrong is
 * expensive, so it is checked before anything else and it is checked here too.
 *
 * Two obligations come with keeping it, because otherwise the two locks drift:
 *
 *  - **Step 6's `guardrails.ts` must import this constant**, not retype its own
 *    list. PLAN §7 puts `do_not_contact` in guardrails; that is still where the
 *    authoritative check lives, but there must be exactly one list of opt-out
 *    synonyms in the repo and this is it.
 *  - **Step 5's caller should promote a hit to the real flag.** When `nextTouch`
 *    returns `kind: 'stop'` because of a suppression tag, the contact's
 *    `do_not_contact` is still `false` in the database — so every other code
 *    path (a manual send from `/pipeline`, a future bulk action, a CSV export)
 *    goes on believing they can be emailed. Setting `do_not_contact = true` at
 *    that point is what makes the tag mean something outside this function.
 */
export const SUPPRESSION_TAGS = [
  'do-not-contact',
  'dnc',
  'unsubscribed',
  'opted-out',
  'opt-out',
  'no-contact',
] as const satisfies readonly string[];

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Schedule the next touch this many days out. */
export type CadenceSchedule = { kind: 'schedule'; days: number; reason: string };

/**
 * Move the contact to stage `dormant`. Not "already dormant" — a contact whose
 * stage is `dormant` gets `{ kind: 'schedule', days: DORMANT_DAYS }`, because
 * the table gives dormant contacts a 90-day heartbeat rather than silence.
 */
export type CadenceDormant = { kind: 'dormant'; reason: string };

/** Never schedule. `lost`, suppressed, or a stage the table does not cover. */
export type CadenceStop = { kind: 'stop'; reason: string };

export type CadenceResult = CadenceSchedule | CadenceDormant | CadenceStop;

export type CadenceInput = {
  stage: Stage;
  /** Touches already made **in the current stage**; `0` is the first step. */
  touchCount: number;
  /**
   * Accepted and deliberately unread — see decision 2 in the header. `source`
   * is how the contact arrived, which is not a fact about what they bought.
   */
  source: Source | null;
  /** `contacts.tags`. Matched case- and separator-insensitively. */
  tags?: readonly string[];
};

// ---------------------------------------------------------------------------
// Tag matching
// ---------------------------------------------------------------------------

/**
 * Max characters per tag, matching `MAX_TAG_LENGTH` in
 * `apps/web/lib/contact-vocab.ts` and the same cap in `scripts/import-contacts.ts`.
 *
 * Applied here too so that `normalizeCadenceTag` is genuinely the same function
 * as `normalizeTag` on the write path rather than nearly the same. Without it a
 * 40-character tag normalises to 40 characters here and to 32 in the column, so
 * the value read back could never match the value passed in.
 */
export const MAX_CADENCE_TAG_LENGTH = 32;

/**
 * Lowercase, trim, collapse whitespace and underscores to single hyphens, cap
 * at `MAX_CADENCE_TAG_LENGTH`.
 *
 * Deliberately duplicated from `apps/web/lib/contact-vocab.ts` rather than
 * imported: `packages/core` must not depend on an app. The two must agree —
 * step by step, including the length cap — and they are both driven by
 * PLAN §4.1's normalisation rule.
 *
 * Applied here as well as on the write path because matching a suppression tag
 * must not depend on a row having been written by a code path that normalised
 * it. `Do Not Contact`, `DO_NOT_CONTACT` and `do-not-contact` all suppress.
 */
export function normalizeCadenceTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_CADENCE_TAG_LENGTH);
}

/**
 * Does this tag list contain `tag`, ignoring case and separator style?
 *
 * Non-array input (including `null`) answers `false` rather than throwing. The
 * declared type says `readonly string[] | undefined` and the column is
 * `not null default '{}'`, but PostgREST rows reach this function through JSON
 * and partial projections, and `tags: null` is what a column left out of a
 * `select` list looks like. The only throw this module makes is the deliberate
 * `RangeError` on `touchCount` (see the header); a `TypeError` leaking out of a
 * tag check would be indistinguishable from it in the job runner's alert path.
 */
export function hasTag(tags: readonly string[] | undefined, tag: string): boolean {
  if (!Array.isArray(tags)) return false;
  const wanted = normalizeCadenceTag(tag);
  if (wanted === '') return false;
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    if (normalizeCadenceTag(raw) === wanted) return true;
  }
  return false;
}

/** The first suppression tag present, or `null`. Non-array input answers `null`. */
export function findSuppressionTag(tags: readonly string[] | undefined): string | null {
  if (!Array.isArray(tags)) return null;
  for (const suppression of SUPPRESSION_TAGS) {
    if (hasTag(tags, suppression)) return suppression;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sequence stepping
// ---------------------------------------------------------------------------

/**
 * The interval for `touchCount` in `sequence`, or `null` once the sequence is
 * exhausted.
 *
 * The explicit `null` is the point: indexing past the end of an array yields
 * `undefined`, which would arrive in `next_touch_at` as an `Invalid Date` and
 * quietly remove a contact from every future query. `noUncheckedIndexedAccess`
 * is on in tsconfig.base.json, so this is enforced by the compiler as well.
 */
export function sequenceStep(
  sequence: readonly number[],
  touchCount: number,
): number | null {
  if (touchCount >= sequence.length) return null;
  return sequence[touchCount] ?? null;
}

function assertTouchCount(touchCount: number): void {
  if (!Number.isInteger(touchCount) || touchCount < 0) {
    throw new RangeError(
      `nextTouch: touchCount must be a non-negative integer, received ${String(touchCount)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// nextTouch
// ---------------------------------------------------------------------------

/**
 * SPEC §4's cadence table as a function.
 *
 * Precedence, in the order applied:
 *
 *  1. `touchCount` is validated. Bad input throws — it never becomes a
 *     schedule.
 *  2. A suppression tag stops everything, before the stage is even looked at.
 *  3. `lost` stops.
 *  4. The stage's own rule, with tags refining it for `won`.
 *
 * Tags refine `won` and nothing else, on purpose. `nfc-card` on a `quoted`
 * contact does not slow the quote chase down to +14: the open deal is the more
 * urgent and more specific fact about that conversation, and the table's NFC
 * row is describing a customer, not a live negotiation. When a `won` contact
 * carries both `delivered` and `nfc-card`, `delivered` wins — it is the
 * discrete, recent, higher-value event, and at +30 vs +14 it is also the
 * quieter of the two, which is the right way to be wrong.
 *
 * @throws {RangeError} if `touchCount` is not a non-negative integer.
 */
export function nextTouch(input: CadenceInput): CadenceResult {
  const { stage, touchCount, tags } = input;

  assertTouchCount(touchCount);

  const suppressed = findSuppressionTag(tags);
  if (suppressed !== null) {
    return {
      kind: 'stop',
      reason: `Tagged "${suppressed}" — this contact must not be emailed.`,
    };
  }

  switch (stage) {
    // -- Open conversation, no reply yet: +3 / +7 / +14, then dormant --------
    //
    // `replied` is not a row in the table. It is folded in here rather than
    // given its own rule, because the alternative — refusing to schedule a
    // stage the table omits — would drop the warmest lead in the pipeline on
    // the floor, and "no warm lead is ever forgotten" is the reason this app
    // exists. The pre-quote pace is the right pace for it; the reason string
    // says so honestly rather than claiming they never replied.
    case 'new':
    case 'contacted':
    case 'replied': {
      const days = sequenceStep(LEAD_SEQUENCE, touchCount);
      if (days === null) {
        return {
          kind: 'dormant',
          reason: `No reply after ${LEAD_SEQUENCE.length} follow-ups — going dormant.`,
        };
      }
      const step = `follow-up ${touchCount + 1} of ${LEAD_SEQUENCE.length}`;
      const reason =
        stage === 'replied'
          ? `Replied but not yet quoted — keeping it alive, ${step}.`
          : `New lead, no reply — ${step}.`;
      return { kind: 'schedule', days, reason };
    }

    // -- Quoted, no reply: +5 / +10 / +21 ------------------------------------
    //
    // The table stops after +21 and does not say what follows. Dormant, by
    // analogy with the lead row: a fourth chase on an unanswered quote is the
    // point at which this stops reading as diligence. Dormant keeps them on the
    // 90-day heartbeat, so the quote is revisited rather than abandoned.
    case 'quoted': {
      const days = sequenceStep(QUOTED_SEQUENCE, touchCount);
      if (days === null) {
        return {
          kind: 'dormant',
          reason: `Quote unanswered after ${QUOTED_SEQUENCE.length} chases — going dormant.`,
        };
      }
      return {
        kind: 'schedule',
        days,
        reason: `Quoted, no reply — chase ${touchCount + 1} of ${QUOTED_SEQUENCE.length}.`,
      };
    }

    // -- Won: an ongoing relationship, so a steady interval, not a sequence ---
    //
    // `touchCount` is intentionally ignored here. A client is never chased off
    // the end of a list into dormancy; the +30 check-in repeats for as long as
    // they are a client.
    case 'won': {
      if (hasTag(tags, DELIVERED_TAG)) {
        return {
          kind: 'schedule',
          days: DELIVERED_DAYS,
          reason: 'Project delivered — referral and testimonial ask.',
        };
      }
      if (hasTag(tags, NFC_CARD_TAG)) {
        return {
          kind: 'schedule',
          days: NFC_CHECK_IN_DAYS,
          reason: 'Bought an NFC card — check-in and website upsell.',
        };
      }
      return {
        kind: 'schedule',
        days: ACTIVE_CLIENT_DAYS,
        reason: 'Active client — monthly check-in.',
      };
    }

    // -- Dormant: alive, quiet. A 90-day heartbeat, forever. -----------------
    case 'dormant':
      return {
        kind: 'schedule',
        days: DORMANT_DAYS,
        reason: 'Dormant — 90-day check-in.',
      };

    // -- Lost: never. -------------------------------------------------------
    //
    // SPEC §4's selection query already excludes `lost`, and guardrails re-check
    // `do_not_contact` at send time. This is the third lock, and it is the one
    // that is a pure function and therefore actually provable.
    //
    // Note that `lost` is the *only* stage this module refuses outright — the
    // other half of SPEC §4's query, `stage not in ('won', ...)`, would suppress
    // three rows of the cadence table that are implemented below. See note A in
    // the header before writing that query.
    case 'lost':
      return {
        kind: 'stop',
        reason: 'Contact is lost — never schedule a follow-up.',
      };

    // -- Anything the table does not cover. ---------------------------------
    //
    // Unreachable while `Stage` and the CHECK constraint agree; reachable the
    // moment a stage is added to the database and not to this switch, or when a
    // row arrives from PostgREST with a value TypeScript was promised could not
    // exist. Stop, rather than guess an interval for a stage nobody has thought
    // about yet.
    //
    // `reason` is rendered on a task card, so it is written for the operator
    // and not for whoever is reading a stack trace. The raw stage value is
    // deliberately not interpolated into it: the caller has the whole input and
    // should log that alongside the result, rather than have an unexpected
    // database string rendered into the UI.
    default: {
      const unknown: never = stage;
      void unknown;
      return {
        kind: 'stop',
        reason: "This contact's stage isn't one the follow-up rules cover, so nothing was scheduled.",
      };
    }
  }
}
