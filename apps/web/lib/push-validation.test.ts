/**
 * Tests for the pure half of step 7.
 *
 * These cover the three things that have no other way of being exercised. The
 * toggle itself is a `useEffect` and three browser APIs; the Server Action needs
 * a session and a database. What is left — and it is where the bugs are — is
 * whether a malformed subscription is refused before it is written, whether a
 * base64url VAPID key becomes the right 65 bytes, and whether the control shows
 * the honest state for each of the five ways this feature can be unavailable.
 *
 * The permission cases are the reason this file exists. A denied permission is
 * terminal — the browser will not prompt again — and the failure that matters is
 * a button that answers a click by doing nothing at all. That is a state
 * transition, so it is asserted rather than eyeballed.
 *
 * No network, no database, no key. The VAPID sample below is a throwaway P-256
 * public point generated for this file; it is a public key by construction and
 * corresponds to no deploy.
 *
 * Run: `pnpm --filter @agency/web test`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_SECRET_BYTES,
  MAX_ENDPOINT_CHARS,
  P256_KEY_BYTES,
  decodeVapidKey,
  derivePushState,
  isActionable,
  isBase64UrlOfBytes,
  isPushEndpoint,
  subscriptionProblem,
} from './push-validation';
import type { PushStateInput } from './push-validation';

/** 65 bytes, first byte 0x04. Throwaway. */
const VAPID_KEY = 'BBy7bCNALcX35haE4Y8Xb0XNXSFqd7BkHBRRHxnjK5vHoRCNQTqV7g7Kkj2ZZWeX7PlVx5x0vWoKqgKFqIByPGI';

/** The same 65 bytes with the point tag changed from 0x04 to 0x03. */
const VAPID_KEY_BAD_TAG =
  'Axy7bCNALcX35haE4Y8Xb0XNXSFqd7BkHBRRHxnjK5vHoRCNQTqV7g7Kkj2ZZWeX7PlVx5x0vWoKqgKFqIByPGI';

const P256DH = VAPID_KEY;
const AUTH = 'gfuyWwqNFKsQpNitgIrr_g';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dGhpcy1pcy1ub3QtcmVhbA';

