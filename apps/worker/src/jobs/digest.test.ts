/**
 * Digest tests — the one notification a day, with no push service and no
 * database.
 *
 * The first half proves `composeDigest`, which is where the whole step lives:
 * every rule about what the operator is interrupted for is a pure function of
 * four numbers, so it can be checked against SPEC §5 directly. The case that
 * matters most is the one that returns null — PLAN §6 step 7 asks for "4
 * follow-ups ready" arriving once at a sane hour, and SPEC §5 warns that an app
 * pinging twenty times a day gets muted. A "0 follow-ups ready" ping on a quiet
 * morning is the first one the operator learns to swipe away, and after that the
 * useful ones go the same way.
 *
 * The second half drives `runDigest` against an in-memory stand-in for PostgREST
 * and a recording sender, following `send-queue.test.ts`. Three things it proves
 * that the pure half cannot: that the counts come from `tasks` and not from the
 * summary, so an inbox task filed yesterday afternoon is in this morning's
 * number; that a run which threw still produces a notification; and that a
 * failed notification cannot fail the run that triggered it.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Db } from '@agency/core';

import { composeDigest, runDigest, type DigestFacts } from './digest';
import type { FollowupSummary } from './followup.js';
import type { PushOutcome, PushPayload, PushSender } from './push.js';

function summary(over: Partial<FollowupSummary> = {}): FollowupSummary {
  return { considered: 0, drafted: 0, skipped: 0, failed: 0, ...over };
}

function facts(over: Partial<DigestFacts> = {}): DigestFacts {
  return {
    followup: summary(),
    pending: 0,
    inboundWaiting: 0,
    killSwitchOn: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// What is worth a notification
// ---------------------------------------------------------------------------

describe('composeDigest — the quiet morning', () => {
  it('sends nothing when the run worked and there is nothing waiting', () => {
    // The whole point of step 7. This is the ping that trains the operator to
    // ignore the next one, so it does not exist.
    assert.equal(composeDigest(facts()), null);
  });

  it('still sends nothing when the run drafted nothing and the switch is on', () => {
    // A paused system with an empty queue has nothing to say either. The kill
    // switch is a suffix on a body, not a reason to interrupt.
    assert.equal(composeDigest(facts({ killSwitchOn: true })), null);
  });

  it('sends nothing when the only thing that happened was skips', () => {
    assert.equal(composeDigest(facts({ followup: summary({ considered: 12, skipped: 12 }) })), null);
  });
});

describe('composeDigest — one draft, four drafts', () => {
  it('says "1 follow-up ready" and not "1 follow-ups ready"', () => {
    // A plural on a count of one is small, and it is the kind of small that
    // makes an internal tool feel unattended.
    const payload = composeDigest(facts({ followup: summary({ drafted: 1 }), pending: 1 }));
    assert.equal(payload?.title, '1 follow-up ready');
  });

  it('says "4 follow-ups ready", which is PLAN §6 step 7 verbatim', () => {
    const payload = composeDigest(facts({ followup: summary({ drafted: 4 }), pending: 7 }));
    assert.equal(payload?.title, '4 follow-ups ready');
    assert.equal(payload?.body, '7 waiting');
    assert.equal(payload?.url, '/');
    assert.equal(payload?.tag, 'digest');
  });

  it('names the inbox share only when there is one', () => {
    const withInbox = composeDigest(
      facts({ followup: summary({ drafted: 4 }), pending: 7, inboundWaiting: 2 }),
    );
    assert.equal(withInbox?.body, '7 waiting · 2 from the inbox');

    const withoutInbox = composeDigest(facts({ followup: summary({ drafted: 4 }), pending: 7 }));
    assert.ok(!withoutInbox?.body.includes('inbox'));
  });

  it('says sending is paused, because a paused operator needs telling', () => {
    // The kill switch does not suppress the digest. "Nothing left this morning
    // because you paused it" is the thing a fortnight of silence would hide.
    const payload = composeDigest(
      facts({ followup: summary({ drafted: 3 }), pending: 3, killSwitchOn: true }),
    );
    assert.equal(payload?.body, '3 waiting · sending is paused');
  });

  it('puts both suffixes in a fixed order', () => {
    const payload = composeDigest(
      facts({ followup: summary({ drafted: 2 }), pending: 9, inboundWaiting: 3, killSwitchOn: true }),
    );
    assert.equal(payload?.body, '9 waiting · 3 from the inbox · sending is paused');
  });
});

describe('composeDigest — a backlog with no new drafts', () => {
  it('reports what is already waiting', () => {
    // Nothing was drafted, but seven cards from earlier in the week are still
    // pending. Silence here is a system that looks asleep.
    const payload = composeDigest(facts({ pending: 7 }));
    assert.equal(payload?.title, '7 things need you');
    assert.equal(payload?.body, '7 waiting');
  });

  it('says "1 thing needs you" for a single card', () => {
    const payload = composeDigest(facts({ pending: 1 }));
    assert.equal(payload?.title, '1 thing needs you');
  });

  it('prefers the draft count when there are both', () => {
    // "4 follow-ups ready" is the actionable sentence; "11 things need you" is
    // an inventory. The body carries the total either way.
    const payload = composeDigest(facts({ followup: summary({ drafted: 4 }), pending: 11 }));
    assert.equal(payload?.title, '4 follow-ups ready');
    assert.equal(payload?.body, '11 waiting');
  });
});

describe('composeDigest — the run that failed', () => {
  it('says so, before anything else', () => {
    // The single most important thing this system can tell its operator, and
    // the one it would otherwise say nothing about.
    const payload = composeDigest(facts({ followup: null, pending: 3 }));
    assert.equal(payload?.title, 'The morning run failed');
    assert.equal(payload?.url, '/');
  });

  it('notifies even when nothing at all is pending', () => {
    const payload = composeDigest(facts({ followup: null }));
    assert.ok(payload !== null, 'a silent failure is the failure this repo argues against');
    assert.equal(payload.title, 'The morning run failed');
  });
});

describe('composeDigest — counts that should not be there', () => {
  it('never renders NaN or a negative at the operator', () => {
    const payload = composeDigest(
      facts({ followup: summary({ drafted: Number.NaN }), pending: -3 }),
    );
    assert.equal(payload, null, 'a broken count is not a reason to interrupt');
  });

  it('floors a fractional count rather than printing it', () => {
    const payload = composeDigest(facts({ followup: summary({ drafted: 2.7 }), pending: 4.2 }));
    assert.equal(payload?.title, '2 follow-ups ready');
    assert.equal(payload?.body, '4 waiting');
  });

  it('carries no customer data in any branch', () => {
    // Nothing in this module interpolates anything but an integer, and this is
    // the assertion that keeps it that way: a lock screen is a public surface.
    const payloads: (PushPayload | null)[] = [
      composeDigest(facts({ followup: null })),
      composeDigest(facts({ followup: summary({ drafted: 4 }), pending: 7, inboundWaiting: 2 })),
      composeDigest(facts({ pending: 7 })),
    ];
    for (const payload of payloads) {
      assert.ok(payload !== null);
      assert.match(payload.title, /^[0-9A-Za-z\-· ]+$/);
      assert.match(payload.body, /^[0-9A-Za-z\-· ]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * The `send-queue.test.ts` fake again, cut to the two calls this file makes: a
 * head count over `tasks` and one `settings` read.
 */
