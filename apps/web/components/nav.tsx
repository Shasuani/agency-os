'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { signOut } from '@/lib/auth-actions';
import { cx } from '@/components/ui/button';

/**
 * The six routes from SPEC §6. This is chrome, so it gets no visual weight:
 * a 44px bar, one hairline, and the active route marked by ink weight plus a
 * 2px accent rule sitting on that hairline. Nothing here competes with data.
 *
 * **A route is only a link if the page exists.** Rendering an unbuilt route as a
 * `<Link>` meant nav items that answered a click with Next's bare default 404 —
 * `/brain` was even marked `live`, which was simply untrue. An unbuilt route is
 * an inert `<span>` carrying the build step that will fill it in. When a step
 * lands, flip `built` to true in the same change that adds the page; the marker
 * and the title text follow. Step 6 did that for `/` and `/brain`, step 8 for
 * `/inbox`. `/content` and `/money` keep their dash: they are v1 stubs (SPEC §6)
 * and no step is coming for them.
 *
 * Client component only because it reads the pathname and hosts the sign-out
 * form. **It fetches nothing** — the kill-switch flag and the last-run summary
 * are read by `app/(app)/layout.tsx`, which is a Server Component, and arrive as
 * props. A Client Component that fetched its own status would do it on every
 * navigation, in the browser, with the anon key, for a bar nobody is looking at.
 */

type RouteStatus =
  /** Built and usable. */
  | 'live'
  /** A later build step fills it in. */
  | 'pending'
  /** Deliberately empty for v1 — SPEC §6 lists these two as stubs. */
  | 'stub';

type Route = {
  href: string;
  label: string;
  status: RouteStatus;
  /** Does a page.tsx exist for this href? If not it renders inert — no 404s. */
  built: boolean;
  /** Shown in the title attribute so the marker is explainable on hover. */
  note: string;
};

