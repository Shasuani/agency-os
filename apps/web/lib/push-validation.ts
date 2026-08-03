/**
 * The pure half of step 7's web side: everything about a push subscription that
 * can be decided without a network, a database or a browser.
 *
 * Three things live here and they are here for one reason each.
 *
 * **The validators**, because `savePushSubscription` is a write reachable from a
 * browser and a Server Action is a POST endpoint that can be invoked with a
 * crafted request. What the toggle passes in comes from `PushSubscription.
 * toJSON()`, which is trustworthy; what the *action* receives is whatever the
 * request body said it was. The action therefore checks shape before it writes,
 * and the check is in a module with no I/O so it is covered by a test rather
 * than by hoping.
 *
 * **The VAPID key decode**, because `pushManager.subscribe()` wants the
 * application server key as bytes and the deploy holds it as base64url. A wrong
 * key does not fail at subscribe time in any useful way — Chrome accepts a
 * malformed one and the push service rejects the *send* days later, at which
 * point the failure is a 400 in the worker's logs and nothing on the operator's
 * screen. Decoding here, up front, turns that into a sentence on /brain.
 *
 * **The state machine**, because the states this control has to get right are
 * exactly the ones nobody exercises by hand: permission denied, a deploy with no
 * VAPID key, a browser that cannot do push at all, a permission that was granted
 * while the subscription went missing. In a `useEffect` none of that is
 * testable — this repo's tests are node:test with no DOM. As a pure function
 * over five booleans it is, and the component is left as wiring.
 *
 * ## The endpoint is a capability URL
 *
 * Anyone holding a push endpoint can push to the operator's browser. It is never
 * logged, never rendered, and never echoed back inside an error string — which
 * is why every message below describes the *shape* of a value and never contains
 * one. That rule is the reason `subscriptionProblem` returns prose rather than
 * the offending input, and the reason ./push-actions.ts does not splice
 * PostgREST's error message into its result.
 *
 * ## Why the key checks are arithmetic rather than a decode
 *
 * `p256dh` and `auth` are stored verbatim and handed to `web-push` exactly as
 * the browser produced them — nothing in this system re-encodes them — so the
 * only thing worth asserting is that they are the right *size*, and the length
 * of a base64 string decides that exactly. 65 bytes is a P-256 public point
 * (`0x04` and two 32-byte coordinates); 16 bytes is the auth secret RFC 8291
 * specifies. A key of the wrong size does not fail on save; it fails much later
 * inside the encryption step of a send, with a subscription row that looks fine.
 *
 * The alphabet check accepts `+` and `/` as well as `-` and `_`. The Push API
 * serialises to base64url and every browser in scope does, but locking the
 * operator out of notifications to enforce a spelling this code never depends on
 * would be the wrong trade.
 *
 * Types only from @agency/core — in fact none at all — so this module is safe in
 * the client bundle, the same property lib/contact-vocab.ts has. A value import
 * from the barrel would drag the Supabase client factories into the browser.
 */

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/**
 * A ceiling on the endpoint, not a specification of one. Real endpoints are
 * 150–400 characters; this exists so a Server Action cannot be talked into
 * writing a megabyte into a `text` column that has no length limit of its own.
 */
export const MAX_ENDPOINT_CHARS = 2000;

/** P-256 uncompressed point: `0x04` plus two 32-byte coordinates. */
export const P256_KEY_BYTES = 65;

/** RFC 8291's auth secret. */
export const AUTH_SECRET_BYTES = 16;

/** The first byte of an uncompressed elliptic-curve point. */
const UNCOMPRESSED_POINT_TAG = 0x04;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** What the toggle sends and what ./push-actions.ts writes. */
export type SubscriptionInput = {
  endpoint: string;
  /** base64url, 65 bytes decoded. */
  p256dh: string;
  /** base64url, 16 bytes decoded. */
  auth: string;
  expirationTime: number | null;
};

/** https, parses, under the cap. */
export function isPushEndpoint(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_ENDPOINT_CHARS) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // http: would mean a push service reachable in clear text, which no browser
  // hands out and which we would have no reason to store.
  return url.protocol === 'https:';
}

/**
 * True when `value` is base64 (either alphabet, optional padding) decoding to
 * exactly `bytes` bytes.
 *
 * The arithmetic: an unpadded base64 body of length L carries
 * `floor(L * 3 / 4)` bytes, and `L % 4 === 1` is not a length base64 can
 * produce at all.
 */
export function isBase64UrlOfBytes(value: unknown, bytes: number): boolean {
  if (typeof value !== 'string') return false;

  const match = /^([A-Za-z0-9\-_+/]+)(={0,2})$/.exec(value);
  if (match === null) return false;

  const body = match[1];
  if (body === undefined) return false;
  if (body.length % 4 === 1) return false;

  return Math.floor((body.length * 3) / 4) === bytes;
}

/**
 * `null` when the input is a subscription this app can store and the worker can
 * push to; otherwise one sentence the operator can read.
 *
 * Every branch is worded about the browser rather than about the operator: none
 * of these is something they did, and "invalid input" on a control they clicked
 * once tells them nothing about what to do next.
 */
