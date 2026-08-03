/**
 * Push tests — the sender, with no push service, no database and no VAPID key
 * that is worth anything.
 *
 * Two halves. The first proves the pure decisions: the status table, the jsonb
 * narrowing, the endpoint hash, and the immediate/deferred rule step 8 calls.
 * The second drives `sendPush` end to end against an in-memory stand-in for
 * PostgREST and a recording transport, which is the only way to reach the
 * behaviour this module exists for.
 *
 * The four faults these are aimed at, all of which are silent in a typecheck:
 *
 *   - a browser that was reinstalled months ago failing one request per digest
 *     forever, until `failed` means nothing and a real outage is invisible
 *   - a capability URL — anyone holding it can push to the operator's phone —
 *     written into a log line or onto an alert card
 *   - a wrong VAPID key filing one alert card per subscription per push
 *   - a notification failure taking the morning run down with it
 *
 * `DRY_RUN` is set explicitly in every group rather than inherited, because the
 * default is true and a test that forgot would pass while sending nothing.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Db } from '@agency/core';

import {
  MAX_SUBSCRIPTIONS,
  classifyPushFailure,
  endpointHash,
  immediatePush,
  pushErrorStatus,
  readSubscriptionKeys,
  resetPushAlerts,
  sendPush,
  setPushTransport,
  type PushPayload,
  type PushTransport,
} from './push';

const DIGEST: PushPayload = {
  title: '4 follow-ups ready',
  body: '7 waiting',
  url: '/',
  tag: 'digest',
};

// ---------------------------------------------------------------------------
// The status table
// ---------------------------------------------------------------------------

describe('classifyPushFailure', () => {
  it('drops a subscription the push service says is gone', () => {
    // The whole reason this module deletes rows. Without it every digest for the
    // rest of the project pays a failed request for a browser that no longer
    // exists, and the failure count stops being a signal.
    assert.equal(classifyPushFailure(404), 'drop');
    assert.equal(classifyPushFailure(410), 'drop');
  });

  it('retries a service that is busy or broken', () => {
    assert.equal(classifyPushFailure(429), 'retry');
    assert.equal(classifyPushFailure(500), 'retry');
    assert.equal(classifyPushFailure(502), 'retry');
    assert.equal(classifyPushFailure(503), 'retry');
  });

  it('alerts on the three codes that mean our keys are wrong', () => {
    // Not the subscription's fault: every row will fail identically, so deleting
    // them would wipe the operator's subscriptions over a mistyped key.
    assert.equal(classifyPushFailure(400), 'alert');
    assert.equal(classifyPushFailure(401), 'alert');
    assert.equal(classifyPushFailure(403), 'alert');
  });

  it('retries anything it has not been taught, including no status at all', () => {
    // A deleted row can only be recovered by the operator noticing notifications
    // stopped and re-subscribing. A retried row costs one request.
    assert.equal(classifyPushFailure(undefined), 'retry');
    assert.equal(classifyPushFailure(418), 'retry');
    assert.equal(classifyPushFailure(0), 'retry');
  });
});

describe('pushErrorStatus', () => {
  it('reads the status off a rejection the way web-push throws it', () => {
    const error = Object.assign(new Error('Received unexpected response code'), {
      statusCode: 410,
    });
    assert.equal(pushErrorStatus(error), 410);
  });

  it('is undefined for an ordinary error, a socket failure, or a non-object', () => {
    assert.equal(pushErrorStatus(new Error('ECONNRESET')), undefined);
    assert.equal(pushErrorStatus('boom'), undefined);
    assert.equal(pushErrorStatus(null), undefined);
    assert.equal(pushErrorStatus({ statusCode: '410' }), undefined);
  });
});

// ---------------------------------------------------------------------------
// The jsonb column
// ---------------------------------------------------------------------------

describe('readSubscriptionKeys', () => {
  it('accepts the shape the subscribe path writes', () => {
    assert.deepEqual(readSubscriptionKeys({ p256dh: 'BPk…', auth: 'k1…', expirationTime: null }), {
      p256dh: 'BPk…',
      auth: 'k1…',
    });
  });

  it('rejects a half-written row rather than sending an unencryptable payload', () => {
    assert.equal(readSubscriptionKeys({ p256dh: 'BPk…' }), null);
    assert.equal(readSubscriptionKeys({ auth: 'k1…' }), null);
    assert.equal(readSubscriptionKeys({ p256dh: 'BPk…', auth: '' }), null);
  });

  it('rejects anything that is not an object, because jsonb allows all of them', () => {
    assert.equal(readSubscriptionKeys(null), null);
    assert.equal(readSubscriptionKeys('BPk…'), null);
    assert.equal(readSubscriptionKeys([{ p256dh: 'a', auth: 'b' }]), null);
    assert.equal(readSubscriptionKeys(undefined), null);
  });
});

describe('endpointHash', () => {
  it('is stable and short', () => {
    const hash = endpointHash('https://fcm.googleapis.com/fcm/send/abc123');
    assert.equal(hash.length, 12);
    assert.equal(hash, endpointHash('https://fcm.googleapis.com/fcm/send/abc123'));
  });

  it('does not contain the endpoint it identifies', () => {
    // The endpoint is a capability URL: anyone holding it can push to the
    // operator's browser. This is the only form of it allowed in a log line.
    const endpoint = 'https://fcm.googleapis.com/fcm/send/secret-token-value';
    const hash = endpointHash(endpoint);
    assert.ok(!hash.includes('secret-token-value'));
    assert.ok(!hash.includes('fcm'));
  });

  it('tells two subscriptions apart', () => {
    assert.notEqual(endpointHash('https://a.example/1'), endpointHash('https://a.example/2'));
  });
});

// ---------------------------------------------------------------------------
// The immediate/deferred rule
// ---------------------------------------------------------------------------

describe('immediatePush', () => {
  it('interrupts for the two classes SPEC §5 names and nothing else', () => {
    assert.ok(immediatePush('new_lead') !== null);
    assert.ok(immediatePush('interested') !== null);
    for (const quiet of [
      'question',
      'objection',
      'scheduling',
      'invoice',
      'not_interested',
      'spam',
      'not_business',
    ]) {
      assert.equal(immediatePush(quiet), null, quiet);
    }
  });

  it('stays silent for not_interested in particular', () => {
    // SPEC §5: "the silent handling of not_interested matters as much as the
    // loud handling of hot leads." A rejection that buzzes the phone is the
    // ping that gets the whole app muted.
    assert.equal(immediatePush('not_interested'), null);
  });

  it('is null for a class it has never heard of, rather than pushing anyway', () => {
    assert.equal(immediatePush(''), null);
    assert.equal(immediatePush('NEW_LEAD'), null);
    assert.equal(immediatePush('something_added_later'), null);
  });

  it('carries no customer data and lands where its words say it lands', () => {
    const payload = immediatePush('new_lead');
    assert.ok(payload !== null);
    assert.equal(payload.tag, 'inbox');
    assert.equal(payload.url, '/inbox');
    assert.match(payload.body, /inbox/);
    // Counts and classes only: nothing here can be a name, a business or a
    // subject line, because nothing here is interpolated at all.
    assert.equal(payload.title, 'New lead');
  });
});

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

/**
 * The same in-memory PostgREST stand-in `send-queue.test.ts` uses, cut down to
 * the four calls this module makes: select subscriptions, delete one by
 * endpoint, insert an alert task, and nothing else. Deliberately literal — a
 * fake cleverer than PostgREST proves things about itself.
 */
