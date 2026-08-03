/**
 * Unit tests for `packages/core/src/guardrails.ts` — PLAN §7's send-path
 * guardrails and SPEC §8's rate limits. Written from those two documents.
 *
 * The rules under test, reproduced so a failure can be read without opening
 * another file:
 *
 *   PLAN §7  | No send without an approved task | re-read the row, refuse unless
 *            |                                  | status = 'approved'
 *   PLAN §7  | Daily volume cap                 | count(interactions) where
 *            |                                  | direction='out', channel='email',
 *            |                                  | occurred_at > now - 24h, against
 *            |                                  | settings.daily_send_cap
 *   SPEC §8  | Max 1 per contact per 48h        | the same query scoped to contact_id
 *   PLAN §7  | do_not_contact                   | checked at send time, permanent
 *   PLAN §7  | Kill switch                      | settings.kill_switch, checked at
 *            |                                  | the top of every send
 *   SPEC §7  | Autonomy ladder                  | built, locked at 1
 *
 * Only the pure half is tested here. `collectSendFacts` and `assertSendAllowed`
 * take a database client, and they are thin: they gather facts and call
 * `evaluateSend`, which is where every decision lives. That split is the reason
 * this file needs no network, no database and no key.
 *
 * They are not untested. `apps/worker/src/jobs/send-queue.test.ts` drives the
 * whole send path — both halves and the three writes — against an in-memory
 * stand-in for PostgREST, which is where the queries themselves are exercised:
 * notably the `meta->>task_id` filter behind `already_sent`, whose whole job is
 * to be true 49 hours after a send.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE COMMITS TO
 * ---------------------------------------------------------------------------
 *
 * 1. **Order of precedence is part of the contract.** A contact who is both
 *    marked `do_not_contact` and sitting behind a full daily cap must refuse
 *    with `do_not_contact`. The reason is rendered on an alert card, and
 *    "we are at today's limit" invites the operator to wait a day and let it
 *    through — the exact wrong response to an opt-out. Tested pairwise, not
 *    just asserted in prose.
 *
 * 2. **`terminal` is per-reason and fixed.** Non-terminal means "the task is
 *    fine and the world is not": kill switch, daily cap, contact cooldown.
 *    Everything else is terminal. The send queue resolves terminal refusals as
 *    `skipped` and leaves non-terminal ones approved, so getting this wrong
 *    either accumulates rows that can never move or retries an opt-out every
 *    sixty seconds forever. There is one table-driven test over all fourteen.
 *
 * 3. **Both windows are half-open at the boundary.** `>= cap` refuses, so a cap
 *    of 10 permits the 10th message and refuses the 11th. Same shape for the
 *    per-contact rule: a message 47 hours ago is inside the window and blocks,
 *    49 hours ago is outside and does not. The 47/49 case is tested against
 *    `windowStart` — the arithmetic that decides which rows the count query
 *    returns — because a count alone cannot express a boundary.
 *
 * 4. **No `detail` contains an `@`.** A refusal detail ends up on a task card, in
 *    a log line and possibly in a push notification. Asserted over every reason
 *    rather than trusted, because a helpful-sounding "refusing to send to …" is
 *    the natural thing to write and it copies a customer's address into three
 *    more places.
 *
 * 5. **The autonomy ceiling is asserted as a value.** SPEC §7's hard rule for v1
 *    is that nothing leaves the system above level 1. If somebody raises
 *    `V1_MAX_AUTONOMY`, this suite fails with the clause attached. Level 3 is
 *    also asserted to permit exactly what level 1 permits and nothing more —
 *    the clamp must not become a promotion path by accident.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTACT_COOLDOWN_MS,
  DAILY_CAP_WINDOW_MS,
  MAX_PER_CONTACT_PER_WINDOW,
  SEND_REFUSAL_REASONS,
  SendRefusedError,
  V1_MAX_AUTONOMY,
  effectiveAutonomy,
  evaluateSend,
  windowStart,
} from './guardrails.js';
import type { SendDecision, SendGuardFacts, SendRefusalReason } from './guardrails.js';
import { SUPPRESSION_TAGS } from './cadence.js';
import type { AutonomyLevel, TaskStatus, TaskType } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-03-04T10:00:00.000Z');

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_ID = '22222222-2222-4222-8222-222222222222';

/**
 * The boring, permitted case. Every test below is this minus one thing, so a
 * failure names the single fact that changed rather than a whole object.
 */
