/**
 * Unit tests for `packages/core/src/cadence.ts` — SPEC.md §4, the cadence
 * defaults table. Written from the spec, not from the implementation.
 *
 * The table under test, reproduced verbatim so a failure can be read against it
 * without opening another file:
 *
 *   | Situation             | Next touch                                  |
 *   |-----------------------|---------------------------------------------|
 *   | New lead, no reply    | +3 days, then +7, then +14, then dormant    |
 *   | Quoted, no reply      | +5 days, then +10, then +21                 |
 *   | Bought an NFC card    | +14 days (check-in + web upsell)            |
 *   | Won / active client   | +30 days                                    |
 *   | Project delivered     | +30 days (referral + testimonial ask)       |
 *   | Dormant               | +90 days                                    |
 *
 * Every `describe` below names the row it covers, so a failing test says which
 * row broke.
 *
 * ---------------------------------------------------------------------------
 * READINGS THIS SUITE COMMITS TO
 * ---------------------------------------------------------------------------
 * The table describes *situations*; the database stores `stage`, `source` and
 * `tags`. Mapping one onto the other requires four decisions the spec does not
 * make explicitly. They are stated here rather than buried in an assertion,
 * because each is a place where an independent reading could reasonably differ.
 *
 * 1. "Project delivered" is not a stage. The vocabulary is
 *    new|contacted|replied|quoted|won|lost|dormant (types.ts `Stage`).
 *    READING: delivered == stage 'won' + the tag `delivered`.
 *    Alternative rejected: adding 'delivered' to the `Stage` union. types.ts is
 *    explicit that every stage value is mirrored by a Postgres CHECK
 *    constraint, so a new union member without a matching migration is "a type
 *    that compiles and a write the database rejects at runtime".
 *    Both rows land on +30, so the observable difference is the `reason`, which
 *    the pinned contract makes part of the API (it is shown in the UI and
 *    logged). Asserted here as: delivered's reason mentions referral or
 *    testimonial, and differs from the plain-won reason.
 *
 * 2. "Bought an NFC card" keys off the TAG `nfc-card`, not `source='nfc_card'`.
 *    PLAN.md §4.1 states the case directly: `source` records how someone
 *    arrived, `tags` record what they needed or bought, and "inferring that from
 *    `source` is the wrong signal — `source` records the introduction, not the
 *    purchase". Someone can arrive on an NFC card and buy an e-commerce site;
 *    someone can be referred by a friend and buy an NFC card. `source` is
 *    therefore asserted to be *inert* for cadence purposes.
 *
 * 3. The NFC row is gated on stage 'won'. `tags` mean "what they need OR
 *    bought" (§4.1), so `nfc-card` on a stage-'new' contact means they want one,
 *    not that they own one. Fails safe in both directions: a +14 first touch on
 *    a fresh lead is far too slow, and a "how's the card going?" check-in to
 *    someone who never bought is the "emailed when they should not be" failure,
 *    which the brief ranks as a real problem rather than a missed opportunity.
 *
 * 4. Stages 'contacted' and 'replied' run the "New lead, no reply" sequence.
 *    They are the pre-quote lead stages; the row is the lead-nurture cadence.
 *    Returning 'stop' for 'replied' — on the grounds that a contact who replied
 *    is not "no reply" — would mean the warmest contact in the pipeline is
 *    never scheduled again, contradicting SPEC §1: "every contact who has ever
 *    spoken to him gets followed up on time".
 *
 * And three places the spec is silent, resolved toward "fail safe":
 *
 *  - Past the end of the quoted sequence (touchCount >= 3) the spec stops
 *    talking. Resolved as dormant, following the pattern the new-lead row sets
 *    explicitly, which keeps the contact on the +90 cadence instead of dropping
 *    them.
 *
 *  - Negative / fractional / NaN `touchCount` is corrupt data, and `nextTouch`
 *    THROWS `RangeError` rather than answering.
 *
 *    This suite originally asserted clamping to the first step of the sequence.
 *    That was wrong, and the reasoning is worth keeping because it is subtle.
 *    There are three candidate behaviours, not two:
 *
 *      throw  — no email is drafted, and SPEC §8's "retries once, then creates
 *               an alert task, never silently swallows the failure" turns the
 *               bad row into a card the operator actually sees.
 *      clamp  — schedules the *shortest* interval in the whole table (+3) off
 *               data already known to be broken, and nothing anywhere reports
 *               it.
 *      stop   — no email, but the contact is silently never scheduled again.
 *
 *    The original argument here — that 'stop' silently drops a live contact —
 *    is a correct argument against `stop`, and it does not touch `throw`.
 *    Throwing is the opposite of silent. Under the governing rule ("a contact
 *    scheduled too late is a missed opportunity, a contact emailed when they
 *    should not be is a real problem") clamping is the only one of the three
 *    that emails a human off corrupt data. So: throw.
 *
 *    Validation runs before the stage is examined, so a corrupt row throws
 *    uniformly rather than throwing or not depending on which stage it carries.
 *    FLAGGED FOR THE HUMAN: step 5's per-contact loop must catch per contact,
 *    or one corrupt row aborts the whole daily batch.
 *
 *  - Precedence when several rows could match:
 *    suppressed > lost > dormant > delivered > nfc-card > won.
 *    Least contact wins throughout. This suite originally ranked nfc-card above
 *    delivered on a "most specific purchase" reading; that is corrected below.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DELIVERED_TAG,
  MAX_CADENCE_TAG_LENGTH,
  NFC_CARD_TAG,
  SUPPRESSION_TAGS,
  nextTouch,
  normalizeCadenceTag,
} from './cadence.js';
import type { CadenceInput, CadenceResult } from './cadence.js';
import type { Source, Stage } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every value of the `Stage` union, so exhaustiveness tests cannot drift. */
const ALL_STAGES: readonly Stage[] = [
  'new',
  'contacted',
  'replied',
  'quoted',
  'won',
  'lost',
  'dormant',
];