const ROUTES: readonly Route[] = [
  {
    href: '/',
    label: 'Today',
    status: 'live',
    built: true,
    note: 'The queue: what needs you this morning',
  },
  {
    href: '/inbox',
    label: 'Inbox',
    status: 'live',
    built: true,
    note: 'What came in, and what the inbox agent decided about it',
  },
  { href: '/pipeline', label: 'Pipeline', status: 'live', built: true, note: 'Contacts' },
  {
    href: '/content',
    label: 'Content',
    status: 'stub',
    built: false,
    note: 'Stub — out of scope for v1 (SPEC §6)',
  },
  {
    href: '/money',
    label: 'Money',
    status: 'stub',
    built: false,
    note: 'Stub — out of scope for v1 (SPEC §6)',
  },
  {
    href: '/brain',
    label: 'Brain',
    status: 'live',
    built: true,
    note: 'Business facts, the kill switch, send caps and the send window',
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** What the right rail says about the last agent run. Already formatted by the
 *  layout, in the operator's timezone — this component never sees a clock. */
export type NavRunStatus = {
  /** 'followup', 'inbox', … */
  agent: string;
  /** '30 Jul · 3 days ago' */
  when: string;
  /** An errored run is worth a hue; a normal one is not. */
  failed: boolean;
};

export type NavProps = {
  /** PLAN §7. True means nothing is being drafted and nothing is being sent. */
  killSwitchOn: boolean;
  /** Null when no agent has ever run, which is the honest state before the
   *  first cron tick with an API key in place. */
  lastRun: NavRunStatus | null;
};

export function Nav({ killSwitchOn, lastRun }: NavProps) {
  const pathname = usePathname() ?? '/';

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/92 backdrop-blur-sm">
      <div className="mx-auto flex h-11 w-full max-w-shell items-stretch gap-6 px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center font-display text-sm font-medium tracking-tight text-ink"
        >
          Agency
          <span className="text-faint">OS</span>
        </Link>

        <nav aria-label="Primary" className="flex items-stretch">
          <ul className="flex items-stretch gap-0.5">
            {ROUTES.map((route) => {
              const active = isActive(pathname, route.href);
              const dim = route.status !== 'live';

              const inner = (
                <>
                  {route.label}
                  {dim ? (
                    <span
                      aria-hidden="true"
                      className="ml-1 text-2xs leading-none text-faint"
                      // A dot for "not built yet", a dash for "never will be".
                    >
                      {route.status === 'pending' ? '·' : '–'}
                    </span>
                  ) : null}
                  {dim ? (
                    <span className="sr-only">
                      {route.status === 'pending' ? ' (not built yet)' : ' (stub)'}
                    </span>
                  ) : null}
                </>
              );

              const shared = cx(
                'relative flex items-center px-2.5 text-sm transition-colors',
                'after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 after:content-[""]',
                active ? 'font-medium text-ink after:bg-accent' : 'after:bg-transparent',
                !active && dim ? 'text-faint' : '',
                !active && !dim ? 'text-muted' : '',
              );

              return (
                <li key={route.href} className="flex">
                  {route.built ? (
                    <Link
                      href={route.href}
                      title={route.note}
                      aria-current={active ? 'page' : undefined}
                      className={cx(shared, !active && 'hover:text-ink')}
                    >
                      {inner}
                    </Link>
                  ) : (
                    // Not a link, not a disabled link: an inert span. A nav item
                    // that answers a click with a 404 is worse than one that
                    // plainly does nothing and says why on hover.
                    <span title={route.note} aria-disabled="true" className={cx(shared, 'cursor-default')}>
                      {inner}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Right rail: run status, the kill-switch indicator, sign-out.

            A Server Action rather than a POST to /auth/signout: Next verifies
            the Origin header against the Host for every action invocation, so a
            cross-origin form cannot force the operator out. A route handler
            gets none of that checking. */}
        <div className="ml-auto flex items-center gap-3">
          <RunStatus lastRun={lastRun} />
          <KillSwitchIndicator on={killSwitchOn} />

          <form action={signOut}>
            <button
              type="submit"
              className="flex h-11 items-center px-2.5 text-sm text-faint transition-colors hover:text-ink"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}

/**
 * "Sends paused", and nothing at all the rest of the time.
 *
 * There is no green "all normal" chip and there will not be one. This has to be
 * unmissable on the one day it is true without adding a word to the bar on the
 * other 364, and a permanent status light trains the eye to stop reading it —
 * which is exactly the failure mode that would make the warning useless when it
 * finally appears.
 *
 * Colour is not the only signal (DESIGN.md §8): it is a filled `warning` chip
 * carrying the words "Sends paused", and it is a link straight to the control
 * that turns it back on. It deliberately carries no `role="alert"` — that would
 * override the link role and take away the one thing a screen-reader user needs
 * from it, which is the ability to follow it. The panel on /brain does the
 * announcing.
 */
function KillSwitchIndicator({ on }: { on: boolean }) {
  if (!on) return null;

  return (
    <Link
      href="/brain"
      title="The kill switch is on: no drafting, no sending, and approvals are refused"
      className="flex items-center gap-1.5 rounded-md border border-warning/50 bg-warning-subtle px-2 py-1 text-xs font-medium text-warning transition-colors hover:border-warning"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
      Sends paused
      <span className="sr-only"> — open Brain to turn sending back on</span>
    </Link>
  );
}

/**
 * When an agent last did something.
 *
 * It reads the newest `agent_runs` row, which the LLM wrapper writes once per
 * model call — so this is "last agent run", not "last cron tick". Those differ
 * on a morning where nothing was due: the job ran, decided there was nobody to
 * contact, and wrote no row. The label says which, because a two-day-old date
 * here is a normal state and must not read as a stalled worker.
 *
 * `text-faint` and hidden on narrow screens: it is a reassurance, not an
 * instruction. An errored run is the exception and gets `text-danger`, because
 * that one *is* an instruction — SPEC §8 says a failed run also files an alert
 * task, so the queue on / has the detail.
 */
function RunStatus({ lastRun }: { lastRun: NavRunStatus | null }) {
  if (lastRun === null) return null;

  return (
    <span
      title={`Last ${lastRun.agent} run — agent_runs is written per model call, so a quiet day writes no row`}
      className={cx(
        'hidden items-baseline gap-1.5 text-xs md:flex',
        lastRun.failed ? 'text-danger' : 'text-faint',
      )}
    >
      <span className="label-caps">{lastRun.agent}</span>
      <span className="numeric">{lastRun.when}</span>
      {lastRun.failed ? <span>failed</span> : null}
    </span>
  );
}
