/**
 * Inbox agent tests — the whole run, with no network, no database and no key.
 *
 * The fake is deliberately literal, and it is the same one `send-queue.test.ts`
 * introduced rather than a second invention: it applies the filters it is given
 * to plain arrays and returns `{ data, error }`. Two things are added, because
 * step 8 depends on both and neither exists in the send queue's version:
 *
 *   - `.in()` and `.ilike()`, which are the pre-filter and the sender match.
 *   - **The unique partial index on `meta->>'gmail_message_id'`.** The fake
 *     enforces it, because the claim is the entire duplicate-suppression design
 *     and a fake that let a second row in would prove the opposite of what these
 *     cases claim.
 *
 * Gmail is faked at `setGmailReadTransport`, so the real parser, the real
 * history flattening and the real 404 handling all run. The model is faked at
 * the `llm` seam, and every case that must not spend money installs a model that
 * fails the test if it is called at all — "no charge" is proved rather than
 * assumed, which is the same discipline `send-queue.test.ts` applies to the
 * Gmail transport.
 *
 * The cases are named after what a regression would do to the operator.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Db } from '@agency/core';
import type { CallOpts } from '@agency/core/llm';
import { LlmError } from '@agency/core/llm';
import {
  setGmailAccessTokenProvider,
  setGmailReadTransport,
} from '@agency/core/gmail-read';

import {
  MAX_MESSAGES_PER_RUN,
  PAUSED_CURSOR_WARNING_MS,
  REPLY_NEXT_TOUCH_DAYS,
  cursorIsAging,
  resetInboxAlerts,
  runInbox,
  runInboxTick,
} from './inbox';
import type { InboxSummary } from './inbox';

// ---------------------------------------------------------------------------
// The PostgREST stand-in
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type TableName = 'tasks' | 'contacts' | 'interactions' | 'settings' | 'brain';

type FakeState = {
  tasks: Row[];
  contacts: Row[];
  interactions: Row[];
  settings: Row[];
  brain: Row[];
  /** Next id handed out, so assertions can name rows. */
  sequence: number;
  /**
   * Return a message to fail one query with, or null to let it through.
   *
   * A seam rather than a flag because the cases that need it are about *which*
   * write failed: an inbound reply that fails at the `contacts` update is an
   * opt-out that was not applied, and one that fails at the `tasks` insert is a
   * reply nobody wrote. They have different consequences and want different
   * assertions.
   */
  fail?: (table: TableName, op: 'select' | 'insert' | 'update' | 'upsert') => string | null;
  /**
   * Called after a select is answered, so a test can make something true
   * *between* the pre-filter and the claim — which is the only way to exercise
   * the race the unique index exists for.
   */
  afterSelect?: (table: TableName) => void;
};

/**
 * `a->>b` reads `a.b`; anything else is a plain column.
 *
 * `->>` is Postgres's *text* accessor and the fake has to be literal about that:
 * the claim's compare-and-swap filters on `meta->>attempts`, and a fake that
 * compared the number 1 to the string '1' would report a mismatch the database
 * would not — which would make the retry path look broken when it is not.
 */
function valueAt(row: Row, column: string): unknown {
  const arrow = column.indexOf('->>');
  if (arrow === -1) return row[column];
  const outer = row[column.slice(0, arrow)];
  const key = column.slice(arrow + 3);
  if (typeof outer !== 'object' || outer === null) return undefined;
  const value = (outer as Row)[key];
  return value === undefined || value === null ? value : String(value);
}

type Result = { data: Row[] | Row | null; error: { message: string; code?: string } | null };

class FakeQuery implements PromiseLike<Result> {
  readonly #state: FakeState;
  readonly #table: TableName;
  readonly #op: 'select' | 'insert' | 'update' | 'upsert';
  readonly #payload: Row | null;
  readonly #filters: ((row: Row) => boolean)[] = [];
  #returning = false;
  #single = false;
  #limit: number | null = null;
  #orderBy: { column: string; ascending: boolean } | null = null;

  constructor(state: FakeState, table: TableName, op: FakeQuery['_op'], payload: Row | null) {
    this.#state = state;
    this.#table = table;
    this.#op = op;
    this.#payload = payload;
  }

  declare _op: 'select' | 'insert' | 'update' | 'upsert';

  select(): this {
    if (this.#op !== 'select') this.#returning = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.#filters.push((row) => valueAt(row, column) === value);
    return this;
  }

  ilike(column: string, value: string): this {
    const wanted = value.toLowerCase();
    this.#filters.push((row) => String(valueAt(row, column) ?? '').toLowerCase() === wanted);
    return this;
  }

  /** Only `not(column, 'is', null)` is used — the style-example query's guard. */
  not(column: string, _operator: 'is', value: unknown): this {
    this.#filters.push((row) => (valueAt(row, column) ?? null) !== value);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    const set = new Set(values);
    this.#filters.push((row) => set.has(valueAt(row, column)));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.#orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(count: number): this {
    this.#limit = count;
    return this;
  }

  maybeSingle(): this {
    this.#single = true;
    return this;
  }

  #matching(): Row[] {
    return this.#state[this.#table].filter((row) => this.#filters.every((keep) => keep(row)));
  }