function facts(over: Partial<SendGuardFacts> = {}): SendGuardFacts {
  const base: SendGuardFacts = {
    now: NOW,
    killSwitch: false,
    autonomyLevel: 1,
    dailySendCap: 10,
    task: {
      id: TASK_ID,
      type: 'draft_email',
      status: 'approved',
      contactId: CONTACT_ID,
      subject: 'Γεια σου Μαρία',
      body: 'Καλησπέρα — μια σύντομη ενημέρωση.',
    },
    contact: {
      id: CONTACT_ID,
      email: 'contact@example.gr',
      doNotContact: false,
      tags: ['ecommerce'],
    },
    alreadySent: false,
    sentInLast24h: 0,
    sentToContactInLast48h: 0,
  };
  return { ...base, ...over };
}

/** `facts` with one field of the task overridden, keeping the rest valid. */
function taskFacts(over: Partial<SendGuardFacts['task']>): SendGuardFacts {
  const base = facts();
  return { ...base, task: { ...base.task, ...over } };
}

/** `facts` with one field of the contact overridden, keeping the rest valid. */
function contactFacts(over: Partial<NonNullable<SendGuardFacts['contact']>>): SendGuardFacts {
  const base = facts();
  const contact = base.contact;
  assert.ok(contact !== null, 'fixture invariant: the base contact is not null');
  return { ...base, contact: { ...contact, ...over } };
}

function describeDecision(decision: SendDecision): string {
  return decision.allowed
    ? `allowed (to "${decision.to}")`
    : `refused ${decision.reason} (terminal=${decision.terminal}) "${decision.detail}"`;
}

function expectRefusal(
  decision: SendDecision,
  reason: SendRefusalReason,
  label: string,
): Extract<SendDecision, { allowed: false }> {
  if (decision.allowed) {
    throw new assert.AssertionError({
      message: `${label}: expected refusal ${reason}, got ${describeDecision(decision)}`,
      actual: 'allowed',
      expected: reason,
      operator: 'expectRefusal',
    });
  }
  assert.equal(
    decision.reason,
    reason,
    `${label}: expected refusal ${reason}, got ${describeDecision(decision)}`,
  );
  assert.ok(decision.detail.trim().length > 0, `${label}: detail must not be empty`);
  return decision;
}

function expectAllowed(
  decision: SendDecision,
  label: string,
): Extract<SendDecision, { allowed: true }> {
  if (!decision.allowed) {
    throw new assert.AssertionError({
      message: `${label}: expected the send to be allowed, got ${describeDecision(decision)}`,
      actual: decision.reason,
      expected: 'allowed',
      operator: 'expectAllowed',
    });
  }
  return decision;
}

// ---------------------------------------------------------------------------
// The permitted case
// ---------------------------------------------------------------------------

