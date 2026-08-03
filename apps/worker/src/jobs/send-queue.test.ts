/**
 * Send-queue tests — the poller, without a database, a network or a Gmail
 * credential.
 *
 * Two halves, in the order they were written.
 *
 * The first tests `send-queue-policy.ts`, which is where every decision the tick
 * makes lives precisely so it can be proved on its own. The four mistakes it is
 * aimed at are the ones that would be worst in production and are all invisible
 * in a typecheck:
 *
 *   - a whole queue of approved drafts resolved to `skipped` in one tick because
 *     `terminal` was flipped on `daily_cap`, which is unrecoverable
 *   - the same customer emailed twice because a task with no `send_after`, or
 *     one whose window has not opened, was selected anyway
 *   - a Gmail outage filing one alert card every sixty seconds until the
 *     operator can no longer find the real cards
 *   - a missing footer variable throwing the morning's approvals away instead of
 *     waiting for a one-line fix
 *
 * The second half drives `runSendQueue` itself against an in-memory stand-in for
 * PostgREST. This file used to claim the orchestration "cannot be exercised
 * without Supabase and Google" — see the section header further down for why
 * that was wrong and what it cost.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setGmailTransport } from '@agency/core/gmail';
import type { Db } from '@agency/core';

import {
  AlertOnce,
  DEFERRABLE_REASONS,
  alertKey,
  clampLimit,
  failureAction,
  gmailErrorKind,
  haltsTick,
  isEnvironmentalFailure,
  nextTouchCount,
  orderDueTasks,
  redactEmails,
  refusalAction,
  resolutionStatus,
  type DueTaskRow,
} from './send-queue-policy';
import { MAX_TASKS_PER_TICK, runSendQueue } from './send-queue';

const NOW = new Date('2026-08-05T10:00:00.000Z');

/** The shape `@agency/core/gmail` throws, rebuilt rather than imported: these
 *  cases are about the classification, and a constructed `GmailError` would tie
 *  them to one module's constructor arguments. */
function gmailError(kind: string, retryable: boolean): Error & { kind: string; retryable: boolean } {
  const error = new Error(`gmail failed: ${kind}`) as Error & { kind: string; retryable: boolean };
  error.name = 'GmailError';
  error.kind = kind;
  error.retryable = retryable;
  return error;
}

// ---------------------------------------------------------------------------
// Selection and ordering
// ---------------------------------------------------------------------------

describe('orderDueTasks', () => {
  it('returns due ids oldest send_after first', () => {
    const rows: DueTaskRow[] = [
      { id: 'c', send_after: '2026-08-05T09:59:00.000Z' },
      { id: 'a', send_after: '2026-08-05T08:00:00.000Z' },
      { id: 'b', send_after: '2026-08-05T09:00:00.000Z' },
    ];
    assert.deepEqual(orderDueTasks(rows, NOW, 10), ['a', 'b', 'c']);
  });

  it('drops a task with no send time rather than sending it now', () => {
    // The class of row the tick counts and alerts about separately. It must
    // never leak into the batch: nothing chose when it should go out.
    const rows: DueTaskRow[] = [
      { id: 'scheduled', send_after: '2026-08-05T09:00:00.000Z' },
      { id: 'unscheduled', send_after: null },
    ];
    assert.deepEqual(orderDueTasks(rows, NOW, 10), ['scheduled']);
  });

  it('drops a task whose send window has not opened yet', () => {
    // PLAN §7.1: a message arriving at 03:00 local reads as a machine. If the
    // query's .lte filter is ever edited away, this is the second lock.
    const rows: DueTaskRow[] = [
      { id: 'due', send_after: '2026-08-05T09:59:59.000Z' },
      { id: 'future', send_after: '2026-08-05T10:00:01.000Z' },
    ];
    assert.deepEqual(orderDueTasks(rows, NOW, 10), ['due']);
  });

  it('treats a send_after exactly equal to now as due', () => {
    const rows: DueTaskRow[] = [{ id: 'edge', send_after: NOW.toISOString() }];
    assert.deepEqual(orderDueTasks(rows, NOW, 10), ['edge']);
  });

  it('drops a row whose timestamp does not parse', () => {
    const rows: DueTaskRow[] = [
      { id: 'good', send_after: '2026-08-05T09:00:00.000Z' },
      { id: 'corrupt', send_after: 'yesterday afternoon' },
    ];
    assert.deepEqual(orderDueTasks(rows, NOW, 10), ['good']);
  });

  it('applies the limit after ordering, so the most overdue are served first', () => {
    const rows: DueTaskRow[] = [
      { id: 'newest', send_after: '2026-08-05T09:59:00.000Z' },
      { id: 'oldest', send_after: '2026-08-01T09:00:00.000Z' },
      { id: 'middle', send_after: '2026-08-03T09:00:00.000Z' },
    ];
    assert.deepEqual(orderDueTasks(rows, NOW, 2), ['oldest', 'middle']);
  });

  it('breaks ties on id so the order is total', () => {
    const at = '2026-08-05T09:00:00.000Z';
    const rows: DueTaskRow[] = [
      { id: 'b', send_after: at },
      { id: 'a', send_after: at },
    ];
    assert.deepEqual(orderDueTasks(rows, NOW, 10), ['a', 'b']);
  });

  it('returns nothing for a limit of zero', () => {
    const rows: DueTaskRow[] = [{ id: 'a', send_after: '2026-08-05T09:00:00.000Z' }];
    assert.deepEqual(orderDueTasks(rows, NOW, 0), []);
  });
});

