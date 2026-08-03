import Link from 'next/link';

import { buttonClass } from '@/components/ui/button';

/**
 * Nothing is waiting.
 *
 * This is the state the screen is *for*, so it is written as a success and not
 * as an absence — DESIGN.md §7 and SPEC §6 both give the sentence verbatim:
 * "Nothing needs you. 9 things handled." No apology, no illustration, no "Oops",
 * no shrugging emoji. It states what happened.
 *
 * Two facts sit under it, and both are only shown when they are true:
 *
 * - **What is still in flight.** Approved tasks waiting for the poller are not
 *   nothing; they are work the operator already did, and the difference between
 *   "sent" and "queued" is the difference between a promise kept and a promise
 *   made. Saying so also explains why a message the operator approved a minute
 *   ago has not arrived — with the default Tue–Thu window, approving on a Monday
 *   schedules for Tuesday morning (PLAN §7.1), and a screen that goes quiet
 *   about that is a screen that looks broken.
 * - **Nothing has happened at all.** A morning with zero handled and zero
 *   pending is either a genuinely quiet day or an agent that did not run. The
 *   page cannot tell the two apart, so it says the first and points at the
 *   pipeline, which is the screen that answers "who am I forgetting?".
 */

export type TodayEmptyStateProps = {
  /** Tasks resolved since local midnight. */
  doneToday: number;
  /** Approved, waiting for the send window. */
  queued: number;
};

export function TodayEmptyState({ doneToday, queued }: TodayEmptyStateProps) {
  return (
    <section className="rounded-lg border border-line bg-raised px-6 py-7">
      <div className="max-w-xl">
        <h2 className="text-lg">Nothing needs you.</h2>

        <p className="mt-1 text-muted">
          {doneToday > 0 ? (
            <>
              <span className="numeric text-ink">{doneToday}</span>{' '}
              {doneToday === 1 ? 'thing' : 'things'} handled today.
            </>
          ) : (
            'Nothing has come in today, and nothing is waiting.'
          )}
          {queued > 0 ? (
            <>
              {' '}
              <span className="numeric text-ink">{queued}</span>{' '}
              {queued === 1 ? 'message is' : 'messages are'} approved and waiting for the send
              window.
            </>
          ) : null}
        </p>

        {doneToday === 0 && queued === 0 ? (
          <>
            <p className="mt-4 text-sm text-muted">
              The follow-up agent files its drafts after the 08:00 run. If it is past that and
              this screen is still empty, either nobody is due or nothing is scheduled — the
              pipeline is where that shows.
            </p>
            <div className="mt-4">
              <Link href="/pipeline" className={buttonClass({ variant: 'secondary' })}>
                Open the pipeline
              </Link>
            </div>
          </>
        ) : null}

        {queued > 0 ? (
          <p className="mt-6 border-t border-line pt-4 text-xs text-faint">
            Queued messages leave inside the send window — the recipient&rsquo;s local business
            hours, a few minutes apart. Nothing arrives at 03:00.
          </p>
        ) : null}
      </div>
    </section>
  );
}
