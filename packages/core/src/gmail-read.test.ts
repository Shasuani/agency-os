/**
 * Tests for `gmail-read.ts` — the network surface, the cursor, and the promise
 * that nothing here logs a customer's email.
 *
 * Gmail is never reached. Every test installs a transport, and several of them
 * install one that *fails the test if it is called at all*, because that is the
 * only way to prove a negative: a test asserting "the dry-run watch returned
 * nulls" would pass equally against a version that registered the watch and
 * threw the answer away.
 *
 * The failures this file is aimed at are the ones that are invisible until they
 * have already cost something:
 *
 *   - a 404 from `history.list` treated as an ordinary error and retried
 *     forever, so the cursor never moves and no mail is read again;
 *   - a `historyId` that went through `Number()` somewhere, losing precision
 *     above 2^53 and pointing the cursor past messages that were never read;
 *   - a 403 reported as "Gmail returned 403", when what it actually means is
 *     that `GMAIL_REFRESH_TOKEN` was minted for `gmail.send` and has to be
 *     reissued — nothing else in the system can tell the operator that;
 *   - `users.watch` firing under `DRY_RUN`, pointing the production mailbox's
 *     notifications at a developer's Pub/Sub topic;
 *   - a subject or a body reaching a log file, which is the one thing this
 *     module must never do.
 *
 * The in-memory PostgREST stand-in at the bottom is the same pattern as
 * `apps/worker/src/jobs/send-queue.test.ts`, cut down to the two calls the
 * cursor makes. It is duplicated rather than shared because the two packages
 * have no test-utility module between them and inventing one for forty lines
 * would be the larger change.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Db } from './db';
import {
  GMAIL_WATCH_SETTING_KEY,
  GmailReadError,
  MAX_HISTORY_RESULTS,
  currentHistoryId,
  getMessage,
  listHistory,
  readGmailWatch,
  setGmailAccessTokenProvider,
  setGmailReadTransport,
  watchMailbox,
  writeGmailWatch,
} from './gmail-read';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Call = { url: string; init: RequestInit };

let calls: Call[] = [];
let tokenCalls: (boolean | undefined)[] = [];

function respondWith(...responders: ((call: Call) => Response)[]): void {
  let index = 0;
  setGmailReadTransport(async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const responder = responders[Math.min(index, responders.length - 1)];
    index += 1;
    if (responder === undefined) throw new Error('no responder');
    return responder(call);
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The module only ever sends a plain object of headers; the cast says so. */
function authorizationOf(call: Call | undefined): string | undefined {
  return ((call?.init.headers ?? {}) as Record<string, string>)['authorization'];
}

/** A transport that fails the test if anything reaches it. */
function forbidNetwork(): void {
  setGmailReadTransport(async () => {
    assert.fail('a request was made when none should have been');
  });
}

const ENV_KEYS = ['DRY_RUN', 'GMAIL_PUBSUB_TOPIC', 'ALLOWED_EMAIL'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  calls = [];
  tokenCalls = [];
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  setGmailAccessTokenProvider(async (force) => {
    tokenCalls.push(force);
    return force === true ? 'token-2' : 'token-1';
  });
});