describe('the allow path', () => {
  it('permits an approved draft_email to a contactable address', () => {
    const decision = expectAllowed(evaluateSend(facts()), 'happy path');
    assert.equal(decision.contactId, CONTACT_ID);
    assert.equal(decision.to, 'contact@example.gr');
    assert.equal(decision.subject, 'Γεια σου Μαρία');
    assert.equal(decision.body, 'Καλησπέρα — μια σύντομη ενημέρωση.');
  });

  it('trims the address, because it becomes a header', () => {
    const decision = expectAllowed(
      evaluateSend(contactFacts({ email: '  contact@example.gr \n' })),
      'padded address',
    );
    assert.equal(decision.to, 'contact@example.gr');
  });

  it('trims the subject and passes the body through verbatim', () => {
    // The operator's own trailing newline is theirs — final_body is "what the
    // owner actually sent". A leading space in a subject is a folding bug.
    const decision = expectAllowed(
      evaluateSend(taskFacts({ subject: '  Ενημέρωση  ', body: 'Γεια.\n\n' })),
      'whitespace',
    );
    assert.equal(decision.subject, 'Ενημέρωση');
    assert.equal(decision.body, 'Γεια.\n\n');
  });

  it('permits an empty subject — Gmail accepts a subjectless message', () => {
    const decision = expectAllowed(evaluateSend(taskFacts({ subject: null })), 'null subject');
    assert.equal(decision.subject, '');
  });

  it('permits a contact with null tags and a null do_not_contact', () => {
    // Both columns are nullable and a partial projection can produce null. A
    // null do_not_contact is "not opted out"; only `true` suppresses.
    expectAllowed(
      evaluateSend(contactFacts({ tags: null, doNotContact: null })),
      'null contact columns',
    );
  });
});

// ---------------------------------------------------------------------------
// One case per refusal reason
// ---------------------------------------------------------------------------

describe('PLAN §7 — kill switch', () => {
  it('refuses every send while the switch is on', () => {
    const decision = expectRefusal(
      evaluateSend(facts({ killSwitch: true })),
      'kill_switch',
      'switch on',
    );
    assert.equal(decision.terminal, false, 'the queue must survive the switch going back on');
  });
});

describe("PLAN §7 — no send without an approved task", () => {
  it('refuses a task that could not be read (null status)', () => {
    expectRefusal(evaluateSend(taskFacts({ status: null })), 'task_not_found', 'null status');
  });

  const unapproved: TaskStatus[] = ['pending', 'sent', 'rejected', 'skipped'];
  for (const status of unapproved) {
    it(`refuses a task whose status is '${status}'`, () => {
      expectRefusal(evaluateSend(taskFacts({ status })), 'task_not_approved', status);
    });
  }

  it("refuses a task already marked 'sent'", () => {
    // The send queue writes the interactions row before it moves the task to
    // 'sent'. If the process dies after both writes, this is what the next tick
    // sees. If it dies between them, the task is still `approved` and the
    // refusal is `already_sent` — see the block below.
    expectRefusal(evaluateSend(taskFacts({ status: 'sent' })), 'task_not_approved', 'already sent');
  });

  const wrongTypes: TaskType[] = ['reminder', 'alert'];
  for (const type of wrongTypes) {
    it(`refuses a '${type}' task — it has no recipient and no draft`, () => {
      expectRefusal(evaluateSend(taskFacts({ type })), 'task_wrong_type', type);
    });
  }

  it('refuses a task with no type at all', () => {
    expectRefusal(evaluateSend(taskFacts({ type: null })), 'task_wrong_type', 'null type');
  });
});

describe('already_sent — the duplicate-send guard that does not expire', () => {
  it('refuses an approved task that already has an outbound record', () => {
    // The failure this exists for, in one line: the Gmail call succeeded, the
    // `interactions` row was written, and the `tasks` update failed three times.
    // The row is still `approved` with a `send_after` in the past, so every
    // tick from now until someone notices re-selects it.
    const decision = expectRefusal(
      evaluateSend(facts({ alreadySent: true })),
      'already_sent',
      'stuck approved after a successful send',
    );
    assert.equal(decision.terminal, true, 'no retry can un-send a message');
  });

  it('holds after the 48-hour cooldown has expired', () => {
    // This is the whole point. The cooldown was doing this job and it is a
    // rolling window: 49 hours later `sentToContactInLast48h` is 0 again, the
    // cap is clear, and without this check the same follow-up goes out a second
    // time to the same person.
    expectRefusal(
      evaluateSend(facts({ alreadySent: true, sentToContactInLast48h: 0, sentInLast24h: 0 })),
      'already_sent',
      'cooldown expired, record did not',
    );
  });

  it('is reported ahead of the cooldown while both are true', () => {
    // Within the first 48 hours both refuse. The one the operator reads should
    // be the permanent fact, not "this waits" — the task is never going out
    // again and the card should say so.
    expectRefusal(
      evaluateSend(facts({ alreadySent: true, sentToContactInLast48h: 1 })),
      'already_sent',
      'both true',
    );
  });

  it('does not fire for a task that was never sent', () => {
    // A Gmail failure leaves no interactions row, and that task must still be
    // retryable on the next tick. If this ever refuses on a plain retry, every
    // transient network blip becomes a follow-up nobody ever receives.
    expectAllowed(evaluateSend(facts({ alreadySent: false })), 'never sent');
  });
});

