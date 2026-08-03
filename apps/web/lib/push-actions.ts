'use server';

/**
 * The two writes behind the notification toggle. Both exports are Server
 * Actions.
 *
 * ## Why a Server Action and not a route handler
 *
 * Next verifies the `Origin` header against `Host` on every Server Action
 * invocation. A `POST /api/push` under `app/api/` gets none of that, so shipping
 * one would mean inventing a CSRF story for a write that creates a
 * push-notification target — the same argument ./task-actions.ts makes about
 * `signOut`. There is also nothing to `GET` here: this is two writes and no
 * reads, and a route handler is the right shape when a non-browser client needs
 * an endpoint. Nothing here is one.
 *
 * The directive is scoped the way ./settings-actions.ts and ./task-actions.ts
 * scope theirs: the pure half lives in ./push-validation.ts without it, so the
 * client bundle does not publish an action id for anything but these two.
 *
 * ## The endpoint is a capability URL, and that changes two things
 *
 * Anyone holding a push endpoint can push to the operator's browser until it
 * expires. So:
 *
 * 1. **Nothing here logs.** Not the endpoint, not the keys, not in an error
 *    path — the same rule the rest of apps/web holds for a contact's address.
 * 2. **PostgREST's own error message is never returned to the caller.** Every
 *    other action in this app splices `error.message` into its result, and that
 *    is right for a cost cap or a brain key. It is wrong here: a unique
 *    violation on `push_subscriptions.endpoint` can carry the conflicting value
 *    in its detail, and that value is the capability URL. This module returns a
 *    fixed sentence and loses the diagnostic detail deliberately.
 *
 * ## Two smaller decisions
 *
 * **`requireOperator()` runs before validation**, unlike `saveBrainEntry`, which
 * checks its key first. A Server Action is a POST endpoint reachable with a
 * crafted request, and this one writes a row that decides where notifications
 * get delivered — so nothing at all is computed for a caller who is not the
 * operator, not even a verdict on the shape of their input. The anon key under
 * RLS does the rest: `public.is_operator()` is on `push_subscriptions` like
 * every other table.
 *
 * **Nothing calls `revalidatePath`.** No server-rendered surface in this app
 * reads `push_subscriptions` — the toggle's state comes from the browser's own
 * `pushManager.getSubscription()`, which is the only source that can tell the
 * operator about *this* device. Revalidating /brain would re-render a page whose
 * output does not depend on the row that just changed.
 */

import type { Json } from '@agency/core';

import { isPushEndpoint, subscriptionProblem } from './push-validation';
import type { SubscriptionInput } from './push-validation';
import { requireOperator } from './supabase/server';

export type PushActionResult = { ok: true } | { ok: false; error: string };

/** Said to the operator whenever the database refuses. The cause is in Supabase's
 *  own logs, where it does not sit next to a capability URL on a screen. */
const WRITE_FAILED = 'Could not save the subscription. Try again.';
const DELETE_FAILED = 'Could not turn notifications off. Try again.';

/**
 * Store one browser's subscription.
 *
 * **Upsert on `endpoint`, which is the table's unique column.** A browser
 * rotates a subscription on its own schedule — reinstalling the app, clearing
 * site data, or the push service expiring the endpoint — and the toggle
 * re-asserts the row every time /brain is opened. Insert-only would accumulate a
 * row per visit; upsert makes the repeat call free and idempotent.
 *
 * The row shape is `{ endpoint, keys: { p256dh, auth, expirationTime } }`.
 * `web-push` reads `keys.p256dh` and `keys.auth` and ignores the third; keeping
 * `expirationTime` in the same object means the one field that says when this
 * subscription stops working is stored rather than dropped on the floor.
 */
export async function savePushSubscription(input: SubscriptionInput): Promise<PushActionResult> {
  const { supabase } = await requireOperator();

  const problem = subscriptionProblem(input);
  if (problem !== null) return { ok: false, error: problem };

  const keys: Json = {
    p256dh: input.p256dh,
    auth: input.auth,
    expirationTime: input.expirationTime,
  };

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert({ endpoint: input.endpoint, keys }, { onConflict: 'endpoint' });

  if (error !== null) return { ok: false, error: WRITE_FAILED };

  return { ok: true };
}

/**
 * Forget one browser's subscription.
 *
 * The row is what the worker pushes from, so deleting it is the thing that
 * actually stops the notifications — `subscription.unsubscribe()` in the browser
 * is the other half and the toggle does both. Doing only the browser half leaves
 * a row the worker keeps sending to until the push service answers 410; doing
 * only this half leaves a subscription that receives nothing, which is at least
 * what the operator asked for.
 *
 * Deleting a row that is not there is success, not a failure to report: the
 * requested end state is "this browser gets no pushes", and it holds either way.
 * That is also why there is no `.select('id')` here — unlike ./task-actions.ts,
 * where "somebody else already handled it" is a different outcome the operator
 * needs told about, here it is the same outcome.
 */
export async function removePushSubscription(endpoint: string): Promise<PushActionResult> {
  const { supabase } = await requireOperator();

  if (!isPushEndpoint(endpoint)) {
    return { ok: false, error: 'That is not a push endpoint this app stored.' };
  }

  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);

  if (error !== null) return { ok: false, error: DELETE_FAILED };

  return { ok: true };
}