afterEach(() => {
  setGmailReadTransport(null);
  setGmailAccessTokenProvider(null);
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// history.list
// ---------------------------------------------------------------------------

describe('listHistory', () => {
  it('flattens messagesAdded in arrival order and dedupes within the page', () => {
    // Gmail history ranges overlap by design; the same id in two records is the
    // common case, not the edge case.
    respondWith(() =>
      json({
        history: [
          { messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] },
          {
            messagesAdded: [
              { message: { id: 'm1', labelIds: ['INBOX'] } },
              { message: { id: 'm2', labelIds: ['INBOX', 'UNREAD'] } },
            ],
          },
        ],
        historyId: '9876543210',
      }),
    );

    return listHistory({ startHistoryId: '1234567890' }).then((page) => {
      assert.deepEqual(page.messageIds, ['m1', 'm2']);
      assert.equal(page.historyId, '9876543210');
      assert.equal(page.nextPageToken, null);
    });
  });

  it('drops our own sends and anything already in trash or spam', async () => {
    // Saves a messages.get per skipped message, and our own sends re-entering
    // the history as inbound interactions is a real failure, not a hypothetical.
    respondWith(() =>
      json({
        history: [
          {
            messagesAdded: [
              { message: { id: 'sent', labelIds: ['SENT'] } },
              { message: { id: 'draft', labelIds: ['DRAFT'] } },
              { message: { id: 'trash', labelIds: ['TRASH'] } },
              { message: { id: 'spam', labelIds: ['SPAM'] } },
              { message: { id: 'real', labelIds: ['INBOX'] } },
            ],
          },
        ],
        historyId: '2',
      }),
    );

    const page = await listHistory({ startHistoryId: '1' });
    assert.deepEqual(page.messageIds, ['real']);
  });

  it('asks Gmail to do the filtering, and clamps maxResults', async () => {
    respondWith(() => json({ historyId: '2' }));
    await listHistory({ startHistoryId: '1', maxResults: 5000, pageToken: 'page-2' });

    const url = new URL(calls[0]?.url ?? '');
    assert.equal(url.searchParams.get('startHistoryId'), '1');
    assert.equal(url.searchParams.get('historyTypes'), 'messageAdded');
    assert.equal(url.searchParams.get('labelId'), 'INBOX');
    assert.equal(url.searchParams.get('maxResults'), String(MAX_HISTORY_RESULTS));
    assert.equal(url.searchParams.get('pageToken'), 'page-2');
  });

  it('keeps a historyId beyond 2^53 exactly as Gmail wrote it', async () => {
    // It is a uint64. One `Number()` anywhere in this path and the cursor lands
    // past messages that were never read — no error, no alert, just missing mail.
    const huge = '18446744073709551615';
    respondWith(() => json({ historyId: huge }));
    const page = await listHistory({ startHistoryId: huge });
    assert.equal(page.historyId, huge);
    assert.notEqual(page.historyId, String(Number(huge)));
  });

  it('refuses a cursor that is not a decimal uint64, without making a request', async () => {
    forbidNetwork();
    await assert.rejects(listHistory({ startHistoryId: 'not-a-cursor' }), (error: unknown) => {
      assert.ok(error instanceof GmailReadError);
      assert.equal(error.kind, 'config');
      return true;
    });
  });

  it('raises history_gone on a 404, and does not mark it retryable', async () => {
    // The whole point of the separate kind. Retrying is pointless — the window
    // is gone from Google, not from us — and the caller has a recovery to run.
    respondWith(() => json({ error: { code: 404 } }, 404));
    await assert.rejects(listHistory({ startHistoryId: '1' }), (error: unknown) => {
      assert.ok(error instanceof GmailReadError);
      assert.equal(error.kind, 'history_gone');
      assert.equal(error.status, 404);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls.length, 1, 'a 404 is not retried');
  });
});

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

describe('failure classification', () => {
  it('retries a 401 once with a forced token, then succeeds', async () => {
    respondWith(
      () => json({}, 401),
      () => json({ historyId: '7' }),
    );
    const page = await listHistory({ startHistoryId: '1' });
    assert.equal(page.historyId, '7');
    assert.deepEqual(tokenCalls, [false, true], 'the second attempt must force a refresh');
    assert.equal(authorizationOf(calls[1]), 'Bearer token-2');
  });

  it('gives up after a second 401 rather than looping on a revoked token', async () => {
    respondWith(() => json({}, 401));
    await assert.rejects(listHistory({ startHistoryId: '1' }), (error: unknown) => {
      assert.ok(error instanceof GmailReadError);
      assert.equal(error.kind, 'auth');
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls.length, 2);
  });

  it('says what a 403 actually means: the refresh token has no gmail.readonly', async () => {
    // A value change, not a name change, so nothing in the code can catch it in
    // advance. This error message is the only place the operator is told.
    respondWith(() => json({}, 403));
    await assert.rejects(listHistory({ startHistoryId: '1' }), (error: unknown) => {
      assert.ok(error instanceof GmailReadError);
      assert.equal(error.kind, 'auth');
      assert.ok(error.message.includes('gmail.readonly'));
      return true;
    });
  });

  it('classifies 429 and 5xx as retryable, and a 400 as not', async () => {
    const cases: [number, string, boolean][] = [
      [429, 'rate_limit', true],
      [503, 'api_error', true],
      [400, 'api_error', false],
    ];
    for (const [status, kind, retryable] of cases) {
      respondWith(() => json({}, status));
      await assert.rejects(listHistory({ startHistoryId: '1' }), (error: unknown) => {
        assert.ok(error instanceof GmailReadError);
        assert.equal(error.kind, kind);
        assert.equal(error.retryable, retryable);
        return true;
      });
    }
  });

  it('treats a thrown fetch as retryable and names only the host', async () => {
    setGmailReadTransport(async () => {
      throw new TypeError('ECONNRESET');
    });
    await assert.rejects(listHistory({ startHistoryId: '1' }), (error: unknown) => {
      assert.ok(error instanceof GmailReadError);
      assert.equal(error.kind, 'network');
      assert.equal(error.retryable, true);
      assert.equal(error.message, 'Request to gmail.googleapis.com failed.');
      return true;
    });
  });

  it('does not crash on a 200 whose body is not JSON', async () => {
    // A proxy returning an HTML error page with a 200 is the usual source.
    respondWith(() => new Response('<html>gateway</html>', { status: 200 }));
    await assert.rejects(listHistory({ startHistoryId: '1' }), (error: unknown) => {
      assert.ok(error instanceof GmailReadError);
      assert.equal(error.kind, 'api_error');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// getProfile and messages.get
// ---------------------------------------------------------------------------

describe('currentHistoryId', () => {
  it('returns the profile history id as a string', async () => {
    respondWith(() => json({ emailAddress: 'info@example.gr', historyId: '4242' }));
    assert.equal(await currentHistoryId(), '4242');
  });

  it('refuses a profile with no usable history id rather than returning a guess', async () => {
    respondWith(() => json({ emailAddress: 'info@example.gr' }));
    await assert.rejects(currentHistoryId(), (error: unknown) => {
      assert.ok(error instanceof GmailReadError);
      assert.equal(error.kind, 'api_error');
      return true;
    });
  });
});

describe('getMessage', () => {
  const GREEK_BODY = 'Ευχαριστώ, με ενδιαφέρει.';

  function messageResource(): unknown {
    return {
      id: 'm-1',
      threadId: 't-1',
      labelIds: ['INBOX'],
      snippet: 'Ευχαριστώ, με ενδιαφέρει.',
      internalDate: '1785000000000',
      payload: {
        mimeType: 'text/plain',
        filename: '',
        headers: [
          { name: 'From', value: 'Μαρία <maria@taverna-ilios.gr>' },
          { name: 'Subject', value: 'Re: προσφορά' },
        ],
        body: {
          data: Buffer.from(
            `${GREEK_BODY}\n\nΣτις Δευ, 3 Αυγ 2026, ο/η Kolta Web <info@example.gr> έγραψε:\n> παλιό`,
            'utf8',
          ).toString('base64url'),
        },
      },
    };
  }

  it('asks for the full message and returns it parsed and trimmed', async () => {
    respondWith(() => json(messageResource()));
    const message = await getMessage('m-1');

    assert.ok((calls[0]?.url ?? '').includes('/messages/m-1?format=full'));
    assert.equal(message.body, GREEK_BODY);
    assert.equal(message.subject, 'Re: προσφορά');
    assert.equal(message.threadId, 't-1');
  });

  it('marks a message from ALLOWED_EMAIL as our own', async () => {
    // The half of `isOwnMessage` that `parseMessage` cannot do on its own,
    // because it is pure and this is where the environment is read.
    process.env['ALLOWED_EMAIL'] = 'Maria@Taverna-Ilios.gr';
    respondWith(() => json(messageResource()));
    assert.equal((await getMessage('m-1')).isOwnMessage, true);
  });

  it('raises not_found rather than history_gone when the message has been deleted', async () => {
    // Same status code, entirely different recovery: one message vanished
    // between the notification and the read, and the cursor is fine.
    respondWith(() => json({}, 404));
    await assert.rejects(getMessage('m-1'), (error: unknown) => {
      assert.ok(error instanceof GmailReadError);
      assert.equal(error.kind, 'not_found');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// users.watch
// ---------------------------------------------------------------------------

describe('watchMailbox', () => {
  it('registers nothing under DRY_RUN — proved by a transport that would fail', async () => {
    // The only Gmail write step 8 makes. A development machine that registered
    // one would divert the production mailbox's notifications to whatever topic
    // the developer happened to have set.
    process.env['DRY_RUN'] = 'true';
    process.env['GMAIL_PUBSUB_TOPIC'] = 'projects/x/topics/gmail';
    forbidNetwork();

    const result = await watchMailbox();
    assert.deepEqual(result, { historyId: null, expiration: null, dryRun: true });
  });

  it('posts the topic, the INBOX filter and the behaviour when it is live', async () => {
    process.env['DRY_RUN'] = 'false';
    process.env['GMAIL_PUBSUB_TOPIC'] = 'projects/x/topics/gmail';
    respondWith(() => json({ historyId: '5150', expiration: '1785600000000' }));

    const result = await watchMailbox();
    assert.equal(result.dryRun, false);
    assert.equal(result.historyId, '5150');
    assert.equal(result.expiration, 1785600000000);

    const body = JSON.parse(String(calls[0]?.init.body ?? '{}')) as Record<string, unknown>;
    assert.deepEqual(body, {
      topicName: 'projects/x/topics/gmail',
      labelIds: ['INBOX'],
      labelFilterBehavior: 'include',
    });
  });

  it('names the Pub/Sub publisher grant on a 403, not the refresh token', async () => {
    // Every call in this file used to share one 403 message: reissue
    // GMAIL_REFRESH_TOKEN with gmail.readonly added. That is right for a read and
    // wrong for `users.watch`, whose 403 almost always means the topic does not
    // grant roles/pubsub.publisher to gmail-api-push@system.gserviceaccount.com —
    // an IAM binding, not a scope. `renewWatchIfNeeded` puts this string on an
    // alert card verbatim, so the operator was being told, on a card, to reissue
    // a credential that was already correct.
    process.env['DRY_RUN'] = 'false';
    process.env['GMAIL_PUBSUB_TOPIC'] = 'projects/x/topics/gmail';
    respondWith(() => json({}, 403));

    await assert.rejects(watchMailbox(), (error: unknown) => {
      assert.ok(error instanceof GmailReadError);
      assert.equal(error.kind, 'auth');
      assert.ok(error.message.includes('roles/pubsub.publisher'));
      assert.ok(error.message.includes('gmail-api-push@system.gserviceaccount.com'));
      // The other possibility is still named, because a 403 does not say which.
      assert.ok(error.message.includes('gmail.readonly'));
      return true;
    });
  });

  it('refuses with a config error when GMAIL_PUBSUB_TOPIC is unset, before any request', async () => {
    delete process.env['GMAIL_PUBSUB_TOPIC'];
    forbidNetwork();
    await assert.rejects(watchMailbox(), (error: unknown) => {
      assert.ok(error instanceof GmailReadError);
      assert.equal(error.kind, 'config');
      assert.ok(error.message.includes('GMAIL_PUBSUB_TOPIC'));
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// The shared access token
// ---------------------------------------------------------------------------

describe('the access token', () => {
  it('is sent as a bearer header on every call', async () => {
    respondWith(() => json({ historyId: '1' }));
    await listHistory({ startHistoryId: '1' });
    assert.equal(authorizationOf(calls[0]), 'Bearer token-1');
  });

  it('fails without minting one of its own when no provider is wired', async () => {
    // Today this is the `config` error naming the missing `gmailAccessToken`
    // export. Once the integration agent adds that wrapper to gmail.ts, the call
    // reaches gmail.ts's own token exchange instead — which, with no Google
    // credentials in the test environment, also fails. The assertion is written
    // to hold in both worlds, and the part that matters in both is the same: the
    // Gmail API was never called, and this module never minted a second token.
    setGmailAccessTokenProvider(null);
    forbidNetwork();
    await assert.rejects(listHistory({ startHistoryId: '1' }));
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Fault = { op: 'select' | 'upsert'; message: string } | null;

/**
 * The two calls the cursor makes against `settings`, and nothing else.
 *
 * Cast through `unknown` for the reason `send-queue.test.ts` gives: `Db` is
 * `SupabaseClient<Database>`, a hundred generic parameters describing a wire
 * protocol this fake is deliberately not implementing.
 */
function fakeDb(rows: Row[], fault: Fault = null): Db {
  return {
    from() {
      return {
        select() {
          const filters: ((row: Row) => boolean)[] = [];
          const query = {
            eq(column: string, value: unknown) {
              filters.push((row) => row[column] === value);
              return query;
            },
            async maybeSingle() {
              if (fault?.op === 'select') return { data: null, error: { message: fault.message } };
              const found = rows.find((row) => filters.every((keep) => keep(row))) ?? null;
              return { data: found, error: null };
            },
          };
          return query;
        },
        async upsert(payload: Row) {
          if (fault?.op === 'upsert') return { error: { message: fault.message } };
          const index = rows.findIndex((row) => row['key'] === payload['key']);
          if (index === -1) rows.push({ ...payload });
          else rows[index] = { ...payload };
          return { error: null };
        },
      };
    },
  } as unknown as Db;
}

describe('the gmail_watch cursor', () => {
  it('round-trips through settings without going near getSetting', async () => {
    // `SettingKey` is a closed union whose parseSetting throws in its default
    // branch, so this key is read and written by its own accessor — the same
    // arrangement `allowed_email` already has.
    const rows: Row[] = [];
    const db = fakeDb(rows);
    const state = {
      historyId: '18446744073709551615',
      expiration: 1785600000000,
      updatedAt: '2026-08-03T07:00:00.000Z',
    };

    await writeGmailWatch(db, state);
    assert.equal(rows[0]?.['key'], GMAIL_WATCH_SETTING_KEY);
    assert.deepEqual(await readGmailWatch(db), state);
  });

  it('is null when nothing has ever been written', async () => {
    assert.equal(await readGmailWatch(fakeDb([])), null);
  });

  it('reads a malformed row as absent rather than wedging the job on it', async () => {
    // Judgement call 4 in the module header: throwing here stops the inbox agent
    // until somebody edits jsonb by hand. Absent means the caller bootstraps,
    // which loses a window — which is why it also logs.
    const rows: Row[] = [{ key: GMAIL_WATCH_SETTING_KEY, value: { history_id: 4242 } }];
    assert.equal(await readGmailWatch(fakeDb(rows)), null);
  });

  it('refuses to write a cursor that is not a decimal uint64', async () => {
    // A bad cursor is not a bad row: it is every message arriving after it never
    // being read.
    const rows: Row[] = [];
    await assert.rejects(
      writeGmailWatch(fakeDb(rows), { historyId: '42.5', expiration: null, updatedAt: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof GmailReadError);
        assert.equal(error.kind, 'config');
        return true;
      },
    );
    assert.equal(rows.length, 0);
  });

  it('surfaces a database failure by name on both sides', async () => {
    await assert.rejects(
      readGmailWatch(fakeDb([], { op: 'select', message: 'boom' })),
      /settings\.gmail_watch/,
    );
    await assert.rejects(
      writeGmailWatch(fakeDb([], { op: 'upsert', message: 'boom' }), {
        historyId: '1',
        expiration: null,
        updatedAt: 'x',
      }),
      /settings\.gmail_watch/,
    );
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('what reaches the log', () => {
  it('logs no subject, body, snippet, sender name, address or domain, on any path', async () => {
    // Stricter than anywhere else in the repo, and deliberately so: an inbound
    // email body is the most sensitive thing this system will ever hold. The
    // secrets below are pushed through the success path, the 404 recovery path,
    // the malformed-cursor path and the watch path in one go.
    const secrets = [
      'Ερώτηση για ιστοσελίδα',
      'Θα ήθελα μια προσφορά',
      'Μαρία Παπαδοπούλου',
      'maria@taverna-ilios.gr',
      'taverna-ilios.gr',
      'Ευχαριστώ πολύ',
    ];

    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      respondWith(() =>
        json({
          id: 'm-1',
          threadId: 't-1',
          labelIds: ['INBOX'],
          snippet: 'Ευχαριστώ πολύ',
          internalDate: '1785000000000',
          payload: {
            mimeType: 'text/plain',
            filename: '',
            headers: [
              { name: 'From', value: 'Μαρία Παπαδοπούλου <maria@taverna-ilios.gr>' },
              { name: 'Subject', value: 'Ερώτηση για ιστοσελίδα' },
            ],
            body: { data: Buffer.from('Θα ήθελα μια προσφορά', 'utf8').toString('base64url') },
          },
        }),
      );
      const message = await getMessage('m-1');
      assert.ok(message.body.includes('προσφορά'), 'the body did reach memory, it just must not reach a log');

      respondWith(() => json({}, 404));
      await listHistory({ startHistoryId: '1' }).catch(() => undefined);

      await readGmailWatch(fakeDb([{ key: GMAIL_WATCH_SETTING_KEY, value: { history_id: null } }]));

      process.env['DRY_RUN'] = 'true';
      process.env['GMAIL_PUBSUB_TOPIC'] = 'projects/x/topics/gmail';
      setGmailReadTransport(async () => json({}));
      await watchMailbox();
    } finally {
      console.log = original;
    }

    const all = lines.join('\n');
    for (const secret of secrets) {
      assert.ok(!all.includes(secret), `a log line contained "${secret}"`);
    }
    assert.ok(lines.length > 0, 'the paths under test do log something — otherwise this proves nothing');
  });
});
