/**
 * The Gmail Pub/Sub push webhook — PLAN §6 step 8, contract §8.1.
 *
 * This is the only route in the process that is deliberately reachable from the
 * internet. Everything under `/jobs/` in `index.ts` is loopback-only by
 * construction; this one lives at `/webhooks/gmail`, outside that prefix, so a
 * future audit of `isLoopbackRequest` does not have to reason about an
 * exception. It answers `204` and hands the work to `runInboxTick`.
 *
 * ---------------------------------------------------------------------------
 * What an unauthenticated request costs, and why that is the design
 * ---------------------------------------------------------------------------
 *
 * A public URL that triggers an agent is a way to spend somebody else's money.
 * One accepted delivery is worth, at the ceiling: up to `MAX_MESSAGES_PER_RUN`
 * Gmail reads, one Haiku classification per *new* message and one Sonnet draft
 * per message that routes to a reply. Nothing else in this repo can be made to
 * spend money by an outsider, so the refusal path is built to be cheaper than
 * the accept path at every step:
 *
 *   - The shared secret is checked first. It is one sha256 and no I/O — no
 *     database read, no JWKS fetch, no model call, and not even a body read.
 *     An unauthenticated flood therefore never reaches Google's certificate
 *     endpoint, which would otherwise turn this route into an amplifier
 *     pointed at somebody else's service.
 *   - The body is read with a hard cap and refused at `413` before it is
 *     parsed, so a large body cannot be used to occupy memory.
 *   - `inbox.ts` is loaded with a dynamic `import()` *after* the `204` is
 *     written, not with a static import at the top of this file. In the running
 *     worker that module is resident anyway, because `index.ts` registers the
 *     15-minute sweep against it — so the honest claim is not that the deploy
 *     saves the load, it is that **this file** does not depend on it. That is
 *     what lets the whole auth path be tested with no database, no API key and
 *     no Gmail credential, which is the state of the machine this was written
 *     on, and it is why a refused request executes nothing but a hash. The one
 *     static import here is `@agency/core` for `gmailWebhookEnv()`; that
 *     reaches `db.ts`, but `db.ts` only *defines* client factories — loading it
 *     constructs no client and reads no key.
 *
 * Beyond the per-request bound there is a per-run one: `runInboxTick` is
 * single-flight, so a thousand deliveries in a second collapse into one run and
 * a second run afterwards; the `interactions` claim means a message already
 * seen costs one `select` and no model call; and `call()`'s daily cost ceiling
 * is the last backstop. A loop pointed at this URL by somebody holding both
 * credentials still cannot spend more than `settings.daily_cost_cap` in a day.
 *
 * ---------------------------------------------------------------------------
 * Both checks, and why one of them is not enough
 * ---------------------------------------------------------------------------
 *
 * The shared secret is a bearer string in a URL. It sits in the Pub/Sub
 * subscription config, in any proxy access log that records query strings, and
 * in the operator's shell history. All it proves is that the caller once knew a
 * secret. The OIDC token proves that the caller is *this* Google service
 * account, right now, with a signature from Google that expires.
 *
 * The OIDC verification is complete and none of it is optional:
 *
 *   - RS256 verified against Google's JWKS. `alg` is read from the token's own
 *     header and rejected unless it is exactly RS256 — an unchecked `alg` is
 *     how `alg: none` and the HMAC-with-the-public-key trick get in.
 *   - `aud` must equal `GMAIL_WEBHOOK_AUDIENCE`. Without this claim a token
 *     Google minted for *any other service* verifies here perfectly.
 *   - `email` must equal `GMAIL_PUBSUB_SERVICE_ACCOUNT` and `email_verified`
 *     must be true. Without it, any holder of a Google account with the right
 *     audience passes.
 *   - `exp` in the future and `iat` not in the future, both with 60 seconds of
 *     clock skew.
 *
 * The two claims above are the ones that make the signature check mean
 * something. `GMAIL_WEBHOOK_AUDIENCE` and `GMAIL_PUBSUB_SERVICE_ACCOUNT` are
 * their variables, and they are read through `@agency/core`'s
 * `gmailWebhookEnv()` — the one grouped accessor in that file that reports a
 * missing variable rather than throwing on it, for the reason the next
 * paragraph gives.
 *
 * **Fail closed.** If any of the three variables is unset, every request is
 * refused with `503`. An open webhook that creates contacts and spends
 * Anthropic money is not something that ships on by default. Local work uses
 * `GET /jobs/inbox/run`, which is loopback-only and drives the identical code
 * path with no webhook at all.
 *
 * ---------------------------------------------------------------------------
 * What the caller is told, which is nothing
 * ---------------------------------------------------------------------------
 *
 * Every refusal is an empty body. The log line names the check that failed;
 * the response does not. Telling an attacker "the secret was fine, the token
 * was not" is a free oracle that turns two unknowns into one.
 *
 * `403` rather than `401` throughout: there is no `WWW-Authenticate` challenge
 * worth offering, and there is nothing the caller could do differently.
 *
 * ---------------------------------------------------------------------------
 * Acknowledge first, process after — and `204` even when it is unusable
 * ---------------------------------------------------------------------------
 *
 * Pub/Sub's default ack deadline is 10 seconds. A history walk plus a Sonnet
 * draft is minutes. Holding the socket open guarantees a redelivery of
 * everything, every time, so the `204` is written before processing starts.
 *
 * Losing a notification is harmless: the cursor is ours (`settings.gmail_watch`)
 * and the next notification — or the 15-minute sweep — re-lists from the same
 * `startHistoryId`.
 *
 * An authenticated request whose envelope does not parse also gets `204`, not
 * `400`. A `400` makes Pub/Sub redeliver a message we can never process until
 * the retention window expires, which is a permanent stream of redeliveries
 * that each cost a request. Acking something unprocessable and logging it is
 * the honest handling. The judgement call is recorded in the contract; the
 * consequence is that a genuinely malformed publisher is invisible except in
 * the log, which is why the log line exists.
 *
 * ---------------------------------------------------------------------------
 * Logging
 * ---------------------------------------------------------------------------
 *
 * The Pub/Sub envelope carries `emailAddress` — the operator's own mailbox —
 * and this file never logs it. Ids, counts and the name of a failed check only,
 * which is the same rule the rest of step 8 follows and stricter than anywhere
 * else in the repo, because the thing on the other side of this route is a
 * customer's email.
 */