function subscription(overrides: Record<string, unknown> = {}): unknown {
  return { endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH, expirationTime: null, ...overrides };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

test('isPushEndpoint takes an https URL and nothing else', () => {
  assert.equal(isPushEndpoint(ENDPOINT), true);
  assert.equal(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAAA'), true);

  assert.equal(isPushEndpoint('http://fcm.googleapis.com/fcm/send/x'), false);
  assert.equal(isPushEndpoint('javascript:alert(1)'), false);
  assert.equal(isPushEndpoint('/fcm/send/x'), false);
  assert.equal(isPushEndpoint(''), false);
  assert.equal(isPushEndpoint(null), false);
  assert.equal(isPushEndpoint(undefined), false);
  assert.equal(isPushEndpoint(42), false);
});

test('isPushEndpoint refuses anything longer than the cap', () => {
  // The column is `text` and the action is a POST endpoint: without a cap the
  // only limit on what gets written is what fits in a request body.
  const long = `https://fcm.googleapis.com/fcm/send/${'a'.repeat(MAX_ENDPOINT_CHARS)}`;
  assert.equal(long.length > MAX_ENDPOINT_CHARS, true);
  assert.equal(isPushEndpoint(long), false);

  const atCap = `https://x.example/${'a'.repeat(MAX_ENDPOINT_CHARS - 'https://x.example/'.length)}`;
  assert.equal(atCap.length, MAX_ENDPOINT_CHARS);
  assert.equal(isPushEndpoint(atCap), true);
});

// ---------------------------------------------------------------------------
// Key sizes
// ---------------------------------------------------------------------------

test('isBase64UrlOfBytes counts bytes, not characters', () => {
  assert.equal(isBase64UrlOfBytes(P256DH, P256_KEY_BYTES), true);
  assert.equal(isBase64UrlOfBytes(AUTH, AUTH_SECRET_BYTES), true);

  // One character short is 64 bytes, which is a key web-push cannot encrypt to.
  assert.equal(isBase64UrlOfBytes(P256DH.slice(0, -1), P256_KEY_BYTES), false);
  assert.equal(isBase64UrlOfBytes(`${P256DH}A`, P256_KEY_BYTES), false);
  assert.equal(isBase64UrlOfBytes(AUTH.slice(0, -1), AUTH_SECRET_BYTES), false);
});

test('isBase64UrlOfBytes accepts both alphabets and optional padding', () => {
  // Deliberate: these strings are stored verbatim and never re-encoded, so
  // refusing a browser that spells base64 the other way would cost the operator
  // notifications to enforce nothing.
  const standard = AUTH.replace(/-/g, '+').replace(/_/g, '/');
  assert.equal(isBase64UrlOfBytes(standard, AUTH_SECRET_BYTES), true);
  assert.equal(isBase64UrlOfBytes(`${AUTH}==`, AUTH_SECRET_BYTES), true);
});

test('isBase64UrlOfBytes refuses characters base64 cannot contain', () => {
  assert.equal(isBase64UrlOfBytes(`${AUTH.slice(0, -1)}!`, AUTH_SECRET_BYTES), false);
  assert.equal(isBase64UrlOfBytes(`${AUTH.slice(0, -1)} `, AUTH_SECRET_BYTES), false);
  assert.equal(isBase64UrlOfBytes('', AUTH_SECRET_BYTES), false);
  assert.equal(isBase64UrlOfBytes(null, AUTH_SECRET_BYTES), false);
  assert.equal(isBase64UrlOfBytes({ length: 22 }, AUTH_SECRET_BYTES), false);
});

// ---------------------------------------------------------------------------
// The payload the Server Action writes
// ---------------------------------------------------------------------------

test('subscriptionProblem accepts what a browser actually produces', () => {
  assert.equal(subscriptionProblem(subscription()), null);
  assert.equal(subscriptionProblem(subscription({ expirationTime: 1_800_000_000_000 })), null);
});

test('subscriptionProblem rejects each field independently', () => {
  assert.notEqual(subscriptionProblem(subscription({ endpoint: 'http://x.example/a' })), null);
  assert.notEqual(subscriptionProblem(subscription({ p256dh: AUTH })), null);
  assert.notEqual(subscriptionProblem(subscription({ auth: P256DH })), null);
  assert.notEqual(subscriptionProblem(subscription({ expirationTime: 'soon' })), null);
  assert.notEqual(subscriptionProblem(subscription({ expirationTime: Number.NaN })), null);
  assert.notEqual(subscriptionProblem(subscription({ expirationTime: -1 })), null);
});

test('subscriptionProblem survives anything at all being posted to it', () => {
  // It is a Server Action argument: the request body decides what arrives here.
  for (const input of [null, undefined, 'endpoint', 7, [], true, Object.create(null)]) {
    assert.notEqual(subscriptionProblem(input), null);
  }
});

test('a problem sentence never contains the endpoint', () => {
  // The endpoint is a capability URL. It reaches no log, no error string and no
  // screen — including the error strings produced when it is the broken field.
  const secret = 'https://fcm.googleapis.com/fcm/send/SECRET-CAPABILITY-TOKEN';
  const problems = [
    subscriptionProblem(subscription({ endpoint: `${secret}${'x'.repeat(MAX_ENDPOINT_CHARS)}` })),
    subscriptionProblem(subscription({ endpoint: secret, p256dh: 'nope' })),
    subscriptionProblem(subscription({ endpoint: secret, auth: 'nope' })),
  ];

  for (const problem of problems) {
    assert.notEqual(problem, null);
    assert.equal(problem?.includes('SECRET-CAPABILITY-TOKEN'), false);
    assert.equal(problem?.includes('fcm.googleapis.com'), false);
  }
});

// ---------------------------------------------------------------------------
// The VAPID key
// ---------------------------------------------------------------------------

test('decodeVapidKey returns the 65 bytes subscribe() wants', () => {
  const bytes = decodeVapidKey(VAPID_KEY);
  assert.notEqual(bytes, null);
  assert.equal(bytes?.length, P256_KEY_BYTES);
  assert.equal(bytes?.[0], 0x04);
});

test('decodeVapidKey tolerates the whitespace an env var picks up', () => {
  const bytes = decodeVapidKey(`  ${VAPID_KEY}\n`);
  assert.deepEqual(bytes, decodeVapidKey(VAPID_KEY));
});

test('decodeVapidKey returns null rather than throwing on a bad key', () => {
  // It runs inside a click handler. A throw there is a console line nobody
  // reads and a button that appears to do nothing.
  assert.equal(decodeVapidKey(null), null);
  assert.equal(decodeVapidKey(''), null);
  assert.equal(decodeVapidKey('   '), null);
  assert.equal(decodeVapidKey(VAPID_KEY.slice(0, -1)), null, 'a key one character short');
  assert.equal(decodeVapidKey(`${VAPID_KEY}A`), null, 'a key one character long');
  assert.equal(decodeVapidKey(AUTH), null, 'the auth secret pasted into the wrong variable');
  assert.equal(decodeVapidKey(VAPID_KEY_BAD_TAG), null, 'not an uncompressed point');
});

// ---------------------------------------------------------------------------
// What the operator is looking at
// ---------------------------------------------------------------------------

const READY: PushStateInput = {
  checked: true,
  supported: true,
  configured: true,
  permission: 'default',
  subscribed: false,
};

test('derivePushState says nothing before the browser has been asked', () => {
  assert.equal(derivePushState({ ...READY, checked: false }), 'checking');
  // Even when everything else already looks decided: the server render cannot
  // know any of it, and a control that flips a frame after paint has lied once.
  assert.equal(
    derivePushState({ ...READY, checked: false, permission: 'granted', subscribed: true }),
    'checking',
  );
});

test('derivePushState reports an unsupported browser ahead of a missing key', () => {
  assert.equal(derivePushState({ ...READY, supported: false }), 'unsupported');
  assert.equal(
    derivePushState({ ...READY, supported: false, configured: false }),
    'unsupported',
    'sending somebody whose browser has no PushManager to go and set an env var fixes nothing',
  );
});

test('derivePushState reports a deploy with no usable VAPID key', () => {
  assert.equal(derivePushState({ ...READY, configured: false }), 'unconfigured');
});

test('derivePushState reports a denied permission as its own state', () => {
  // Terminal: the browser will not prompt again, so this must never render an
  // enable button. That is the whole reason this state is named.
  assert.equal(derivePushState({ ...READY, permission: 'denied' }), 'blocked');
  assert.equal(isActionable('blocked'), false);
});

test('derivePushState separates "granted but not subscribed" from "never asked"', () => {
  // The failure this distinguishes: permission granted, then subscribe or the
  // save threw. A second click will not prompt, so the sentence must not imply
  // it will.
  assert.equal(derivePushState({ ...READY, permission: 'granted' }), 'granted_not_subscribed');
  assert.equal(derivePushState({ ...READY, permission: 'default' }), 'off');
  assert.equal(derivePushState({ ...READY, permission: null }), 'off');
});

test('derivePushState always offers the off switch to a subscribed device', () => {
  assert.equal(derivePushState({ ...READY, subscribed: true, permission: 'granted' }), 'subscribed');
  assert.equal(
    derivePushState({ ...READY, subscribed: true, permission: 'denied' }),
    'subscribed',
    'a live subscription with no way to remove it is a row the worker keeps pushing to',
  );
});

test('isActionable marks exactly the states with a working button', () => {
  assert.deepEqual(
    (['checking', 'unsupported', 'unconfigured', 'subscribed', 'blocked', 'granted_not_subscribed', 'off'] as const).filter(
      isActionable,
    ),
    ['subscribed', 'granted_not_subscribed', 'off'],
  );
});
