/**
 * Web Push — PLAN §6 step 7, SPEC §5.
 *
 * One module, two callers. The daily digest (`./digest.ts`) calls it once after
 * the morning run; the inbox agent (step 8) calls it the moment a `new_lead` or
 * an `interested` reply lands. It decides nothing about *when* a notification is
 * warranted — it takes a payload, sends it to every subscription the operator's
 * browsers have registered, and cleans up the ones that are dead.
 *
 * ---------------------------------------------------------------------------
 * Deleting a 410 is the load-bearing behaviour in this file
 * ---------------------------------------------------------------------------
 *
 * A push endpoint dies permanently and without warning: the operator reinstalls
 * Chrome, resets their phone, or the push service expires the subscription. From
 * then on that endpoint answers `410 Gone` forever, and there is no recovery
 * except the operator subscribing again from `/brain`.
 *
 * If the row is left in place, every digest for the rest of this project's life
 * pays one failed HTTP request and logs one failure for a subscription that can
 * never work again. The cost is not the request — it is that `failed` stops
 * meaning anything. A count that is always 1 is a count nobody reads, and a real
 * outage (a push service down, a rejected VAPID key) becomes invisible inside
 * the noise. So 404 and 410 delete the row and are counted separately as
 * `removed`, and `failed` is reserved for things that might work next time.
 *
 * The classification errs the other way for everything it has not been taught:
 * an unknown status is `retry`. A row deleted in error cannot be recovered
 * without the operator noticing that notifications stopped and re-enabling them,
 * which is exactly the kind of silent breakage this repo keeps arguing against.
 * A row retried in error costs one request a day.
 *
 * ---------------------------------------------------------------------------
 * Why the payload carries counts and never customer data
 * ---------------------------------------------------------------------------
 *
 * "New lead from Μαρία at Taverna Ilios" would put a customer's name on a lock
 * screen in a café, and into the browser's notification store on disk, where it
 * outlives the notification. The Web Push payload is end-to-end encrypted, so
 * the push service itself cannot read it — the exposure is the *display*, not
 * the transport, and encryption does not help with a display.
 *
 * So a payload says counts and classes only: "4 follow-ups ready", "New lead".
 * A second benefit follows from the first and is what makes the dry-run line
 * useful: because the payload provably contains no customer data, it is safe to
 * log verbatim.
 *
 * The endpoint is the opposite case. It is a **capability URL** — anyone holding
 * it can push to the operator's browser — so it is never logged, never put on an
 * alert card, and never returned. When a row is dropped the log carries
 * `endpoint_hash`, the first twelve hex characters of its sha256, which is
 * enough to tell two drops apart and useless to anyone who reads the log.
 *
 * ---------------------------------------------------------------------------
 * Decisions this file makes that the contract does not
 * ---------------------------------------------------------------------------
 *
 * **`sendPush` never throws.** A failed push must not fail the run that
 * triggered it. The morning's drafts exist whether or not the phone buzzed, and
 * an exception thrown out of a notification would be a notification failure that
 * loses work — precisely backwards.
 *
 * **The VAPID subject is `mailto:${ALLOWED_EMAIL}` and there is no new
 * environment variable for it.** The spec requires a `mailto:` or `https:`
 * contact the push service can reach if this sender misbehaves, and the
 * operator's own address is exactly that. A `VAPID_SUBJECT` variable would be a
 * second name for a value already in `.env`, and one more thing to set on Railway
 * that fails at 08:00 rather than at boot.
 *
 * **A transport seam (`setPushTransport`).** The contract does not ask for one;
 * it is here because without it the behaviour this module exists for — dropping
 * a 410 rather than retrying it forever — could not be tested at all. `DRY_RUN`
 * sends nothing, so the dry-run path cannot exercise a status code, and the
 * alternative is an integration test against a live push service. The seam is
 * the same shape and the same argument as `setGmailTransport` in
 * `packages/core/src/gmail.ts`.
 *
 * **A TTL of six hours, and `topic` set to the tag.** `web-push` defaults to
 * four weeks of retention. A notification about this morning's four drafts that
 * is delivered on Thursday when the laptop comes back online is worse than no
 * notification: it says something is waiting that the operator dealt with days
 * ago. `topic` lets the push service itself collapse an undelivered notification
 * when a newer one with the same tag arrives, so a laptop that has been shut for
 * three days wakes to one digest and not three.
 *
 * **A row whose `keys` are unusable is counted as `failed`, not dropped.** It
 * can never succeed, so by the argument at the top it ought to be deleted — but
 * the only way to get one is a bug in our own write path, and deleting the
 * operator's subscription because we failed to parse our own column is a
 * destructive answer to a problem a log line fixes. It is logged with its
 * endpoint hash so it is visible rather than silent.
 *
 * **`DRY_RUN=true` sends nothing.** A push leaves the machine, so the house rule
 * applies. Note what it costs: dead subscriptions are never reaped in
 * development, because the reaping is a side effect of a real send.
 *
 * **Missing VAPID keys are a logged no-op, and file a card only when there is
 * somebody to notify.** `apps/worker/src/index.ts` deliberately does not assert
 * these at boot — the worker must still run the 08:00 agent on a machine with no
 * push setup, which is the machine this was built on. But a subscription row can
 * only exist if the web app was served a public key, so rows present *and* keys
 * absent is a genuine half-configured deploy, and that gets one card.
 *
 * ---------------------------------------------------------------------------
 * What the integration agent must register
 * ---------------------------------------------------------------------------
 *
 * Nothing. This module has no route, no timer and no `/health` entry: it is
 * called by `./digest.ts` once a morning and by the inbox agent when a
 * `new_lead` or an `interested` reply lands. `VAPID_PUBLIC_KEY` and
 * `VAPID_PRIVATE_KEY` must **not** go into `validateEnv()`, for the reason in
 * the last paragraph above.
 */