type Row = Record<string, unknown>;
type TableName = 'push_subscriptions' | 'tasks';
type ReadFault = { table: TableName; message: string } | null;

type FakeState = {
  push_subscriptions: Row[];
  tasks: Row[];
  readFault: ReadFault;
  deleteFault: boolean;
};

class FakeQuery
  implements PromiseLike<{ data: Row[] | null; error: { message: string } | null; count: number | null }>
{
  readonly #state: FakeState;
  readonly #table: TableName;
  readonly #op: 'select' | 'insert' | 'delete';
  readonly #payload: Row | null;
  readonly #filters: ((row: Row) => boolean)[] = [];
  #limit: number | null = null;

  constructor(state: FakeState, table: TableName, op: 'select' | 'insert' | 'delete', payload: Row | null) {
    this.#state = state;
    this.#table = table;
    this.#op = op;
    this.#payload = payload;
  }

  select(_columns?: string): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.#filters.push((row) => row[column] === value);
    return this;
  }

  limit(count: number): this {
    this.#limit = count;
    return this;
  }

  #run(): { data: Row[] | null; error: { message: string } | null; count: number | null } {
    if (this.#op === 'insert') {
      this.#state[this.#table].push({ ...(this.#payload ?? {}) });
      return { data: null, error: null, count: null };
    }

    if (this.#op === 'delete') {
      if (this.#state.deleteFault) return { data: null, error: { message: 'delete failed' }, count: null };
      const keep = this.#state[this.#table].filter((row) => !this.#filters.every((match) => match(row)));
      this.#state[this.#table] = keep;
      return { data: null, error: null, count: null };
    }

    const fault = this.#state.readFault;
    if (fault !== null && fault.table === this.#table) {
      return { data: null, error: { message: fault.message }, count: null };
    }

    let rows = this.#state[this.#table].filter((row) => this.#filters.every((match) => match(row)));
    if (this.#limit !== null) rows = rows.slice(0, this.#limit);
    return { data: rows, error: null, count: rows.length };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: Row[] | null;
          error: { message: string } | null;
          count: number | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.#run()).then(onfulfilled, onrejected);
  }
}