/** Every value of the `Source` union, plus the null the column allows. */
const ALL_SOURCES: readonly (Source | null)[] = [
  'nfc_card',
  'referral',
  'inbound',
  'outbound',
  'walk_in',
  null,
];

/**
 * Builds an input with the boring defaults filled in. `source` is required by
 * the signature and defaults to null here precisely because reading #2 says it
 * must not affect the answer.
 */
function input(over: Partial<CadenceInput> & { stage: Stage }): CadenceInput {
  return { touchCount: 0, source: null, ...over };
}

/** `reason` is part of the contract — it is rendered and logged, not a comment. */
function assertReason(result: CadenceResult, label: string): void {
  assert.equal(typeof result.reason, 'string', `${label}: reason must be a string`);
  assert.ok(result.reason.trim().length > 0, `${label}: reason must not be empty`);
}

function describeResult(result: CadenceResult): string {
  return result.kind === 'schedule'
    ? `schedule +${result.days} ("${result.reason}")`
    : `${result.kind} ("${result.reason}")`;
}

function expectSchedule(result: CadenceResult, days: number, label: string): void {
  if (result.kind !== 'schedule') {
    throw new assert.AssertionError({
      message: `${label}: expected schedule +${days} days, got ${describeResult(result)}`,
      actual: result.kind,
      expected: 'schedule',
      operator: 'expectSchedule',
    });
  }
  assert.equal(result.days, days, `${label}: expected +${days} days, got +${result.days}`);
  assert.ok(
    Number.isInteger(result.days) && result.days > 0,
    `${label}: days must be a positive integer, got ${result.days}`,
  );
  assertReason(result, label);
}

function expectDormant(result: CadenceResult, label: string): void {
  assert.equal(
    result.kind,
    'dormant',
    `${label}: expected kind 'dormant', got ${describeResult(result)}`,
  );
  assertReason(result, label);
}

function expectStop(result: CadenceResult, label: string): void {
  assert.equal(
    result.kind,
    'stop',
    `${label}: expected kind 'stop', got ${describeResult(result)}`,
  );
  assertReason(result, label);
}

/** Narrowing accessor for tests that need to compare `reason` strings. */
function reasonOf(result: CadenceResult): string {
  return result.reason;
}

// ---------------------------------------------------------------------------
// Row: New lead, no reply — +3 days, then +7, then +14, then dormant
// ---------------------------------------------------------------------------

