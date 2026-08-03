/**
 * Webhook tests — the auth on the one public route, with no network anywhere.
 *
 * The whole file runs against a locally generated RSA key pair. `node:crypto`
 * signs the tokens and the JWKS fetch is replaced with a function that returns
 * the matching public key, so "a Google-signed token verifies" and "a forged
 * one does not" are both proved without reaching Google — and without an API
 * key, a database or a Gmail credential, which is the state of the machine this
 * was written on.
 *
 * The cases are named after what a failure would let somebody do, because that
 * is what makes them worth keeping:
 *
 *   - a token minted for a different Google service triggering paid model calls
 *     on this account (`aud`)
 *   - any Google account holder doing the same (`email`)
 *   - `alg: none` and the HMAC-with-the-public-key forgery
 *   - an unauthenticated flood reaching Google's certificate endpoint through us
 *   - a body large enough to be worth buffering
 *   - a redelivery loop caused by answering 400 to something unparseable
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signWith, type KeyObject } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  GMAIL_WEBHOOK_PATH,
  MAX_WEBHOOK_BODY_BYTES,
  handleGmailWebhook,
  parsePubSubEnvelope,
  resetWebhookWarnings,
  setInboxTrigger,
  setJwksFetcher,
  verifyOidcToken,
  verifySharedSecret,
} from './gmail-webhook';

// ---------------------------------------------------------------------------
// Keys and tokens
// ---------------------------------------------------------------------------

const KID = 'test-key-1';
const AUDIENCE = 'https://worker.example/webhooks/gmail';
const SERVICE_ACCOUNT = 'pubsub-push@agency-os.iam.gserviceaccount.com';
const SECRET = 'a-shared-secret-of-some-length';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwks(kid: string, key: KeyObject): unknown {
  const jwk = key.export({ format: 'jwk' }) as Record<string, unknown>;
  return { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

const NOW = new Date('2026-08-05T10:00:00.000Z');

function claims(over: Record<string, unknown> = {}, at: Date = NOW): Record<string, unknown> {
  const seconds = Math.floor(at.getTime() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    azp: SERVICE_ACCOUNT,
    email: SERVICE_ACCOUNT,
    email_verified: true,
    iat: seconds - 30,
    exp: seconds + 3600,
    ...over,
  };
}

/** A signed token. `privateKey` defaults to the key the fake JWKS publishes. */
function token(
  payload: Record<string, unknown> = claims(),
  header: Record<string, unknown> = { alg: 'RS256', kid: KID, typ: 'JWT' },
  privateKey: KeyObject = pair.privateKey,
): string {
  const head = b64url(header);
  const body = b64url(payload);
  const signature = signWith('RSA-SHA256', Buffer.from(`${head}.${body}`, 'utf8'), privateKey);
  return `${head}.${body}.${signature.toString('base64url')}`;
}

function bearer(value: string): string {
  return `Bearer ${value}`;
}

// ---------------------------------------------------------------------------
// The shared secret
// ---------------------------------------------------------------------------

function urlWith(query: string): URL {
  return new URL(`http://worker.example${GMAIL_WEBHOOK_PATH}${query}`);
}

describe('verifySharedSecret', () => {
  it('accepts the configured token', () => {
    assert.equal(verifySharedSecret(urlWith(`?token=${SECRET}`), SECRET), true);
  });

  it('rejects a different token', () => {
    assert.equal(verifySharedSecret(urlWith('?token=nope'), SECRET), false);
  });

  it('rejects a token that is a prefix of the secret', () => {
    // The case a naive `startsWith` or a truncating comparison would pass, and
    // the reason both sides are hashed to a fixed length before comparison.
    assert.equal(verifySharedSecret(urlWith(`?token=${SECRET.slice(0, 8)}`), SECRET), false);
  });

  it('rejects a request with no token at all', () => {
    assert.equal(verifySharedSecret(urlWith(''), SECRET), false);
    assert.equal(verifySharedSecret(urlWith('?token='), SECRET), false);
  });

  it('rejects everything when the secret is unset', () => {
    // A deploy with an empty variable must not agree with a caller who sends
    // nothing. This is the failure that would silently open the route.
    assert.equal(verifySharedSecret(urlWith('?token='), ''), false);
    assert.equal(verifySharedSecret(urlWith('?token=anything'), ''), false);
  });

  it('does not throw on a token of a wildly different length', () => {
    // `timingSafeEqual` throws on a length mismatch; hashing first is what
    // stops that throw from becoming a length oracle.
    assert.equal(verifySharedSecret(urlWith(`?token=${'x'.repeat(5000)}`), SECRET), false);
  });
});