import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gmailWebhookEnv } from '@agency/core';

const ROUTE = 'gmail-webhook';

/** Mounted by `index.ts` (see the note at the bottom of this file). */
export const GMAIL_WEBHOOK_PATH = '/webhooks/gmail';

/**
 * Hard ceiling on the request body.
 *
 * A Pub/Sub push envelope is a few hundred bytes: a base64 blob holding
 * `{ emailAddress, historyId }`, plus the message id and the subscription name.
 * 64 KiB is three orders of magnitude of headroom and still small enough that
 * a body cannot be used to occupy memory. Enforced while reading, not after —
 * the point is to never buffer an unbounded body.
 */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/** Google's public certificates, in JWKS form. */
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Both spellings Google uses in the `iss` claim. */
const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];

/** Tolerated clock difference between this container and Google, either way. */
const CLOCK_SKEW_MS = 60_000;

/** How long a fetched JWKS is trusted before it is fetched again. */
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * The floor between two refetches triggered by an unknown `kid`.
 *
 * Google rotates keys, so an unknown `kid` is a legitimate reason to refetch.
 * It is also a free denial-of-service amplifier: an attacker who can reach this
 * route with a valid shared secret and a token carrying a random `kid` would
 * otherwise make us hit Google once per request. One refetch a minute is enough
 * to pick up a rotation within a minute and cheap enough to be uninteresting.
 */
const JWKS_REFETCH_MIN_INTERVAL_MS = 60_000;

function log(message: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), route: ROUTE, message, ...extra }));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * One line per process for an unconfigured webhook, not one per request.
 *
 * Pub/Sub retries a `503` with backoff for days. Logging every one of them
 * would bury everything else in the worker's output, and the operator only
 * needs to be told once what is missing.
 */
let configWarned = false;

/** Test seam: `handleGmailWebhook` is asserted across several configurations. */
export function resetWebhookWarnings(): void {
  configWarned = false;
}