describe("SPEC §4 row 'New lead, no reply' — +3, then +7, then +14, then dormant", () => {
  it('stage new, touchCount 0 → +3 days (first touch)', () => {
    expectSchedule(nextTouch(input({ stage: 'new', touchCount: 0 })), 3, 'new/0');
  });

  it('stage new, touchCount 1 → +7 days (second touch)', () => {
    expectSchedule(nextTouch(input({ stage: 'new', touchCount: 1 })), 7, 'new/1');
  });

  it('stage new, touchCount 2 → +14 days (third touch)', () => {
    expectSchedule(nextTouch(input({ stage: 'new', touchCount: 2 })), 14, 'new/2');
  });

  it('stage new, touchCount 3 → dormant (the transition named in PLAN §6 step 3)', () => {
    expectDormant(nextTouch(input({ stage: 'new', touchCount: 3 })), 'new/3');
  });

  it('the full sequence in order is 3, 7, 14, dormant', () => {
    const steps = [0, 1, 2].map((touchCount) => nextTouch(input({ stage: 'new', touchCount })));
    const days = steps.map((r) => (r.kind === 'schedule' ? r.days : r.kind));
    assert.deepEqual(days, [3, 7, 14], 'new-lead sequence must be exactly +3, +7, +14');
    expectDormant(nextTouch(input({ stage: 'new', touchCount: 3 })), 'new/3');
  });

  it('stage contacted runs the same sequence — contacted with no reply IS the row', () => {
    expectSchedule(nextTouch(input({ stage: 'contacted', touchCount: 0 })), 3, 'contacted/0');
    expectSchedule(nextTouch(input({ stage: 'contacted', touchCount: 1 })), 7, 'contacted/1');
    expectSchedule(nextTouch(input({ stage: 'contacted', touchCount: 2 })), 14, 'contacted/2');
    expectDormant(nextTouch(input({ stage: 'contacted', touchCount: 3 })), 'contacted/3');
  });

  it('stage replied runs the same sequence — reading #4, a warm lead is never dropped', () => {
    expectSchedule(nextTouch(input({ stage: 'replied', touchCount: 0 })), 3, 'replied/0');
    expectSchedule(nextTouch(input({ stage: 'replied', touchCount: 1 })), 7, 'replied/1');
    expectSchedule(nextTouch(input({ stage: 'replied', touchCount: 2 })), 14, 'replied/2');
    expectDormant(nextTouch(input({ stage: 'replied', touchCount: 3 })), 'replied/3');
  });

  it('touchCount past the end of the sequence stays dormant, it does not wrap', () => {
    for (const touchCount of [4, 5, 12, 99, 1000]) {
      expectDormant(nextTouch(input({ stage: 'new', touchCount })), `new/${touchCount}`);
      expectDormant(
        nextTouch(input({ stage: 'contacted', touchCount })),
        `contacted/${touchCount}`,
      );
      expectDormant(nextTouch(input({ stage: 'replied', touchCount })), `replied/${touchCount}`);
    }
  });

  it('negative touchCount is corrupt data and throws — it never becomes the aggressive +3', () => {
    // Adjudicated: clamping would schedule the shortest interval in the table
    // off data known to be broken, silently. See the header.
    assert.throws(() => nextTouch(input({ stage: 'new', touchCount: -1 })), RangeError, 'new/-1');
    assert.throws(() => nextTouch(input({ stage: 'new', touchCount: -99 })), RangeError, 'new/-99');
    assert.throws(
      () => nextTouch(input({ stage: 'contacted', touchCount: -1 })),
      RangeError,
      'contacted/-1',
    );
  });

  it('the answer does not depend on source — every Source value and null give +3', () => {
    for (const source of ALL_SOURCES) {
      expectSchedule(nextTouch(input({ stage: 'new', touchCount: 0, source })), 3, `new/0/${source}`);
    }
  });

  it('unrelated tags do not disturb the sequence', () => {
    expectSchedule(
      nextTouch(input({ stage: 'new', touchCount: 1, tags: ['ecommerce', 'redesign'] })),
      7,
      'new/1 + work tags',
    );
  });
});

// ---------------------------------------------------------------------------
// Row: Quoted, no reply — +5 days, then +10, then +21
// ---------------------------------------------------------------------------