// ---------------------------------------------------------------------------
// The OIDC token
// ---------------------------------------------------------------------------

describe('verifyOidcToken', () => {
  let fetches = 0;

  beforeEach(() => {
    fetches = 0;
    setJwksFetcher(async () => {
      fetches += 1;
      return jwks(KID, pair.publicKey);
    });
  });

  afterEach(() => {
    setJwksFetcher(null);
  });

  const opts = { audience: AUDIENCE, serviceAccount: SERVICE_ACCOUNT, now: NOW };

  it('accepts a token Google signed for this audience and this service account', async () => {
    const result = await verifyOidcToken(bearer(token()), opts);
    assert.deepEqual(result, { ok: true, email: SERVICE_ACCOUNT });
  });

  it('refuses a token minted for another audience', async () => {
    // Without this claim, any Google-signed OIDC token — one issued for
    // somebody else's Cloud Run service — triggers paid model calls here.
    const result = await verifyOidcToken(
      bearer(token(claims({ aud: 'https://someone-else.example/hook' }))),
      opts,
    );
    assert.deepEqual(result, { ok: false, reason: 'oidc_audience' });
  });

  it('refuses a token from another service account', async () => {
    const result = await verifyOidcToken(
      bearer(token(claims({ email: 'someone@gmail.com' }))),
      opts,
    );
    assert.deepEqual(result, { ok: false, reason: 'oidc_email' });
  });

  it('refuses an unverified email claim', async () => {
    const result = await verifyOidcToken(bearer(token(claims({ email_verified: false }))), opts);
    assert.deepEqual(result, { ok: false, reason: 'oidc_email_unverified' });
  });

  it('refuses alg: none', async () => {
    const head = b64url({ alg: 'none', kid: KID });
    const body = b64url(claims());
    const result = await verifyOidcToken(bearer(`${head}.${body}.`), opts);
    assert.deepEqual(result, { ok: false, reason: 'oidc_alg' });
  });

  it('refuses a token that asks to be verified with a symmetric algorithm', async () => {
    // The classic forgery: sign with HS256 using the public key as the secret
    // and hope the verifier trusts the header's `alg`.
    const result = await verifyOidcToken(
      bearer(token(claims(), { alg: 'HS256', kid: KID })),
      opts,
    );
    assert.deepEqual(result, { ok: false, reason: 'oidc_alg' });
  });

  it('refuses a token signed by a key Google does not publish', async () => {
    const result = await verifyOidcToken(
      bearer(token(claims(), { alg: 'RS256', kid: KID }, OTHER.privateKey)),
      opts,
    );
    assert.deepEqual(result, { ok: false, reason: 'oidc_signature' });
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const signed = token();
    const [head, , signature] = signed.split('.') as [string, string, string];
    const tampered = `${head}.${b64url(claims({ email: 'attacker@gmail.com' }))}.${signature}`;
    const result = await verifyOidcToken(bearer(tampered), opts);
    assert.deepEqual(result, { ok: false, reason: 'oidc_signature' });
  });

  it('refuses an unknown key id', async () => {
    const result = await verifyOidcToken(
      bearer(token(claims(), { alg: 'RS256', kid: 'rotated-away' })),
      opts,
    );
    assert.deepEqual(result, { ok: false, reason: 'oidc_unknown_key' });
  });

  it('refuses a foreign issuer', async () => {
    const result = await verifyOidcToken(
      bearer(token(claims({ iss: 'https://accounts.example.com' }))),
      opts,
    );
    assert.deepEqual(result, { ok: false, reason: 'oidc_issuer' });
  });

  it('accepts both spellings Google uses for the issuer', async () => {
    const result = await verifyOidcToken(bearer(token(claims({ iss: 'accounts.google.com' }))), opts);
    assert.equal(result.ok, true);
  });

  it('refuses an expired token, and tolerates one minute of skew', async () => {
    const seconds = Math.floor(NOW.getTime() / 1000);
    const justExpired = await verifyOidcToken(bearer(token(claims({ exp: seconds - 30 }))), opts);
    assert.equal(justExpired.ok, true, 'within the 60s skew window');

    const longExpired = await verifyOidcToken(bearer(token(claims({ exp: seconds - 3600 }))), opts);
    assert.deepEqual(longExpired, { ok: false, reason: 'oidc_expired' });
  });

  it('refuses a token issued in the future', async () => {
    const seconds = Math.floor(NOW.getTime() / 1000);
    const result = await verifyOidcToken(bearer(token(claims({ iat: seconds + 600 }))), opts);
    assert.deepEqual(result, { ok: false, reason: 'oidc_issued_in_future' });
  });

  it('refuses a missing or malformed Authorization header', async () => {
    assert.deepEqual(await verifyOidcToken(undefined, opts), { ok: false, reason: 'oidc_missing' });
    assert.deepEqual(await verifyOidcToken('Basic abc', opts), { ok: false, reason: 'oidc_missing' });
    assert.deepEqual(await verifyOidcToken(bearer('not-a-jwt'), opts), {
      ok: false,
      reason: 'oidc_malformed',
    });
    assert.deepEqual(await verifyOidcToken(bearer('a.b.c'), opts), {
      ok: false,
      reason: 'oidc_malformed',
    });
  });

  it('reports a JWKS outage as its own reason rather than as a pass', async () => {
    setJwksFetcher(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const result = await verifyOidcToken(bearer(token()), opts);
    assert.deepEqual(result, { ok: false, reason: 'oidc_jwks_unavailable' });
  });

  it('fetches the JWKS once for a burst of deliveries', async () => {
    // Google's certificate endpoint is somebody else's service. One fetch per
    // delivery would make a burst of Pub/Sub pushes into a burst pointed at it.
    for (let i = 0; i < 5; i += 1) {
      const result = await verifyOidcToken(bearer(token()), opts);
      assert.equal(result.ok, true);
    }
    assert.equal(fetches, 1);
  });

  it('does not refetch on every unknown key id', async () => {
    // An attacker with the shared secret and a random `kid` per request would
    // otherwise turn this route into an amplifier aimed at Google.
    for (let i = 0; i < 5; i += 1) {
      await verifyOidcToken(bearer(token(claims(), { alg: 'RS256', kid: `unknown-${i}` })), opts);
    }
    assert.equal(fetches, 1);
  });

  it('does not refetch on every request while the fetch itself is failing', async () => {
    // The same amplifier by the other door, and the worse one: a failing fetch
    // leaves no cache behind, so without the floor covering it every delivery
    // goes straight back out to Google — at exactly the moment Google is already
    // having trouble.
    let attempts = 0;
    setJwksFetcher(async () => {
      attempts += 1;
      throw new Error('getaddrinfo ENOTFOUND');
    });

    for (let i = 0; i < 5; i += 1) {
      const result = await verifyOidcToken(bearer(token()), opts);
      // Still an outage and still refused — the floor must not turn one into
      // "unknown key", which is a different problem with a different fix.
      assert.deepEqual(result, { ok: false, reason: 'oidc_jwks_unavailable' });
    }

    assert.equal(attempts, 1, `hit Google ${attempts} times for one outage`);
  });
});

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

function envelope(payload: unknown, messageId = 'pubsub-1'): string {
  return JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      messageId,
      publishTime: NOW.toISOString(),
    },
    subscription: 'projects/agency-os/subscriptions/gmail-push',
  });
}

