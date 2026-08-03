/**
 * The follow-up agent's two selection queries, against an in-memory PostgREST.
 *
 * Both of them decide who gets an email tomorrow morning, both of them are
 * written as chained PostgREST calls that no typecheck can be wrong about, and
 * both of them have already been wrong in a way that produced no error at all:
 *
 *   - `loadContactsWithOpenDraft` filtered on `status = 'pending'` and
 *     `agent = 'followup'`, so an approved draft waiting for its send window —
 *     which the seeded window can put five days out — made the contact invisible
 *     to the guard, and the next morning wrote them a second email.
 *   - `selectDueContacts` had no email filter, so a contact with a phone number
 *     and no address stayed due forever, stayed at the head of an oldest-first
 *     ordering forever, and sixty of them stopped the agent drafting for
 *     anybody.
 *
 * Neither is provable from `followup-select.ts`, because neither is in it. The
 * fake below applies the filters it is given to plain arrays and does nothing
 * else — a fake cleverer than PostgREST would be proving things about itself.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Db } from '@agency/core';

import { loadContactsWithOpenDraft, selectDueContacts } from './followup.js';
import { MAX_CONTACTS_PER_RUN, SELECTION_GRACE_MS } from './followup-select.js';

const NOW = new Date('2026-08-05T05:00:00.000Z');

type Row = Record<string, unknown>;

/** Only the operators these two queries actually use. */
class FakeQuery implements PromiseLike<{ data: Row[]; error: { message: string } | null }> {
  readonly #rows: Row[];
  readonly #filters: ((row: Row) => boolean)[] = [];
  #limit: number | null = null;
  #order: { column: string; ascending: boolean } | null = null;

  constructor(rows: Row[]) {
    this.#rows = rows;
  }

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.#filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.#filters.push((row) => values.includes(row[column]));
    return this;
  }

  not(column: string, _op: 'is', value: unknown): this {
    this.#filters.push((row) => (row[column] ?? null) !== value);
    return this;
  }

  /** `%` is the only wildcard these queries use, and only as `%@%`. */
  like(column: string, pattern: string): this {
    const inner = pattern.replace(/^%|%$/g, '');
    this.#filters.push((row) => typeof row[column] === 'string' && (row[column] as string).includes(inner));
    return this;
  }

  lte(column: string, value: string): this {
    this.#filters.push((row) => {
      const at = row[column];
      return typeof at === 'string' && at <= value;
    });
    return this;
  }

  /** `a.is.null,b.is.false` — the two disjunctions the due query is built from. */
  or(expression: string): this {
    const clauses = expression.split(',').map((clause) => clause.split('.'));
    this.#filters.push((row) =>
      clauses.some(([column, op, literal]) => {
        const value = row[column ?? ''] ?? null;
        if (op === 'is') return literal === 'null' ? value === null : value === (literal === 'true');
        if (op === 'neq') return value !== null && value !== literal;
        throw new Error(`the fake does not implement or(${op ?? ''})`);
      }),
    );
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.#order = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(count: number): this {
    this.#limit = count;
    return this;
  }

  #result(): { data: Row[]; error: null } {
    let rows = this.#rows.filter((row) => this.#filters.every((f) => f(row)));
    const order = this.#order;
    if (order !== null) {
      rows = [...rows].sort((a, b) => {
        const left = String(a[order.column] ?? '');
        const right = String(b[order.column] ?? '');
        if (left === right) return 0;
        return (left < right ? -1 : 1) * (order.ascending ? 1 : -1);
      });
    }
    if (this.#limit !== null) rows = rows.slice(0, this.#limit);
    return { data: rows, error: null };
  }

  then<A, B>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.#result()).then(onfulfilled, onrejected);
  }
}

function fakeDb(tables: { contacts?: Row[]; tasks?: Row[] }): Db {
  return {
    from(table: string) {
      const rows = table === 'contacts' ? (tables.contacts ?? []) : (tables.tasks ?? []);
      return new FakeQuery(rows);
    },
  } as unknown as Db;
}

