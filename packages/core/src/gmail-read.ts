/**
 * The only way a message enters this system.
 *
 * Gmail over REST with `fetch`, against four endpoints and nothing else:
 * `users.history.list` to learn what arrived, `users.messages.get` to read one,
 * `users.getProfile` to bootstrap or recover the cursor, and `users.watch` to
 * register the Pub/Sub notification. `googleapis` is not in the lockfile and
 * step 8 may not add a dependency — the same small mercy `gmail.ts` records.
 *
 * This module is not on the `@agency/core` barrel and must not be put there, for
 * two reasons rather than one. It opens sockets, like `gmail.ts` and `llm.ts`.
 * And it is the module that holds a customer's inbound email in memory, which is
 * the most sensitive object this system will ever have: not a name and an
 * address, but whatever they chose to write to a business in confidence.
 * `apps/web` imports the barrel for `appTimezone`, so re-exporting this here
 * would put the inbound mail path inside the Next.js server bundle and make it
 * reachable from a Server Action by autocomplete.
 *
 * ---------------------------------------------------------------------------
 * What is never logged, in any path, including error paths
 * ---------------------------------------------------------------------------
 *
 * Stricter than anywhere else in the repo, and the strictness is the point.
 * Never: a subject, a body, a snippet, a display name, a sender address, or even
 * a sender's domain. Never an access token. Never a raw response body from
 * Google — its errors echo request parameters back, which is how a client secret
 * ends up in a log file.
 *
 * Logged: Gmail message and thread ids, history ids, HTTP status codes, counts,
 * and the watch expiry. `gmail.ts` and `send-queue.ts` already log
 * `gmail_message_id`, so this is consistent rather than a new exposure — an
 * opaque id is what makes a run traceable at all, and it says nothing about who
 * wrote or what they said.
 *
 * There are exactly four log call sites in this file — a lost history window, a
 * watch registration in each of its two modes, and a malformed cursor row — and
 * a test drives a Greek subject, body, display name and address through all four
 * paths and asserts that none of it appears. `gmail-mime.ts`, which is the file
 * that actually holds the body, has no `console` call at all.
 *
 * ---------------------------------------------------------------------------
 * The access token, and the one thing the integration agent must wire
 * ---------------------------------------------------------------------------
 *
 * `gmail.ts` already owns the OAuth refresh exchange, caches the access token at
 * module scope and guards concurrent refreshes with an in-flight promise — and
 * its comment says that guard exists for exactly this file: a webhook arriving
 * in parallel with a sweep tick would otherwise mint two tokens for the same
 * account within a millisecond, which Google rate-limits.
 *
 * So this module does **not** mint its own. It imports `gmailAccessToken` from
 * `gmail.ts` — a thin wrapper over that file's private `accessToken`, added
 * during integration for this one caller. There is one cache and one in-flight
 * guard in the process, which is the whole point; the version of this that
 * duplicated the refresh exchange would ship two of each and re-authenticate
 * twice per burst.
 *
 * `setGmailAccessTokenProvider` is the seam the tests use, and is also how a
 * caller could inject a token without going near the OAuth exchange at all.
 *
 * ---------------------------------------------------------------------------
 * DRY_RUN does not stub reads
 * ---------------------------------------------------------------------------
 *
 * The house rule stubs anything that leaves the machine in the sense of
 * *changing something out there*: a send, a push, a `users.watch` registration.
 * A read changes nothing. And a dry run with no messages in it cannot exercise
 * the MIME parser, the classifier prompt or the routing table, which is the
 * entire thing that needs looking at before this goes live. The only Gmail write
 * step 8 makes is `users.watch`, and that one is stubbed.
 *
 * ---------------------------------------------------------------------------
 * The 404 from history.list is a data-loss event, not an error to retry
 * ---------------------------------------------------------------------------
 *
 * Gmail keeps roughly a week of history and less on a busy mailbox. A
 * `startHistoryId` older than that returns 404, and it is the one status code in
 * this file with its own error kind (`history_gone`) because the caller must
 * treat it differently from every other failure: re-list the current history id,
 * store it, **process nothing**, and file one alert naming the window that was
 * lost. Retrying it is pointless — the window is gone from Google, not from us —
 * and walking the mailbox from the beginning would classify and draft replies to
 * hundreds of months-old messages and spend real money doing it. Losing the
 * window and saying so is the correct trade, and it is the same reasoning
 * `followup.ts` uses when it declines to draft rather than draft something
 * hollow.
 *
 * ---------------------------------------------------------------------------
 * Judgement calls the interface contract did not make
 * ---------------------------------------------------------------------------
 *
 * 1. **A 403 is an `auth` error whose message names the likely cause, and there
 *    are two of them.** On a read it is almost always the scope: the existing
 *    `GMAIL_REFRESH_TOKEN` was minted for `gmail.send` and every call in this
 *    file needs `gmail.readonly` as well. On `users.watch` it is almost always
 *    the Pub/Sub topic missing the `roles/pubsub.publisher` grant for
 *    `gmail-api-push@system.gserviceaccount.com` — an IAM binding, not a scope,
 *    and the single most likely first-run failure. Nothing in the code can tell
 *    which from the response, so `ForbiddenCause` picks the message by endpoint
 *    and each message names the other possibility as the fallback. This matters
 *    because `renewWatchIfNeeded` puts the string on an alert card verbatim.
 * 2. **`listHistory` drops ids whose history record already carries `SENT`,
 *    `DRAFT`, `TRASH` or `SPAM`.** The history entry includes the labels, so this
 *    costs nothing and saves a `messages.get` round trip per skipped message. Our
 *    own sends re-enter the history and must never become inbound interactions;
 *    `parseMessage`'s `isOwnMessage` is the second lock on that, not the first.
 * 3. **`historyId` is a string everywhere, and a non-digit one is refused.** It
 *    is a uint64. `Number()` on it starts losing precision above 2^53 and the
 *    loss shows up as a cursor that quietly skips mail — no error, no alert, just
 *    messages that were never read. Refusing a malformed value at the boundary is
 *    cheaper than finding that out from a customer.
 * 4. **A malformed `gmail_watch` row reads as absent and logs one line.** The
 *    alternative is throwing, which wedges the inbox job on a bad jsonb value
 *    until somebody edits the table by hand. Reading it as absent makes the
 *    caller bootstrap from the current history id, which loses a window — so the
 *    log line exists to make that visible rather than silent.
 */