describe('the recipient must exist', () => {
  it('refuses a task with no contact_id', () => {
    expectRefusal(evaluateSend(taskFacts({ contactId: null })), 'no_contact', 'no contact_id');
  });

  it('refuses when the contact_id does not resolve to a row', () => {
    expectRefusal(evaluateSend(facts({ contact: null })), 'contact_missing', 'missing row');
  });

  const unusable: (string | null)[] = [null, '', '   ', 'not-an-address', ' \n '];
  for (const email of unusable) {
    it(`refuses an unusable email address (${JSON.stringify(email)})`, () => {
      expectRefusal(
        evaluateSend(contactFacts({ email })),
        'no_email_address',
        JSON.stringify(email),
      );
    });
  }
});

describe('PLAN §7 — do_not_contact, checked at send time', () => {
  it('refuses a contact marked do_not_contact', () => {
    const decision = expectRefusal(
      evaluateSend(contactFacts({ doNotContact: true })),
      'do_not_contact',
      'opted out',
    );
    assert.equal(decision.terminal, true, 'an opt-out is never worth retrying');
  });

  for (const tag of SUPPRESSION_TAGS) {
    it(`refuses a contact tagged '${tag}', even with do_not_contact false`, () => {
      expectRefusal(
        evaluateSend(contactFacts({ doNotContact: false, tags: ['ecommerce', tag] })),
        'suppression_tag',
        tag,
      );
    });
  }

  it("refuses a tag written as 'Do_Not_Contact' — normalisation comes from cadence.ts", () => {
    // The synonym list and its normalisation live in exactly one place. If this
    // fails, the two locks on the opt-out door have drifted apart.
    const decision = expectRefusal(
      evaluateSend(contactFacts({ tags: ['Do_Not_Contact'] })),
      'suppression_tag',
      'shouty tag',
    );
    assert.match(decision.detail, /do-not-contact/, 'the detail names the normalised tag');
  });

  it('does not treat an ordinary work tag as suppression', () => {
    expectAllowed(evaluateSend(contactFacts({ tags: ['nfc-card', 'redesign'] })), 'work tags');
  });
});