import { createHash } from 'node:crypto';

import webpush from 'web-push';

import {
  assertEnv,
  createServiceClient,
  isDryRun,
  MissingEnvError,
  requireEnv,
  webPushEnv,
} from '@agency/core';
import type { Db, TaskInsert } from '@agency/core';

import { AlertOnce } from './send-queue-policy.js';

const AGENT = 'push';

export const PUSH_TAGS = ['digest', 'inbox'] as const;
export type PushTag = (typeof PUSH_TAGS)[number];

export type PushPayload = {
  /** Counts and classes only. Never a name, address, subject or body. */
  title: string;
  body: string;
  /** Where a click lands. '/' or '/inbox'. */
  url: string;
  /** Collapse key: a second push with the same tag replaces the first. */
  tag: PushTag;
};

export type PushOutcome = {
  subscriptions: number;
  sent: number;
  /** 404/410 — the subscription was dead and its row has been deleted. */
  removed: number;
  /** Left in place for the next push: 429, 5xx, a transport failure. */
  failed: number;
  dryRun: boolean;
};

/** The seam both callers depend on, so a test can pass a recorder. */
export type PushSender = (payload: PushPayload, options?: { db?: Db }) => Promise<PushOutcome>;

/**
 * Subscriptions one push will fan out to.
 *
 * One operator with a laptop and a phone is two rows. Twenty is a ceiling
 * against a bug in the subscribe path — a browser that rotates its endpoint on
 * every page load, an upsert that stops upserting — not a design for a team.
 */
export const MAX_SUBSCRIPTIONS = 20;

/** See the header. Four weeks is the library default and is far too long. */
export const PUSH_TTL_SECONDS = 6 * 60 * 60;

/**
 * The three variables a real send needs. `ALLOWED_EMAIL` is the VAPID subject;
 * the two keys are the identity the push service checks the signature against.
 */
const PUSH_ENV_VARS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'ALLOWED_EMAIL'] as const;

/** SPEC §7: level 1 is the only level v1 operates at. Descriptive, not a permission. */
const ALERT_AUTONOMY_LEVEL = 1;

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

/**
 * What actually puts the bytes on the wire.
 *
 * `subscription` is deliberately the shape `web-push` wants and not the database
 * row: the row's `keys` column is `jsonb` and untyped at rest, so it is parsed
 * and narrowed before it gets anywhere near here.
 */
export type PushTransport = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: { topic: PushTag; ttlSeconds: number },
) => Promise<void>;

const realTransport: PushTransport = async (subscription, payload, options) => {
  const { publicKey, privateKey } = webPushEnv();
  await webpush.sendNotification(subscription, payload, {
    TTL: options.ttlSeconds,
    topic: options.topic,
    urgency: 'normal',
    vapidDetails: {
      subject: `mailto:${requireEnv('ALLOWED_EMAIL')}`,
      publicKey,
      privateKey,
    },
  });
};

let transport: PushTransport | null = null;