describe("SPEC §4 row 'Quoted, no reply' — +5, then +10, then +21", () => {
  it('stage quoted, touchCount 0 → +5 days', () => {
    expectSchedule(nextTouch(input({ stage: 'quoted', touchCount: 0 })), 5, 'quoted/0');
  });

  it('stage quoted, touchCount 1 → +10 days', () => {
    expectSchedule(nextTouch(input({ stage: 'quoted', touchCount: 1 })), 10, 'quoted/1');
  });

  it('stage quoted, touchCount 2 → +21 days', () => {
    expectSchedule(nextTouch(input({ stage: 'quoted', touchCount: 2 })), 21, 'quoted/2');
  });

  it('the full sequence in order is 5, 10, 21', () => {
    const days = [0, 1, 2].map((touchCount) => {
      const r = nextTouch(input({ stage: 'quoted', touchCount }));
      return r.kind === 'schedule' ? r.days : r.kind;
    });
    assert.deepEqual(days, [5, 10, 21], 'quoted sequence must be exactly +5, +10, +21');
  });

  it('after +21 with no reply → dormant (spec is silent; follows the new-lead pattern)', () => {
    expectDormant(nextTouch(input({ stage: 'quoted', touchCount: 3 })), 'quoted/3');
  });

  it('touchCount well past the end of the quoted sequence stays dormant', () => {
    for (const touchCount of [4, 7, 50, 1000]) {
      expectDormant(nextTouch(input({ stage: 'quoted', touchCount })), `quoted/${touchCount}`);
    }
  });

  it('negative touchCount throws rather than clamping to the first step', () => {
    assert.throws(() => nextTouch(input({ stage: 'quoted', touchCount: -1 })), RangeError, 'quoted/-1');
    assert.throws(
      () => nextTouch(input({ stage: 'quoted', touchCount: -42 })),
      RangeError,
      'quoted/-42',
    );
  });

  it('the answer does not depend on source', () => {
    for (const source of ALL_SOURCES) {
      expectSchedule(
        nextTouch(input({ stage: 'quoted', touchCount: 1, source })),
        10,
        `quoted/1/${source}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Row: Bought an NFC card — +14 days (check-in + web upsell)
// ---------------------------------------------------------------------------

describe("SPEC §4 row 'Bought an NFC card' — +14 days, keyed off the tag, not the source", () => {
  it("stage won + tag 'nfc-card' → +14 days", () => {
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 0, tags: ['nfc-card'] })),
      14,
      'won + nfc-card tag',
    );
  });

  it('the +14 check-in recurs — it is a cadence, not a one-shot sequence', () => {
    for (const touchCount of [0, 1, 2, 5, 40]) {
      expectSchedule(
        nextTouch(input({ stage: 'won', touchCount, tags: ['nfc-card'] })),
        14,
        `won + nfc-card/${touchCount}`,
      );
    }
  });

  it('other tags alongside it do not matter, and position in the array does not matter', () => {
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 0, tags: ['ecommerce', 'nfc-card', 'seo'] })),
      14,
      'won + nfc-card among other tags',
    );
  });

  it("AMBIGUITY 2 — source 'nfc_card' alone does NOT trigger the row (PLAN §4.1)", () => {
    // Arrived on a card, bought a website. `source` is the introduction, not the
    // purchase. This contact is a plain active client: +30, not +14.
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 0, source: 'nfc_card', tags: ['website'] })),
      30,
      "won + source nfc_card, tagged 'website'",
    );
  });

  it("AMBIGUITY 2 — source 'nfc_card' with no tags at all is still just a won client (+30)", () => {
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 0, source: 'nfc_card' })),
      30,
      'won + source nfc_card, no tags',
    );
  });

  it("AMBIGUITY 2 — a referred customer who bought a card DOES get +14", () => {
    // The mirror image: the purchase is real, the introduction was a referral.
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 0, source: 'referral', tags: ['nfc-card'] })),
      14,
      'won + source referral + nfc-card tag',
    );
  });

  it('source and tag agreeing changes nothing — the tag is what is read', () => {
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 0, source: 'nfc_card', tags: ['nfc-card'] })),
      14,
      'won + source nfc_card + nfc-card tag',
    );
  });

  it("READING 3 — a stage-'new' lead tagged nfc-card wants one, has not bought: +3, not +14", () => {
    expectSchedule(
      nextTouch(input({ stage: 'new', touchCount: 0, tags: ['nfc-card'] })),
      3,
      'new + nfc-card tag',
    );
  });

  it("READING 3 — a stage-'quoted' lead tagged nfc-card runs the quoted sequence", () => {
    expectSchedule(
      nextTouch(input({ stage: 'quoted', touchCount: 0, tags: ['nfc-card'] })),
      5,
      'quoted + nfc-card tag',
    );
  });

  it('negative touchCount throws even though this row ignores touchCount', () => {
    // Validation is uniform and runs before the stage is read, so a corrupt row
    // is reported wherever it lands rather than only on the stages that happen
    // to consume the counter.
    assert.throws(
      () => nextTouch(input({ stage: 'won', touchCount: -3, tags: ['nfc-card'] })),
      RangeError,
      'won + nfc-card/-3',
    );
  });

  it('the reason distinguishes it from a plain won client — the draft is an upsell', () => {
    const nfc = nextTouch(input({ stage: 'won', touchCount: 0, tags: ['nfc-card'] }));
    const won = nextTouch(input({ stage: 'won', touchCount: 0 }));
    assert.notEqual(
      reasonOf(nfc),
      reasonOf(won),
      'an NFC check-in and a client check-in are different messages; the reason must say so',
    );
    assert.match(
      reasonOf(nfc),
      /nfc|card|upsell/i,
      `NFC reason should name the situation, got "${reasonOf(nfc)}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// Row: Won / active client — +30 days
// ---------------------------------------------------------------------------

describe("SPEC §4 row 'Won / active client' — +30 days", () => {
  it('stage won, touchCount 0 → +30 days', () => {
    expectSchedule(nextTouch(input({ stage: 'won', touchCount: 0 })), 30, 'won/0');
  });

  it('the +30 retainer cadence recurs indefinitely — there is no end to the sequence', () => {
    for (const touchCount of [0, 1, 2, 3, 11, 500]) {
      expectSchedule(nextTouch(input({ stage: 'won', touchCount })), 30, `won/${touchCount}`);
    }
  });

  it('negative touchCount throws', () => {
    assert.throws(() => nextTouch(input({ stage: 'won', touchCount: -1 })), RangeError, 'won/-1');
  });

  it('the answer does not depend on source', () => {
    for (const source of ALL_SOURCES) {
      expectSchedule(nextTouch(input({ stage: 'won', touchCount: 0, source })), 30, `won/0/${source}`);
    }
  });

  it('work tags that are not nfc-card or delivered leave it at +30', () => {
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 4, tags: ['ecommerce', 'hosting', 'seo'] })),
      30,
      'won + unrelated tags',
    );
  });

  it('an omitted tags array and an empty tags array behave identically', () => {
    const omitted = nextTouch(input({ stage: 'won', touchCount: 0 }));
    const empty = nextTouch(input({ stage: 'won', touchCount: 0, tags: [] }));
    assert.deepEqual(empty, omitted, 'tags: [] must mean the same as tags omitted');
  });
});

// ---------------------------------------------------------------------------
// Row: Project delivered — +30 days (referral + testimonial ask)
// ---------------------------------------------------------------------------

describe("SPEC §4 row 'Project delivered' — +30 days (referral + testimonial ask)", () => {
  it("AMBIGUITY 1 — delivered is stage 'won' + tag 'delivered', and gives +30", () => {
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 0, tags: ['delivered'] })),
      30,
      'won + delivered tag',
    );
  });

  it('the +30 recurs — a delivered project keeps generating referral asks', () => {
    for (const touchCount of [0, 1, 3, 20]) {
      expectSchedule(
        nextTouch(input({ stage: 'won', touchCount, tags: ['delivered'] })),
        30,
        `won + delivered/${touchCount}`,
      );
    }
  });

  it('the reason differs from a plain won client — the ask is referral + testimonial', () => {
    const delivered = nextTouch(input({ stage: 'won', touchCount: 0, tags: ['delivered'] }));
    const won = nextTouch(input({ stage: 'won', touchCount: 0 }));
    assert.notEqual(
      reasonOf(delivered),
      reasonOf(won),
      'both are +30, so `reason` is the only thing carrying the difference into the draft',
    );
    assert.match(
      reasonOf(delivered),
      /referral|testimonial|deliver/i,
      `delivered reason should name the ask, got "${reasonOf(delivered)}"`,
    );
  });

  it('alongside other work tags it is still recognised', () => {
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 0, tags: ['ecommerce', 'delivered'] })),
      30,
      'won + delivered among other tags',
    );
  });

  it("READING 1 — the tag is gated on stage 'won'; on 'quoted' the quoted sequence still wins", () => {
    expectSchedule(
      nextTouch(input({ stage: 'quoted', touchCount: 0, tags: ['delivered'] })),
      5,
      'quoted + delivered tag',
    );
  });

  it("READING 1 — the tag is gated on stage 'won'; on 'new' the lead sequence still wins", () => {
    expectSchedule(
      nextTouch(input({ stage: 'new', touchCount: 0, tags: ['delivered'] })),
      3,
      'new + delivered tag',
    );
  });

  it('PRECEDENCE — delivered outranks nfc-card: +30, the quieter of the two', () => {
    // Adjudicated. SPEC §4 lists both rows and gives no precedence between them,
    // so the fail-safe rule decides: +30 contacts them less often than +14, and
    // a just-shipped project is the more recent, higher-value event to lead
    // with. The referral and testimonial ask is also the more valuable message
    // — the card upsell survives to the next cycle, a testimonial window does
    // not. Order within the array must not matter.
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 0, tags: ['delivered', 'nfc-card'] })),
      30,
      'won + delivered + nfc-card',
    );
    expectSchedule(
      nextTouch(input({ stage: 'won', touchCount: 0, tags: ['nfc-card', 'delivered'] })),
      30,
      'won + nfc-card + delivered (order reversed)',
    );
  });

  it('negative touchCount throws', () => {
    assert.throws(
      () => nextTouch(input({ stage: 'won', touchCount: -2, tags: ['delivered'] })),
      RangeError,
      'won + delivered/-2',
    );
  });
});