describe('parsePubSubEnvelope', () => {
  it('reads the mailbox and the history id', () => {
    const parsed = parsePubSubEnvelope(
      envelope({ emailAddress: 'owner@example.gr', historyId: '987654' }),
    );
    assert.deepEqual(parsed, {
      emailAddress: 'owner@example.gr',
      historyId: '987654',
      pubsubMessageId: 'pubsub-1',
    });
  });

  it('keeps a numeric history id as a string', () => {
    const parsed = parsePubSubEnvelope(envelope({ historyId: 987654 }));
    assert.equal(parsed?.historyId, '987654');
    assert.equal(typeof parsed?.historyId, 'string');
  });

  it('does not lose precision on a history id above 2^53', () => {
    // A uint64 read through `Number` starts skipping mail here rather than
    // erroring, which is the worst shape a bug can take in this system.
    const huge = '9007199254740993';
    const parsed = parsePubSubEnvelope(envelope({ historyId: huge }));
    assert.equal(parsed?.historyId, huge);
  });

  it('is null when the body is not a Pub/Sub push at all', () => {
    assert.equal(parsePubSubEnvelope('not json'), null);
    assert.equal(parsePubSubEnvelope('{"hello":"world"}'), null);
    assert.equal(parsePubSubEnvelope('[]'), null);
  });

  it('keeps the delivery id when the inner payload is unusable', () => {
    // So the log can name which delivery was dropped even though nothing in it
    // could be read.
    const raw = JSON.stringify({ message: { data: 'not-base64-json', messageId: 'pubsub-9' } });
    assert.deepEqual(parsePubSubEnvelope(raw), {
      emailAddress: null,
      historyId: null,
      pubsubMessageId: 'pubsub-9',
    });
  });

  it('has no history id when the notification carries none', () => {
    const parsed = parsePubSubEnvelope(envelope({ emailAddress: 'owner@example.gr' }));
    assert.equal(parsed?.historyId, null);
  });
});

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