import { isDryRun, optionalEnv, requireEnv } from './env';
import { gmailAccessToken } from './gmail';
import type { Db } from './db';
import type { GmailMessageResource, InboundMessage } from './gmail-mime';
import { parseMessage } from './gmail-mime';

export type {
  GmailAddress,
  GmailHeader,
  GmailMessageResource,
  GmailPayload,
  InboundMessage,
  ParseMessageOptions,
} from './gmail-mime';

export {
  MAX_BODY_CHARS,
  MAX_SUBJECT_CHARS,
  decodeBase64Url,
  decodeEncodedWords,
  detectOptOut,
  extractPlainText,
  guessLanguage,
  headerValue,
  parseAddress,
  parseAddressList,
  parseMessage,
  stripHtml,
  stripQuotedReply,
} from './gmail-mime';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Gmail's own ceiling for `history.list` is 500; 100 is a page this job can
 *  finish inside one tick without holding a burst of messages in memory. */
export const MAX_HISTORY_RESULTS = 100;

/** `settings.key` for the cursor. Not a `SettingKey`: see `readGmailWatch`. */
export const GMAIL_WATCH_SETTING_KEY = 'gmail_watch';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GmailReadErrorKind =
  /** An environment variable, or the shared token wrapper, is missing. */
  | 'config'
  /** 401 after a forced refresh, or a 403 — most likely a missing scope. */
  | 'auth'
  /** 429. */
  | 'rate_limit'
  /** 404 from history.list — the cursor is older than Gmail will serve. */
  | 'history_gone'
  /** 404 from anything else — the message was deleted between list and get. */
  | 'not_found'
  /** Any other non-2xx. */
  | 'api_error'
  /** `fetch` threw — DNS, TLS, a reset socket. */
  | 'network';