/** Cast through `unknown`: `Db` describes a wire protocol this fake is
 *  deliberately not implementing, and the cast is the honest way to say "this
 *  satisfies the three calls the module makes". */
function fakeDb(state: FakeState): Db {
  return {
    from(table: TableName) {
      return {
        select: (columns?: string) => new FakeQuery(state, table, 'select', null).select(columns),
        insert: (payload: Row) => new FakeQuery(state, table, 'insert', payload),
        delete: () => new FakeQuery(state, table, 'delete', null),
      };
    },
  } as unknown as Db;
}

function subscriptionRow(id: string, over: Row = {}): Row {
  return {
    id,
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}-capability-token`,
    keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
    ...over,
  };
}

function state(over: Partial<FakeState> = {}): FakeState {
  return { push_subscriptions: [], tasks: [], readFault: null, deleteFault: false, ...over };
}

function alertCards(db: FakeState): Row[] {
  return db.tasks.filter((row) => row['type'] === 'alert');
}

/** A transport that answers with a fixed status per endpoint substring. */
function transportThatFails(statuses: Record<string, number>): {
  transport: PushTransport;
  sent: { endpoint: string; payload: string }[];
} {
  const sent: { endpoint: string; payload: string }[] = [];
  const transport: PushTransport = async (subscription, payload) => {
    for (const [needle, status] of Object.entries(statuses)) {
      if (subscription.endpoint.includes(needle)) {
        throw Object.assign(new Error('push service said no'), { statusCode: status });
      }
    }
    sent.push({ endpoint: subscription.endpoint, payload });
  };
  return { transport, sent };
}

describe('sendPush', () => {
  const ORIGINAL_ENV = {
    DRY_RUN: process.env['DRY_RUN'],
    VAPID_PUBLIC_KEY: process.env['VAPID_PUBLIC_KEY'],
    VAPID_PRIVATE_KEY: process.env['VAPID_PRIVATE_KEY'],
    ALLOWED_EMAIL: process.env['ALLOWED_EMAIL'],
  };

  const originalLog = console.log;
  let lines: string[] = [];

  beforeEach(() => {
    lines = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    resetPushAlerts();

    // Nothing may reach a push service by accident: every test that expects a
    // send installs its own recorder over the top of this one.
    setPushTransport(async (subscription) => {
      throw new Error(`the test opened a socket to ${subscription.endpoint}`);
    });

    process.env['DRY_RUN'] = 'false';
    process.env['VAPID_PUBLIC_KEY'] = 'test-public-key';
    process.env['VAPID_PRIVATE_KEY'] = 'test-private-key';
    process.env['ALLOWED_EMAIL'] = 'owner@example.gr';
  });

  afterEach(() => {
    console.log = originalLog;
    setPushTransport(null);
    resetPushAlerts();
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('sends one notification to every subscribed browser', async () => {
    const { transport, sent } = transportThatFails({});
    setPushTransport(transport);

    const db = state({ push_subscriptions: [subscriptionRow('laptop'), subscriptionRow('phone')] });
    const outcome = await sendPush(DIGEST, { db: fakeDb(db) });

    assert.deepEqual(outcome, {
      subscriptions: 2,
      sent: 2,
      removed: 0,
      failed: 0,
      dryRun: false,
    });
    assert.equal(sent.length, 2);
    assert.deepEqual(JSON.parse(sent[0]?.payload ?? '{}'), DIGEST);
  });

  it('deletes a subscription the push service says is gone, and keeps the live one', async () => {
    // The 410 that would otherwise fail one request per digest forever. A
    // reinstalled browser never comes back to the same endpoint.
    const { transport, sent } = transportThatFails({ dead: 410 });
    setPushTransport(transport);

    const db = state({ push_subscriptions: [subscriptionRow('dead'), subscriptionRow('live')] });
    const outcome = await sendPush(DIGEST, { db: fakeDb(db) });

    assert.equal(outcome.removed, 1);
    assert.equal(outcome.sent, 1, 'the other browser still gets it');
    assert.equal(outcome.failed, 0, 'a dead row is not a failure, or failure stops meaning anything');
    assert.equal(db.push_subscriptions.length, 1);
    assert.equal(db.push_subscriptions[0]?.['id'], 'live');
    assert.equal(sent.length, 1);
  });

  it('deletes on a 404 as well as a 410', async () => {
    const { transport } = transportThatFails({ gone: 404 });
    setPushTransport(transport);

    const db = state({ push_subscriptions: [subscriptionRow('gone')] });
    const outcome = await sendPush(DIGEST, { db: fakeDb(db) });

    assert.equal(outcome.removed, 1);
    assert.equal(db.push_subscriptions.length, 0);
  });

  it('leaves the row alone when the push service is merely busy', async () => {
    // 429 and 5xx are about the service, not the subscription. Deleting here
    // would cost the operator their notifications over a rate limit.
    const { transport } = transportThatFails({ busy: 429, broken: 503 });
    setPushTransport(transport);

    const db = state({ push_subscriptions: [subscriptionRow('busy'), subscriptionRow('broken')] });
    const outcome = await sendPush(DIGEST, { db: fakeDb(db) });

    assert.equal(outcome.failed, 2);
    assert.equal(outcome.removed, 0);
    assert.equal(db.push_subscriptions.length, 2);
  });

  it('counts a dead row as failed when the delete itself fails', async () => {
    // Honest accounting: the endpoint is gone and the row is still there, so the
    // next push pays for it again. Reporting `removed` would claim a cleanup
    // that did not happen.
    const { transport } = transportThatFails({ dead: 410 });
    setPushTransport(transport);

    const db = state({ push_subscriptions: [subscriptionRow('dead')], deleteFault: true });
    const outcome = await sendPush(DIGEST, { db: fakeDb(db) });

    assert.equal(outcome.removed, 0);
    assert.equal(outcome.failed, 1);
    assert.equal(db.push_subscriptions.length, 1);
  });

  it('files one card for a rejected VAPID key however many pushes hit it', async () => {
    // 403 is the same answer for every subscription and every push. Ungated,
    // an inbound burst files a card per message per browser and buries the
    // cards the operator actually needs.
    const { transport } = transportThatFails({ '': 403 });
    setPushTransport(transport);

    const db = state({ push_subscriptions: [subscriptionRow('laptop'), subscriptionRow('phone')] });
    for (let push = 0; push < 3; push += 1) {
      await sendPush(DIGEST, { db: fakeDb(db) });
    }

    assert.equal(alertCards(db).length, 1, 'six rejections, one card');
    assert.equal(db.push_subscriptions.length, 2, 'and nothing was deleted over a key mistake');
    assert.match(String(alertCards(db)[0]?.['reasoning']), /VAPID_PRIVATE_KEY/);
  });

  it('sends nothing under DRY_RUN and says what it would have sent', async () => {
    // The house rule: a push leaves the machine. The transport installed in
    // beforeEach throws if it is called, so this is proved rather than assumed.
    process.env['DRY_RUN'] = 'true';

    const db = state({ push_subscriptions: [subscriptionRow('laptop')] });
    const outcome = await sendPush(DIGEST, { db: fakeDb(db) });

    assert.deepEqual(outcome, {
      subscriptions: 1,
      sent: 0,
      removed: 0,
      failed: 0,
      dryRun: true,
    });
    const log = lines.join('\n');
    assert.match(log, /dry_run/);
    assert.match(log, /4 follow-ups ready/, 'the payload holds no customer data, so it is logged');
  });

  it('never writes an endpoint to a log line or an alert card', async () => {
    // The endpoint is a capability URL. This is the assertion that keeps it out
    // of the two places this module writes prose.
    const { transport } = transportThatFails({ dead: 410, bad: 403 });
    setPushTransport(transport);

    const db = state({ push_subscriptions: [subscriptionRow('dead'), subscriptionRow('bad')] });
    await sendPush(DIGEST, { db: fakeDb(db) });

    const written = [lines.join('\n'), JSON.stringify(db.tasks)].join('\n');
    assert.ok(written.length > 0);
    assert.ok(!written.includes('capability-token'), 'no endpoint');
    assert.ok(!written.includes('fcm.googleapis.com'), 'not even the host');
    assert.ok(!written.includes('p256dh-dead'), 'no subscription key material');
    // What it says instead: the hash, which distinguishes two subscriptions and
    // gives away nothing.
    assert.match(lines.join('\n'), /endpoint_hash/);
    assert.match(
      lines.join('\n'),
      new RegExp(endpointHash('https://fcm.googleapis.com/fcm/send/dead-capability-token')),
    );
  });

  it('leaves a row with unusable keys in place and counts it, rather than deleting it', async () => {
    const { transport, sent } = transportThatFails({});
    setPushTransport(transport);

    const db = state({
      push_subscriptions: [subscriptionRow('broken', { keys: { p256dh: 'only-half' } }), subscriptionRow('good')],
    });
    const outcome = await sendPush(DIGEST, { db: fakeDb(db) });

    assert.equal(outcome.failed, 1);
    assert.equal(outcome.sent, 1);
    assert.equal(db.push_subscriptions.length, 2, 'our own parse bug must not destroy a subscription');
    assert.equal(sent.length, 1);
  });

  it('does nothing and files nothing when nobody has subscribed', async () => {
    const db = state();
    const outcome = await sendPush(DIGEST, { db: fakeDb(db) });

    assert.deepEqual(outcome, { subscriptions: 0, sent: 0, removed: 0, failed: 0, dryRun: false });
    assert.equal(alertCards(db).length, 0, 'a fresh install is not a fault');
  });

  it('files one card when browsers are subscribed but the keys are not set', async () => {
    // A subscription row can only exist if the web app was served a public key,
    // so rows present and keys absent is a genuinely half-configured deploy.
    delete process.env['VAPID_PRIVATE_KEY'];

    const db = state({ push_subscriptions: [subscriptionRow('laptop')] });
    const first = await sendPush(DIGEST, { db: fakeDb(db) });
    await sendPush(DIGEST, { db: fakeDb(db) });

    assert.equal(first.sent, 0);
    assert.equal(alertCards(db).length, 1, 'two pushes, one card');
    assert.match(String(alertCards(db)[0]?.['reasoning']), /VAPID_PRIVATE_KEY/);
    assert.ok(!String(alertCards(db)[0]?.['reasoning']).includes('test-public-key'), 'names, never values');
  });

  it('never throws, whatever the database does', async () => {
    // The caller is a run whose real work is already finished and already on
    // Today. A notification must not be able to fail it.
    const db = state({
      push_subscriptions: [subscriptionRow('laptop')],
      readFault: { table: 'push_subscriptions', message: 'connection terminated' },
    });

    const outcome = await sendPush(DIGEST, { db: fakeDb(db) });
    assert.deepEqual(outcome, { subscriptions: 0, sent: 0, removed: 0, failed: 0, dryRun: false });
    assert.match(lines.join('\n'), /push failed/);
  });

  it('reads no more subscriptions than the ceiling', async () => {
    const { transport, sent } = transportThatFails({});
    setPushTransport(transport);

    const rows: Row[] = [];
    for (let index = 0; index < MAX_SUBSCRIPTIONS + 5; index += 1) {
      rows.push(subscriptionRow(`browser-${index}`));
    }

    const db = state({ push_subscriptions: rows });
    const outcome = await sendPush(DIGEST, { db: fakeDb(db) });

    assert.equal(outcome.subscriptions, MAX_SUBSCRIPTIONS);
    assert.equal(sent.length, MAX_SUBSCRIPTIONS);
  });
});