function contact(id: string, over: Row = {}): Row {
  return {
    id,
    email: `${id}@example.gr`,
    stage: 'contacted',
    do_not_contact: false,
    next_touch_at: '2026-08-05T05:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// selectDueContacts
// ---------------------------------------------------------------------------

describe('selectDueContacts', () => {
  it('leaves a contact with no email address out of the run entirely', async () => {
    // The failure this closes: `screenContact` deliberately does NOT push the
    // date of an addressless contact, because the date is their reminder at the
    // top of /pipeline on the morning they are due. That is right, and it means
    // the row is due forever — so if the query returns them they are also at the
    // head of an oldest-first ordering forever. Sixty of them (an NFC card with a
    // name and a phone number is the commonest contact in this pipeline) fill
    // MAX_CONTACTS_PER_RUN permanently, every one is screened out, and the agent
    // drafts nothing for anybody, every morning, with a log line as the only
    // symptom.
    const db = fakeDb({
      contacts: [
        contact('nfc', { email: null, next_touch_at: '2020-01-01T00:00:00.000Z' }),
        contact('blank', { email: '   ', next_touch_at: '2020-01-02T00:00:00.000Z' }),
        contact('phone-in-the-wrong-box', {
          email: '+30 210 1234567',
          next_touch_at: '2020-01-03T00:00:00.000Z',
        }),
        contact('reachable'),
      ],
    });

    const due = await selectDueContacts(db, NOW);

    assert.deepEqual(
      due.map((row) => row.id),
      ['reachable'],
    );
  });

  it('keeps a contact whose stage or do_not_contact is NULL', async () => {
    // PostgREST three-valued logic: a plain .neq('stage','lost') drops every row
    // whose stage was never set, silently. The `or` form is what stops that, and
    // `screenContact` is what decides those rows are a data problem worth an
    // alert rather than a contact to forget.
    const db = fakeDb({
      contacts: [
        contact('no-stage', { stage: null }),
        contact('no-flag', { do_not_contact: null }),
        contact('lost', { stage: 'lost' }),
        contact('opted-out', { do_not_contact: true }),
      ],
    });

    const due = await selectDueContacts(db, NOW);

    assert.deepEqual(
      due.map((row) => row.id).sort(),
      ['no-flag', 'no-stage'],
    );
  });

  it('serves the most overdue first and never more than the per-run ceiling', async () => {
    const contacts = Array.from({ length: MAX_CONTACTS_PER_RUN + 5 }, (_, index) =>
      contact(`c${String(index).padStart(3, '0')}`, {
        next_touch_at: `2026-0${index < 9 ? '1' : '2'}-${String((index % 28) + 1).padStart(2, '0')}T05:00:00.000Z`,
      }),
    );

    const due = await selectDueContacts(fakeDb({ contacts }), NOW);

    assert.equal(due.length, MAX_CONTACTS_PER_RUN);
    const dates = due.map((row) => String(row.next_touch_at));
    assert.deepEqual(dates, [...dates].sort());
  });

  it('includes a contact due within the grace window', async () => {
    // `next_touch_at` is written at exactly 08:00 local and the cron fires at
    // exactly 08:00 local. A few seconds of timer drift the wrong way would miss
    // the whole day's queue.
    const justAfter = new Date(NOW.getTime() + SELECTION_GRACE_MS - 1000).toISOString();
    const wellAfter = new Date(NOW.getTime() + SELECTION_GRACE_MS + 60_000).toISOString();

    const due = await selectDueContacts(
      fakeDb({
        contacts: [contact('inside', { next_touch_at: justAfter }), contact('outside', { next_touch_at: wellAfter })],
      }),
      NOW,
    );

    assert.deepEqual(
      due.map((row) => row.id),
      ['inside'],
    );
  });
});

// ---------------------------------------------------------------------------
// loadContactsWithOpenDraft
// ---------------------------------------------------------------------------

describe('loadContactsWithOpenDraft', () => {
  it('counts an approved draft, not only a pending one', async () => {
    // The two-emails-in-a-week bug. `approveTask` moves the row to `approved`
    // and writes `send_after`, which the seeded Tue–Thu window can put five days
    // out. Meanwhile the draft branch already moved `next_touch_at` to draft time
    // plus the cadence interval. The contact comes due again while the first
    // message is still sitting in the send queue, and nothing errors.
    const db = fakeDb({
      tasks: [{ contact_id: 'c1', type: 'draft_email', status: 'approved', agent: 'followup' }],
    });

    assert.deepEqual([...(await loadContactsWithOpenDraft(db, ['c1']))], ['c1']);
  });

  it('counts a pending reply from the inbox agent as well as a follow-up', async () => {
    // An inbox reply waiting for approval is an email to this contact that has
    // not gone out. Drafting a cold nudge on top of it is exactly the
    // "mid-conversation" failure `pushNextTouch` only mitigates, with a
    // three-day floor — so a reply card left unapproved for four days used to
    // produce it.
    const db = fakeDb({
      tasks: [{ contact_id: 'c1', type: 'draft_email', status: 'pending', agent: 'inbox' }],
    });

    assert.deepEqual([...(await loadContactsWithOpenDraft(db, ['c1']))], ['c1']);
  });

  it('does not hold a contact back for a resolved task', async () => {
    // `sent` is covered by the 48-hour cooldown and `last_touch_at`; `rejected`
    // and `skipped` are the operator deciding against the message. None of them
    // is an email in flight.
    const db = fakeDb({
      tasks: [
        { contact_id: 'c1', type: 'draft_email', status: 'sent', agent: 'followup' },
        { contact_id: 'c2', type: 'draft_email', status: 'rejected', agent: 'followup' },
        { contact_id: 'c3', type: 'draft_email', status: 'skipped', agent: 'inbox' },
      ],
    });

    assert.deepEqual([...(await loadContactsWithOpenDraft(db, ['c1', 'c2', 'c3']))], []);
  });

  it('ignores a task type that is not an email', async () => {
    // An alert card about a contact is not a message waiting to go to them, and
    // treating it as one would stop the agent ever writing to somebody whose row
    // has a problem.
    const db = fakeDb({
      tasks: [{ contact_id: 'c1', type: 'alert', status: 'pending', agent: 'followup' }],
    });

    assert.deepEqual([...(await loadContactsWithOpenDraft(db, ['c1']))], []);
  });

  it('asks nothing of the database for an empty id list', async () => {
    const db = {
      from() {
        throw new Error('the guard queried the database for no contacts');
      },
    } as unknown as Db;

    assert.deepEqual([...(await loadContactsWithOpenDraft(db, []))], []);
  });
});
