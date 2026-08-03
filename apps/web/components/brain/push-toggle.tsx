'use client';

/**
 * The notification switch (PLAN §6 step 7). One control, seven states, and the
 * point of the whole file is that none of the seven is a button that does
 * nothing.
 *
 * Web Push has more ways to be unavailable than anything else in this app, and
 * every one of them looks identical from the operator's side — they click, and
 * no notification ever arrives. So the states are derived by
 * `derivePushState` in lib/push-validation.ts, which is a pure function with a
 * test, and this component is wiring plus the sentence each state deserves.
 *
 * ## Four decisions
 *
 * **Permission is requested from the click and never on mount.** Browsers count
 * a prompt shown without a gesture against the origin, and Chrome will suppress
 * the permission UI entirely for a site that does it. Mounting registers the
 * service worker and reads the existing subscription — neither prompts — and
 * `Notification.requestPermission()` runs only inside `enable`.
 *
 * **A denied permission is stated as terminal.** The browser will not ask again;
 * the block has to be cleared in site settings. Rendering an enable button in
 * that state produces a control that swallows clicks silently, which is exactly
 * the failure this screen exists to avoid — so `blocked` renders prose and no
 * button, and says where the setting is.
 *
 * **A failed save undoes the browser subscription.** If `savePushSubscription`
 * comes back with an error, this unsubscribes before reporting it. A browser
 * subscription with no row in `push_subscriptions` is a subscription nothing
 * will ever push to, and leaving it in place would leave the control saying
 * "on" for something that is off.
 *
 * **Opening this page repairs a rotated subscription.** A browser can retire an
 * endpoint and issue a new one on its own — after a reinstall, a permission
 * change, or a push-service expiry — and a service worker cannot re-register it
 * because it can reach neither the VAPID key nor an authenticated write. So the
 * mount effect re-asserts whatever subscription this browser currently holds.
 * `savePushSubscription` upserts on the endpoint, so the common case (nothing
 * rotated) is one idempotent write and the rotated case heals the moment /brain
 * is opened. Without it the control would read "subscribed" from the browser
 * while the row the worker sends from pointed at a dead endpoint.
 *
 * One state this control cannot see, stated because somebody will hit it: if the
 * deploy's VAPID pair is rotated, subscriptions made with the old public key
 * keep looking healthy in the browser and start failing in the worker with a
 * 403. The fix from here is Turn off and then Enable — the first drops the row
 * and the browser subscription, the second makes one against the new key.
 *
 * The endpoint is a capability URL: it is never rendered here and never put in
 * an error message. Every string below describes a state, not a value.
 */

import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { removePushSubscription, savePushSubscription } from '@/lib/push-actions';
import { decodeVapidKey, derivePushState, subscriptionProblem } from '@/lib/push-validation';
import type { PushPermission, PushStateKind, SubscriptionInput } from '@/lib/push-validation';

/** Scope is the whole origin because the file is served from the root. */
const SERVICE_WORKER_PATH = '/sw.js';

export type PushToggleProps = {
  /** Null when `VAPID_PUBLIC_KEY` is unset on this deploy. Read on the server in
   *  app/(app)/brain/page.tsx and passed down: it is a public key, so a prop is
   *  exactly as exposed as a `NEXT_PUBLIC_` variable and is one name fewer. */
  vapidPublicKey: string | null;
};