type Row = Record<string, unknown>;
type TableName = 'tasks' | 'settings';

type FakeState = { tasks: Row[]; settings: Row[]; countFault: boolean };

class FakeQuery
  implements PromiseLike<{ data: Row | Row[] | null; error: { message: string } | null; count: number | null }>
{
  readonly #state: FakeState;
  readonly #table: TableName;
  readonly #filters: ((row: Row) => boolean)[] = [];
  #head = false;
  #single = false;

  constructor(state: FakeState, table: TableName) {
    this.#state = state;
    this.#table = table;
  }

  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    this.#head = options?.head === true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.#filters.push((row) => row[column] === value);
    return this;
  }

  maybeSingle(): this {
    this.#single = true;
    return this;
  }

  #run(): { data: Row | Row[] | null; error: { message: string } | null; count: number | null } {
    if (this.#state.countFault && this.#table === 'tasks') {
      return { data: null, error: { message: 'connection terminated' }, count: null };
    }
    const rows = this.#state[this.#table].filter((row) => this.#filters.every((match) => match(row)));
    if (this.#head) return { data: null, error: null, count: rows.length };
    if (this.#single) return { data: rows[0] ?? null, error: null, count: null };
    return { data: rows, error: null, count: rows.length };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: Row | Row[] | null;
          error: { message: string } | null;
          count: number | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.#run()).then(onfulfilled, onrejected);
  }
}

function fakeDb(state: FakeState): Db {
  return {
    from(table: TableName) {
      return {
        select: (columns?: string, options?: { count?: string; head?: boolean }) =>
          new FakeQuery(state, table).select(columns, options),
      };
    },
  } as unknown as Db;
}

function taskRow(id: string, over: Row = {}): Row {
  return { id, agent: 'followup', type: 'draft_email', status: 'pending', ...over };
}

function state(over: Partial<FakeState> = {}): FakeState {
  return {
    tasks: [],
    settings: [{ key: 'kill_switch', value: false }],
    countFault: false,
    ...over,
  };
}

/** A sender that records instead of pushing, which is the seam `PushSender` is
 *  for. Nothing in these tests may reach `push.ts`'s transport. */
function recorder(outcome: Partial<PushOutcome> = {}): {
  push: PushSender;
  pushes: PushPayload[];
} {
  const pushes: PushPayload[] = [];
  const push: PushSender = async (payload) => {
    pushes.push(payload);
    return { subscriptions: 1, sent: 1, removed: 0, failed: 0, dryRun: false, ...outcome };
  };
  return { push, pushes };
}