  /**
   * The unique partial index from contract §8.10, enforced here because the
   * claim is what makes a duplicate task and a duplicate charge impossible. A
   * fake without it would let every idempotency case below pass for the wrong
   * reason.
   */
  #uniqueViolation(payload: Row): Result | null {
    if (this.#table !== 'interactions') return null;
    const meta = payload['meta'];
    if (typeof meta !== 'object' || meta === null) return null;
    const id = (meta as Row)['gmail_message_id'];
    if (typeof id !== 'string' || id === '') return null;

    const clash = this.#state.interactions.some((row) => valueAt(row, 'meta->>gmail_message_id') === id);
    if (!clash) return null;

    return {
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "interactions_gmail_message_id_key"',
      },
    };
  }

  #run(): Result {
    const failure = this.#state.fail?.(this.#table, this.#op) ?? null;
    if (failure !== null) return { data: null, error: { message: failure } };

    if (this.#op === 'insert') {
      const violation = this.#uniqueViolation(this.#payload ?? {});
      if (violation !== null) return violation;

      this.#state.sequence += 1;
      const row = { id: `${this.#table}-${this.#state.sequence}`, ...(this.#payload ?? {}) };
      this.#state[this.#table].push(row);
      return { data: this.#returning ? row : null, error: null };
    }

    if (this.#op === 'upsert') {
      const payload = this.#payload ?? {};
      const key = payload['key'];
      const existing = this.#state[this.#table].find((row) => row['key'] === key);
      if (existing !== undefined) Object.assign(existing, payload);
      else this.#state[this.#table].push({ ...payload });
      return { data: null, error: null };
    }

    if (this.#op === 'update') {
      // Matched before the write, which is what makes a compare-and-swap on
      // `meta->>attempts` mean anything, and returned when the caller asked for
      // it — PostgREST answers an update with the rows it actually changed, and
      // "no rows changed" is the signal the claim's retake reads.
      const rows = this.#matching();
      for (const row of rows) Object.assign(row, this.#payload ?? {});
      if (!this.#returning) return { data: null, error: null };
      if (this.#single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    let rows = this.#matching();
    if (this.#orderBy !== null) {
      const { column, ascending } = this.#orderBy;
      rows = [...rows].sort((a, b) => {
        const left = String(valueAt(a, column) ?? '');
        const right = String(valueAt(b, column) ?? '');
        return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    if (this.#limit !== null) rows = rows.slice(0, this.#limit);

    const result: Result = this.#single
      ? { data: rows[0] ?? null, error: null }
      : { data: rows, error: null };

    this.#state.afterSelect?.(this.#table);
    return result;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.#run()).then(onfulfilled, onrejected);
  }
}

function fakeDb(state: FakeState): Db {
  return {
    from(table: TableName) {
      return {
        select: () => new FakeQuery(state, table, 'select', null),
        insert: (payload: Row) => new FakeQuery(state, table, 'insert', payload),
        update: (payload: Row) => new FakeQuery(state, table, 'update', payload),
        upsert: (payload: Row) => new FakeQuery(state, table, 'upsert', payload),
      };
    },
  } as unknown as Db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-05T10:00:00.000Z');
const CURSOR = '4000';
const OWNER = 'owner@example.gr';

function settingsRows(over: Row[] = []): Row[] {
  return [
    { key: 'kill_switch', value: false },
    { key: 'autonomy', value: { draft_email: 1, reminder: 1, alert: 1 } },
    { key: 'daily_send_cap', value: 40 },
    { key: 'daily_cost_cap', value: 2 },
    { key: 'gmail_watch', value: { history_id: CURSOR, expiration: null, updated_at: '2026-08-04T10:00:00.000Z' } },
    ...over,
  ];
}

function state(over: Partial<FakeState> = {}): FakeState {
  return {
    tasks: [],
    contacts: [],
    interactions: [],
    settings: settingsRows(),
    brain: [{ key: 'services', value: 'Websites for small businesses.' }],
    sequence: 0,
    ...over,
  };
}

function contactRow(id: string, over: Row = {}): Row {
  return {
    id,
    name: 'Μαρία',
    business: 'Taverna Ilios',
    email: 'maria@example.gr',
    phone: null,
    language: 'el',
    city: 'Athens',
    country: 'GR',
    timezone: 'Europe/Athens',
    source: 'nfc_card',
    stage: 'contacted',
    value_estimate: null,
    notes: null,
    last_touch_at: null,
    next_touch_at: null,
    touch_count: 1,
    do_not_contact: false,
    tags: [],
    stage_changed_at: '2026-07-01T00:00:00.000Z',
    created_at: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

type GmailMessage = {
  id: string;
  threadId?: string;
  from?: string;
  subject?: string;
  body?: string;
  labelIds?: string[];
};

type GmailScript = {
  /** Message ids the history returns, in order. */
  history: string[];
  historyId?: string;
  nextPageToken?: string | null;
  messages: Record<string, GmailMessage>;
  profileHistoryId?: string;
  /** Status to answer history.list with, when it is not 200. */
  historyStatus?: number;
  /** Message ids whose `messages.get` fails. */
  brokenMessages?: string[];
  /** Status for a broken `messages.get`. 500 unless a case says otherwise. */
  brokenStatus?: number;
  /** What `users.watch` answers with. Only reached when DRY_RUN is off. */
  watchExpiration?: string;
};

let gmailCalls: string[] = [];

function messageResource(message: GmailMessage): unknown {
  const body = message.body ?? 'Καλησπέρα, μια ερώτηση.';
  return {
    id: message.id,
    threadId: message.threadId ?? `thread-${message.id}`,
    labelIds: message.labelIds ?? ['INBOX', 'UNREAD'],
    snippet: body.slice(0, 40),
    internalDate: String(NOW.getTime() - 60_000),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: message.from ?? 'Μαρία <maria@example.gr>' },
        { name: 'To', value: `Owner <${OWNER}>` },
        { name: 'Subject', value: message.subject ?? 'Ερώτηση' },
        { name: 'Message-ID', value: `<${message.id}@mail.gmail.com>` },
        { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
      ],
      body: { data: Buffer.from(body, 'utf8').toString('base64url') },
    },
  };
}

function installGmail(script: GmailScript): void {
  setGmailAccessTokenProvider(async () => 'test-token');
  setGmailReadTransport(async (url: string) => {
    gmailCalls.push(url);
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.includes('/profile')) {
      return json({ historyId: script.profileHistoryId ?? '9999' });
    }

    if (url.includes('/watch')) {
      return json({ historyId: '8888', expiration: script.watchExpiration ?? '1798761600000' });
    }

    if (url.includes('/history?')) {
      if (script.historyStatus !== undefined && script.historyStatus !== 200) {
        return json({ error: 'nope' }, script.historyStatus);
      }
      return json({
        history: script.history.map((id) => ({
          messagesAdded: [{ message: { id, labelIds: script.messages[id]?.labelIds ?? ['INBOX'] } }],
        })),
        historyId: script.historyId ?? '5000',
        ...(script.nextPageToken ? { nextPageToken: script.nextPageToken } : {}),
      });
    }

    const match = /\/messages\/([^?]+)/.exec(url);
    if (match !== null) {
      const id = decodeURIComponent(match[1] ?? '');
      if (script.brokenMessages?.includes(id)) {
        return json({ error: 'boom' }, script.brokenStatus ?? 500);
      }
      const message = script.messages[id];
      if (message === undefined) return json({ error: 'gone' }, 404);
      return json(messageResource(message));
    }

    throw new Error(`the test did not expect a call to ${url}`);
  });
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

type ModelScript = {
  class?: string;
  confidence?: string;
  reason?: string;
  language?: string;
  /** Thrown instead of answering. */
  error?: Error;
};

let modelCalls: CallOpts[] = [];

/** A model that answers the classification and then the draft. */
function fakeModel(script: ModelScript = {}) {
  return async <T>(opts: CallOpts): Promise<T> => {
    modelCalls.push(opts);
    if (script.error !== undefined) throw script.error;

    if (opts.model === 'claude-haiku-4-5') {
      return {
        class: script.class ?? 'question',
        confidence: script.confidence ?? 'high',
        reason: script.reason ?? 'They asked when the work can start.',
        language: script.language ?? 'el',
      } as T;
    }
    return {
      subject: 'Re: Ερώτηση',
      body: 'Καλησπέρα Μαρία, μπορούμε να ξεκινήσουμε τη Δευτέρα.',
      reason: 'Answered the start-date question.',
      confidence: 'high',
    } as T;
  };
}

/** A model that fails the test if it is called. Proves "no charge". */
function noModel() {
  return async <T>(opts: CallOpts): Promise<T> => {
    modelCalls.push(opts);
    throw new Error(`the test paid for a ${opts.model} call it should not have made`);
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = {
  DRY_RUN: process.env['DRY_RUN'],
  ALLOWED_EMAIL: process.env['ALLOWED_EMAIL'],
  GMAIL_PUBSUB_TOPIC: process.env['GMAIL_PUBSUB_TOPIC'],
};

const originalLog = console.log;
let lines: string[] = [];
let pushes: unknown[] = [];

async function recordPush(payload: unknown): Promise<never> {
  pushes.push(payload);
  return { subscriptions: 1, sent: 1, removed: 0, failed: 0, dryRun: true } as never;
}

beforeEach(() => {
  lines = [];
  pushes = [];
  gmailCalls = [];
  modelCalls = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  process.env['DRY_RUN'] = 'true';
  process.env['ALLOWED_EMAIL'] = OWNER;
  process.env['GMAIL_PUBSUB_TOPIC'] = 'projects/agency-os/topics/gmail';
  resetInboxAlerts();
});

afterEach(() => {
  console.log = originalLog;
  setGmailReadTransport(null);
  setGmailAccessTokenProvider(null);
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function alertCards(db: FakeState): Row[] {
  return db.tasks.filter((row) => row['type'] === 'alert');
}

function draftCards(db: FakeState): Row[] {
  return db.tasks.filter((row) => row['type'] === 'draft_email');
}

function watchValue(db: FakeState): Row {
  const row = db.settings.find((entry) => entry['key'] === 'gmail_watch');
  return (row?.['value'] ?? {}) as Row;
}

// ---------------------------------------------------------------------------
// The switch, the cursor and the window
// ---------------------------------------------------------------------------

describe('runInbox — before any message is read', () => {
  it('reads nothing at all when the kill switch is on', async () => {
    // PLAN §7: a paused system does not classify, and it certainly does not
    // draft. The three tests after this one are about the two things a pause
    // must NOT stop.
    const db = state({ settings: [{ key: 'kill_switch', value: true }, ...settingsRows()] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.considered, 0);
    assert.equal(summary.classified, 0);
    assert.deepEqual(modelCalls, []);
    assert.equal(db.interactions.length, 0, 'no message was read or recorded');
    // The cursor did not move, so nothing behind it is lost.
    assert.equal(watchValue(db)['history_id'], CURSOR);
  });

  it('still renews the Gmail watch while the switch is on', async () => {
    // The switch used to be checked before the watch renewal and before the
    // cursor read, which meant a pause froze all three at once. Gmail expires a
    // watch after seven days and keeps about a week of history, so a switch left
    // on for eight days expired the subscription on day seven and blew past the
    // history horizon around day six. On the first sweep after it came off,
    // `history.list` answered 404, a fresh cursor was anchored, and every message
    // sent during the pause was gone — discovered afterwards, from a card.
    //
    // Renewing a `users.watch` contacts nobody, costs no model token and writes
    // to no contact. It is not what the switch is for.
    process.env['DRY_RUN'] = 'false';
    const db = state({
      settings: [
        { key: 'kill_switch', value: true },
        ...settingsRows().filter((row) => row['key'] !== 'gmail_watch'),
        {
          key: 'gmail_watch',
          value: { history_id: CURSOR, expiration: NOW.getTime() + 1000, updated_at: NOW.toISOString() },
        },
      ],
    });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.ok(
      gmailCalls.some((url) => url.includes('/watch')),
      'the watch was not renewed, so the webhook dies on day seven of the pause',
    );
    assert.equal(watchValue(db)['expiration'], 1798761600000);
    assert.equal(db.interactions.length, 0, 'and still nothing was read');
  });

  it('anchors a first cursor even while the switch is on', async () => {
    // A fresh install that is paused has nothing behind the cursor to lose, and
    // anchoring one means the mail that arrives during the pause is waiting when
    // it comes off rather than being skipped.
    const db = state({
      settings: [
        { key: 'kill_switch', value: true },
        ...settingsRows().filter((row) => row['key'] !== 'gmail_watch'),
      ],
    });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } }, profileHistoryId: '7777' });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(watchValue(db)['history_id'], '7777');
    assert.equal(summary.classified, 0);
    assert.deepEqual(modelCalls, []);
  });

  it('files one card when a pause has gone on long enough to start losing mail', async () => {
    const paused = new Date(NOW.getTime() - PAUSED_CURSOR_WARNING_MS - 60_000).toISOString();
    const db = state({
      settings: [
        { key: 'kill_switch', value: true },
        ...settingsRows().filter((row) => row['key'] !== 'gmail_watch'),
        {
          key: 'gmail_watch',
          value: { history_id: CURSOR, expiration: NOW.getTime() + 30 * 24 * 60 * 60 * 1000, updated_at: paused },
        },
      ],
    });
    installGmail({ history: [], messages: {} });

    await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });
    await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    const cards = alertCards(db);
    assert.equal(cards.length, 1, 'one condition, not one card per sweep');
    assert.ok(String(cards[0]?.['title']).includes('kill switch'));
  });

  it('anchors the first ever run to now and reads nothing before it', async () => {
    const db = state({ settings: settingsRows().filter((row) => row['key'] !== 'gmail_watch') });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } }, profileHistoryId: '7777' });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.considered, 0);
    assert.equal(summary.cursorAdvanced, true);
    assert.equal(watchValue(db)['history_id'], '7777');
    assert.deepEqual(alertCards(db), [], 'nothing was missed, so nothing to report');
    assert.deepEqual(modelCalls, []);
  });

  it('re-anchors and reports the window when the cursor is too old to serve', async () => {
    // The alternative — walking the mailbox from the beginning — would draft
    // replies to hundreds of months-old messages and spend real money doing it.
    const db = state();
    installGmail({ history: [], messages: {}, historyStatus: 404, profileHistoryId: '8888' });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.considered, 0);
    assert.equal(watchValue(db)['history_id'], '8888');
    assert.deepEqual(modelCalls, []);

    const cards = alertCards(db);
    assert.equal(cards.length, 1);
    assert.ok(String(cards[0]?.['reasoning']).includes('2026-08-04T10:00:00.000Z'));
    assert.ok(String(cards[0]?.['reasoning']).includes('Check Gmail by hand'));
  });

  it('advances the cursor on an empty sweep without calling a model', async () => {
    const db = state();
    installGmail({ history: [], messages: {}, historyId: '6000' });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.cursorAdvanced, true);
    assert.equal(watchValue(db)['history_id'], '6000');
    assert.deepEqual(modelCalls, []);
  });

  it('keeps the old cursor rather than writing a null one', async () => {
    // Gmail sends no historyId on an empty page often enough that this matters,
    // and a null cursor is every message that arrives after it never being read.
    const db = state();
    installGmail({ history: [], messages: {}, historyId: undefined as unknown as string });
    setGmailReadTransport(async (url: string) => {
      gmailCalls.push(url);
      if (url.includes('/history?')) {
        return new Response(JSON.stringify({ history: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ historyId: '1' }), { status: 200 });
    });

    await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });
    assert.equal(watchValue(db)['history_id'], CURSOR);
  });
});

// ---------------------------------------------------------------------------
// The loud routing
// ---------------------------------------------------------------------------

describe('runInbox — a message that deserves a reply', () => {
  it('creates the contact, claims the row, drafts a reply and pushes immediately', async () => {
    const db = state();
    installGmail({
      history: ['m1'],
      messages: { m1: { id: 'm1', subject: 'Ενδιαφέρομαι' } },
      historyId: '6000',
    });

    const summary = await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: fakeModel({ class: 'new_lead' }),
      push: recordPush,
    });

    assert.equal(summary.classified, 1);
    assert.equal(summary.drafted, 1);
    assert.equal(summary.cursorAdvanced, true);

    // The contact
    assert.equal(db.contacts.length, 1);
    assert.equal(db.contacts[0]?.['email'], 'maria@example.gr');
    assert.equal(db.contacts[0]?.['source'], 'inbound');
    assert.equal(db.contacts[0]?.['stage'], 'new', 'new_lead does not promote');

    // The interaction, with the meta shape /inbox reads
    assert.equal(db.interactions.length, 1);
    const meta = db.interactions[0]?.['meta'] as Row;
    assert.equal(meta['gmail_message_id'], 'm1');
    assert.equal(meta['class'], 'new_lead');
    assert.equal(meta['confidence'], 'high');
    assert.equal(typeof meta['classified_at'], 'string');
    assert.equal(meta['task_id'], draftCards(db)[0]?.['id']);

    // The card
    const card = draftCards(db)[0];
    assert.equal(card?.['agent'], 'inbox');
    assert.equal(card?.['status'], 'pending');
    assert.equal(card?.['autonomy_level'], 1);
    assert.ok(String(card?.['draft_body']).includes('Δευτέρα'));

    // The push
    assert.deepEqual(pushes, [
      { title: 'New lead', body: 'Open the inbox to read it.', url: '/inbox', tag: 'inbox' },
    ]);

    // Haiku first, then Sonnet. Never the other way round.
    assert.deepEqual(
      modelCalls.map((call) => call.model),
      ['claude-haiku-4-5', 'claude-sonnet-5'],
    );
  });

  it('holds the morning agent off a live conversation', async () => {
    // Without this the follow-up agent drafts a cold nudge at somebody we
    // replied to yesterday, and the operator gets two cards about one person.
    const db = state({ contacts: [contactRow('c1', { next_touch_at: NOW.toISOString() })] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    const next = new Date(String(db.contacts[0]?.['next_touch_at'])).getTime();
    assert.equal(next, NOW.getTime() + REPLY_NEXT_TOUCH_DAYS * 24 * 60 * 60 * 1000);
  });

  it('does not pull a further-out follow-up date closer when the stage did not move', async () => {
    // `pushNextTouch` only ever pushes out. `new_lead` does not promote — they
    // were created as `new` a moment ago and nobody has written to them — so
    // nothing about this contact changed and their existing date stands.
    const far = '2026-09-01T08:00:00.000Z';
    const db = state({ contacts: [contactRow('c1', { stage: 'new', next_touch_at: far })] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: fakeModel({ class: 'new_lead' }),
      push: recordPush,
    });
    assert.equal(db.contacts[0]?.['next_touch_at'], far);
  });

  it('re-dates a contact whose stage moved, even if that pulls the date closer', async () => {
    // The one case that is allowed to pull in, and it is the case that matters
    // most: a dormant lead writes back. Their `next_touch_at` is ninety days out
    // because `followup.ts` put it there when they went quiet, and the old date
    // belongs to the old stage. Leaving it would schedule the warmest contact in
    // the pipeline for a nudge in three months.
    const far = '2026-11-01T08:00:00.000Z';
    const db = state({ contacts: [contactRow('c1', { stage: 'dormant', next_touch_at: far })] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    assert.equal(db.contacts[0]?.['stage'], 'replied');
    const next = new Date(String(db.contacts[0]?.['next_touch_at'])).getTime();
    assert.equal(next, NOW.getTime() + REPLY_NEXT_TOUCH_DAYS * 24 * 60 * 60 * 1000);
  });

  it('never moves last_touch_at — an inbound message is not an outbound touch', async () => {
    const db = state({ contacts: [contactRow('c1', { last_touch_at: '2026-07-01T08:00:00.000Z' })] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });
    assert.equal(db.contacts[0]?.['last_touch_at'], '2026-07-01T08:00:00.000Z');
  });

  it('does not knock a quoted lead back to replied', async () => {
    const db = state({ contacts: [contactRow('c1', { stage: 'quoted' })] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel({ class: 'question' }), push: recordPush });
    assert.equal(db.contacts[0]?.['stage'], 'quoted');
  });

  it('promotes a contacted lead who replies', async () => {
    const db = state({ contacts: [contactRow('c1', { stage: 'contacted' })] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel({ class: 'interested' }), push: recordPush });
    assert.equal(db.contacts[0]?.['stage'], 'replied');
    assert.equal(pushes.length, 1);
  });

  it('waits for the digest on everything that is not a hot lead', async () => {
    const db = state({ contacts: [contactRow('c1')] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel({ class: 'question' }), push: recordPush });
    assert.deepEqual(pushes, [], 'twenty pings a day and the app gets muted');
    assert.equal(draftCards(db).length, 1, 'the card is what the digest counts');
  });
});

// ---------------------------------------------------------------------------
// The quiet routing — the half that matters as much
// ---------------------------------------------------------------------------

describe('runInbox — the silent classes', () => {
  it('closes a contact who says no, without a draft, a push or a sound', async () => {
    // SPEC §5: "The silent handling of not_interested matters as much as the
    // loud handling of hot leads."
    const db = state({ contacts: [contactRow('c1', { stage: 'quoted', next_touch_at: NOW.toISOString() })] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    const summary = await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: fakeModel({ class: 'not_interested', reason: 'They have chosen another agency.' }),
      push: recordPush,
    });

    assert.equal(summary.classified, 1);
    assert.equal(summary.drafted, 0);
    assert.equal(summary.silent, 1);

    assert.equal(db.contacts[0]?.['stage'], 'lost');
    assert.equal(db.contacts[0]?.['do_not_contact'], true);
    assert.equal(db.contacts[0]?.['next_touch_at'], null, 'a closed contact has no next touch');

    assert.deepEqual(draftCards(db), []);
    assert.deepEqual(pushes, []);

    // The interactions row is the only trace, and it is what /inbox shows.
    const meta = db.interactions[0]?.['meta'] as Row;
    assert.equal(meta['class'], 'not_interested');
    assert.equal(meta['task_id'], null);
  });

  it('honours a bare opt-out without calling a model at all', async () => {
    // The compliance footer promises that replying STOP works. A model call is
    // not allowed to be the thing that decides whether a legal opt-out was
    // honoured — not when it can be rate-limited, down, or over the cost cap.
    const db = state({ contacts: [contactRow('c1')] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1', body: 'STOP' } } });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.classified, 1);
    assert.deepEqual(modelCalls, []);
    assert.equal(db.contacts[0]?.['stage'], 'lost');
    assert.equal(db.contacts[0]?.['do_not_contact'], true);
    assert.deepEqual(pushes, []);
  });

  it('honours the Greek opt-out word as well', async () => {
    const db = state({ contacts: [contactRow('c1')] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1', body: 'ΔΙΑΓΡΑΦΗ' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });
    assert.equal(db.contacts[0]?.['do_not_contact'], true);
    assert.deepEqual(modelCalls, []);
  });

  it('records spam and stops there', async () => {
    const db = state({ contacts: [contactRow('c1', { stage: 'contacted' })] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel({ class: 'spam' }), push: recordPush });

    assert.equal(summary.silent, 1);
    assert.equal(db.interactions.length, 1, 'a row is written regardless of class');
    assert.equal((db.interactions[0]?.['meta'] as Row)['class'], 'spam');
    assert.deepEqual(draftCards(db), []);
    assert.deepEqual(pushes, []);
    assert.equal(db.contacts[0]?.['stage'], 'contacted', 'spam changes nothing about them');
    assert.equal(db.contacts[0]?.['do_not_contact'], false);
  });

  it('records not_business and stops there', async () => {
    const db = state({ contacts: [contactRow('c1')] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel({ class: 'not_business' }), push: recordPush });
    assert.equal(db.interactions.length, 1);
    assert.deepEqual(draftCards(db), []);
    assert.deepEqual(pushes, []);
  });

  it('never drafts at somebody who has already opted out', async () => {
    // The one mistake in this file with a legal edge. The class does not get a
    // vote: they are still logged and still classified, because they are
    // talking to us.
    const db = state({ contacts: [contactRow('c1', { do_not_contact: true })] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    const summary = await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: fakeModel({ class: 'interested' }),
      push: recordPush,
    });

    assert.equal(summary.classified, 1);
    assert.equal(summary.drafted, 0);
    assert.deepEqual(draftCards(db), []);
    assert.equal((db.interactions[0]?.['meta'] as Row)['class'], 'interested');
    assert.deepEqual(
      modelCalls.map((call) => call.model),
      ['claude-haiku-4-5'],
      'no Sonnet call was paid for',
    );
  });

  it('never processes our own sends', async () => {
    // Our sends re-enter the history. Left unchecked the owner becomes a contact
    // the agent writes follow-ups to.
    const db = state();
    installGmail({
      history: ['m1'],
      messages: { m1: { id: 'm1', from: `Owner <${OWNER}>` } },
    });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.silent, 1);
    assert.deepEqual(db.contacts, []);
    assert.deepEqual(db.interactions, []);
    assert.deepEqual(modelCalls, []);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('runInbox — the same message twice', () => {
  it('costs nothing the second time a notification covers it', async () => {
    // Pub/Sub is at-least-once and Gmail history ranges overlap. This is the
    // ordinary case, not the edge case.
    const db = state({ contacts: [contactRow('c1')] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });
    const afterFirst = modelCalls.length;

    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
    const second = await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    assert.equal(second.duplicate, 1);
    assert.equal(second.classified, 0);
    assert.equal(modelCalls.length, afterFirst, 'not one extra model call');
    assert.equal(db.interactions.length, 1);
    assert.equal(draftCards(db).length, 1);
  });

  it('does not fetch a message it has already recorded', async () => {
    const db = state({ contacts: [contactRow('c1')] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    gmailCalls = [];
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    assert.ok(!gmailCalls.some((url) => url.includes('/messages/')));
  });

  it('loses the race at the unique index rather than at a second invoice', async () => {
    // The pre-filter is the cheap half and two runs can both pass it. The claim
    // is the correct half: the row already exists, the insert is a 23505, and
    // nothing after it happens.
    const db = state({ contacts: [contactRow('c1')] });
    // A row planted directly, as a concurrent delivery would have left it.
    db.interactions.push({
      id: 'planted',
      contact_id: 'c1',
      direction: 'in',
      channel: 'email',
      meta: { gmail_message_id: 'm1' },
    });

    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.duplicate, 1);
    assert.deepEqual(modelCalls, []);
    assert.deepEqual(draftCards(db), []);
    assert.equal(db.interactions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// One bad message costs one message
// ---------------------------------------------------------------------------

describe('runInbox — failures', () => {
  it('processes the rest of the batch when one message cannot be read', async () => {
    const db = state({ contacts: [contactRow('c1')] });
    installGmail({
      history: ['bad', 'good'],
      messages: { bad: { id: 'bad' }, good: { id: 'good' } },
      brokenMessages: ['bad'],
    });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    assert.equal(summary.failed, 1);
    assert.equal(summary.classified, 1);
    assert.equal(draftCards(db).length, 1);
  });

  it('leaves the cursor alone after a failure, so the message is tried again', async () => {
    const db = state();
    installGmail({
      history: ['bad'],
      messages: { bad: { id: 'bad' } },
      brokenMessages: ['bad'],
      historyId: '6000',
    });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    assert.equal(summary.cursorAdvanced, false);
    assert.equal(watchValue(db)['history_id'], CURSOR);
  });

  it('files one card for a failure rather than one per sweep', async () => {
    const db = state();
    installGmail({ history: ['bad'], messages: { bad: { id: 'bad' } }, brokenMessages: ['bad'] });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });
    installGmail({ history: ['bad'], messages: { bad: { id: 'bad' } }, brokenMessages: ['bad'] });
    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    assert.equal(alertCards(db).length, 1);
  });

  it('stops the run at the daily cost cap instead of discovering it 24 more times', async () => {
    const db = state();
    installGmail({
      history: ['m1', 'm2', 'm3'],
      messages: { m1: { id: 'm1' }, m2: { id: 'm2' }, m3: { id: 'm3' } },
    });

    const summary = await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: fakeModel({ error: new LlmError('Daily cost cap reached', 'cost_cap') }),
      push: recordPush,
    });

    assert.equal(summary.failed, 1);
    assert.equal(modelCalls.length, 1, 'the second message was not attempted');
    assert.equal(summary.cursorAdvanced, false);
    assert.equal(alertCards(db).length, 1);
  });

  it('records a message with no usable sender rather than re-reading it forever', async () => {
    const db = state();
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1', from: 'not an address' } } });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.silent, 1);
    assert.equal(db.interactions.length, 1);
    assert.equal((db.interactions[0]?.['meta'] as Row)['class'], 'not_business');
    assert.deepEqual(db.contacts, []);
    assert.deepEqual(modelCalls, []);
  });

  it('stops following page tokens rather than making unbounded Gmail requests', async () => {
    // A public webhook that can be made to page forever is a public webhook
    // that can be made to hammer somebody else's API on our credentials.
    const db = state({ contacts: [contactRow('c1')] });
    installGmail({
      history: ['m1'],
      messages: { m1: { id: 'm1', body: 'STOP' } },
      nextPageToken: 'always-more',
      historyId: '6000',
    });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    // Exactly the ceiling, not "no more than" it: this script hands back a page
    // token for ever, so a walk that stopped after one page would satisfy `<= 5`
    // while proving nothing about the bound.
    const historyCalls = gmailCalls.filter((url) => url.includes('/history?'));
    assert.equal(historyCalls.length, 5, `followed ${historyCalls.length} pages`);
    assert.equal(summary.cursorAdvanced, false, 'there is more history than this run took');
    assert.equal(watchValue(db)['history_id'], CURSOR);
  });

  it('does not advance the cursor when the batch hit the ceiling', async () => {
    const ids = Array.from({ length: MAX_MESSAGES_PER_RUN + 5 }, (_, i) => `m${i}`);
    const messages: Record<string, GmailMessage> = {};
    for (const id of ids) messages[id] = { id, body: 'STOP' };

    const db = state();
    installGmail({ history: ids, messages, historyId: '6000' });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.classified, MAX_MESSAGES_PER_RUN);
    assert.equal(summary.cursorAdvanced, false);
    assert.equal(watchValue(db)['history_id'], CURSOR);
  });

  it('drains the tail of a burst instead of jumping the cursor past it', async () => {
    // The regression this case exists for was silent mail loss. Run one takes
    // the first 25 and correctly holds the cursor. Run two used to find every id
    // it looked at already recorded, conclude there was nothing to do, and write
    // `history.list`'s *current mailbox* history id — which is not the end of
    // the page it walked. The last five messages were then never read, never
    // classified and never replied to, with `failed: 0` and nothing in the log.
    const ids = Array.from({ length: MAX_MESSAGES_PER_RUN + 5 }, (_, i) => `m${i}`);
    const messages: Record<string, GmailMessage> = {};
    for (const id of ids) messages[id] = { id, body: 'STOP' };

    const db = state();
    installGmail({ history: ids, messages, historyId: '6000' });
    const first = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(first.classified, MAX_MESSAGES_PER_RUN);
    assert.equal(first.cursorAdvanced, false, 'there is more behind the ceiling');

    installGmail({ history: ids, messages, historyId: '6000' });
    const second = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(second.duplicate, MAX_MESSAGES_PER_RUN);
    assert.equal(second.classified, 5, 'the tail was read on the next sweep');
    assert.equal(second.cursorAdvanced, true, 'and only now is the window finished');
    assert.equal(watchValue(db)['history_id'], '6000');

    for (const id of ids) {
      const row = db.interactions.find((entry) => (entry['meta'] as Row)['gmail_message_id'] === id);
      assert.ok(row !== undefined, `${id} was never recorded`);
    }
  });

  it('does not advance the cursor when a page token is still outstanding and nothing was new', async () => {
    // Same guard, the other way in: an empty batch says nothing about the pages
    // the ceiling stopped the walk from reading.
    const db = state({ contacts: [contactRow('c1')] });
    db.interactions.push({
      id: 'planted',
      contact_id: 'c1',
      direction: 'in',
      channel: 'email',
      meta: { gmail_message_id: 'm1', class: 'question', attempts: 1 },
    });

    installGmail({
      history: ['m1'],
      messages: { m1: { id: 'm1' } },
      nextPageToken: 'always-more',
      historyId: '6000',
    });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.duplicate, 1);
    assert.equal(summary.cursorAdvanced, false);
    assert.equal(watchValue(db)['history_id'], CURSOR);
  });
});

// ---------------------------------------------------------------------------
// The claim is the attempt counter
// ---------------------------------------------------------------------------

describe('runInbox — a message that failed after it was claimed', () => {
  it('applies an opt-out on the next sweep when the contacts update failed', async () => {
    // The worst shape of "claimed, then failed": the reply said STOP, the
    // `contacts` update errored, and the row was already recorded — so every
    // later sweep dropped the message as a duplicate, `do_not_contact` was never
    // set, and the follow-up agent went on writing to somebody who said no.
    const db = state({ contacts: [contactRow('c1', { next_touch_at: NOW.toISOString() })] });
    db.fail = (table, op) => (table === 'contacts' && op === 'update' ? 'connection reset' : null);

    installGmail({ history: ['m1'], messages: { m1: { id: 'm1', body: 'STOP' } } });
    const first = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(first.failed, 1);
    assert.equal(db.contacts[0]?.['do_not_contact'], false, 'the opt-out did not land');
    assert.equal(first.cursorAdvanced, false);

    db.fail = undefined;
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1', body: 'STOP' } } });
    const second = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(second.duplicate, 0, 'the unfinished row is retried, not skipped');
    assert.equal(second.classified, 1);
    assert.equal(db.contacts[0]?.['do_not_contact'], true);
    assert.equal(db.contacts[0]?.['next_touch_at'], null);
    assert.equal(db.interactions.length, 1, 'the same row, taken over');
    assert.deepEqual(modelCalls, [], 'a bare opt-out still costs nothing');
  });

  it('drafts the reply on the next sweep when the classifier answer was unusable', async () => {
    const db = state({ contacts: [contactRow('c1')] });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    const first = await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: fakeModel({ class: 'nonsense' }),
      push: recordPush,
    });

    assert.equal(first.failed, 1);
    assert.equal(draftCards(db).length, 0);
    assert.equal((db.interactions[0]?.['meta'] as Row)['class'], null);
    assert.equal((db.interactions[0]?.['meta'] as Row)['attempts'], 1);

    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
    const second = await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: fakeModel({ class: 'question' }),
      push: recordPush,
    });

    assert.equal(second.classified, 1);
    assert.equal(second.drafted, 1);
    assert.equal(db.interactions.length, 1);
    assert.equal((db.interactions[0]?.['meta'] as Row)['class'], 'question');
    assert.equal((db.interactions[0]?.['meta'] as Row)['attempts'], 2);
    assert.equal(second.cursorAdvanced, true);
  });

  it('gives up after three attempts rather than holding the mailbox forever', async () => {
    // Unbounded retries would be one Haiku call every fifteen minutes for ever,
    // and — because the cursor waits for the batch — new mail behind this
    // message would eventually stop being read at all.
    const db = state({ contacts: [contactRow('c1')] });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
      const run = await runInbox({
        db: fakeDb(db),
        now: NOW,
        llm: fakeModel({ class: 'nonsense' }),
        push: recordPush,
      });
      assert.equal(run.failed, 1, `attempt ${attempt}`);
      assert.equal(run.cursorAdvanced, false, `attempt ${attempt}`);
    }

    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } }, historyId: '6000' });
    const fourth = await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: noModel(),
      push: recordPush,
    });

    assert.equal(fourth.duplicate, 1);
    assert.equal(fourth.failed, 0);
    assert.equal(fourth.cursorAdvanced, true, 'the rest of the mailbox is not held hostage');
    assert.equal(watchValue(db)['history_id'], '6000');

    const cards = alertCards(db);
    const last = String(cards[cards.length - 1]?.['reasoning']);
    assert.ok(last.includes('will not be tried again'), last);
    assert.ok(!last.includes('It will be tried again on the next sweep'), last);
  });

  it('does not promise a retry it cannot perform', async () => {
    const db = state({ contacts: [contactRow('c1')] });
    db.fail = (table, op) => (table === 'tasks' && op === 'insert' ? 'foreign key violation' : null);
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    // The alert insert fails too here, which is the point of `fileAlert` being
    // best-effort; what matters is that the row is left retryable.
    const meta = db.interactions[0]?.['meta'] as Row;
    assert.equal(meta['class'], null);
    assert.equal(meta['attempts'], 1);
  });

  it('does not spend an attempt on the daily cost cap', async () => {
    // The cap is a condition of the day, not a fault in the message. Three
    // sweeps inside one capped afternoon would otherwise use up every attempt a
    // customer's email has and abandon it over something it had no part in.
    const db = state({ contacts: [contactRow('c1')] });

    for (let sweep = 1; sweep <= 3; sweep += 1) {
      installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
      const run = await runInbox({
        db: fakeDb(db),
        now: NOW,
        llm: fakeModel({ error: new LlmError('Daily cost cap reached', 'cost_cap') }),
        push: recordPush,
      });
      assert.equal(run.failed, 1, `sweep ${sweep}`);
    }

    assert.equal((db.interactions[0]?.['meta'] as Row)['attempts'], 0, 'the claim was handed back');

    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
    const after = await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: fakeModel({ class: 'question' }),
      push: recordPush,
    });

    assert.equal(after.classified, 1, 'and the message is still there when the cap resets');
    assert.equal(after.drafted, 1);
  });

  it('bounds a message Gmail will not hand over, and says what it did', async () => {
    // Without an attempt count on a message that fails *before* the claim, this
    // id is fresh on every sweep for ever, the cursor can never move past it,
    // and once 25 ids pile up behind it new mail stops being read.
    const db = state();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      installGmail({ history: ['bad'], messages: { bad: { id: 'bad' } }, brokenMessages: ['bad'] });
      const run = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });
      assert.equal(run.failed, 1, `attempt ${attempt}`);
      assert.equal(run.cursorAdvanced, false, `attempt ${attempt}`);
    }

    assert.equal(db.interactions.length, 1, 'one row, taken over each time');
    const meta = db.interactions[0]?.['meta'] as Row;
    assert.equal(meta['attempts'], 3);
    assert.equal(meta['read_error'], 'api_error');
    assert.equal(db.interactions[0]?.['body'], null, 'nothing was read, so nothing is stored');

    gmailCalls = [];
    installGmail({
      history: ['bad'],
      messages: { bad: { id: 'bad' } },
      brokenMessages: ['bad'],
      historyId: '6000',
    });
    const fourth = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(fourth.failed, 0);
    assert.equal(fourth.cursorAdvanced, true);
    assert.ok(!gmailCalls.some((url) => url.includes('/messages/bad')), 'not even fetched again');
  });

  it('loses the race at the unique index when a second delivery claims first', async () => {
    // The pre-filter is the cheap half and two runs can both pass it. This
    // plants the competing row *after* the pre-filter has answered, which is the
    // only arrangement that reaches the claim's 23505.
    const db = state({ contacts: [contactRow('c1')] });
    let planted = false;
    db.afterSelect = (table) => {
      if (table !== 'interactions' || planted) return;
      planted = true;
      db.interactions.push({
        id: 'planted',
        contact_id: 'c1',
        direction: 'in',
        channel: 'email',
        meta: { gmail_message_id: 'm1', class: null, attempts: 1 },
      });
    };

    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.duplicate, 1);
    assert.deepEqual(modelCalls, [], 'not one call was paid for');
    assert.deepEqual(draftCards(db), []);
    assert.equal(db.interactions.length, 1);
  });

  it('does not take over a row it did not write', async () => {
    // No `attempts` field means the row came from somewhere else. Reclassifying
    // a message somebody else is holding is how one message becomes two cards.
    const db = state({ contacts: [contactRow('c1')] });
    db.interactions.push({
      id: 'foreign',
      contact_id: 'c1',
      direction: 'in',
      channel: 'email',
      meta: { gmail_message_id: 'm1' },
    });

    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.duplicate, 1);
    assert.deepEqual(modelCalls, []);
    assert.equal(db.interactions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Read failures that are about the mailbox, not about a message
// ---------------------------------------------------------------------------

describe('runInbox — when Gmail itself is the problem', () => {
  it('stops the run on a revoked token instead of refreshing once per message', async () => {
    // `gmailRequest` forces a token refresh on the first 401, so continuing the
    // batch means one forced mint per message against a credential Google has
    // already revoked — 25 a sweep, 96 sweeps a day — plus a card each.
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const messages: Record<string, GmailMessage> = {};
    for (const id of ids) messages[id] = { id };

    const db = state();
    installGmail({ history: ids, messages, brokenMessages: ids, brokenStatus: 401 });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(summary.failed, 1, 'the run stopped at the first one');
    assert.equal(alertCards(db).length, 1, 'one condition, one card');
    assert.equal(summary.cursorAdvanced, false, 'nothing was lost');
    assert.deepEqual(db.interactions, [], 'no attempt is consumed by a mailbox-wide failure');

    const fetched = gmailCalls.filter((url) => url.includes('/messages/'));
    assert.ok(fetched.length <= 2, `tried ${fetched.length} reads against a dead credential`);
  });

  it('files one card for a rate limit rather than one per message', async () => {
    const ids = ['m1', 'm2', 'm3'];
    const messages: Record<string, GmailMessage> = {};
    for (const id of ids) messages[id] = { id };

    const db = state();
    installGmail({ history: ids, messages, brokenMessages: ids, brokenStatus: 429 });

    await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    assert.equal(alertCards(db).length, 1);
    assert.ok(String(alertCards(db)[0]?.['reasoning']).includes('rather than repeating'));
  });

  it('does not stall the mailbox over a message that has been deleted', async () => {
    // A 404 on `messages.get` is a message the operator deleted from their phone
    // in the seconds after it arrived. No number of retries produces it, and
    // counting it as a failure holds the cursor over it for a week.
    const db = state({ contacts: [contactRow('c1')] });
    installGmail({
      history: ['gone', 'm1'],
      messages: { m1: { id: 'm1' } },
      historyId: '6000',
    });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    assert.equal(summary.failed, 0);
    assert.equal(summary.classified, 1, 'the message behind it was still read');
    assert.equal(summary.cursorAdvanced, true);
    assert.equal(watchValue(db)['history_id'], '6000');
    assert.equal(alertCards(db).length, 1, 'and it is not silent about it');
  });

  it('files an alert when the run cannot start at all', async () => {
    // SPEC §8: an agent run never silently swallows a failure. A 403 from
    // history.list is the expected first-day state — the refresh token was
    // minted for gmail.send only — and it used to reach a log line and nothing
    // else, every fifteen minutes, with every screen the operator looks at
    // saying nothing.
    const db = state();
    installGmail({ history: [], messages: {}, historyStatus: 403 });

    await assert.rejects(() =>
      runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush }),
    );

    const cards = alertCards(db);
    assert.equal(cards.length, 1);
    assert.ok(String(cards[0]?.['reasoning']).includes('gmail.readonly'));
    assert.equal(watchValue(db)['history_id'], CURSOR);
  });
});