/** Test seam. Pass null to restore the real one. */
export function setPushTransport(next: PushTransport | null): void {
  transport = next;
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/**
 * What a push service's status code means for the row that produced it.
 *
 * | 404, 410   | drop  | the endpoint is gone forever — delete the row       |
 * | 429, ≥500  | retry | the service is busy or broken; the row is fine       |
 * | 400/401/403| alert | our VAPID keys are wrong; every row will fail alike  |
 * | otherwise  | retry | the safe direction — see the file header             |
 */
export function classifyPushFailure(status: number | undefined): 'drop' | 'retry' | 'alert' {
  if (status === 404 || status === 410) return 'drop';
  if (status === 429) return 'retry';
  if (status !== undefined && status >= 500) return 'retry';
  if (status === 400 || status === 401 || status === 403) return 'alert';
  return 'retry';
}

/**
 * The classes that interrupt the operator, and what the interruption says.
 *
 * This is §7.6's immediate/deferred decision expressed once, as a function, so
 * the inbox agent calls it rather than restating the rule. Everything it returns
 * null for is not dropped — it is deferred to the digest, which counts pending
 * tasks at digest time and therefore picks up a task filed at 15:00 the previous
 * day for free. That is why there is no notification queue and no `notify_after`
 * column: two mechanisms answering "is there something waiting" from the same
 * table cannot drift apart.
 *
 * The copy is a judgement call the contract fixes for the title and leaves loose
 * for the body: §7.4 writes the body as "Open Today to read it" while §7.6 sends
 * the click to `/inbox`. A notification whose words and whose destination
 * disagree teaches the operator to distrust both, so the body names the page the
 * click actually opens.
 */
export const IMMEDIATE_CLASSES = ['new_lead', 'interested'] as const;

export function immediatePush(inboundClass: string): PushPayload | null {
  if (inboundClass === 'new_lead') {
    return { title: 'New lead', body: 'Open the inbox to read it.', url: '/inbox', tag: 'inbox' };
  }
  if (inboundClass === 'interested') {
    return {
      title: 'A reply is waiting',
      body: 'Open the inbox to read it.',
      url: '/inbox',
      tag: 'inbox',
    };
  }
  return null;
}

/**
 * Twelve hex characters of sha256.
 *
 * Enough to tell two subscriptions apart across log lines; useless to anyone who
 * reads the log, which is the whole point — the endpoint itself is a capability
 * URL and must never be written down.
 */
export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 12);
}

/**
 * The `keys` jsonb column, narrowed.
 *
 * Written by a Server Action that validates both halves, and read here as if it
 * had not been: it is `jsonb`, it is untyped at rest, and a hand-edited row must
 * not throw inside a loop that is holding a notification for two other browsers.
 */
export function readSubscriptionKeys(keys: unknown): { p256dh: string; auth: string } | null {
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return null;
  const record = keys as Record<string, unknown>;
  const p256dh = record['p256dh'];
  const auth = record['auth'];
  if (typeof p256dh !== 'string' || p256dh === '') return null;
  if (typeof auth !== 'string' || auth === '') return null;
  return { p256dh, auth };
}

/**
 * The status a push service rejection carries.
 *
 * Read off the object rather than through `instanceof WebPushError`: the error
 * crosses a CommonJS/ESM boundary, a second copy of the package in a future
 * install would break the identity check silently, and reading a numeric
 * property is the same amount of code with none of that risk.
 */
export function pushErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

/**
 * One card per problem per process. Without it, an inbound burst with a rejected
 * VAPID key files one card per message per browser, and the cards the operator
 * needs are underneath them.
 */
const processAlerts = new AlertOnce();

/** Test seam, in the same spirit as `resetAccessTokenCache()` in `gmail.ts`. */
export function resetPushAlerts(): void {
  processAlerts.reset();
}

function log(message: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), agent: AGENT, message, ...extra }));
}

type SubscriptionRow = { id: string; endpoint: string; keys: unknown };

