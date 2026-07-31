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
 * **A route is only a link if the page exists.** Four of the six do not yet, and
 * rendering them as `<Link>` meant four items in the primary nav that answered a
 * click with Next's bare default 404 — `/brain` was even marked `live`, which
 * was simply untrue. An unbuilt route is now an inert `<span>` carrying the
 * build step that will fill it in. When a step lands, flip `built` to true in
 * the same commit that adds the page; the marker and the title text follow.
 *
 * Client component only because it reads the pathname and hosts the sign-out
 * form. It fetches nothing.
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
    status: 'pending',
    built: true,
    note: 'Placeholder — the Today dashboard is build step 6',
  },
  {
    href: '/inbox',
    label: 'Inbox',
    status: 'pending',
    built: false,
    note: 'Not built yet — the inbox agent is build step 8',
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
    status: 'pending',
    built: false,
    note: 'Not built yet — business facts and the kill switch arrive in build step 6',
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav() {
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

        {/* Right rail. Sign-out today; the kill-switch indicator and run status
            join it in step 6.

            A Server Action rather than a POST to /auth/signout: Next verifies
            the Origin header against the Host for every action invocation, so a
            cross-origin form cannot force the operator out. A route handler
            gets none of that checking. */}
        <div className="ml-auto flex items-center">
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