describe('SPEC §7 — the autonomy ladder, locked at 1', () => {
  it('is locked at level 1: "nothing leaves the system to a third party above level 1 in v1"', () => {
    assert.equal(
      V1_MAX_AUTONOMY,
      1,
      'SPEC §7 hard rule for v1: nothing leaves the system above level 1. ' +
        'Raising this is a product decision, not a config change.',
    );
  });

  it('refuses level 0 — "ask before drafting" means do not send', () => {
    const decision = expectRefusal(
      evaluateSend(facts({ autonomyLevel: 0 })),
      'autonomy_off',
      'level 0',
    );
    assert.equal(decision.terminal, true);
  });

  it('clamps levels above 1 rather than refusing them', () => {
    // A fat-fingered 2 in /brain must not silently strand a queue of approved
    // messages. Clamping is safe: only the operator can approve a task.
    for (const level of [2, 3] as AutonomyLevel[]) {
      assert.equal(effectiveAutonomy(level), 1, `level ${level} clamps to 1`);
    }
  });

  it('permits at level 3 exactly what it permits at level 1, and nothing more', () => {
    const atOne = expectAllowed(evaluateSend(facts({ autonomyLevel: 1 })), 'level 1');
    const atThree = expectAllowed(evaluateSend(facts({ autonomyLevel: 3 })), 'level 3');
    assert.deepEqual(atThree, atOne, 'a raised setting must not widen what is permitted');
  });

  it('a raised autonomy level does not relax the rate limits', () => {
    expectRefusal(
      evaluateSend(facts({ autonomyLevel: 3, sentInLast24h: 10, dailySendCap: 10 })),
      'daily_cap',
      'level 3 at the cap',
    );
    expectRefusal(
      evaluateSend(facts({ autonomyLevel: 3, sentToContactInLast48h: 1 })),
      'contact_cooldown',
      'level 3 inside the cooldown',
    );
  });

  it('a raised autonomy level does not approve an unapproved task', () => {
    // The whole safety argument for clamping rests on this: level 2 would mean
    // "send, then notify", and nothing in v1 can move a task to `approved`
    // except the operator.
    expectRefusal(
      evaluateSend(facts({ autonomyLevel: 3, task: { ...facts().task, status: 'pending' } })),
      'task_not_approved',
      'level 3, pending',
    );
  });
});

describe('the body', () => {
  const blank: (string | null)[] = [null, '', '   ', '\n\n', '\t \r\n'];
  for (const body of blank) {
    it(`refuses a blank body (${JSON.stringify(body)})`, () => {
      expectRefusal(evaluateSend(taskFacts({ body })), 'empty_body', JSON.stringify(body));
    });
  }
});

// ---------------------------------------------------------------------------
// PLAN §7 — the daily volume cap
// ---------------------------------------------------------------------------