export function subscriptionProblem(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return 'The browser did not return a usable subscription.';
  }

  const candidate = input as Partial<Record<keyof SubscriptionInput, unknown>>;

  if (!isPushEndpoint(candidate.endpoint)) {
    return 'The browser returned a subscription with no usable endpoint.';
  }
  if (!isBase64UrlOfBytes(candidate.p256dh, P256_KEY_BYTES)) {
    return 'The browser returned a subscription whose encryption key is the wrong size.';
  }
  if (!isBase64UrlOfBytes(candidate.auth, AUTH_SECRET_BYTES)) {
    return 'The browser returned a subscription whose auth secret is the wrong size.';
  }

  // `expirationTime` is null on every browser in scope. It is carried through
  // rather than dropped because the column is jsonb and a future browser that
  // does set it would otherwise have the one field that says when this stops
  // working silently discarded.
  const expiry = candidate.expirationTime;
  if (expiry !== null && expiry !== undefined) {
    if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry < 0) {
      return 'The browser returned a subscription with an expiry this app cannot read.';
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// The VAPID key
// ---------------------------------------------------------------------------

/**
 * The deploy's `VAPID_PUBLIC_KEY` as the bytes `pushManager.subscribe()` wants,
 * or `null` when it is not a usable key.
 *
 * Returning null rather than throwing is the point: this runs inside a click
 * handler, and a thrown error there is a console line nobody reads and a button
 * that appears to do nothing. Null becomes a sentence saying the deploy is
 * misconfigured, which is the one thing the operator can act on.
 *
 * The `0x04` check is worth the two lines. A base64url string of exactly 65
 * bytes that is not an uncompressed P-256 point is almost certainly a key pasted
 * with a character missing, and the alternative to catching it here is a push
 * service returning 400 on every send for a subscription that looks healthy in
 * the database.
 *
 * The return type spells out `Uint8Array<ArrayBuffer>` rather than the bare
 * `Uint8Array`: since TypeScript 5.7 the bare form is
 * `Uint8Array<ArrayBufferLike>`, which includes `SharedArrayBuffer` and is
 * therefore not assignable to the `BufferSource` that `pushManager.subscribe()`
 * takes. The array really is backed by a plain `ArrayBuffer`; this says so.
 */
export function decodeVapidKey(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!isBase64UrlOfBytes(trimmed, P256_KEY_BYTES)) return null;

  const standard = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), '=');

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }

  if (binary.length !== P256_KEY_BYTES) return null;

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  if (bytes[0] !== UNCOMPRESSED_POINT_TAG) return null;

  return bytes;
}

// ---------------------------------------------------------------------------
// What the control is showing
// ---------------------------------------------------------------------------

/** `Notification.permission`, named so this module needs no DOM lib. */
export type PushPermission = 'default' | 'granted' | 'denied';

export type PushStateInput = {
  /**
   * False until the mount effect has run. The server render and the first client
   * paint know none of the rest, and a control that renders "Enable
   * notifications" and then flips to "Turn off" a frame later has lied twice.
   */
  checked: boolean;
  /** `serviceWorker` in navigator && `PushManager` in window && `Notification` in window. */
  supported: boolean;
  /** VAPID_PUBLIC_KEY is set on this deploy *and* decodes. */
  configured: boolean;
  permission: PushPermission | null;
  /** A live `PushSubscription` exists in this browser for this origin. */
  subscribed: boolean;
};

/**
 * The seven states this control can actually be in. There is no eighth, and
 * none of them is "the button does nothing".
 */
export type PushStateKind =
  /** The mount effect has not finished. */
  | 'checking'
  /** This browser cannot do Web Push. Nothing to offer. */
  | 'unsupported'
  /** No usable VAPID key on this deploy. Nothing to offer. */
  | 'unconfigured'
  /** Subscribed on this device. The only state with an off switch. */
  | 'subscribed'
  /** Permission denied. Terminal until the operator clears it in site settings. */
  | 'blocked'
  /** Permission already granted but no subscription — a failed attempt, or a
   *  browser that rotated one away. */
  | 'granted_not_subscribed'
  /** Supported, configured, never asked. */
  | 'off';

/**
 * Order matters, and two of the rungs are judgement calls the spec does not
 * make.
 *
 * **`unsupported` outranks `unconfigured`** because it is a fact about the
 * machine in front of the operator. Telling somebody on a browser that has no
 * `PushManager` to go and set an environment variable sends them to fix
 * something that would not help.
 *
 * **`subscribed` outranks `blocked`** because a device holding a live
 * subscription must always be offered the way to remove it. Revoking permission
 * in Chrome or Firefox drops the subscription too, so the pair is close to
 * unreachable — but if it ever happens, the state that hides the off switch is
 * the state that strands a row the worker keeps pushing to.
 *
 * `granted_not_subscribed` exists as its own rung rather than collapsing into
 * `off` because the sentence the operator needs is different: the browser has
 * already agreed, so a second click will not prompt, and what failed was the
 * subscribe or the save.
 */
export function derivePushState(input: PushStateInput): PushStateKind {
  if (!input.checked) return 'checking';
  if (!input.supported) return 'unsupported';
  if (!input.configured) return 'unconfigured';
  if (input.subscribed) return 'subscribed';
  if (input.permission === 'denied') return 'blocked';
  if (input.permission === 'granted') return 'granted_not_subscribed';
  return 'off';
}

/** True for the three states that carry a button. Everything else is prose, on
 *  purpose: a control the operator can click that cannot succeed is worse than
 *  no control and a sentence saying why. */
export function isActionable(kind: PushStateKind): boolean {
  return kind === 'off' || kind === 'granted_not_subscribed' || kind === 'subscribed';
}