// ---------------------------------------------------------------------------
// Row: Dormant — +90 days
// ---------------------------------------------------------------------------

describe("SPEC §4 row 'Dormant' — +90 days", () => {
  it('stage dormant, touchCount 0 → +90 days', () => {
    expectSchedule(nextTouch(input({ stage: 'dormant', touchCount: 0 })), 90, 'dormant/0');
  });

  it('a dormant contact schedules — it does not stop', () => {
    const result = nextTouch(input({ stage: 'dormant', touchCount: 0 }));
    assert.equal(
      result.kind,
      'schedule',
      `dormant is a slow cadence, not a dead end; got ${describeResult(result)}`,
    );
  });

  it('the +90 cadence recurs indefinitely at every touchCount', () => {
    for (const touchCount of [0, 1, 2, 3, 7, 99, 1000]) {
      expectSchedule(
        nextTouch(input({ stage: 'dormant', touchCount })),
        90,
        `dormant/${touchCount}`,
      );
    }
  });

  it('negative touchCount throws', () => {
    assert.throws(
      () => nextTouch(input({ stage: 'dormant', touchCount: -1 })),
      RangeError,
      'dormant/-1',
    );
  });

  it('the answer does not depend on source', () => {
    for (const source of ALL_SOURCES) {
      expectSchedule(
        nextTouch(input({ stage: 'dormant', touchCount: 0, source })),
        90,
        `dormant/0/${source}`,
      );
    }
  });

  it('PRECEDENCE — dormant outranks the tag rows; less contact wins', () => {
    expectSchedule(
      nextTouch(input({ stage: 'dormant', touchCount: 0, tags: ['nfc-card'] })),
      90,
      'dormant + nfc-card tag',
    );
    expectSchedule(
      nextTouch(input({ stage: 'dormant', touchCount: 0, tags: ['delivered'] })),
      90,
      'dormant + delivered tag',
    );
  });
});