describe('PLAN §7 — daily volume cap, rolling 24h', () => {
  it('permits one under the cap', () => {
    expectAllowed(evaluateSend(facts({ sentInLast24h: 9, dailySendCap: 10 })), '9 of 10');
  });

  it('refuses at the cap', () => {
    const decision = expectRefusal(
      evaluateSend(facts({ sentInLast24h: 10, dailySendCap: 10 })),
      'daily_cap',
      '10 of 10',
    );
    assert.equal(decision.terminal, false, 'the cap clears with time; the task must wait, not die');
    assert.match(decision.detail, /10/, 'the operator is told what the cap is');
  });

  it('refuses over the cap', () => {
    // Reachable if the cap is lowered in /brain after the day's sending.
    expectRefusal(
      evaluateSend(facts({ sentInLast24h: 11, dailySendCap: 10 })),
      'daily_cap',
      '11 of 10',
    );
  });

  it('a cap of 0 refuses everything — "pause sending without the kill switch"', () => {
    expectRefusal(evaluateSend(facts({ sentInLast24h: 0, dailySendCap: 0 })), 'daily_cap', 'cap 0');
  });

  it('says something true about a cap of 0 instead of promising a retry', () => {
    // Same branch, two different situations. A cap of 10 with 10 sent is
    // temporary — the rolling window drains and the message goes. A cap of 0 is
    // `settings-validation.ts`'s documented soft pause: deliberate, indefinite,
    // and impossible to satisfy, because `0 >= 0`. Both used to say "this goes
    // out once the last 24 hours drop below it", on a queue that halts on the
    // first task every tick for as long as the setting stands.
    const paused = evaluateSend(facts({ sentInLast24h: 0, dailySendCap: 0 }));
    assert.equal(paused.allowed, false);
    if (paused.allowed) return;
    assert.ok(!paused.detail.includes('drop below'), 'promised a retry that cannot happen');
    assert.ok(paused.detail.includes('/brain'), 'and did not say where to fix it');

    const full = evaluateSend(facts({ sentInLast24h: 10, dailySendCap: 10 }));
    assert.equal(full.allowed, false);
    if (full.allowed) return;
    assert.ok(full.detail.includes('drop below'), 'a real cap does drain');
  });

  it('honours the ramp from PLAN §7.1 without any code change', () => {
    for (const cap of [10, 20, 30, 40]) {
      expectAllowed(
        evaluateSend(facts({ sentInLast24h: cap - 1, dailySendCap: cap })),
        `week cap ${cap}, one under`,
      );
      expectRefusal(
        evaluateSend(facts({ sentInLast24h: cap, dailySendCap: cap })),
        'daily_cap',
        `week cap ${cap}, at the cap`,
      );
    }
  });

  it('counts a rolling 24 hours, not a calendar day', () => {
    assert.equal(DAILY_CAP_WINDOW_MS, 24 * 60 * 60 * 1000);
    const start = windowStart(NOW, DAILY_CAP_WINDOW_MS);
    assert.equal(start.toISOString(), '2026-03-03T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// SPEC §8 — max 1 message per contact per 48h
// ---------------------------------------------------------------------------

describe('SPEC §8 — one message per contact per 48 hours', () => {
  it('permits a contact with nothing in the window', () => {
    expectAllowed(evaluateSend(facts({ sentToContactInLast48h: 0 })), 'no prior touch');
  });

  it('refuses a contact with one message in the window', () => {
    const decision = expectRefusal(
      evaluateSend(facts({ sentToContactInLast48h: MAX_PER_CONTACT_PER_WINDOW })),
      'contact_cooldown',
      'one in the window',
    );
    assert.equal(decision.terminal, false, 'the cooldown expires; the task must wait, not die');
  });

  it('is the duplicate-send guard when the process dies mid-write', () => {
    // The send queue writes `interactions` before it moves the task to 'sent'.
    // A crash in between leaves an approved task and an interactions row, and
    // this is the check that stops the second copy going out.
    expectRefusal(
      evaluateSend(facts({ sentToContactInLast48h: 1 })),
      'contact_cooldown',
      'crash recovery',
    );
  });

  it('a message 47 hours ago blocks; 49 hours ago does not', () => {
    // `evaluateSend` receives a count, so the boundary lives in the window
    // arithmetic the count query uses. This is that arithmetic.
    assert.equal(CONTACT_COOLDOWN_MS, 48 * 60 * 60 * 1000);
    const since = windowStart(NOW, CONTACT_COOLDOWN_MS);

    const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 60 * 60 * 1000);
    const counted = (occurredAt: Date): number => (occurredAt >= since ? 1 : 0);

    assert.equal(counted(hoursAgo(47)), 1, '47 hours ago is inside the 48h window');
    assert.equal(counted(hoursAgo(49)), 0, '49 hours ago is outside it');

    expectRefusal(
      evaluateSend(facts({ sentToContactInLast48h: counted(hoursAgo(47)) })),
      'contact_cooldown',
      'touched 47 hours ago',
    );
    expectAllowed(
      evaluateSend(facts({ sentToContactInLast48h: counted(hoursAgo(49)) })),
      'touched 49 hours ago',
    );
  });

  it('the boundary itself counts — a message exactly 48 hours old still blocks', () => {
    // `.gte('occurred_at', since)` is inclusive, so the arithmetic here must be
    // too. Being wrong in this direction sends a second message; being wrong in
    // the other delays one by a second.
    const since = windowStart(NOW, CONTACT_COOLDOWN_MS);
    const exactly48h = new Date(NOW.getTime() - CONTACT_COOLDOWN_MS);
    assert.ok(exactly48h >= since);
  });
});

// ---------------------------------------------------------------------------
// Precedence — which reason the operator is shown when several apply
// ---------------------------------------------------------------------------

describe('order of precedence', () => {
  it('do_not_contact beats a full daily cap', () => {
    // "We are at today's limit" invites the operator to wait a day and let it
    // through, which is the exact wrong response to an opt-out.
    const base = contactFacts({ doNotContact: true });
    expectRefusal(
      evaluateSend({ ...base, sentInLast24h: 10, dailySendCap: 10 }),
      'do_not_contact',
      'opted out and capped',
    );
  });

  it('do_not_contact beats the per-contact cooldown', () => {
    const base = contactFacts({ doNotContact: true });
    expectRefusal(
      evaluateSend({ ...base, sentToContactInLast48h: 1 }),
      'do_not_contact',
      'opted out and cooling down',
    );
  });

  it('the kill switch is reported ahead of everything, including an opt-out', () => {
    // Not because it matters more, but because it must behave identically for
    // every task in the queue: one toggle, one answer.
    const base = contactFacts({ doNotContact: true });
    expectRefusal(
      evaluateSend({ ...base, killSwitch: true }),
      'kill_switch',
      'switch on and opted out',
    );
  });

  it('an unapproved task is reported ahead of an opt-out', () => {
    const base = contactFacts({ doNotContact: true });
    expectRefusal(
      evaluateSend({ ...base, task: { ...base.task, status: 'pending' } }),
      'task_not_approved',
      'pending and opted out',
    );
  });

  it('do_not_contact beats a suppression tag', () => {
    expectRefusal(
      evaluateSend(contactFacts({ doNotContact: true, tags: ['unsubscribed'] })),
      'do_not_contact',
      'both locks',
    );
  });

  it('a suppression tag beats a missing email address', () => {
    expectRefusal(
      evaluateSend(contactFacts({ tags: ['dnc'], email: null })),
      'suppression_tag',
      'tagged and unreachable',
    );
  });

  it('every permanent reason is reported ahead of every rate reason', () => {
    // Stated as a property rather than one more pairwise case: whatever else is
    // wrong with the task, a full cap and a live cooldown must never be the
    // reason shown for a task that could never be sent anyway.
    const capped = { sentInLast24h: 10, dailySendCap: 10, sentToContactInLast48h: 1 };
    const permanent: [string, SendGuardFacts][] = [
      ['null status', taskFacts({ status: null })],
      ['pending', taskFacts({ status: 'pending' })],
      ['reminder', taskFacts({ type: 'reminder' })],
      ['no contact_id', taskFacts({ contactId: null })],
      ['missing contact', facts({ contact: null })],
      ['opted out', contactFacts({ doNotContact: true })],
      ['tagged', contactFacts({ tags: ['opt-out'] })],
      ['no address', contactFacts({ email: null })],
      ['autonomy 0', facts({ autonomyLevel: 0 })],
      ['blank body', taskFacts({ body: '   ' })],
    ];

    for (const [label, base] of permanent) {
      const decision = evaluateSend({ ...base, ...capped });
      assert.equal(decision.allowed, false, `${label}: expected a refusal`);
      if (decision.allowed) continue;
      assert.notEqual(decision.reason, 'daily_cap', `${label}: reported the cap instead`);
      assert.notEqual(decision.reason, 'contact_cooldown', `${label}: reported the cooldown instead`);
      assert.equal(decision.terminal, true, `${label}: a permanent reason must be terminal`);
    }
  });
});

// ---------------------------------------------------------------------------
// Properties that hold across every reason
// ---------------------------------------------------------------------------

/** One fact set per reason, so the suite can iterate over all fourteen. */
const REFUSAL_CASES: Record<SendRefusalReason, SendGuardFacts> = {
  kill_switch: facts({ killSwitch: true }),
  task_not_found: taskFacts({ status: null }),
  task_not_approved: taskFacts({ status: 'pending' }),
  already_sent: facts({ alreadySent: true }),
  task_wrong_type: taskFacts({ type: 'alert' }),
  no_contact: taskFacts({ contactId: null }),
  contact_missing: facts({ contact: null }),
  do_not_contact: contactFacts({ doNotContact: true }),
  suppression_tag: contactFacts({ tags: ['unsubscribed'] }),
  no_email_address: contactFacts({ email: 'nope' }),
  autonomy_off: facts({ autonomyLevel: 0 }),
  empty_body: taskFacts({ body: '  ' }),
  daily_cap: facts({ sentInLast24h: 10, dailySendCap: 10 }),
  contact_cooldown: facts({ sentToContactInLast48h: 1 }),
};

/** Non-terminal means "the task is fine and the world is not". */
const NON_TERMINAL: readonly SendRefusalReason[] = [
  'kill_switch',
  'daily_cap',
  'contact_cooldown',
];

describe('every refusal reason', () => {
  it('is reachable — the fixture table covers the whole union', () => {
    assert.deepEqual(
      Object.keys(REFUSAL_CASES).sort(),
      [...SEND_REFUSAL_REASONS].sort(),
      'a reason with no test case is a reason nobody has checked',
    );
  });

  for (const reason of SEND_REFUSAL_REASONS) {
    const input = REFUSAL_CASES[reason];

    it(`${reason}: produces its own reason code`, () => {
      expectRefusal(evaluateSend(input), reason, reason);
    });

    it(`${reason}: carries a human sentence with no customer data in it`, () => {
      const decision = expectRefusal(evaluateSend(input), reason, reason);
      const detail = decision.detail;

      assert.ok(detail.trim().length > 0, `${reason}: detail must not be empty`);
      assert.ok(
        /[.!]$/.test(detail.trim()),
        `${reason}: detail is shown to the operator and should be a sentence, got "${detail}"`,
      );
      assert.ok(!detail.includes('@'), `${reason}: detail must not contain an email address`);
      assert.ok(
        !detail.includes('contact@example.gr'),
        `${reason}: detail must not contain the recipient`,
      );
      assert.ok(!detail.includes('Μαρία'), `${reason}: detail must not contain a name`);
      assert.ok(
        !detail.includes('Καλησπέρα'),
        `${reason}: detail must not contain the message body`,
      );
      assert.ok(!detail.includes(TASK_ID), `${reason}: detail is prose, not an id dump`);
    });

    it(`${reason}: is ${NON_TERMINAL.includes(reason) ? 'not ' : ''}terminal`, () => {
      const decision = expectRefusal(evaluateSend(input), reason, reason);
      assert.equal(
        decision.terminal,
        !NON_TERMINAL.includes(reason),
        `${reason}: terminal decides whether the send queue resolves the task or retries it`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// SendRefusedError — the shape the send queue branches on
// ---------------------------------------------------------------------------

describe('SendRefusedError', () => {
  it('carries the reason, the detail, the terminal flag and the task id', () => {
    const decision = expectRefusal(
      evaluateSend(contactFacts({ doNotContact: true })),
      'do_not_contact',
      'error shape',
    );
    const error = new SendRefusedError(TASK_ID, decision);

    assert.ok(error instanceof SendRefusedError);
    assert.ok(error instanceof Error, 'must survive a generic catch');
    assert.equal(error.name, 'SendRefusedError');
    assert.equal(error.taskId, TASK_ID);
    assert.equal(error.reason, 'do_not_contact');
    assert.equal(error.detail, decision.detail);
    assert.equal(error.terminal, true);
  });

  it('puts the reason and the task id in the message, and no customer data', () => {
    // The message is what lands in a log line if a caller logs the error whole.
    const decision = expectRefusal(
      evaluateSend(contactFacts({ email: 'contact@example.gr', doNotContact: true })),
      'do_not_contact',
      'error message',
    );
    const error = new SendRefusedError(TASK_ID, decision);

    assert.match(error.message, /do_not_contact/);
    assert.match(error.message, new RegExp(TASK_ID));
    assert.ok(!error.message.includes('@'), 'no address may reach a log line');
  });
});