type FakeRes = ServerResponse & { statusCode: number; headersSent: boolean; body: string };

function makeRes(): FakeRes {
  const res = {
    statusCode: 0,
    headersSent: false,
    body: '',
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      this.body = chunk ?? '';
      return this;
    },
  };
  return res as unknown as FakeRes;
}

function makeReq(options: {
  method?: string;
  query?: string;
  body?: string;
  authorization?: string | undefined;
  contentLength?: string;
}): IncomingMessage {
  const body = options.body ?? '';
  const stream = Readable.from([Buffer.from(body, 'utf8')]);
  const headers: Record<string, string> = { host: 'worker.example' };
  if (options.authorization !== undefined) headers['authorization'] = options.authorization;
  if (options.contentLength !== undefined) headers['content-length'] = options.contentLength;

  Object.assign(stream, {
    method: options.method ?? 'POST',
    url: `${GMAIL_WEBHOOK_PATH}${options.query ?? `?token=${SECRET}`}`,
    headers,
  });
  return stream as unknown as IncomingMessage;
}

/**
 * `handleGmailWebhook` takes no clock — the signature is fixed by the contract
 * and a route that could be told what time it is would be a route an attacker
 * could tell what time it is. So the handler cases sign against the real one.
 */
function liveToken(over: Record<string, unknown> = {}): string {
  return token(claims(over, new Date()));
}