/**
 * Everything this module throws.
 *
 * `retryable` points the same direction as `gmail.ts`'s: a transient socket
 * failure is retryable, because treating it as terminal loses a real message,
 * and the cost of being wrong the other way is one more attempt on the next
 * tick. `history_gone` is deliberately **not** retryable — it has a recovery, and
 * retrying it forever is how a cursor stays stuck.
 */
export class GmailReadError extends Error {
  override readonly name = 'GmailReadError';
  readonly kind: GmailReadErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(kind: GmailReadErrorKind, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.status = options?.status;
    this.retryable = isRetryable(kind, options?.status);
  }
}

function isRetryable(kind: GmailReadErrorKind, status: number | undefined): boolean {
  if (kind === 'rate_limit' || kind === 'network') return true;
  if (kind === 'api_error') return status !== undefined && status >= 500;
  return false;
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * How this module reaches the network.
 *
 * It exists so the tests can install a transport that fails if it is called,
 * and thereby *prove* that the dry-run watch registers nothing — a test
 * asserting "the result had a null history id" proves considerably less, since
 * the same result comes back from a version that made the call and discarded it.
 */
export type GmailReadTransport = (url: string, init: RequestInit) => Promise<Response>;

let transport: GmailReadTransport | null = null;

/** Test seam. Pass `null` to restore the real `fetch`. */
export function setGmailReadTransport(next: GmailReadTransport | null): void {
  transport = next;
}

/** `(force?: boolean) => Promise<string>` — the shape `gmail.ts` exports. */
export type AccessTokenProvider = (force?: boolean) => Promise<string>;

let tokenProvider: AccessTokenProvider | null = null;

/** Test seam, and the escape hatch described in the header. */
export function setGmailAccessTokenProvider(next: AccessTokenProvider | null): void {
  tokenProvider = next;
}

/**
 * The shared access token from `gmail.ts`.
 *
 * The seam wins when one is installed, so a test can exercise every read path
 * without an OAuth client. Otherwise this is the send path's own cache — see the
 * header on why there must be exactly one of those in the process.
 */
async function accessToken(force = false): Promise<string> {
  if (tokenProvider !== null) return tokenProvider(force);
  return gmailAccessToken(force);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'gmail-read', ...fields }));
}

async function http(url: string, init: RequestInit): Promise<Response> {
  const send = transport ?? ((u: string, i: RequestInit) => fetch(u, i));
  try {
    return await send(url, init);
  } catch (cause) {
    // The message names the host and nothing else.
    throw new GmailReadError('network', `Request to ${new URL(url).host} failed.`, { cause });
  }
}

/**
 * Which 403 this endpoint can produce.
 *
 * Every Gmail call in this file used to share one 403 message: reissue
 * `GMAIL_REFRESH_TOKEN` with `gmail.readonly` added. That is right for a read,
 * and it is the commonest first-run failure — but `users.watch` goes through the
 * same function and its 403 usually means something else entirely: the topic in
 * `GMAIL_PUBSUB_TOPIC` does not grant `roles/pubsub.publisher` to
 * `gmail-api-push@system.gserviceaccount.com`. That is a Google Cloud IAM
 * binding, not a scope, and `renewWatchIfNeeded` puts this message verbatim on
 * an alert card — so the operator was being told, on a card, to reissue a
 * credential that was already correct, while the actual cause was named nowhere
 * in the repo.
 *
 * Both possibilities are named in each message rather than one being asserted,
 * because a 403 does not carry which it is and a confident wrong diagnosis is
 * what this is fixing.
 */
type ForbiddenCause = 'scope' | 'watch';

const FORBIDDEN_MESSAGE: Record<ForbiddenCause, string> = {
  scope:
    'Gmail returned 403 on a read. The usual cause is that GMAIL_REFRESH_TOKEN was minted for ' +
    'gmail.send only; it must be reissued with https://www.googleapis.com/auth/gmail.readonly ' +
    'added.',
  watch:
    'Gmail returned 403 on users.watch. The usual cause is not the token: the Pub/Sub topic in ' +
    'GMAIL_PUBSUB_TOPIC must grant roles/pubsub.publisher to ' +
    'gmail-api-push@system.gserviceaccount.com, and does not until you add it in the Google ' +
    'Cloud console. Check that first; if the binding is already there, the refresh token is ' +
    'missing https://www.googleapis.com/auth/gmail.readonly.',
};