// ---------------------------------------------------------------------------
// Check 2 — the shared secret
// ---------------------------------------------------------------------------

/**
 * Does `?token=` match the configured secret?
 *
 * Both sides are hashed before they are compared, for two reasons that both
 * matter: `timingSafeEqual` throws on a length mismatch, and returning early on
 * that throw would leak the secret's length to anyone able to time the route.
 * Hashing makes both operands 32 bytes whatever the inputs were, so the
 * comparison is constant-time over the *contents* and reveals nothing about the
 * length.
 *
 * An empty secret never matches. A caller who supplies no token, and a
 * misconfigured deploy with an empty variable, must not accidentally agree.
 */
export function verifySharedSecret(url: URL, secret: string): boolean {
  if (secret === '') return false;
  const token = url.searchParams.get('token');
  if (token === null || token === '') return false;

  const a = createHash('sha256').update(token, 'utf8').digest();
  const b = createHash('sha256').update(secret, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Check 4 — the OIDC token
// ---------------------------------------------------------------------------

export type OidcVerification = { ok: true; email: string } | { ok: false; reason: string };

type Jwk = Record<string, unknown> & { kid?: unknown; alg?: unknown; kty?: unknown };

type JwksCache = { keys: Map<string, Jwk>; fetchedAt: number };

let jwksCache: JwksCache | null = null;
let jwksLastFetchAttempt = 0;
/** Why the last fetch failed, so a request inside the floor can say so. */
let jwksLastFailure: Error | null = null;
let jwksFetcher: (() => Promise<unknown>) | null = null;

/**
 * Replace the JWKS fetch. Pass `null` to restore the real one.
 *
 * Also drops the cache, so one test's key set cannot verify another test's
 * token — a cache that survived the seam being swapped would make the tests
 * order-dependent, which for an auth check is worse than having no test.
 */
export function setJwksFetcher(fn: (() => Promise<unknown>) | null): void {
  jwksFetcher = fn;
  jwksCache = null;
  jwksLastFetchAttempt = 0;
  jwksLastFailure = null;
}

async function fetchJwks(): Promise<unknown> {
  if (jwksFetcher !== null) return jwksFetcher();
  const response = await fetch(GOOGLE_JWKS_URL);
  if (!response.ok) throw new Error(`JWKS fetch returned ${response.status}`);
  return response.json();
}

function indexJwks(document: unknown): Map<string, Jwk> {
  const keys = new Map<string, Jwk>();
  if (typeof document !== 'object' || document === null) return keys;
  const list = (document as { keys?: unknown }).keys;
  if (!Array.isArray(list)) return keys;

  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const jwk = entry as Jwk;
    if (typeof jwk.kid !== 'string' || jwk.kid === '') continue;
    // RSA only. Google publishes RSA signing keys here, and accepting another
    // key type would mean accepting another algorithm alongside it.
    if (jwk.kty !== 'RSA') continue;
    keys.set(jwk.kid, jwk);
  }
  return keys;
}

/**
 * The signing key for `kid`, refetching at most as often as the two intervals
 * above allow.
 *
 * Returns null rather than throwing on an unknown key: an unknown `kid` is a
 * failed verification, not an outage. A genuine outage — the fetch itself
 * throwing — is allowed to propagate so the caller can name it separately in
 * the log, because "Google is unreachable" and "the token is forged" want
 * different responses from the operator even though both produce a `403`.
 *
 * **The interval covers the failing fetch as well as the unknown `kid`, and
 * that is the point of it.** A fetch that throws leaves no cache behind, so
 * without this every request would find the cache empty and go straight back out
 * to Google — the amplifier this interval exists to prevent, running at exactly
 * the moment Google is already having trouble. The remembered failure is
 * re-thrown rather than swallowed so the caller still logs an outage rather than
 * a forged token; those are different problems and the log must not confuse them.
 */
async function signingKey(kid: string, now: number): Promise<Jwk | null> {
  const stale = jwksCache === null || now - jwksCache.fetchedAt > JWKS_TTL_MS;

  if (stale) {
    if (now - jwksLastFetchAttempt < JWKS_REFETCH_MIN_INTERVAL_MS) {
      // Inside the floor. Keep using a stale key set if there is one — stale
      // keys still verify yesterday's tokens — and otherwise say what happened
      // last time without making the request again.
      if (jwksCache === null) throw jwksLastFailure ?? new Error('JWKS is not available.');
    } else {
      jwksLastFetchAttempt = now;
      try {
        jwksCache = { keys: indexJwks(await fetchJwks()), fetchedAt: now };
        jwksLastFailure = null;
      } catch (error) {
        jwksLastFailure = error instanceof Error ? error : new Error(String(error));
        throw jwksLastFailure;
      }
    }
  }
  if (jwksCache === null) throw jwksLastFailure ?? new Error('JWKS is not available.');

  const cached = jwksCache.keys.get(kid);
  if (cached !== undefined) return cached;

  if (now - jwksLastFetchAttempt < JWKS_REFETCH_MIN_INTERVAL_MS) return null;

  jwksLastFetchAttempt = now;
  try {
    jwksCache = { keys: indexJwks(await fetchJwks()), fetchedAt: now };
    jwksLastFailure = null;
  } catch (error) {
    jwksLastFailure = error instanceof Error ? error : new Error(String(error));
    throw jwksLastFailure;
  }
  return jwksCache.keys.get(kid) ?? null;
}

function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(json);
}

