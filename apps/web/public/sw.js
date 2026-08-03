/*
 * The service worker. Plain JavaScript, no build step, served from /sw.js so its
 * scope is the whole origin.
 *
 * It exists for one reason: a browser will not deliver a Web Push message to a
 * page. It delivers it to a service worker, and the worker has to be registered
 * before the subscription can be created. Everything below is the minimum that
 * obligation costs.
 *
 * ## There is no fetch handler, and there will not be one
 *
 * A cache would serve a stale Today screen. The whole promise of that page is
 * that the four things at the top of it are what matters *now*; an offline copy
 * of yesterday's queue is worse than no page at all, because the operator cannot
 * tell the two apart. Nothing here intercepts a request, so the app behaves
 * exactly as it does without a service worker, and the only failure this file
 * can cause is a notification that does not appear.
 *
 * There is no web app manifest either. Chrome, Edge and Firefox subscribe to
 * push with no install; only iOS Safari requires the app be added to the home
 * screen first, and SPEC §1 describes a dashboard opened on a laptop. Adding a
 * manifest would mean editing the root layout, which step 7 does not own. Noted
 * as future work rather than half-built.
 *
 * ## Every push shows a notification, including the ones that make no sense
 *
 * The subscription is created with `userVisibleOnly: true`, which is a promise
 * to the browser that every delivered message becomes something the operator can
 * see. Break it — throw inside the handler, or decide a payload is not worth
 * showing — and the browser shows its own "This site has been updated in the
 * background" notice instead, then eventually revokes the permission. So the
 * parse is defensive and its failure path still shows something: a generic
 * notification is a bug the operator can report, a revoked permission is a
 * feature that silently stopped working weeks ago.
 *
 * ## What a payload is allowed to contain
 *
 * Counts and classes. Never a name, an address, a subject or a message body —
 * apps/worker/src/jobs/push.ts is where that rule is enforced and where the
 * reasoning lives. It matters here because this is the code that puts the text
 * on a lock screen in a café and into the browser's notification store on disk.
 * If a future payload ever carries a customer's name, this file is the last
 * place it could have been stopped.
 *
 * ## skipWaiting is safe here specifically
 *
 * Normally taking over immediately is risky: a new worker can start serving new
 * assets to an old page. This one serves nothing. Without it a corrected push
 * handler would sit in `waiting` until every tab of the app was closed, which on
 * a dashboard somebody leaves open all day means the fix lands next week.
 *
 * ## pushsubscriptionchange is deliberately not handled
 *
 * When a browser rotates a subscription, re-registering it needs the VAPID
 * public key and an authenticated write, and a service worker has neither: it
 * cannot call a Server Action and it must not be handed the key by a broadcast
 * it cannot authenticate. The repair happens instead in the toggle on /brain,
 * which re-asserts whatever subscription this browser currently holds every time
 * that page is opened. In between, the old endpoint answers 410 and the worker
 * deletes the row, so the failure is "no notifications until you next open the
 * app", never a duplicate or a push to a stranger.
 */

/* global self, clients */

const FALLBACK = {
  title: 'Agency OS',
  body: 'Something is waiting. Open the app.',
  url: '/',
  tag: 'digest',
};

/** Whatever arrived, reduced to the four fields this worker knows. */
function readPayload(event) {
  if (event.data === null || event.data === undefined) return FALLBACK;

  let raw;
  try {
    raw = event.data.json();
  } catch {
    return FALLBACK;
  }

  if (typeof raw !== 'object' || raw === null) return FALLBACK;

  return {
    title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : FALLBACK.title,
    body: typeof raw.body === 'string' && raw.body !== '' ? raw.body : FALLBACK.body,
    // Relative paths only. An absolute URL in a payload would let anything that
    // could ever forge a push send the operator somewhere else.
    url: typeof raw.url === 'string' && raw.url.startsWith('/') ? raw.url : FALLBACK.url,
    tag: typeof raw.tag === 'string' && raw.tag !== '' ? raw.tag : FALLBACK.tag,
  };
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  const payload = readPayload(event);

  // `tag` is the collapse key: a second digest replaces the first rather than
  // stacking. Two notifications saying different counts about the same queue is
  // how a phone teaches somebody to swipe both away without reading either.
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: { url: payload.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target =
    event.notification.data !== null &&
    typeof event.notification.data === 'object' &&
    typeof event.notification.data.url === 'string'
      ? event.notification.data.url
      : FALLBACK.url;

  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });

      // Focus what is already open rather than adding a third tab of the same
      // dashboard. `navigate` can reject when the client is cross-origin or has
      // been discarded, and a failure to move an existing tab must not stop it
      // being focused.
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          await client.navigate(target);
        } catch {
          /* focus it where it stands */
        }
        return client.focus();
      }

      return clients.openWindow(target);
    })(),
  );
});