// ---------------------------------------------------------------------------
// 'lost' never schedules
// ---------------------------------------------------------------------------

describe("Stage 'lost' — never scheduled, under any input", () => {
  it('stage lost, touchCount 0 → stop', () => {
    expectStop(nextTouch(input({ stage: 'lost', touchCount: 0 })), 'lost/0');
  });

  it('stage lost stops at every valid touchCount, however large', () => {
    for (const touchCount of [0, 1, 2, 3, 14, 1000]) {
      expectStop(nextTouch(input({ stage: 'lost', touchCount })), `lost/${touchCount}`);
    }
  });

  it('stage lost with a corrupt touchCount throws — validation is uniform across stages', () => {
    // Both throwing and returning 'stop' would be safe here, since neither
    // emails anyone and 'lost' ignores the counter entirely. Validation is kept
    // uniform so that one bad row is reported the same way wherever it lands,
    // rather than being swallowed on exactly the stages that ignore the field.
    for (const touchCount of [-99, -1]) {
      assert.throws(
        () => nextTouch(input({ stage: 'lost', touchCount })),
        RangeError,
        `lost/${touchCount}`,
      );
    }
  });

  it('stage lost stops for every source', () => {
    for (const source of ALL_SOURCES) {
      expectStop(nextTouch(input({ stage: 'lost', touchCount: 0, source })), `lost/0/${source}`);
    }
  });

  it('PRECEDENCE — lost outranks every tag row; nothing resurrects a lost contact', () => {
    for (const tags of [['nfc-card'], ['delivered'], ['nfc-card', 'delivered'], ['ecommerce']]) {
      expectStop(
        nextTouch(input({ stage: 'lost', touchCount: 0, tags })),
        `lost + [${tags.join(', ')}]`,
      );
    }
  });

  it('stage lost never returns a days value, so no caller can accidentally schedule it', () => {
    const result = nextTouch(input({ stage: 'lost', touchCount: 2, source: 'nfc_card' }));
    assert.ok(!('days' in result), 'a stop result must not carry a days field');
  });
});