function claimString(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

function claimNumber(claims: Record<string, unknown>, name: string): number | null {
  const value = claims[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Verify a Pub/Sub push OIDC token.
 *
 * Every failure returns a short machine reason rather than throwing, because
 * the caller logs the reason and answers `403` either way — and because a
 * thrown error from a verification function is one `catch` away from being
 * treated as a pass.
 *
 * The order of the checks is signature first, claims after. Reading claims off
 * a token whose signature has not been verified and acting on them is the
 * mistake this ordering makes impossible.
 */
export async function verifyOidcToken(
  authorization: string | undefined,
  opts: { audience: string; serviceAccount: string; now?: Date },
): Promise<OidcVerification> {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return { ok: false, reason: 'oidc_missing' };
  }
  const token = authorization.slice('Bearer '.length).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'oidc_malformed' };

  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: Record<string, unknown>;
  try {
    const decoded = decodeSegment(headerPart);
    if (typeof decoded !== 'object' || decoded === null) throw new Error('not an object');
    header = decoded as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'oidc_malformed' };
  }

  // Read from the token's own header and pinned to one value. An unpinned `alg`
  // is how `none` and the HMAC-with-the-RSA-public-key forgery get accepted.
  if (header['alg'] !== 'RS256') return { ok: false, reason: 'oidc_alg' };
  const kid = claimString(header, 'kid');
  if (kid === null) return { ok: false, reason: 'oidc_kid' };

  const nowMs = (opts.now ?? new Date()).getTime();

  let jwk: Jwk | null;
  try {
    jwk = await signingKey(kid, nowMs);
  } catch {
    return { ok: false, reason: 'oidc_jwks_unavailable' };
  }
  if (jwk === null) return { ok: false, reason: 'oidc_unknown_key' };

  let signatureOk = false;
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    signatureOk = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'),
      key,
      Buffer.from(signaturePart, 'base64url'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: 'oidc_signature' };

  let claims: Record<string, unknown>;
  try {
    const decoded = decodeSegment(payloadPart);
    if (typeof decoded !== 'object' || decoded === null) throw new Error('not an object');
    claims = decoded as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'oidc_malformed' };
  }

  const iss = claimString(claims, 'iss');
  if (iss === null || !GOOGLE_ISSUERS.includes(iss)) return { ok: false, reason: 'oidc_issuer' };

  // The claim that makes the whole check mean something: without it, a token
  // Google signed for a different service of a different owner verifies.
  const aud = claimString(claims, 'aud');
  if (aud === null || aud !== opts.audience) return { ok: false, reason: 'oidc_audience' };

  const email = claimString(claims, 'email');
  if (email === null || email.toLowerCase() !== opts.serviceAccount.trim().toLowerCase()) {
    return { ok: false, reason: 'oidc_email' };
  }
  if (claims['email_verified'] !== true) return { ok: false, reason: 'oidc_email_unverified' };

  const exp = claimNumber(claims, 'exp');
  if (exp === null || exp * 1000 + CLOCK_SKEW_MS <= nowMs) return { ok: false, reason: 'oidc_expired' };

  const iat = claimNumber(claims, 'iat');
  if (iat !== null && iat * 1000 - CLOCK_SKEW_MS > nowMs) {
    return { ok: false, reason: 'oidc_issued_in_future' };
  }

  return { ok: true, email };
}

