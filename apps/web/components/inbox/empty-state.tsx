import Link from 'next/link';

import { buttonClass } from '@/components/ui/button';

/**
 * The two ways `/inbox` can have nothing to show. They are different facts and
 * they get different text, the same split components/pipeline/empty-state.tsx
 * makes.
 *
 * 1. **Nothing matches the filter.** Mail has arrived; this view excludes it.
 *    The only useful thing to say is what is being filtered on and where the way
 *    out is.
 * 2. **Nothing came in.** This is the interesting one, and it is the reason this
 *    component is not one line. An empty inbox has two causes that look
 *    identical from here: a quiet fortnight, or a pipeline that is not delivering
 *    — a lapsed Gmail watch, a Pub/Sub subscription pointing at a dead worker, a
 *    refresh token without the read scope. This page cannot tell which, and it
 *    must not pretend to. So it states what it knows (no inbound email is
 *    recorded in this window), says plainly that it fills itself and that nothing
 *    on it is entered by hand, and names the thing to check if mail *is* arriving
 *    in Gmail. An empty state that says only "All clear" would be the app
 *    claiming a fact it does not have.
 *
 * DESIGN.md §7: state what is true. No apology, no illustration, no "Oops".
 */

export type InboxEmptyStateProps = {
  /** The window in days, so the sentence is about the view being looked at. */
  days: number;
  /** The active class filter's label, or null when there is no filter. */
  classLabel: string | null;
  /** `/inbox` with the class filter dropped, window kept. */
  clearHref: string;
  /** `/inbox?days=90` — the widest window this page offers. */
  widestHref: string;
  /** True when the window already is the widest one on offer. */
  atWidest: boolean;
};

export function InboxEmptyState({
  days,
  classLabel,
  clearHref,
  widestHref,
  atWidest,
}: InboxEmptyStateProps) {
  return (
    <section className="rounded-lg border border-line bg-raised px-6 py-7">
      {classLabel === null ? (
        <NothingArrived days={days} widestHref={widestHref} atWidest={atWidest} />
      ) : (
        <NoMatch days={days} classLabel={classLabel} clearHref={clearHref} />
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function NothingArrived({
  days,
  widestHref,
  atWidest,
}: {
  days: number;
  widestHref: string;
  atWidest: boolean;
}) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg">Nothing has come in for {days} days.</h2>

      <p className="mt-1 text-muted">
        This page lists every email the inbox agent has read, and what it decided about each one —
        including the ones it handled without asking. Nothing on it is entered by hand, so an
        empty list means no inbound email has been recorded in this window.
      </p>

      {atWidest ? null : (
        <p className="mt-3 text-muted">
          A quiet fortnight looks exactly like this.{' '}
          <Link href={widestHref} className="text-accent transition-colors hover:text-accent-hover">
            Widen the window to 90 days
          </Link>{' '}
          to see whether anything has arrived at all.
        </p>
      )}

      <p className="mt-6 border-t border-line pt-4 text-xs text-faint">
        If mail is arriving in Gmail and nothing appears here, the delivery path is what to check,
        not this screen: the Gmail watch expires after seven days and is renewed by the worker, and
        the Pub/Sub subscription has to reach a running worker to be acted on. The worker&apos;s
        health endpoint reports when the inbox agent last ran.
      </p>
    </div>
  );
}

function NoMatch({
  days,
  classLabel,
  clearHref,
}: {
  days: number;
  classLabel: string;
  clearHref: string;
}) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg">Nothing matches.</h2>

      <p className="mt-1 text-muted">
        No inbound email in the last {days} days is filed under{' '}
        <span className="text-ink">{classLabel}</span>. The filter lives in the URL, so this view
        is linkable — and reversible.
      </p>

      <div className="mt-5">
        <Link href={clearHref} className={buttonClass({ variant: 'secondary' })}>
          Show every class
        </Link>
      </div>
    </div>
  );
}