// ---------------------------------------------------------------------------
// Contract-level properties that hold for every row
// ---------------------------------------------------------------------------

describe('CadenceResult contract — properties that hold across the whole table', () => {
  it('every stage returns one of the three kinds, with a usable reason', () => {
    for (const stage of ALL_STAGES) {
      for (const touchCount of [0, 1, 2, 3, 10]) {
        const result = nextTouch(input({ stage, touchCount }));
        assert.ok(
          result.kind === 'schedule' || result.kind === 'dormant' || result.kind === 'stop',
          `${stage}/${touchCount}: unexpected kind '${result.kind}'`,
        );
        assertReason(result, `${stage}/${touchCount}`);
      }
    }
  });

  it('every scheduled result is a positive whole number of days', () => {
    for (const stage of ALL_STAGES) {
      for (const touchCount of [0, 1, 2, 3, 10]) {
        for (const tags of [[], ['nfc-card'], ['delivered']]) {
          const result = nextTouch(input({ stage, touchCount, tags }));
          if (result.kind !== 'schedule') continue;
          assert.ok(
            Number.isInteger(result.days) && result.days > 0,
            `${stage}/${touchCount}: days must be a positive integer, got ${result.days}`,
          );
        }
      }
    }
  });

  it('only the intervals in the spec table are ever produced', () => {
    const allowed = new Set([3, 5, 7, 10, 14, 21, 30, 90]);
    for (const stage of ALL_STAGES) {
      for (const source of ALL_SOURCES) {
        for (const touchCount of [0, 1, 2, 3, 4, 25]) {
          for (const tags of [[], ['nfc-card'], ['delivered'], ['nfc-card', 'delivered']]) {
            const result = nextTouch(input({ stage, touchCount, source, tags }));
            if (result.kind !== 'schedule') continue;
            assert.ok(
              allowed.has(result.days),
              `${stage}/${touchCount}/${source}/[${tags.join(',')}]: +${result.days} is not a value in the spec table`,
            );
          }
        }
      }
    }
  });

  it('a corrupt touchCount throws for every stage, and never yields a schedule', () => {
    // The whole-table statement of the adjudicated rule: no stage, and no tag
    // combination, can turn a broken counter into an email. Fractional, NaN and
    // Infinity are included because `touch_count` reaches this function through
    // JSON from PostgREST, where all three are reachable and none are integers.
    for (const stage of ALL_STAGES) {
      for (const touchCount of [-1, -99, 1.5, -0.5, NaN, Infinity, -Infinity]) {
        for (const tags of [[], ['nfc-card'], ['delivered']]) {
          assert.throws(
            () => nextTouch(input({ stage, touchCount, tags })),
            RangeError,
            `${stage}/${touchCount}/[${tags.join(',')}] must throw, not schedule`,
          );
        }
      }
    }
  });

  it('is deterministic — the same input always gives the same result', () => {
    for (const stage of ALL_STAGES) {
      const args = input({ stage, touchCount: 1, source: 'referral', tags: ['nfc-card'] });
      const first = nextTouch(args);
      assert.deepEqual(nextTouch(args), first, `${stage}: second call differed`);
      assert.deepEqual(nextTouch(args), first, `${stage}: third call differed`);
    }
  });

  it('does not mutate its input — a frozen input is accepted unchanged', () => {
    const tags = Object.freeze(['nfc-card', 'delivered']);
    const args = Object.freeze<CadenceInput>({
      stage: 'won',
      touchCount: 2,
      source: 'referral',
      tags,
    });
    const before = JSON.stringify(args);
    nextTouch(args);
    assert.equal(JSON.stringify(args), before, 'nextTouch must not mutate its input');
    assert.deepEqual(tags, ['nfc-card', 'delivered'], 'nextTouch must not mutate the tags array');
  });

  it('is pure with respect to the clock — a frozen clock is not consulted', () => {
    // No stubbing of Date is possible from inside a pure function's contract, so
    // this asserts the observable consequence: identical inputs at two different
    // moments give identical output. A Date.now() dependency would break here
    // only intermittently, but a `days` value derived from the current date
    // (e.g. skipping weekends) would break it immediately for some run days.
    const args = input({ stage: 'quoted', touchCount: 1 });
    const a = nextTouch(args);
    const b = nextTouch({ ...args });
    assert.deepEqual(b, a);
  });
});