// ---------------------------------------------------------------------------
// Check 5 — the envelope
// ---------------------------------------------------------------------------

export type PubSubEnvelope = {
  emailAddress: string | null;
  historyId: string | null;
  pubsubMessageId: string | null;
};

/**
 * Decode a Pub/Sub push envelope.
 *
 * The shape is `{ message: { data, messageId }, subscription }`, where `data` is
 * base64 of `{ emailAddress, historyId }`. Null means "this is not a Pub/Sub
 * push at all"; an envelope that is one but whose inner payload is unusable
 * comes back with null fields, so the caller can still log which delivery it
 * was and stop looking for it.
 *
 * `historyId` is returned as a **string** even when Gmail sends it as a JSON
 * number. It is a uint64: `Number()` on it starts losing precision above 2^53,
 * and the loss surfaces as a cursor that quietly skips mail rather than as an
 * error.
 */
export function parsePubSubEnvelope(raw: string): PubSubEnvelope | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof envelope !== 'object' || envelope === null) return null;

  const message = (envelope as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;

  const record = message as Record<string, unknown>;
  const messageId = typeof record['messageId'] === 'string' ? record['messageId'] : null;
  const data = record['data'];

  if (typeof data !== 'string' || data === '') {
    return { emailAddress: null, historyId: null, pubsubMessageId: messageId };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    return { emailAddress: null, historyId: null, pubsubMessageId: messageId };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { emailAddress: null, historyId: null, pubsubMessageId: messageId };
  }

  const inner = payload as Record<string, unknown>;
  const rawHistory = inner['historyId'];
  const historyId =
    typeof rawHistory === 'string' && rawHistory !== ''
      ? rawHistory
      : typeof rawHistory === 'number' && Number.isFinite(rawHistory)
        ? String(BigInt(Math.trunc(rawHistory)))
        : null;

  const emailAddress =
    typeof inner['emailAddress'] === 'string' && inner['emailAddress'] !== ''
      ? inner['emailAddress']
      : null;

  return { emailAddress, historyId, pubsubMessageId: messageId };
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

type BodyRead = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'aborted' };

/**
 * Read the request body, refusing anything over the cap while it arrives.
 *
 * `Content-Length` is checked first where it exists, so an oversized body is
 * refused before a byte of it is buffered — but the streaming check is the one
 * that is authoritative, because the header is supplied by the caller and a
 * chunked request has none at all.
 */