// ---------------------------------------------------------------------------
// Step 9 must not cost a step 8 reply
// ---------------------------------------------------------------------------

describe('runInbox — style examples', () => {
  it('drafts the reply anyway when the style examples will not load', async () => {
    const db = state({ contacts: [contactRow('c1')] });
    db.fail = (table, op) => (table === 'tasks' && op === 'select' ? 'statement timeout' : null);
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    assert.equal(summary.drafted, 1, 'a style hint is a nicety; the reply is not');
    assert.equal(summary.failed, 0);
    assert.equal(draftCards(db).length, 1);
  });
});

// ---------------------------------------------------------------------------
// The sender match
// ---------------------------------------------------------------------------

describe('runInbox — matching the sender', () => {
  it('matches an existing contact whatever case they wrote from', async () => {
    const db = state({ contacts: [contactRow('c1', { email: 'Maria@Example.gr' })] });
    installGmail({
      history: ['m1'],
      messages: { m1: { id: 'm1', from: 'Μαρία <MARIA@example.GR>' } },
    });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });
    assert.equal(db.contacts.length, 1, 'no second contact for the same person');
    assert.equal(db.interactions[0]?.['contact_id'], 'c1');
  });

  it('does not treat an underscore in an address as a wildcard', async () => {
    // PostgREST's ilike has no escape syntax and `_` matches any single
    // character, so without the code-side re-check this reply would be drafted
    // for a stranger whose address differs by one letter.
    const db = state({ contacts: [contactRow('c1', { email: 'mariaXk@example.gr' })] });
    installGmail({
      history: ['m1'],
      messages: { m1: { id: 'm1', from: 'Μαρία <maria_k@example.gr>' } },
    });

    await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    assert.equal(db.contacts.length, 2, 'a new contact, not somebody else’s row');
    const created = db.contacts.find((row) => row['email'] === 'maria_k@example.gr');
    assert.ok(created !== undefined);
  });

  it('takes the winner\'s row when another delivery created the contact first', async () => {
    // `contacts_email_unique` (migration 20260803160000) makes one row per
    // address a database fact, which gives this insert a losing branch it did not
    // have before: two messages from the same new sender in one batch, or a
    // webhook delivery racing the sweep. The winner's row is the same answer this
    // function would have given a moment later, so it is read back rather than
    // counted as a failure — otherwise the second message of a two-message burst
    // from a new lead fails and waits fifteen minutes for a sweep.
    let contactSelects = 0;
    const raced = contactRow('c-winner', { email: 'nea@example.gr' });

    const db = state({
      contacts: [],
      // The row appears between the sender lookup and the insert, which is the
      // only way to make the race real without two processes.
      afterSelect: (table) => {
        if (table !== 'contacts') return;
        contactSelects += 1;
        if (contactSelects === 2) db.contacts.push(raced);
      },
      fail: (table, op) =>
        table === 'contacts' && op === 'insert'
          ? 'duplicate key value violates unique constraint "contacts_email_unique"'
          : null,
    });

    installGmail({
      history: ['m1'],
      messages: { m1: { id: 'm1', from: 'Νέα <nea@example.gr>' } },
    });

    const summary = await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });

    assert.equal(summary.failed, 0, 'the race is not a failure');
    assert.equal(db.contacts.length, 1, 'and it did not become a second row');
    assert.equal(db.interactions[0]?.['contact_id'], 'c-winner');
  });

  it('never drafts when any row for that address has opted out', async () => {
    // Two rows for one address is now refused by `contacts_email_unique`, but
    // the index was added after this code and cannot repair rows that predate
    // it — and the inbox agent must not depend on a migration having been run.
    // Reading the opt-out off whichever row the database returned first would
    // mean answering somebody who said no roughly half the time.
    const db = state({
      contacts: [
        contactRow('c-old', {
          created_at: '2026-01-01T00:00:00.000Z',
          stage: 'lost',
          do_not_contact: true,
        }),
        contactRow('c-new', { created_at: '2026-06-01T00:00:00.000Z', stage: 'contacted' }),
      ],
    });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });

    const summary = await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: fakeModel({ class: 'interested' }),
      push: recordPush,
    });

    assert.equal(summary.classified, 1, 'they are still talking to us, so it is still logged');
    assert.equal(summary.drafted, 0);
    assert.deepEqual(draftCards(db), []);
    assert.deepEqual(
      modelCalls.map((call) => call.model),
      ['claude-haiku-4-5'],
      'and no Sonnet call was paid for',
    );
  });

  it('closes every row that carries the address when somebody opts out', async () => {
    // Leaving the second row contactable is the follow-up agent writing to them
    // next week, on a database that has already recorded the opt-out.
    const db = state({
      contacts: [
        contactRow('c-old', {
          created_at: '2026-01-01T00:00:00.000Z',
          next_touch_at: NOW.toISOString(),
        }),
        contactRow('c-new', {
          created_at: '2026-06-01T00:00:00.000Z',
          next_touch_at: NOW.toISOString(),
        }),
      ],
    });
    installGmail({ history: ['m1'], messages: { m1: { id: 'm1', body: 'STOP' } } });

    await runInbox({ db: fakeDb(db), now: NOW, llm: noModel(), push: recordPush });

    for (const row of db.contacts) {
      assert.equal(row['do_not_contact'], true, `${String(row['id'])} was left contactable`);
      assert.equal(row['next_touch_at'], null);
    }
  });

  it('attributes the conversation to the same row whatever order the rows come back in', async () => {
    const rows = [
      contactRow('c-old', { created_at: '2026-01-01T00:00:00.000Z' }),
      contactRow('c-new', { created_at: '2026-06-01T00:00:00.000Z' }),
    ];

    const attributions: unknown[] = [];
    for (const contacts of [rows, [...rows].reverse()]) {
      const db = state({ contacts: contacts.map((row) => ({ ...row })) });
      installGmail({ history: ['m1'], messages: { m1: { id: 'm1' } } });
      await runInbox({ db: fakeDb(db), now: NOW, llm: fakeModel(), push: recordPush });
      attributions.push(db.interactions[0]?.['contact_id']);
    }

    assert.deepEqual(attributions, ['c-old', 'c-old']);
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('runInbox — what reaches the log', () => {
  it('puts no customer data in any log line, on the happy path or the failure path', async () => {
    const db = state();
    installGmail({
      history: ['m1', 'bad'],
      messages: {
        m1: {
          id: 'm1',
          from: 'Μαρία Παπαδοπούλου <maria@example.gr>',
          subject: 'Θέλω μια ιστοσελίδα',
          body: 'Καλησπέρα, ψάχνω για κάποιον να φτιάξει το e-shop μου.',
        },
        bad: { id: 'bad' },
      },
      brokenMessages: ['bad'],
    });

    await runInbox({
      db: fakeDb(db),
      now: NOW,
      llm: fakeModel({ class: 'new_lead', reason: 'They asked about an e-shop for Taverna Ilios.' }),
      push: recordPush,
    });

    const whole = lines.join('\n');
    for (const secret of [
      'maria@example.gr',
      'example.gr',
      'Παπαδοπούλου',
      'Θέλω μια ιστοσελίδα',
      'e-shop μου',
      'They asked about an e-shop',
    ]) {
      assert.ok(!whole.includes(secret), `leaked: ${secret}`);
    }

    // What may be logged, and is, so the run is auditable at all.
    assert.ok(whole.includes('m1'));
    assert.ok(whole.includes('new_lead'));
  });
});


// ---------------------------------------------------------------------------
// The cursor age check — pure
// ---------------------------------------------------------------------------

describe('cursorIsAging', () => {
  const now = new Date('2026-08-05T10:00:00.000Z');
  const limit = 4 * 24 * 60 * 60 * 1000;

  it('is quiet about a cursor that moved recently', () => {
    assert.equal(cursorIsAging('2026-08-05T09:00:00.000Z', now, limit), false);
  });

  it('fires once the cursor has stood still for the whole window', () => {
    assert.equal(cursorIsAging('2026-08-01T09:59:00.000Z', now, limit), true);
  });

  it('treats a timestamp it cannot read as aging', () => {
    // An unreadable value is not evidence that the window is safe, and the cost
    // of being wrong in the other direction is a customer email nobody ever sees.
    assert.equal(cursorIsAging('last Tuesday', now, limit), true);
  });

  it('says nothing about a cursor that has never moved', () => {
    // No stored time means no pause to measure. The bootstrap path handles it.
    assert.equal(cursorIsAging(null, now, limit), false);
  });
});

// ---------------------------------------------------------------------------
// Single-flight, which is what bounds the cost of a public webhook
// ---------------------------------------------------------------------------

describe('runInboxTick', () => {
  /** A run whose completion the test controls. */
  function deferred(): { promise: Promise<InboxSummary>; resolve: () => void } {
    let release = (): void => {};
    const promise = new Promise<InboxSummary>((resolveWith) => {
      release = () =>
        resolveWith({
          considered: 0,
          duplicate: 0,
          classified: 0,
          drafted: 0,
          silent: 0,
          failed: 0,
          cursorAdvanced: false,
        });
    });
    return { promise, resolve: release };
  }

  it('collapses a burst into one run and exactly one more', async () => {
    // The header at the top of inbox.ts promises this, and it is what stops a
    // thousand Pub/Sub pushes in a second from becoming a thousand runs against
    // a mailbox and an Anthropic account. Until this test existed it was the one
    // claim in the file with nothing behind it, because `runInbox()` with no
    // injected db builds a service-role client and throws without a key.
    const triggers: string[] = [];
    const first = deferred();
    const second = deferred();
    const runs = [first, second];

    const tick = runInboxTick('webhook', async (t) => {
      triggers.push(t);
      const next = runs.shift();
      return next === undefined ? Promise.reject(new Error('a third run started')) : next.promise;
    });

    // Everything that arrives while the first run is in flight.
    await runInboxTick('cron');
    await runInboxTick('webhook');
    await runInboxTick('webhook');

    first.resolve();
    await Promise.resolve();
    second.resolve();
    await tick;

    assert.deepEqual(triggers, ['webhook', 'webhook']);
  });

  it('does not drop the caller that arrived mid-run', async () => {
    // Without the pending flag a notification landing during a sweep is simply
    // lost, and SPEC §5's immediate push for a new lead waits up to fifteen
    // minutes for the next one. Two deliveries inside one run's duration is the
    // normal shape of a burst, not an edge case.
    const triggers: string[] = [];
    const first = deferred();
    const second = deferred();
    const runs = [first, second];

    const tick = runInboxTick('cron', async (t) => {
      triggers.push(t);
      const next = runs.shift();
      return next === undefined ? Promise.reject(new Error('a third run started')) : next.promise;
    });

    await runInboxTick('webhook');
    first.resolve();
    await Promise.resolve();
    second.resolve();
    await tick;

    // A cron sweep does not displace a webhook: the webhook is the one with a
    // waiting message behind it.
    assert.deepEqual(triggers, ['cron', 'webhook']);
  });

  it('stops rather than looping when a run fails', async () => {
    // Whatever was queued while a run was failing would fail the same way, and a
    // loop here would be a hot one. The fifteen-minute sweep is the retry.
    let started = 0;

    const tick = runInboxTick('webhook', async () => {
      started += 1;
      throw new Error('postgrest is down');
    });

    await runInboxTick('webhook');
    await tick;

    assert.equal(started, 1);
  });

  it('is usable again after a failed run', async () => {
    let started = 0;
    await runInboxTick('cron', async () => {
      started += 1;
      throw new Error('postgrest is down');
    });
    await runInboxTick('cron', async () => {
      started += 1;
      return {
        considered: 0,
        duplicate: 0,
        classified: 0,
        drafted: 0,
        silent: 0,
        failed: 0,
        cursorAdvanced: false,
      };
    });

    assert.equal(started, 2, 'the flag was left set by the failure');
  });
});
