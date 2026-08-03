import type { ReactNode } from 'react';

import { appTimezone } from '@agency/core';

import { Nav, type NavRunStatus } from '@/components/nav';
import { formatStampLabel, readKillSwitch, readLastRun } from '@/lib/settings';
import { dayKeyInZone } from '@/lib/validation';

/**
 * The application shell: skip link, nav, and the one `<main>` on the page.
 *
 * Everything inside this route group is a screen the operator reaches while
 * signed in. `/login` sits outside it (in `app/login/`) and therefore gets the
 * document and nothing else — no nav full of links that would bounce a
 * signed-out visitor straight back to the form they are already looking at.
 *
 * There is exactly one `<main id="content">` in the tree, here. Pages render a
 * `<div>`; a second `<main>` nested inside this one is invalid HTML and breaks
 * landmark navigation, which is the whole reason a screen reader has landmarks.
 * The skip link lives with the region it targets so the two cannot separate.
 *
 * **The nav's two status readings happen here, not in the nav.** `Nav` is a
 * Client Component; a Client Component that fetched the kill-switch flag would
 * do it in the browser, on every navigation, with the anon key, for a bar nobody
 * is looking at. This is a Server Component, so both reads happen once per
 * request and both dates are formatted here, in the operator's timezone, and
 * reach the client as finished strings — the same arrangement /pipeline uses,
 * and the reason no hydration mismatch is possible.
 *
 * Both reads are also *cheap and unavoidable*: the layout re-renders on every
 * navigation, so they are issued together rather than in sequence.
 * `readKillSwitch` answers `true` if it cannot tell, because "cannot tell" and
 * "paused" have the same consequence — nothing is sending — and only one of
 * those two is safe to display. `readLastRun` never throws: chrome must not be
 * able to take down every screen in the app.
 *
 * The layout is `force-dynamic` for the same reason /brain is: the kill-switch
 * indicator's entire value is that it agrees with the database right now, and a
 * cached shell would be a cached answer to "is anything going out?".
 */

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [killSwitchOn, lastRun] = await Promise.all([readKillSwitch(), readLastRun()]);

  const timeZone = appTimezone();
  const today = dayKeyInZone(new Date(), timeZone);

  const runStatus: NavRunStatus | null =
    lastRun === null || lastRun.at === null
      ? null
      : {
          agent: lastRun.agent ?? 'agent',
          when: formatStampLabel(lastRun.at, today, timeZone) ?? '',
          failed: lastRun.status === 'error',
        };

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Keyboard-first: the first tab stop skips the nav entirely. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-1.5 focus:text-accent-fg"
      >
        Skip to content
      </a>

      <Nav killSwitchOn={killSwitchOn} lastRun={runStatus} />

      <main id="content" className="mx-auto w-full max-w-shell flex-1 px-6 py-6">
        {children}
      </main>
    </div>
  );
}