export const sendPush: PushSender = async (payload, options = {}) => {
  const outcome: PushOutcome = {
    subscriptions: 0,
    sent: 0,
    removed: 0,
    failed: 0,
    dryRun: isDryRun(),
  };

  try {
    const db = options.db ?? createServiceClient();
    const rows = await loadSubscriptions(db);
    outcome.subscriptions = rows.length;

    if (rows.length === 0) {
      // Once per process. The ordinary state of a fresh install is "nobody has
      // enabled notifications yet", and a line about it every morning and after
      // every inbound message is a line nobody reads.
      if (processAlerts.claim('no-subscriptions')) {
        log('no push subscriptions — nothing to notify', { tag: payload.tag });
      }
      return outcome;
    }

    if (outcome.dryRun) {
      // Logged verbatim on purpose: the payload provably holds no customer data
      // (see the header), and the whole value of a dry run is reading what would
      // have been sent.
      log('push stubbed', {
        dry_run: true,
        tag: payload.tag,
        subscriptions: outcome.subscriptions,
        title: payload.title,
        body: payload.body,
        url: payload.url,
      });
      return outcome;
    }

    const missing = missingPushConfig();
    if (missing.length > 0) {
      log('web push is not configured — nothing was sent', {
        tag: payload.tag,
        subscriptions: outcome.subscriptions,
        missing,
      });
      if (processAlerts.claim('push-config')) {
        await fileAlert(
          db,
          'Notifications are not configured',
          `${outcome.subscriptions} browser${outcome.subscriptions === 1 ? ' is' : 's are'} ` +
            `subscribed to notifications, but ${missing.join(', ')} ${
              missing.length === 1 ? 'is' : 'are'
            } not set on the worker, so nothing can be delivered. Nothing else is affected — ` +
            'drafts are still on Today. See PLAN.md §8.',
        );
      }
      return outcome;
    }

    const body = JSON.stringify(payload);
    const send = transport ?? realTransport;

    for (const row of rows) {
      const keys = readSubscriptionKeys(row.keys);
      if (keys === null) {
        outcome.failed += 1;
        log('a push subscription has unusable keys and was left alone', {
          endpoint_hash: endpointHash(row.endpoint),
        });
        continue;
      }

      try {
        await send({ endpoint: row.endpoint, keys }, body, {
          topic: payload.tag,
          ttlSeconds: PUSH_TTL_SECONDS,
        });
        outcome.sent += 1;
      } catch (error) {
        const status = pushErrorStatus(error);
        const verdict = classifyPushFailure(status);

        if (verdict === 'drop') {
          const deleted = await deleteSubscription(db, row.endpoint);
          if (deleted) {
            outcome.removed += 1;
            log('dropped a dead push subscription', {
              endpoint_hash: endpointHash(row.endpoint),
              status,
            });
          } else {
            // The endpoint is gone and the row is still there, so the next push
            // pays for it again. Counted as failed rather than removed because
            // that is what actually happened.
            outcome.failed += 1;
          }
          continue;
        }

        outcome.failed += 1;
        log('a push was rejected', {
          endpoint_hash: endpointHash(row.endpoint),
          status,
          verdict,
        });

        if (verdict === 'alert' && processAlerts.claim(`push-rejected:${status ?? 'unknown'}`)) {
          await fileAlert(
            db,
            'Notifications are being rejected',
            `The push service rejected a notification with status ${status ?? 'unknown'}. That is ` +
              'a problem with the VAPID keys on the worker rather than with any one browser, so ' +
              'no notifications are arriving at all. Check VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY ' +
              'against the pair the browser subscribed with — regenerating one without the other ' +
              'is the usual cause. Nothing else is affected.',
          );
        }
      }
    }

    log('push finished', {
      tag: payload.tag,
      subscriptions: outcome.subscriptions,
      sent: outcome.sent,
      removed: outcome.removed,
      failed: outcome.failed,
    });
    return outcome;
  } catch (error) {
    // Never throws: the caller is a run whose real work is already done.
    log('push failed', {
      tag: payload.tag,
      error: error instanceof Error ? error.message : String(error),
    });
    return outcome;
  }
};

async function loadSubscriptions(db: Db): Promise<SubscriptionRow[]> {
  const { data, error } = await db
    .from('push_subscriptions')
    .select('id, endpoint, keys')
    .limit(MAX_SUBSCRIPTIONS);

  if (error) throw new Error(`Failed to read push subscriptions: ${error.message}`);
  return (data ?? []) as SubscriptionRow[];
}

/**
 * Deleted by endpoint rather than by id: `endpoint` is the unique column the
 * subscribe path upserts on, so it is the identity of a subscription even if the
 * row was replaced between the select and this delete.
 */
async function deleteSubscription(db: Db, endpoint: string): Promise<boolean> {
  try {
    const { error } = await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) {
      log('failed to delete a dead push subscription', {
        endpoint_hash: endpointHash(endpoint),
        error: error.message,
      });
      return false;
    }
    return true;
  } catch (error) {
    log('failed to delete a dead push subscription', {
      endpoint_hash: endpointHash(endpoint),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Variable names, never values. A name is not a secret; a key is. */
function missingPushConfig(): string[] {
  try {
    assertEnv(PUSH_ENV_VARS, 'web push');
    return [];
  } catch (error) {
    if (error instanceof MissingEnvError) return [...error.missing];
    return [...PUSH_ENV_VARS];
  }
}

/**
 * SPEC §8: an error never disappears silently.
 *
 * Best-effort, exactly as in `send-queue.ts`: if the database is the broken
 * thing then this insert fails too, and throwing out of a notification's error
 * handler would turn a failed push into a failed morning run.
 */
async function fileAlert(db: Db, title: string, reasoning: string): Promise<void> {
  const task: TaskInsert = {
    agent: AGENT,
    type: 'alert',
    contact_id: null,
    title,
    reasoning,
    status: 'pending',
    autonomy_level: ALERT_AUTONOMY_LEVEL,
  };

  try {
    const { error } = await db.from('tasks').insert(task);
    if (error) log('failed to file an alert task', { title, error: error.message });
  } catch (error) {
    log('failed to file an alert task', {
      title,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