/**
 * One authenticated Gmail call, with the single 401 retry `gmail.ts` also does.
 *
 * `notFound` decides what a 404 means, which is the only thing that varies
 * between the endpoints: on `history.list` it is a cursor Gmail will no longer
 * serve, and on `messages.get` it is a message somebody deleted in the seconds
 * between the notification and the read.
 */
async function gmailRequest(
  path: string,
  init: RequestInit,
  notFound: 'history_gone' | 'not_found',
  forbidden: ForbiddenCause = 'scope',
): Promise<unknown> {
  const url = `${GMAIL_API_BASE}${path}`;
  const call = (token: string): Promise<Response> =>
    http(url, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
    });

  let response = await call(await accessToken());
  if (response.status === 401) {
    response = await call(await accessToken(true));
    if (response.status === 401) {
      throw new GmailReadError(
        'auth',
        'Gmail rejected the access token twice. GMAIL_REFRESH_TOKEN needs to be reissued.',
        { status: 401 },
      );
    }
  }

  if (response.status === 403) {
    // See judgement call 1 in the header, and `ForbiddenCause` for why this one
    // message became two.
    throw new GmailReadError('auth', FORBIDDEN_MESSAGE[forbidden], { status: 403 });
  }
  if (response.status === 429) {
    throw new GmailReadError('rate_limit', 'Gmail rate-limited the read (429).', { status: 429 });
  }
  if (response.status === 404) {
    if (notFound === 'history_gone') {
      log({ event: 'history_gone', status: 404 });
      throw new GmailReadError(
        'history_gone',
        'Gmail no longer has history from this cursor (404). The mailbox must be re-anchored ' +
          'to the current history id and the intervening window reported, not walked.',
        { status: 404 },
      );
    }
    throw new GmailReadError('not_found', 'Gmail returned 404 for the message.', { status: 404 });
  }
  if (!response.ok) {
    throw new GmailReadError('api_error', `Gmail returned ${response.status}.`, { status: response.status });
  }

  try {
    return await response.json();
  } catch (cause) {
    // A 2xx whose body will not parse. Retryable: nothing was changed by a read,
    // so trying again on the next tick costs one request and risks nothing.
    throw new GmailReadError('api_error', 'Gmail returned a response body that would not parse.', {
      status: 502,
      cause,
    });
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type GmailHistoryPage = {
  /** Message ids added since the cursor, arrival order, deduped within the page. */
  messageIds: string[];
  /** The historyId to store once the whole batch is done. Null when Gmail sent none. */
  historyId: string | null;
  nextPageToken: string | null;
};

/** A history id is a uint64 written as digits. See judgement call 3. */
function isHistoryId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && value.length <= 24;
}

function readHistoryId(value: unknown): string | null {
  return isHistoryId(value) ? value : null;
}

/** Labels that mean "this is not inbound mail". See judgement call 2. */
const EXCLUDED_LABELS = new Set(['SENT', 'DRAFT', 'TRASH', 'SPAM']);

type HistoryResponse = {
  history?: { messagesAdded?: { message?: { id?: unknown; labelIds?: unknown } }[] }[];
  historyId?: unknown;
  nextPageToken?: unknown;
};

/**
 * What arrived since the cursor.
 *
 * `historyTypes=messageAdded` and `labelId=INBOX` are both filters Gmail applies
 * server-side, so a label change or a read receipt on an old message does not
 * come back as work. The page is deduped: Gmail history ranges overlap by design
 * and the same message id appears in two records more often than not.
 */