function readBody(req: IncomingMessage, max: number): Promise<BodyRead> {
  const declared = Number(req.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    return Promise.resolve({ ok: false, reason: 'too_large' });
  }

  return new Promise<BodyRead>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const settle = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > max) {
        settle({ ok: false, reason: 'too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ ok: false, reason: 'aborted' }));
    req.on('aborted', () => settle({ ok: false, reason: 'aborted' }));
  });
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

type InboxTrigger = (trigger: 'webhook' | 'manual') => void;

let inboxTrigger: InboxTrigger | null = null;

/**
 * Replace what an accepted delivery starts. Pass `null` to restore the real one.
 *
 * The real one is `triggerInbox` from `../jobs/inbox.js`, loaded with a dynamic
 * `import()` at the moment it is needed rather than at the top of this file —
 * see the header. This seam exists so the auth tests can assert *that* a
 * delivery was accepted without a database, a Gmail credential or an API key
 * anywhere near them.
 */
export function setInboxTrigger(fn: InboxTrigger | null): void {
  inboxTrigger = fn;
}

function end(res: ServerResponse, status: number): void {
  // Empty body on every path. A refusal says nothing, and an acknowledgement
  // has nothing to say: Pub/Sub reads the status code and discards the rest.
  res.writeHead(status);
  res.end();
}

/**
 * `POST /webhooks/gmail`.
 *
 * Never throws: `index.ts` calls it as `void handleGmailWebhook(req, res)`, and
 * an unhandled rejection out of a request handler takes the worker down —
 * which would stop the morning agent and the send queue as well.
 */
export async function handleGmailWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== 'POST') {
      end(res, 405);
      return;
    }

    // Read per request rather than at module load: a worker that boots before
    // its variables are set must start accepting correctly the moment they are,
    // and the cost is three property reads.
    const config = gmailWebhookEnv();
    if (!config.ok) {
      if (!configWarned) {
        configWarned = true;
        // Names, never values. A missing variable is a configuration fact; its
        // contents would be a secret in a log file.
        log('the Gmail webhook is not configured and is refusing every delivery', {
          missing: config.missing,
        });
      }
      end(res, 503);
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // First, because it is one hash and no I/O. Everything below this line
    // costs something.
    if (!verifySharedSecret(url, config.secret)) {
      log('refused a delivery', { reason: 'shared_secret' });
      end(res, 403);
      return;
    }

    const body = await readBody(req, MAX_WEBHOOK_BODY_BYTES);
    if (!body.ok) {
      if (body.reason === 'too_large') {
        log('refused a delivery', { reason: 'body_too_large', max_bytes: MAX_WEBHOOK_BODY_BYTES });
        end(res, 413);
      }
      // An aborted request has no socket left to answer on.
      return;
    }

    const oidc = await verifyOidcToken(req.headers['authorization'], {
      audience: config.audience,
      serviceAccount: config.serviceAccount,
    });
    if (!oidc.ok) {
      log('refused a delivery', { reason: oidc.reason });
      end(res, 403);
      return;
    }

    const envelope = parsePubSubEnvelope(body.text);
    if (envelope === null || envelope.historyId === null) {
      // Acked on purpose. See the header: a 400 here is a redelivery loop that
      // lasts as long as Pub/Sub's retention.
      log('acknowledged a delivery this route cannot use', {
        pubsub_message_id: envelope?.pubsubMessageId ?? null,
        reason: envelope === null ? 'not_a_pubsub_envelope' : 'no_history_id',
      });
      end(res, 204);
      return;
    }

    // The acknowledgement goes out before any work starts, and the work is not
    // awaited. `emailAddress` is deliberately not logged.
    end(res, 204);
    log('accepted a delivery', {
      pubsub_message_id: envelope.pubsubMessageId,
      history_id: envelope.historyId,
    });

    await startInbox();
  } catch (error) {
    // Reaching here means a bug in this file rather than a bad request. The
    // caller is told nothing, and the process survives.
    log('the webhook handler threw', {
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      if (!res.headersSent) end(res, 500);
    } catch {
      // The socket is already gone. Nothing left to do.
    }
  }
}

/**
 * Start the inbox run, loading it only now.
 *
 * The dynamic import is the reason a refused request never touches the Gmail
 * client or the Anthropic wrapper. A failure to load is logged and swallowed:
 * the `204` has already been written, and the 15-minute sweep will pick up
 * whatever this delivery would have.
 */
async function startInbox(): Promise<void> {
  try {
    if (inboxTrigger !== null) {
      inboxTrigger('webhook');
      return;
    }
    const module = await import('../jobs/inbox.js');
    module.triggerInbox('webhook');
  } catch (error) {
    log('failed to start the inbox run for an accepted delivery', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * ---------------------------------------------------------------------------
 * What the integration agent must register in `apps/worker/src/index.ts`
 * ---------------------------------------------------------------------------
 *
 * In `handleRequest`, **before** the `/jobs/*` branches and deliberately **not**
 * behind `isLoopbackRequest`:
 *
 *     if (req.method === 'POST' && url.pathname === GMAIL_WEBHOOK_PATH) {
 *       void handleGmailWebhook(req, res);
 *       return;
 *     }
 *
 * A non-POST to the same path falls through to the 404 branch, which is fine —
 * this handler answers 405 when it is reached with the wrong method, and the
 * two outcomes are equivalent to a caller that is not Pub/Sub.
 *
 * Nothing here goes into `validateEnv()`. The worker must still boot and still
 * run the 08:00 agent on a machine with no Gmail setup; this route fails closed
 * with a `503` on its own account.
 */