describe('runDigest', () => {
  const originalLog = console.log;
  let lines: string[] = [];

  beforeEach(() => {
    lines = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it('counts what is pending now, not what the run happened to draft', async () => {
    // A task the inbox agent filed at 15:00 yesterday is still pending this
    // morning. FollowupSummary cannot know about it, which is exactly why the
    // digest reads the table instead of trusting the summary.
    const db = state({
      tasks: [
        taskRow('a'),
        taskRow('b'),
        taskRow('yesterday', { agent: 'inbox' }),
        taskRow('done', { status: 'sent' }),
      ],
    });
    const { push, pushes } = recorder();

    const result = await runDigest({
      db: fakeDb(db),
      followup: summary({ considered: 5, drafted: 2 }),
      push,
    });

    assert.equal(result.pending, 3, 'the resolved task is not waiting for anybody');
    assert.equal(result.drafted, 2);
    assert.equal(result.pushed, true);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]?.title, '2 follow-ups ready');
    assert.equal(pushes[0]?.body, '3 waiting · 1 from the inbox');
  });

  it('sends nothing on a morning with nothing in it', async () => {
    const db = state();
    const { push, pushes } = recorder();

    const result = await runDigest({ db: fakeDb(db), followup: summary({ considered: 4, skipped: 4 }), push });

    assert.equal(result.pushed, false);
    assert.equal(result.push, null);
    assert.equal(pushes.length, 0, 'this is the ping that gets the app muted');
  });

  it('notifies when the run threw, which is when it matters most', async () => {
    const db = state({ tasks: [taskRow('a')] });
    const { push, pushes } = recorder();

    const result = await runDigest({ db: fakeDb(db), followup: null, push });

    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]?.title, 'The morning run failed');
    assert.equal(result.drafted, 0);
  });

  it('says sending is paused without refusing to speak', async () => {
    const db = state({
      tasks: [taskRow('a'), taskRow('b')],
      settings: [{ key: 'kill_switch', value: true }],
    });
    const { push, pushes } = recorder();

    await runDigest({ db: fakeDb(db), followup: summary({ drafted: 2 }), push });

    assert.equal(pushes[0]?.body, '2 waiting · sending is paused');
  });

  it('does not claim the system is paused when the switch cannot be read', async () => {
    // A hand-edited settings row throws out of the reader. Failing closed here
    // would put a false "sending is paused" on the operator's phone.
    const db = state({ tasks: [taskRow('a')], settings: [{ key: 'kill_switch', value: 'yes' }] });
    const { push, pushes } = recorder();

    await runDigest({ db: fakeDb(db), followup: summary({ drafted: 1 }), push });

    assert.equal(pushes.length, 1);
    assert.ok(!String(pushes[0]?.body).includes('paused'));
  });

  it('reports pushed: false when the notification went nowhere', async () => {
    // Every subscription was dead. The drafts still exist; the phone did not
    // buzz, and `/health` should be able to tell the difference.
    const db = state({ tasks: [taskRow('a')] });
    const { push } = recorder({ subscriptions: 1, sent: 0, removed: 1 });

    const result = await runDigest({ db: fakeDb(db), followup: summary({ drafted: 1 }), push });

    assert.equal(result.pushed, false);
    assert.equal(result.push?.removed, 1);
  });

  it('never throws when the database is the broken thing', async () => {
    // `runFollowupJob` awaits this after it has already written its drafts and
    // its `/health` entry. A digest that throws would mark a successful morning
    // as a failed one.
    const db = state({ tasks: [taskRow('a')], countFault: true });
    const { push, pushes } = recorder();

    const result = await runDigest({ db: fakeDb(db), followup: summary({ drafted: 1 }), push });

    assert.deepEqual(result, { pushed: false, pending: 0, drafted: 1, push: null });
    assert.equal(pushes.length, 0);
    assert.match(lines.join('\n'), /digest could not be sent/);
  });

  it('never throws when the sender itself throws', async () => {
    const db = state({ tasks: [taskRow('a')] });
    const angry: PushSender = async () => {
      throw new Error('the push service is down');
    };

    const result = await runDigest({ db: fakeDb(db), followup: summary({ drafted: 1 }), push: angry });
    assert.equal(result.pushed, false);
  });

  it('logs counts and never a task, a contact or a body', async () => {
    const db = state({
      tasks: [taskRow('a', { title: 'Follow up with Μαρία', draft_body: 'Καλημέρα,' })],
    });
    const { push } = recorder();

    await runDigest({ db: fakeDb(db), followup: summary({ drafted: 1 }), push });

    const log = lines.join('\n');
    assert.ok(log.length > 0);
    assert.ok(!log.includes('Μαρία'), 'no contact name');
    assert.ok(!log.includes('Καλημέρα'), 'no draft body');
    assert.match(log, /digest sent/);
  });
});
