import { cx } from '@/components/ui/button';
import { countLabel, dryRunNote, sendOutcome } from '@/lib/task-view';
import type { TaskStatus } from '@agency/core';

/**
 * What was dealt with today, collapsed.
 *
 * SPEC §6 puts this at the bottom of Today and calls it "handled without you".
 * It is called "Handled today" here because the app cannot honestly tell the two
 * apart: a task the operator rejected at 08:20 and a task the send queue skipped
 * because the contact had opted out are both resolved rows with a `resolved_at`,
 * and nothing records who resolved them. Claiming the operator's own work was
 * done "without you" would be the app taking credit, which is the one thing an
 * instrument must not do.
 *
 * `<details>`, closed by default, and native rather than a disclosure widget:
 * it is keyboard-operable and screen-reader-announced for free, it remembers
 * nothing across renders (which is correct — this list is a footnote, not a
 * view), and it costs no client JavaScript on a page whose job is to be fast.
 *
 * The status is a word before it is a colour. `sent` is the only one tinted, and
 * only `positive`, because it is the outcome the morning exists to produce;
 * `rejected` and `skipped` are the operator exercising judgement and are not
 * painted as failures.
 *
 * A send made under `DRY_RUN` says `Dry run` here rather than `Sent`, and that
 * is the point of the change: with the flag defaulting to true, this list was
 * reporting the same word for a message a customer has and a message nobody
 * has. The label and the tone are decided by `sendOutcome` in lib/task-view, so
 * this screen and `/inbox` cannot drift on it. The summary line carries the
 * count, because the collapsed state is what the operator reads most days and
 * it should not take a click to learn that nothing went out.
 */

export type HandledRow = {
  id: string;
  status: TaskStatus;
  /** True when the send happened with `DRY_RUN` on — everything but the socket.
   *  Always false for `rejected` and `skipped`, which record no send. */
  dryRun: boolean;
  /** Contact name, or the task title when there is no contact. Never empty. */
  primary: string;
  title: string;
  /** `'09:14'` in the operator's timezone, resolved on the server. */
  at: string;
};

export function HandledList({ rows }: { rows: readonly HandledRow[] }) {
  if (rows.length === 0) return null;

  const note = dryRunNote(rows.filter((row) => row.dryRun).length);

  return (
    <details className="rounded-lg border border-line">
      <summary className="cursor-pointer list-none px-4 py-2.5 text-sm text-muted marker:content-none hover:text-ink">
        Handled today · <span className="numeric text-ink">{rows.length}</span>
        <span className="ml-2 text-xs text-faint">
          {countLabel(rows.length, 'task', 'tasks')} sent, rejected or skipped since midnight
          {note === '' ? null : ` · ${note}`}
        </span>
      </summary>

      <ul className="border-t border-line">
        {rows.map((row) => {
          const outcome = sendOutcome(row.status, row.dryRun);
          return (
          <li
            key={row.id}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line px-4 py-1.5 last:border-b-0"
          >
            <span className={cx('label-caps w-16 shrink-0', outcome.tone)}>{outcome.label}</span>
            <span className="text-sm text-ink">{row.primary}</span>
            <span className="text-xs text-muted">{row.title}</span>
            <span className="numeric ml-auto text-xs text-faint">{row.at}</span>
          </li>
          );
        })}
      </ul>
    </details>
  );
}