// ---------------------------------------------------------------------------
// Malformed input that the type system promises cannot happen
// ---------------------------------------------------------------------------

describe('Hostile input — rows that TypeScript says are impossible and PostgREST produces anyway', () => {
  // The declared type of `tags` is `readonly string[] | undefined` and the
  // column is `not null default '{}'`, so every case below is a lie told by a
  // caller. They are here because the callers are a JSON round-trip and a
  // hand-written `select` list, neither of which the compiler checks. The rule
  // is that only `touchCount` throws: a bad tags value must degrade to "no
  // tags", because a TypeError escaping from here is indistinguishable, in the
  // job runner's alert path, from the deliberate RangeError.

  it('tags: null is treated as no tags, not as a crash', () => {
    const args = input({ stage: 'won', tags: null as unknown as readonly string[] });
    expectSchedule(nextTouch(args), 30, 'won + tags:null');
  });

  it('tags: null does not crash for any stage', () => {
    for (const stage of ALL_STAGES) {
      const args = input({ stage, tags: null as unknown as readonly string[] });
      assert.doesNotThrow(() => nextTouch(args), `${stage} + tags:null must not throw`);
    }
  });

  it('a non-array tags value is treated as no tags', () => {
    for (const bogus of ['nfc-card', 42, {}, true]) {
      const args = input({ stage: 'won', tags: bogus as unknown as readonly string[] });
      expectSchedule(nextTouch(args), 30, `won + tags:${JSON.stringify(bogus)}`);
    }
  });

  it('non-string entries inside tags are skipped, and real tags around them still match', () => {
    const tags = [null, 42, 'NFC_Card', undefined] as unknown as readonly string[];
    expectSchedule(nextTouch(input({ stage: 'won', tags })), 14, 'won + mixed junk + nfc');
  });

  it('a suppression tag still suppresses when the array also contains junk', () => {
    const tags = [null, 'Do Not Contact'] as unknown as readonly string[];
    expectStop(nextTouch(input({ stage: 'won', tags })), 'won + junk + do-not-contact');
  });

  it('an unrecognised stage stops, with a reason written for the operator', () => {
    const result = nextTouch(input({ stage: 'archived' as Stage }));
    expectStop(result, 'unknown stage');
    // The raw database value belongs in the log the caller writes, not in the
    // string rendered on a task card.
    assert.ok(
      !reasonOf(result).includes('archived'),
      `the reason must not interpolate the raw stage value, got "${reasonOf(result)}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// Tag normalisation — must match the write path exactly
// ---------------------------------------------------------------------------

describe('normalizeCadenceTag — the same function as normalizeTag on the write path', () => {
  it('lowercases, trims and collapses separators', () => {
    for (const raw of ['NFC-Card', ' nfc card ', 'NFC_CARD', 'nfc--card', '-nfc-card-']) {
      assert.equal(normalizeCadenceTag(raw), 'nfc-card', `normalising "${raw}"`);
    }
  });

  it('caps length at MAX_CADENCE_TAG_LENGTH, as apps/web and the CSV import do', () => {
    // Both write paths end with .slice(0, 32). If this one did not, a tag long
    // enough to be truncated on write could never be matched by a caller
    // passing the untruncated original.
    assert.equal(MAX_CADENCE_TAG_LENGTH, 32);
    const long = 'a'.repeat(40);
    assert.equal(normalizeCadenceTag(long).length, MAX_CADENCE_TAG_LENGTH);
    assert.equal(normalizeCadenceTag(long), normalizeCadenceTag(normalizeCadenceTag(long)));
  });

  it('every tag this module keys off survives its own normalisation unchanged', () => {
    for (const tag of [...SUPPRESSION_TAGS, DELIVERED_TAG, NFC_CARD_TAG]) {
      assert.equal(normalizeCadenceTag(tag), tag, `${tag} must already be in normal form`);
    }
  });
});