describe('handleGmailWebhook', () => {
  const ORIGINAL = {
    GMAIL_WEBHOOK_SECRET: process.env['GMAIL_WEBHOOK_SECRET'],
    GMAIL_WEBHOOK_AUDIENCE: process.env['GMAIL_WEBHOOK_AUDIENCE'],
    GMAIL_PUBSUB_SERVICE_ACCOUNT: process.env['GMAIL_PUBSUB_SERVICE_ACCOUNT'],
  };

  const originalLog = console.log;
  let lines: string[] = [];
  let fetches = 0;
  let triggered: string[] = [];

  beforeEach(() => {
    lines = [];
    fetches = 0;
    triggered = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };

    process.env['GMAIL_WEBHOOK_SECRET'] = SECRET;
    process.env['GMAIL_WEBHOOK_AUDIENCE'] = AUDIENCE;
    process.env['GMAIL_PUBSUB_SERVICE_ACCOUNT'] = SERVICE_ACCOUNT;

    resetWebhookWarnings();
    setJwksFetcher(async () => {
      fetches += 1;
      return jwks(KID, pair.publicKey);
    });
    setInboxTrigger((trigger) => {
      triggered.push(trigger);
    });
  });

  afterEach(() => {
    console.log = originalLog;
    setJwksFetcher(null);
    setInboxTrigger(null);
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const goodBody = (): string => envelope({ emailAddress: 'owner@example.gr', historyId: '4242' });

  it('accepts a properly authenticated delivery and starts a run', async () => {
    const res = makeRes();
    await handleGmailWebhook(
      makeReq({ body: goodBody(), authorization: bearer(liveToken()) }),
      res,
    );

    assert.equal(res.statusCode, 204);
    assert.equal(res.body, '');
    assert.deepEqual(triggered, ['webhook']);
  });

  it('answers before it starts the run', async () => {
    // Pub/Sub's ack deadline is 10 seconds and a run is minutes. If this ever
    // inverts, every delivery is redelivered and every message is processed
    // twice — or would be, were the interactions claim not there as well.
    let statusWhenTriggered: number | null = null;
    const res = makeRes();
    setInboxTrigger(() => {
      statusWhenTriggered = res.statusCode;
    });

    await handleGmailWebhook(makeReq({ body: goodBody(), authorization: bearer(liveToken()) }), res);
    assert.equal(statusWhenTriggered, 204);
  });

  it('refuses a wrong shared secret without touching the JWKS or starting a run', async () => {
    // The cheap-to-refuse property. If this regresses, an unauthenticated flood
    // becomes a flood aimed at Google's certificate endpoint.
    const res = makeRes();
    await handleGmailWebhook(
      makeReq({ query: '?token=wrong', body: goodBody(), authorization: bearer(liveToken()) }),
      res,
    );

    assert.equal(res.statusCode, 403);
    assert.equal(res.body, '');
    assert.equal(fetches, 0);
    assert.deepEqual(triggered, []);
  });

  it('refuses a delivery with no OIDC token', async () => {
    const res = makeRes();
    await handleGmailWebhook(makeReq({ body: goodBody() }), res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(triggered, []);
  });

  it('refuses a token minted for another audience', async () => {
    const res = makeRes();
    await handleGmailWebhook(
      makeReq({
        body: goodBody(),
        authorization: bearer(liveToken({ aud: 'https://elsewhere.example' })),
      }),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.deepEqual(triggered, []);
  });

  it('never tells the caller which check failed', async () => {
    for (const req of [
      makeReq({ query: '?token=wrong', body: goodBody(), authorization: bearer(liveToken()) }),
      makeReq({ body: goodBody() }),
      makeReq({ body: goodBody(), authorization: bearer('a.b.c') }),
    ]) {
      const res = makeRes();
      await handleGmailWebhook(req, res);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body, '', 'a refusal says nothing');
    }
  });

  it('names the failed check in the log, and only there', async () => {
    const res = makeRes();
    await handleGmailWebhook(makeReq({ query: '?token=wrong', body: goodBody() }), res);
    const line = lines.find((entry) => entry.includes('refused a delivery'));
    assert.ok(line !== undefined);
    assert.ok(line.includes('shared_secret'));
    assert.ok(!line.includes('owner@example.gr'), 'the mailbox never reaches a log line');
  });

  it('refuses every delivery with 503 when the two new variables are unset', async () => {
    // Fail closed. An open webhook that creates contacts and spends Anthropic
    // money is not something that ships on by default.
    for (const missing of ['GMAIL_WEBHOOK_AUDIENCE', 'GMAIL_PUBSUB_SERVICE_ACCOUNT', 'GMAIL_WEBHOOK_SECRET']) {
      resetWebhookWarnings();
      const saved = process.env[missing];
      delete process.env[missing];

      const res = makeRes();
      await handleGmailWebhook(makeReq({ body: goodBody(), authorization: bearer(liveToken()) }), res);

      assert.equal(res.statusCode, 503, missing);
      assert.deepEqual(triggered, [], missing);
      process.env[missing] = saved;
    }
  });

  it('logs the missing configuration once per process, not once per delivery', async () => {
    delete process.env['GMAIL_WEBHOOK_AUDIENCE'];
    for (let i = 0; i < 3; i += 1) {
      await handleGmailWebhook(makeReq({ body: goodBody() }), makeRes());
    }
    const warnings = lines.filter((line) => line.includes('is not configured'));
    assert.equal(warnings.length, 1);
  });

  it('answers 405 to anything that is not a POST', async () => {
    const res = makeRes();
    await handleGmailWebhook(makeReq({ method: 'GET', body: '' }), res);
    assert.equal(res.statusCode, 405);
    assert.deepEqual(triggered, []);
  });

  it('refuses an oversized body before buffering it', async () => {
    const res = makeRes();
    await handleGmailWebhook(
      makeReq({
        body: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1),
        authorization: bearer(liveToken()),
      }),
      res,
    );
    assert.equal(res.statusCode, 413);
    assert.deepEqual(triggered, []);
  });

  it('refuses an oversized Content-Length without reading the stream', async () => {
    const res = makeRes();
    await handleGmailWebhook(
      makeReq({
        body: 'small',
        contentLength: String(MAX_WEBHOOK_BODY_BYTES + 1),
        authorization: bearer(liveToken()),
      }),
      res,
    );
    assert.equal(res.statusCode, 413);
  });

  it('acknowledges an authenticated delivery it cannot parse, rather than asking for it again', async () => {
    // A 400 here makes Pub/Sub redeliver something we can never process until
    // the retention window expires.
    const res = makeRes();
    await handleGmailWebhook(
      makeReq({ body: '{"not":"an envelope"}', authorization: bearer(liveToken()) }),
      res,
    );
    assert.equal(res.statusCode, 204);
    assert.deepEqual(triggered, [], 'nothing to run');
  });

  it('acknowledges an envelope with no history id', async () => {
    const res = makeRes();
    await handleGmailWebhook(
      makeReq({ body: envelope({ emailAddress: 'owner@example.gr' }), authorization: bearer(liveToken()) }),
      res,
    );
    assert.equal(res.statusCode, 204);
    assert.deepEqual(triggered, []);
  });

  it('still answers 204 when starting the run throws', async () => {
    // The acknowledgement is already written; a failure to start is the sweep's
    // problem fifteen minutes later, not Pub/Sub's.
    setInboxTrigger(() => {
      throw new Error('the inbox module is broken');
    });
    const res = makeRes();
    await handleGmailWebhook(makeReq({ body: goodBody(), authorization: bearer(liveToken()) }), res);
    assert.equal(res.statusCode, 204);
  });

  it('never puts the operator mailbox in a log line', async () => {
    await handleGmailWebhook(
      makeReq({ body: goodBody(), authorization: bearer(liveToken()) }),
      makeRes(),
    );
    for (const line of lines) {
      assert.ok(!line.includes('owner@example.gr'), line);
    }
  });
});