export async function listHistory(input: {
  startHistoryId: string;
  pageToken?: string | null;
  maxResults?: number;
}): Promise<GmailHistoryPage> {
  if (!isHistoryId(input.startHistoryId)) {
    throw new GmailReadError(
      'config',
      'listHistory was given a startHistoryId that is not a decimal uint64. ' +
        'A cursor that is not exactly what Gmail issued cannot be trusted to point anywhere.',
    );
  }

  const requested = input.maxResults ?? MAX_HISTORY_RESULTS;
  const maxResults = Math.min(Math.max(1, Math.trunc(requested)), MAX_HISTORY_RESULTS);

  const query = new URLSearchParams({
    startHistoryId: input.startHistoryId,
    historyTypes: 'messageAdded',
    labelId: 'INBOX',
    maxResults: String(maxResults),
  });
  if (typeof input.pageToken === 'string' && input.pageToken !== '') {
    query.set('pageToken', input.pageToken);
  }

  const payload = (await gmailRequest(`/history?${query.toString()}`, { method: 'GET' }, 'history_gone')) as
    | HistoryResponse
    | null;

  const seen = new Set<string>();
  const messageIds: string[] = [];

  for (const record of payload?.history ?? []) {
    for (const added of record?.messagesAdded ?? []) {
      const message = added?.message;
      const id = message?.id;
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue;

      const labels = Array.isArray(message?.labelIds) ? message.labelIds : [];
      if (labels.some((label) => typeof label === 'string' && EXCLUDED_LABELS.has(label))) continue;

      seen.add(id);
      messageIds.push(id);
    }
  }

  return {
    messageIds,
    historyId: readHistoryId(payload?.historyId),
    nextPageToken:
      typeof payload?.nextPageToken === 'string' && payload.nextPageToken !== ''
        ? payload.nextPageToken
        : null,
  };
}

/**
 * `users.getProfile` — the bootstrap and the 404 recovery.
 *
 * The only call that answers "where is the mailbox now", which is what both the
 * very first run and a lost cursor need.
 */
export async function currentHistoryId(): Promise<string> {
  const payload = (await gmailRequest('/profile', { method: 'GET' }, 'not_found')) as {
    historyId?: unknown;
  } | null;

  const historyId = readHistoryId(payload?.historyId);
  if (historyId === null) {
    throw new GmailReadError('api_error', 'users.getProfile returned no usable historyId.');
  }
  return historyId;
}

/**
 * One message, parsed.
 *
 * `format=full` rather than `metadata` because the body is the whole point, and
 * rather than `raw` because `raw` would mean writing a MIME parser for the
 * container as well as for the parts — Gmail has already done that work and does
 * it correctly for messages this parser would not survive.
 *
 * The operator's own address is supplied here rather than read inside
 * `parseMessage`, which stays pure. `optionalEnv` rather than `requireEnv`: a
 * missing `ALLOWED_EMAIL` should not stop a message being read, it should only
 * cost the `From`-based half of the own-message check, which the SENT and DRAFT
 * labels still cover.
 */
export async function getMessage(id: string): Promise<InboundMessage> {
  const resource = (await gmailRequest(
    `/messages/${encodeURIComponent(id)}?format=full`,
    { method: 'GET' },
    'not_found',
  )) as GmailMessageResource | null;

  if (resource === null || typeof resource !== 'object' || typeof resource.id !== 'string') {
    throw new GmailReadError('api_error', 'messages.get returned a resource with no id.');
  }

  return parseMessage(resource, { ownAddress: optionalEnv('ALLOWED_EMAIL') ?? null });
}

// ---------------------------------------------------------------------------
// The watch
// ---------------------------------------------------------------------------

export type WatchResult = {
  /** Null under dry run — the caller must not write a null cursor. */
  historyId: string | null;
  /** Epoch ms. Gmail expires a watch after 7 days. */
  expiration: number | null;
  dryRun: boolean;
};

/**
 * Register the Pub/Sub notification, or say what would have been registered.
 *
 * **Stubbed under `DRY_RUN`**, and it is the only Gmail call in this file that
 * is. `users.watch` writes state into somebody else's system — it points a
 * Google-side notification channel at a topic and it expires seven days later —
 * so a development machine that registered one would divert the production
 * mailbox's notifications at whatever `GMAIL_PUBSUB_TOPIC` the developer happened
 * to have set.
 *
 * The dry-run branch returns a null `historyId` on purpose. The caller must not
 * write a cursor it never actually anchored: a cursor that was invented locally
 * points at a mailbox position Gmail never agreed to.
 */