describe('clampLimit', () => {
  it('defaults to the maximum', () => {
    assert.equal(clampLimit(undefined, 10), 10);
  });

  it('never exceeds the maximum, however loudly it is asked', () => {
    assert.equal(clampLimit(500, 10), 10);
  });

  it('never goes below one', () => {
    assert.equal(clampLimit(0, 10), 1);
    assert.equal(clampLimit(-4, 10), 1);
  });

  it('floors a fractional request rather than throwing', () => {
    assert.equal(clampLimit(3.7, 10), 3);
  });

  it('falls back to the maximum on NaN', () => {
    assert.equal(clampLimit(Number.NaN, 10), 10);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('refusalAction', () => {
  it('resolves every terminal refusal', () => {
    const terminal = [
      'task_not_found',
      'task_wrong_type',
      'task_not_approved',
      'no_contact',
      'contact_missing',
      'do_not_contact',
      'suppression_tag',
      'no_email_address',
      'empty_body',
      'autonomy_off',
    ] as const;
    for (const reason of terminal) {
      assert.equal(refusalAction(reason, true), 'resolve', reason);
    }
  });

  it('defers the three reasons that are about the world', () => {
    for (const reason of DEFERRABLE_REASONS) {
      assert.equal(refusalAction(reason, false), 'defer', reason);
    }
  });

  it('still defers daily_cap even if terminal is wrongly true', () => {
    // The unrecoverable failure this table exists for: one flipped boolean in a
    // guardrail refactor resolving the entire approved queue to `skipped` in a
    // single tick. The drafts and the operator's approvals would both be gone,
    // and nothing would have errored.
    assert.equal(refusalAction('daily_cap', true), 'defer');
    assert.equal(refusalAction('kill_switch', true), 'defer');
    assert.equal(refusalAction('contact_cooldown', true), 'defer');
  });

  it('honours terminal for a reason this file has not been taught', () => {
    // A reason added to guardrails.ts later must behave correctly here with no
    // edit — and must not be silently deferred forever.
    const future = 'some_future_reason' as never;
    assert.equal(refusalAction(future, true), 'resolve');
    assert.equal(refusalAction(future, false), 'defer');
  });
});

describe('resolutionStatus', () => {
  it('records an already-sent task as sent, not skipped', () => {
    // The refusal means an outbound record for this task exists: the customer
    // has the message. Writing `skipped` would leave Today claiming a follow-up
    // the operator can see in their own Sent folder was never sent.
    assert.equal(resolutionStatus('already_sent'), 'sent');
  });

  it('records every other terminal refusal as skipped', () => {
    for (const reason of ['do_not_contact', 'empty_body', 'no_email_address'] as const) {
      assert.equal(resolutionStatus(reason), 'skipped', reason);
    }
  });
});

describe('haltsTick', () => {
  it('halts on the two global refusals', () => {
    assert.equal(haltsTick('daily_cap'), true);
    assert.equal(haltsTick('kill_switch'), true);
  });

  it('does not halt on a per-contact cooldown', () => {
    // The next task in the batch belongs to somebody else and is still sendable.
    assert.equal(haltsTick('contact_cooldown'), false);
  });

  it('does not halt on a permanent refusal', () => {
    assert.equal(haltsTick('do_not_contact'), false);
    assert.equal(haltsTick('empty_body'), false);
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe('gmailErrorKind', () => {
  it('reads the kind off a GmailError', () => {
    assert.equal(gmailErrorKind(gmailError('rate_limit', true)), 'rate_limit');
  });

  it('is null for an ordinary error', () => {
    assert.equal(gmailErrorKind(new Error('connection terminated')), null);
  });

  it('is null for a non-object', () => {
    assert.equal(gmailErrorKind('boom'), null);
    assert.equal(gmailErrorKind(null), null);
    assert.equal(gmailErrorKind(undefined), null);
  });
});

describe('failureAction', () => {
  it('defers a retryable Gmail failure', () => {
    assert.equal(failureAction(gmailError('rate_limit', true)), 'defer');
    assert.equal(failureAction(gmailError('api_error', true)), 'defer');
  });

  it('defers a missing footer or OAuth variable instead of throwing the queue away', () => {
    // Non-retryable, but it is the installation that is broken, not the draft.
    // Resolving here would skip a morning of approvals over a one-line fix.
    assert.equal(failureAction(gmailError('config', false)), 'defer');
    assert.equal(failureAction(gmailError('auth', false)), 'defer');
    assert.equal(failureAction(gmailError('network', false)), 'defer');
  });

  it('resolves a failure that is about this one message', () => {
    // These fail identically on every future tick. Retrying a 400 forever is how
    // a queue turns into a log flood.
    assert.equal(failureAction(gmailError('message_too_large', false)), 'resolve');
    assert.equal(failureAction(gmailError('api_error', false)), 'resolve');
  });

  it('defers a database error', () => {
    // A PostgREST blip is not evidence that the message is unsendable, and the
    // guardrails have already resolved the tasks that genuinely cannot be sent.
    assert.equal(failureAction(new Error('Failed to insert the interaction row')), 'defer');
  });

  it('defers something thrown that is not an Error at all', () => {
    assert.equal(failureAction('kaboom'), 'defer');
    assert.equal(failureAction(undefined), 'defer');
  });
});

describe('isEnvironmentalFailure', () => {
  it('recognises a MissingEnvError', () => {
    const error = new Error('Missing required environment variable: BUSINESS_ADDRESS');
    error.name = 'MissingEnvError';
    assert.equal(isEnvironmentalFailure(error), true);
  });

  it('recognises anything flagged retryable', () => {
    assert.equal(isEnvironmentalFailure(gmailError('api_error', true)), true);
  });

  it('does not claim an ordinary error', () => {
    assert.equal(isEnvironmentalFailure(new Error('no')), false);
  });

  it('does not claim a message-level Gmail failure', () => {
    assert.equal(isEnvironmentalFailure(gmailError('message_too_large', false)), false);
  });
});

// ---------------------------------------------------------------------------
// The alert gate
// ---------------------------------------------------------------------------

describe('alertKey', () => {
  it('collapses an outage onto one key regardless of which task hit it', () => {
    const outage = gmailError('rate_limit', true);
    assert.equal(alertKey('task-1', outage), alertKey('task-2', outage));
  });

  it('separates two different environmental problems', () => {
    assert.notEqual(alertKey('task-1', gmailError('auth', false)), alertKey('task-1', gmailError('config', false)));
  });

  it('keys a message-level failure per task', () => {
    const tooBig = gmailError('message_too_large', false);
    assert.notEqual(alertKey('task-1', tooBig), alertKey('task-2', tooBig));
  });

  it('keys a database failure per task', () => {
    const dbError = new Error('Failed to update the task row');
    assert.equal(alertKey('task-1', dbError), 'task:task-1');
  });
});

describe('AlertOnce', () => {
  it('claims a key once and refuses it thereafter', () => {
    const gate = new AlertOnce();
    assert.equal(gate.claim('environment:auth'), true);
    assert.equal(gate.claim('environment:auth'), false);
    assert.equal(gate.claim('environment:auth'), false);
  });

  it('files one card for an outage that spans sixty ticks', () => {
    // Without this, a Gmail outage puts one alert in the operator's queue every
    // minute until the real cards are unfindable.
    const gate = new AlertOnce();
    const outage = gmailError('network', true);
    let filed = 0;
    for (let tick = 0; tick < 60; tick += 1) {
      for (const taskId of ['task-1', 'task-2', 'task-3']) {
        if (gate.claim(alertKey(taskId, outage))) filed += 1;
      }
    }
    assert.equal(filed, 1);
  });

  it('files one card per task for a per-task failure', () => {
    const gate = new AlertOnce();
    const tooBig = gmailError('message_too_large', false);
    let filed = 0;
    for (let tick = 0; tick < 10; tick += 1) {
      for (const taskId of ['task-1', 'task-2']) {
        if (gate.claim(alertKey(taskId, tooBig))) filed += 1;
      }
    }
    assert.equal(filed, 2);
  });

  it('keeps different keys apart', () => {
    const gate = new AlertOnce();
    assert.equal(gate.claim('a'), true);
    assert.equal(gate.claim('b'), true);
    assert.equal(gate.size, 2);
  });

  it('forgets everything on reset', () => {
    const gate = new AlertOnce();
    gate.claim('a');
    gate.reset();
    assert.equal(gate.claim('a'), true);
  });
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe('redactEmails', () => {
  it('removes the address Postgres wrote into a constraint violation', () => {
    // The exact shape that would otherwise reach the worker log and an alert
    // card: the send path is the one place a recipient's address is in scope
    // when something fails.
    const message =
      'duplicate key value violates unique constraint "contacts_email_key" ' +
      'DETAIL: Key (email)=(maria@example.gr) already exists.';
    const redacted = redactEmails(message);
    assert.ok(!redacted.includes('maria@example.gr'));
    assert.ok(!redacted.includes('example.gr'));
    assert.ok(redacted.includes('[address]'));
    assert.ok(redacted.includes('contacts_email_key'));
  });

  it('removes an address wrapped in angle brackets', () => {
    assert.equal(redactEmails('rejected <kostas@example.com>'), 'rejected <[address]>');
  });

  it('removes more than one address', () => {
    const redacted = redactEmails('a@b.gr and c@d.com both failed');
    assert.equal(redacted, '[address] and [address] both failed');
  });

  it('leaves an ordinary message alone', () => {
    const message = 'Failed to update the task row: connection terminated';
    assert.equal(redactEmails(message), message);
  });
});

describe('nextTouchCount', () => {
  it('counts a first touch from an unset column', () => {
    assert.equal(nextTouchCount(null), 1);
    assert.equal(nextTouchCount(undefined), 1);
  });

  it('increments a normal count', () => {
    assert.equal(nextTouchCount(3), 4);
  });

  it('recovers from a corrupt count instead of writing it through', () => {
    assert.equal(nextTouchCount(-3), 1);
    assert.equal(nextTouchCount(2.6), 3);
    assert.equal(nextTouchCount(Number.NaN), 1);
    assert.equal(nextTouchCount('7' as unknown as number), 1);
  });
});

// ---------------------------------------------------------------------------
// The tick itself
// ---------------------------------------------------------------------------

/**
 * Everything above this line is the pure half. Everything below drives
 * `runSendQueue` end to end against an in-memory stand-in for PostgREST.
 *
 * The header of this file used to say the orchestration "cannot be exercised
 * without Supabase and Google". That was true of `createServiceClient()` and of
 * nothing else: `runSendQueue({ db, now, alerts })` takes all three of its
 * dependencies as arguments, and under `DRY_RUN=true` the Gmail call returns
 * without opening a socket. Five of the worst faults this job has had were
 * reachable in a few hundred lines of fake with no network, no database and no
 * key — a duplicate email 49 hours after the first, a queue starved by ten
 * cooling-down contacts, 1,440 identical alert cards a day, a dry run that
 * could not run, and a kill switch that stopped everything with nothing on
 * screen to say so. Each of them has a case below, named after what it does to
 * the operator rather than after the function it lives in.
 *
 * The fake is deliberately literal. It applies the filters it is given to plain
 * arrays and returns `{ data, error, count }` — no query planner, no ordering
 * cleverness beyond what the job asks for. A fake that were smarter than
 * PostgREST would prove things about itself instead of about this file.
 *
 * A transport is installed that fails the test if it is ever called, so "no
 * message left the building" is proved rather than assumed.
 */

type Row = Record<string, unknown>;

type TableName = 'tasks' | 'contacts' | 'interactions' | 'settings';

/** Which write to break, so a failure that only happens in production can be
 *  made to happen here. `op` is the verb, not the statement. */
type WriteFault = { table: TableName; op: 'insert' | 'update'; message: string } | null;

type FakeState = {
  tasks: Row[];
  contacts: Row[];
  interactions: Row[];
  settings: Row[];
  fault: WriteFault;
};

/** `a->>b` reads `a.b`; anything else is a plain column. Only `meta->>task_id`
 *  is used in anger, and it is the filter the duplicate-send guard turns on. */
function valueAt(row: Row, column: string): unknown {
  const arrow = column.indexOf('->>');
  if (arrow === -1) return row[column];
  const outer = row[column.slice(0, arrow)];
  const key = column.slice(arrow + 3);
  if (typeof outer !== 'object' || outer === null) return undefined;
  return (outer as Row)[key];
}

class FakeQuery implements PromiseLike<{ data: Row[] | Row | null; error: { message: string } | null; count: number | null }> {
  readonly #state: FakeState;
  readonly #table: TableName;
  readonly #op: 'select' | 'insert' | 'update';
  readonly #payload: Row | null;
  readonly #filters: ((row: Row) => boolean)[] = [];
  #wantCount = false;
  #head = false;
  #single = false;
  #limit: number | null = null;
  #orderBy: { column: string; ascending: boolean } | null = null;

  constructor(state: FakeState, table: TableName, op: 'select' | 'insert' | 'update', payload: Row | null) {
    this.#state = state;
    this.#table = table;
    this.#op = op;
    this.#payload = payload;
  }

  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    this.#wantCount = options?.count === 'exact';
    this.#head = options?.head === true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.#filters.push((row) => valueAt(row, column) === value);
    return this;
  }

  is(column: string, value: unknown): this {
    this.#filters.push((row) => (valueAt(row, column) ?? null) === value);
    return this;
  }

  /** Only `not(column, 'is', null)` is used, which is the selection's guard
   *  against a task nothing ever scheduled. */
  not(column: string, _operator: 'is', value: unknown): this {
    this.#filters.push((row) => (valueAt(row, column) ?? null) !== value);
    return this;
  }

  lte(column: string, value: string): this {
    this.#filters.push((row) => String(valueAt(row, column) ?? '') <= value);
    return this;
  }

  gte(column: string, value: string): this {
    this.#filters.push((row) => String(valueAt(row, column) ?? '') >= value);
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

  #run(): { data: Row[] | Row | null; error: { message: string } | null; count: number | null } {
    const fault = this.#state.fault;
    if (fault !== null && fault.table === this.#table && fault.op === this.#op) {
      return { data: null, error: { message: fault.message }, count: null };
    }

    if (this.#op === 'insert') {
      this.#state[this.#table].push({ ...(this.#payload ?? {}) });
      return { data: null, error: null, count: null };
    }

    if (this.#op === 'update') {
      for (const row of this.#matching()) Object.assign(row, this.#payload ?? {});
      return { data: null, error: null, count: null };
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
    const count = rows.length;
    if (this.#limit !== null) rows = rows.slice(0, this.#limit);

    if (this.#head) return { data: null, error: null, count };
    if (this.#single) return { data: rows[0] ?? null, error: null, count: this.#wantCount ? count : null };
    return { data: rows, error: null, count: this.#wantCount ? count : null };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: Row[] | Row | null; error: { message: string } | null; count: number | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.#run()).then(onfulfilled, onrejected);
  }
}

/**
 * The client shape the job uses, and nothing else.
 *
 * Cast through `unknown` because `Db` is `SupabaseClient<Database>` — a hundred
 * generic parameters deep, all of them describing a wire protocol this fake is
 * deliberately not implementing. The cast is the honest way to say "this
 * satisfies the four calls the job makes".
 */
function fakeDb(state: FakeState): Db {
  return {
    from(table: TableName) {
      return {
        select: (columns?: string, options?: { count?: string; head?: boolean }) =>
          new FakeQuery(state, table, 'select', null).select(columns, options),
        insert: (payload: Row) => new FakeQuery(state, table, 'insert', payload),
        update: (payload: Row) => new FakeQuery(state, table, 'update', payload),
      };
    },
  } as unknown as Db;
}

const TICK_NOW = new Date('2026-08-04T06:10:00.000Z');

const SETTINGS_ROWS: Row[] = [
  { key: 'kill_switch', value: false },
  { key: 'autonomy', value: { draft_email: 1, reminder: 1, alert: 1 } },
  { key: 'daily_send_cap', value: 40 },
  { key: 'daily_cost_cap', value: 2 },
  { key: 'send_window', value: { days: [2, 3, 4], start_hour: 9, end_hour: 16 } },
];

function contactRow(id: string, over: Row = {}): Row {
  return {
    id,
    name: 'Μαρία',
    business: 'Taverna Ilios',
    email: `contact-${id}@example.gr`,
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
    touch_count: 2,
    do_not_contact: false,
    tags: [],
    ...over,
  };
}

function taskRow(id: string, contactId: string | null, over: Row = {}): Row {
  return {
    id,
    agent: 'followup',
    type: 'draft_email',
    contact_id: contactId,
    title: 'Follow-up',
    reasoning: 'Quoted three weeks ago.',
    draft_subject: 'Μια σύντομη υπενθύμιση',
    draft_body: 'Καλημέρα,\n\nΜια υπενθύμιση.',
    final_body: 'Καλημέρα,\n\nΜια υπενθύμιση.',
    status: 'approved',
    autonomy_level: 1,
    send_after: '2026-08-04T06:05:00.000Z',
    created_at: '2026-08-04T05:00:00.000Z',
    resolved_at: null,
    ...over,
  };
}

function outboundRow(contactId: string, taskId: string, occurredAt: string): Row {
  return {
    id: `interaction-${taskId}`,
    contact_id: contactId,
    direction: 'out',
    channel: 'email',
    subject: 'x',
    body: 'y',
    occurred_at: occurredAt,
    meta: { task_id: taskId },
  };
}

function state(over: Partial<FakeState> = {}): FakeState {
  return {
    tasks: [],
    contacts: [],
    interactions: [],
    settings: SETTINGS_ROWS.map((row) => ({ ...row })),
    fault: null,
    ...over,
  };
}

function alertCards(db: FakeState): Row[] {
  return db.tasks.filter((row) => row['type'] === 'alert');
}

describe('runSendQueue — one tick, end to end', () => {
  const ORIGINAL_ENV = {
    DRY_RUN: process.env['DRY_RUN'],
    BUSINESS_NAME: process.env['BUSINESS_NAME'],
    BUSINESS_ADDRESS: process.env['BUSINESS_ADDRESS'],
    PRIVACY_POLICY_URL: process.env['PRIVACY_POLICY_URL'],
    GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'],
    GOOGLE_CLIENT_SECRET: process.env['GOOGLE_CLIENT_SECRET'],
    GMAIL_REFRESH_TOKEN: process.env['GMAIL_REFRESH_TOKEN'],
  };

  const originalLog = console.log;
  let lines: string[] = [];
  let gate: AlertOnce;

  beforeEach(() => {
    lines = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    gate = new AlertOnce();

    setGmailTransport(async (url) => {
      throw new Error(`the test opened a socket to ${url}`);
    });

    process.env['DRY_RUN'] = 'true';
    process.env['BUSINESS_NAME'] = 'Kolta Web';
    process.env['BUSINESS_ADDRESS'] = 'Ermou 12, 105 63 Athens, Greece';
    process.env['PRIVACY_POLICY_URL'] = 'https://example.gr/privacy';
    // The state STATUS.md describes: no Gmail credentials anywhere.
    delete process.env['GOOGLE_CLIENT_ID'];
    delete process.env['GOOGLE_CLIENT_SECRET'];
    delete process.env['GMAIL_REFRESH_TOKEN'];
  });

  afterEach(() => {
    console.log = originalLog;
    setGmailTransport(null);
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('sends a due task and writes all three rows, in a dry run with no Gmail credentials', async () => {
    // PLAN §7's dry-run row: "agents run, tasks are created, Gmail send is
    // stubbed and logged". Requiring GOOGLE_CLIENT_ID here meant the only
    // machine this repo exists on could not run a single tick — the queue
    // deferred everything and filed "Sending is not configured" instead.
    const db = state({
      contacts: [contactRow('c1')],
      tasks: [taskRow('t1', 'c1')],
    });

    const summary = await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    assert.deepEqual(summary, {
      claimed: 1,
      attempted: 1,
      sent: 1,
      refused: 0,
      failed: 0,
      deferred: 0,
    });
    assert.equal(db.interactions.length, 1, 'the outbound row is what the guards count');
    assert.equal(db.interactions[0]?.['meta'] instanceof Object, true);
    assert.equal((db.interactions[0]?.['meta'] as Row)['task_id'], 't1');
    assert.equal(db.tasks[0]?.['status'], 'sent');
    assert.equal(db.contacts[0]?.['touch_count'], 3);
    assert.equal(alertCards(db).length, 0);
  });

  it('never sends the same task twice, however long the tasks update stays broken', async () => {
    // The 49-hour duplicate. Gmail accepts the message, the interactions row
    // lands, and `UPDATE tasks SET status='sent'` fails all three attempts. The
    // row is left `approved` with a `send_after` in the past, so it is selected
    // again on every tick from then on. The per-contact cooldown refuses it for
    // 48 hours and then stops refusing it, and the customer gets a second copy
    // with nothing having errored in between.
    const db = state({
      contacts: [contactRow('c1')],
      tasks: [taskRow('t1', 'c1')],
      fault: { table: 'tasks', op: 'update', message: 'could not serialize access' },
    });

    const first = await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });
    assert.equal(first.sent, 1);
    assert.equal(db.interactions.length, 1);
    assert.equal(db.tasks[0]?.['status'], 'approved', 'the write that failed is the one under test');

    // Two days later: the cooldown window has rolled past, the daily cap is
    // clear, and nothing about the task row has changed.
    const later = new Date('2026-08-06T07:10:00.000Z');
    db.fault = null;
    const second = await runSendQueue({ db: fakeDb(db), now: later, alerts: gate });

    assert.equal(second.sent, 0, 'a second copy of this message must never leave');
    assert.equal(db.interactions.length, 1, 'no second outbound row');
    assert.equal(
      db.tasks[0]?.['status'],
      'sent',
      'and the row is repaired to what actually happened, not marked skipped',
    );
  });

  it('sends the tenth task behind ten contacts in their cooldown', async () => {
    // Deferring does not move `send_after`, so a deferred task keeps its place
    // at the head of the queue. Selecting exactly ten rows and stopping meant
    // ten cooling-down contacts held every slot on every tick, for as long as
    // they kept cooling down, and the summary read as ordinary deferral while
    // the queue silently stopped moving.
    const contacts: Row[] = [];
    const tasks: Row[] = [];
    const interactions: Row[] = [];
    for (let index = 0; index < MAX_TASKS_PER_TICK; index += 1) {
      const contactId = `cool-${index}`;
      contacts.push(contactRow(contactId));
      tasks.push(
        taskRow(`t-cool-${index}`, contactId, {
          send_after: `2026-08-04T00:0${index}:00.000Z`,
        }),
      );
      // Emailed an hour ago: inside the 48-hour window, so each one defers.
      interactions.push(outboundRow(contactId, `earlier-${index}`, '2026-08-04T05:10:00.000Z'));
    }
    contacts.push(contactRow('clean'));
    tasks.push(taskRow('t-clean', 'clean', { send_after: '2026-08-04T06:00:00.000Z' }));

    const db = state({ contacts, tasks, interactions });
    const summary = await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    assert.equal(summary.deferred, MAX_TASKS_PER_TICK);
    assert.equal(summary.sent, 1, 'the sendable task behind them must still go');
    const clean = db.tasks.find((row) => row['id'] === 't-clean');
    assert.equal(clean?.['status'], 'sent');
  });

  it('never hands Gmail more than the per-tick ceiling, however long the queue is', async () => {
    const contacts: Row[] = [];
    const tasks: Row[] = [];
    for (let index = 0; index < MAX_TASKS_PER_TICK + 5; index += 1) {
      contacts.push(contactRow(`c${index}`));
      tasks.push(
        taskRow(`t${index}`, `c${index}`, {
          send_after: `2026-08-04T05:${String(index).padStart(2, '0')}:00.000Z`,
        }),
      );
    }

    const db = state({ contacts, tasks });
    const summary = await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    assert.equal(summary.sent, MAX_TASKS_PER_TICK);
    assert.equal(summary.attempted, MAX_TASKS_PER_TICK);
    assert.equal(db.interactions.length, MAX_TASKS_PER_TICK);
  });

  it('files one alert card for a terminal refusal it cannot resolve, not one a minute', async () => {
    // The contact was deleted, so the refusal is `contact_missing` — terminal,
    // and the task is marked skipped. When that write also fails the task stays
    // approved and is refused again on the next tick, and the next. Ungated,
    // that is one card every sixty seconds: 1,440 a day, burying every real
    // card in the operator's queue.
    const db = state({
      contacts: [],
      tasks: [taskRow('t1', 'missing-contact')],
      fault: { table: 'tasks', op: 'update', message: 'connection terminated' },
    });

    for (let tick = 0; tick < 5; tick += 1) {
      await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });
    }

    assert.equal(alertCards(db).length, 1, 'five ticks, one card');
    assert.equal(db.interactions.length, 0, 'and nothing was sent');
  });

  it('defers everything and files one card when a footer variable is missing', async () => {
    // Non-negotiable under dry run too: an EU commercial message with no
    // physical address is not a message this system may send. But the morning's
    // approvals must survive a one-line fix, so nothing is resolved.
    delete process.env['BUSINESS_ADDRESS'];

    const db = state({ contacts: [contactRow('c1')], tasks: [taskRow('t1', 'c1')] });

    const first = await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });
    await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    assert.equal(first.sent, 0);
    assert.equal(first.deferred, 1);
    assert.equal(db.tasks[0]?.['status'], 'approved', 'the approval is not thrown away');
    assert.equal(db.interactions.length, 0);
    assert.equal(alertCards(db).length, 1, 'two ticks, one card');
    assert.match(String(alertCards(db)[0]?.['reasoning']), /BUSINESS_ADDRESS/);
  });

  it('sends nothing and says so when the kill switch cannot be read', async () => {
    // A hand-edited `settings.kill_switch` that is not a boolean throws out of
    // the settings reader. Failing closed is right; failing closed in silence is
    // not — sending stops completely and the only screen the operator looks at
    // has nothing on it.
    const db = state({
      contacts: [contactRow('c1')],
      tasks: [taskRow('t1', 'c1')],
      settings: [
        { key: 'kill_switch', value: 'yes' },
        ...SETTINGS_ROWS.slice(1).map((row) => ({ ...row })),
      ],
    });

    await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });
    await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    assert.equal(db.interactions.length, 0);
    assert.equal(db.tasks[0]?.['status'], 'approved');
    assert.equal(alertCards(db).length, 1, 'two ticks, one card');
    assert.match(String(alertCards(db)[0]?.['title']), /kill switch/i);
  });

  it('sends nothing at all while the kill switch is on', async () => {
    const db = state({
      contacts: [contactRow('c1')],
      tasks: [taskRow('t1', 'c1')],
      settings: [
        { key: 'kill_switch', value: true },
        ...SETTINGS_ROWS.slice(1).map((row) => ({ ...row })),
      ],
    });

    const summary = await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    assert.equal(summary.claimed, 0, 'the switch is checked before anything is selected');
    assert.equal(db.interactions.length, 0);
    assert.equal(db.tasks[0]?.['status'], 'approved');
  });

  it('resolves an opted-out contact rather than retrying it every minute', async () => {
    const db = state({
      contacts: [contactRow('c1', { do_not_contact: true })],
      tasks: [taskRow('t1', 'c1')],
    });

    const summary = await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    assert.equal(summary.sent, 0);
    assert.equal(summary.refused, 1);
    assert.equal(db.interactions.length, 0, 'an opt-out is checked at send time, every time');
    const task = db.tasks.find((row) => row['id'] === 't1');
    assert.equal(task?.['status'], 'skipped', 'skipped, never rejected — step 9 reads rejected');
    assert.equal(alertCards(db).length, 1);
  });

  it('sends an inbox reply into the thread it is answering', async () => {
    // Both fields were hard-coded to null here until this test existed, so every
    // approved reply left as a brand new message: `Re: …` in the subject, no
    // In-Reply-To, its own thread. Two costs, and the second is the expensive
    // one. The recipient sees two unrelated conversations for one exchange. And
    // `recordSend` files the outbound row under the NEW thread id, so when they
    // write back `loadThread` shows the drafter our own reply and not their
    // original question — in a prompt built entirely on being shown the whole
    // conversation.
    //
    // `tasks` has no thread column and this pass may not add one. It does not
    // need one: `inbox.ts` writes `task_id` into the inbound interaction's meta
    // in the same step that files the task, next to the thread id and the RFC
    // Message-ID. That row is the join.
    const db = state({
      contacts: [contactRow('c1')],
      tasks: [taskRow('t1', 'c1', { agent: 'inbox', title: 'Reply: Μαρία' })],
      interactions: [
        {
          id: 'inbound-1',
          contact_id: 'c1',
          direction: 'in',
          channel: 'email',
          subject: 'Ερώτηση',
          body: 'Πόσο κοστίζει;',
          occurred_at: '2026-08-03T18:00:00.000Z',
          meta: {
            gmail_message_id: 'g1',
            gmail_thread_id: 'THREAD-1',
            rfc_message_id: '<their-message@mail.gmail.com>',
            task_id: 't1',
          },
        },
      ],
    });

    const summary = await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    assert.equal(summary.sent, 1);
    const outbound = db.interactions.find((row) => row['direction'] === 'out');
    assert.equal((outbound?.['meta'] as Row)['gmail_thread_id'], 'THREAD-1');
  });

  it('sends a follow-up as a new thread, because it is not answering anything', async () => {
    // The empty result is the whole answer rather than a failure: no inbound row
    // carries this task id, so there is no conversation to join.
    const db = state({ contacts: [contactRow('c1')], tasks: [taskRow('t1', 'c1')] });

    await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    const outbound = db.interactions.find((row) => row['direction'] === 'out');
    assert.equal((outbound?.['meta'] as Row)['gmail_thread_id'], null);
    assert.equal(alertCards(db).length, 0, 'not finding a thread is not a problem to report');
  });

  it('does not take another task\'s thread', async () => {
    // The join is `meta->>task_id`, not the contact. Two conversations with the
    // same person must not braid into each other.
    const db = state({
      contacts: [contactRow('c1')],
      tasks: [taskRow('t1', 'c1')],
      interactions: [
        {
          id: 'inbound-other',
          contact_id: 'c1',
          direction: 'in',
          channel: 'email',
          subject: 'Κάτι άλλο',
          body: '...',
          occurred_at: '2026-08-01T18:00:00.000Z',
          meta: { gmail_thread_id: 'THREAD-OTHER', task_id: 't-other' },
        },
      ],
    });

    await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    const outbound = db.interactions.find((row) => row['direction'] === 'out');
    assert.equal((outbound?.['meta'] as Row)['gmail_thread_id'], null);
  });

  it('re-anchors the follow-up date on the send, not on the draft', async () => {
    // `followup.ts` writes `next_touch_at` at draft time using the interval
    // derived from the touches that had already happened, which is one step
    // behind the touch it is filing. Nothing re-computed it once the message
    // left, so chase 2 was drafted three days after chase 1 instead of seven —
    // and when the approval waited for the send window, the contact came due
    // before the first message had even gone out.
    const draftedFor = '2026-08-06T05:00:00.000Z';
    const db = state({
      contacts: [
        contactRow('c1', { stage: 'contacted', stage_changed_at: '2026-08-01T00:00:00.000Z', next_touch_at: draftedFor }),
      ],
      tasks: [taskRow('t1', 'c1')],
      interactions: [
        {
          id: 'outreach',
          contact_id: 'c1',
          direction: 'out',
          channel: 'email',
          subject: 'x',
          body: 'y',
          occurred_at: '2026-08-02T06:00:00.000Z',
          meta: { task_id: 't0' },
        },
      ],
    });

    await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    const next = String(db.contacts[0]?.['next_touch_at']);
    assert.notEqual(next, draftedFor, 'the date still belonged to the draft');
    assert.ok(new Date(next).getTime() > TICK_NOW.getTime(), 'the next touch is after the send');
    assert.equal(alertCards(db).length, 0);
  });

  it('does not pull the follow-up date in when it is already further out', async () => {
    // The contact wrote back and `inbox.ts` pushed them out, or the operator
    // moved them by hand. A send is not a reason to bring that closer.
    const far = '2026-12-01T06:00:00.000Z';
    const db = state({
      contacts: [
        contactRow('c1', { stage: 'contacted', stage_changed_at: '2026-08-01T00:00:00.000Z', next_touch_at: far }),
      ],
      tasks: [taskRow('t1', 'c1')],
    });

    await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    assert.equal(db.contacts[0]?.['next_touch_at'], far);
  });

  it('logs ids and counts and never a name, an address or a body', async () => {
    // The house rule, asserted rather than trusted: the send path is the one
    // place in the system where a recipient's address is in scope at the moment
    // something is written to a log.
    const db = state({
      contacts: [contactRow('c1')],
      tasks: [taskRow('t1', 'c1')],
    });

    await runSendQueue({ db: fakeDb(db), now: TICK_NOW, alerts: gate });

    const log = lines.join('\n');
    assert.ok(log.length > 0, 'a tick that did work logs');
    assert.ok(!log.includes('@example.gr'), 'no recipient address');
    assert.ok(!log.includes('Μαρία'), 'no contact name');
    assert.ok(!log.includes('Καλημέρα'), 'no message body');
    assert.ok(!log.includes('υπενθύμιση'), 'no subject line');
    assert.ok(log.includes('t1'), 'the task id is what makes a line useful');
  });
});