export function PushToggle({ vapidPublicKey }: PushToggleProps) {
  // Decoded once, up front, so a key that is present but malformed shows as
  // "not configured" instead of failing inside a click handler.
  const applicationServerKey = useMemo(() => decodeVapidKey(vapidPublicKey), [vapidPublicKey]);

  const [checked, setChecked] = useState(false);
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<PushPermission | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function inspect(): Promise<void> {
      if (!browserCanPush()) {
        if (!cancelled) {
          setSupported(false);
          setChecked(true);
        }
        return;
      }

      if (cancelled) return;
      setSupported(true);
      setPermission(Notification.permission as PushPermission);

      // Nothing to register a worker for on a deploy with no usable key, and the
      // state is already decided.
      if (applicationServerKey === null) {
        if (!cancelled) setChecked(true);
        return;
      }

      try {
        const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
        const existing = await registration.pushManager.getSubscription();
        if (cancelled) return;

        setSubscribed(existing !== null);
        setChecked(true);
        if (existing === null) return;

        // The repair path. See the header.
        const result = await savePushSubscription(toInput(existing));
        if (!cancelled && !result.ok) setError(result.error);
      } catch {
        if (cancelled) return;
        setChecked(true);
        setError('This browser would not start the notification worker.');
      }
    }

    void inspect();
    return () => {
      cancelled = true;
    };
  }, [applicationServerKey]);

  async function enable(): Promise<void> {
    if (applicationServerKey === null) return;

    setBusy(true);
    setError(null);

    let subscription: PushSubscription | null = null;
    // Which of the three steps threw. Without it the catch has one sentence for
    // three different failures, and "the browser would not subscribe" is a lie
    // when what actually happened is that the write failed.
    let stage: 'permission' | 'subscribe' | 'save' = 'permission';

    try {
      const granted = (await Notification.requestPermission()) as PushPermission;
      setPermission(granted);

      if (granted === 'denied') {
        // No error line: the panel now renders the blocked state, which says
        // more than a second sentence in red would.
        return;
      }
      if (granted !== 'granted') {
        setError('The prompt was dismissed. Nothing was changed — you can ask again.');
        return;
      }

      stage = 'subscribe';
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);

      // Reaching here means this browser reported no subscription. Anything
      // present now was made with a different application server key — the
      // deploy's VAPID pair was rotated — or by another tab that raced this one,
      // and `subscribe()` answers that with InvalidStateError rather than
      // replacing it, which would leave the operator with a control that throws
      // every time and no way out short of clearing site data.
      const stale = await registration.pushManager.getSubscription();
      if (stale !== null) await undo(stale);

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });

      const input = toInput(subscription);

      const problem = subscriptionProblem(input);
      if (problem !== null) {
        await undo(subscription);
        setError(problem);
        return;
      }

      stage = 'save';
      const result = await savePushSubscription(input);
      if (!result.ok) {
        await undo(subscription);
        setError(result.error);
        return;
      }

      setSubscribed(true);
    } catch {
      // Whatever happened, the browser must not be left holding a subscription
      // no row points at: it would read as "on" and deliver nothing.
      if (subscription !== null) await undo(subscription);
      setError(ENABLE_FAILED[stage]);
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
      const subscription = await registration.pushManager.getSubscription();

      if (subscription === null) {
        setSubscribed(false);
        return;
      }

      // The row first: it is what the worker sends from, so deleting it is what
      // actually stops the notifications. If it fails, nothing else happens and
      // the control keeps saying "on", which is the truth.
      const result = await removePushSubscription(subscription.endpoint);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      // The row is already gone, so a browser that refuses to unsubscribe leaves
      // a subscription nothing will ever push to. Not worth reporting.
      await undo(subscription);
      setSubscribed(false);
    } catch {
      setError('Could not turn notifications off in this browser.');
    } finally {
      setBusy(false);
    }
  }

  const state = derivePushState({
    checked,
    supported,
    configured: applicationServerKey !== null,
    permission,
    subscribed,
  });

  return (
    <Panel
      level={3}
      title="Notifications"
      note="One digest after the morning run, plus hot inbound leads"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="max-w-prose">
          <p className="text-base text-ink">{HEADLINE[state]}</p>
          <p className="mt-1 text-sm text-muted">{DETAIL[state]}</p>
          {error !== null ? (
            <p role="alert" className="mt-1 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>

        {state === 'subscribed' ? (
          <Button variant="secondary" onClick={() => void disable()} disabled={busy}>
            {busy ? 'Turning off…' : 'Turn off'}
          </Button>
        ) : null}

        {state === 'off' || state === 'granted_not_subscribed' ? (
          <Button variant="primary" onClick={() => void enable()} disabled={busy}>
            {busy ? 'Enabling…' : 'Enable notifications'}
          </Button>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * The copy, one line per state, kept next to the component rather than in a
 * vocab module: nothing else in the app renders these strings, and the reason
 * each one is worded the way it is belongs beside the state that produces it.
 */
const HEADLINE: Record<PushStateKind, string> = {
  checking: 'Checking this browser…',
  unsupported: 'This browser cannot receive notifications.',
  unconfigured: 'Notifications are not configured on this deployment.',
  subscribed: 'On for this browser.',
  blocked: 'This browser is blocking notifications.',
  granted_not_subscribed: 'This browser allows notifications but is not subscribed.',
  off: 'Off for this browser.',
};

const DETAIL: Record<PushStateKind, string> = {
  checking: 'Reading what this browser already allows. Nothing has been asked for yet.',
  unsupported:
    'Desktop Chrome, Edge and Firefox can. On an iPhone, Safari can only once the app has been added to the home screen.',
  unconfigured:
    'VAPID_PUBLIC_KEY is missing or is not a valid key. It has to be set on the web deployment as well as on the worker; the private key belongs to the worker alone.',
  subscribed:
    'One notification after the morning run, and one when a new lead or a reply arrives. Each browser subscribes separately.',
  blocked:
    'It will not ask again. Clear the block in this site’s settings — the icon at the left of the address bar — and this control will work.',
  granted_not_subscribed:
    'The last attempt did not finish, or the browser retired the subscription. Enabling again will not prompt you.',
  off: 'One notification after the morning run, and one when a new lead or a reply arrives. Never one per task.',
};

/** One sentence per step of `enable`, so a failure names the step it happened
 *  in. All three end in the same place — nothing subscribed, nothing stored. */
const ENABLE_FAILED: Record<'permission' | 'subscribe' | 'save', string> = {
  permission: 'This browser would not show the permission prompt.',
  subscribe: 'This browser allowed notifications but would not create a subscription.',
  save: 'The subscription was made but could not be stored, so it has been undone. Try again.',
};

/** All three, because a browser can have any two of them. */
function browserCanPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** What the Server Action stores, out of what the browser holds. */
function toInput(subscription: PushSubscription): SubscriptionInput {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
    expirationTime: subscription.expirationTime,
  };
}

/** Never throws. Undoing a subscription is cleanup; its failure must not replace
 *  the error the caller is about to report. */
async function undo(subscription: PushSubscription): Promise<void> {
  try {
    await subscription.unsubscribe();
  } catch {
    /* nothing points at it */
  }
}