export async function watchMailbox(): Promise<WatchResult> {
  let topicName: string;
  try {
    topicName = requireEnv('GMAIL_PUBSUB_TOPIC', 'the Gmail inbox watch');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown';
    throw new GmailReadError('config', `Cannot register the Gmail watch: ${detail}`, { cause });
  }

  if (isDryRun()) {
    log({ event: 'watch', dry_run: true });
    return { historyId: null, expiration: null, dryRun: true };
  }

  const payload = (await gmailRequest(
    '/watch',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topicName,
        labelIds: ['INBOX'],
        labelFilterBehavior: 'include',
      }),
    },
    'not_found',
    'watch',
  )) as { historyId?: unknown; expiration?: unknown } | null;

  const historyId = readHistoryId(payload?.historyId);
  const rawExpiration = payload?.expiration;
  const expiration =
    typeof rawExpiration === 'string' && /^\d+$/.test(rawExpiration)
      ? Number(rawExpiration)
      : typeof rawExpiration === 'number' && Number.isFinite(rawExpiration)
        ? rawExpiration
        : null;

  log({ event: 'watch', dry_run: false, expiration });
  return { historyId, expiration, dryRun: false };
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

export type GmailWatchState = {
  /** Gmail's historyId as a string. It is a uint64 and must never become a number. */
  historyId: string;
  /** Epoch ms of the users.watch expiry, or null if never registered. */
  expiration: number | null;
  updatedAt: string;
};

/**
 * Stored as `settings.gmail_watch`, snake_case inside the jsonb.
 *
 * It is **not** read through `getSetting`. `SettingKey` is a closed union and
 * `parseSetting` throws in its `default` branch, so a sixth key there would mean
 * editing a file this workflow does not own — and `settings` already carries a
 * key outside `SettingsMap` (`allowed_email`, inserted by the RLS migration), so
 * this is the established shape rather than a new one. No migration is needed:
 * `settings.key` is `text primary key` and `value` is `jsonb`.
 *
 * snake_case inside the value matches `send_window`'s `start_hour` and the rest
 * of the table.
 */
type StoredWatch = { history_id?: unknown; expiration?: unknown; updated_at?: unknown };

export async function readGmailWatch(db: Db): Promise<GmailWatchState | null> {
  const { data, error } = await db
    .from('settings')
    .select('value')
    .eq('key', GMAIL_WATCH_SETTING_KEY)
    .maybeSingle();

  if (error) throw new Error(`Failed to read settings.${GMAIL_WATCH_SETTING_KEY}: ${error.message}`);
  if (!data) return null;

  const value = data.value as StoredWatch | null;
  const historyId = readHistoryId(value?.history_id);
  if (historyId === null) {
    // See judgement call 4: absent rather than fatal, but never silent.
    log({ event: 'gmail_watch_malformed' });
    return null;
  }

  const expiration =
    typeof value?.expiration === 'number' && Number.isFinite(value.expiration) ? value.expiration : null;
  const updatedAt = typeof value?.updated_at === 'string' ? value.updated_at : '';

  return { historyId, expiration, updatedAt };
}

export async function writeGmailWatch(db: Db, state: GmailWatchState): Promise<void> {
  if (!isHistoryId(state.historyId)) {
    throw new GmailReadError(
      'config',
      'Refusing to write a Gmail cursor that is not a decimal uint64. A bad cursor is not a bad ' +
        'row, it is every message that arrives after it never being read.',
    );
  }

  const { error } = await db.from('settings').upsert(
    {
      key: GMAIL_WATCH_SETTING_KEY,
      value: {
        history_id: state.historyId,
        expiration: state.expiration,
        updated_at: state.updatedAt,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' },
  );

  if (error) throw new Error(`Failed to write settings.${GMAIL_WATCH_SETTING_KEY}: ${error.message}`);
}
