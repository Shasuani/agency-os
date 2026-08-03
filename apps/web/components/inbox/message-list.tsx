import Link from 'next/link';

import { ClassChip } from '@/components/inbox/class-chip';
import { cx } from '@/components/ui/button';
import { StageBadge } from '@/components/ui/stage-badge';
import type { InboxRowView } from '@/lib/inbox-vocab';

/**
 * The record: one row per inbound email, newest first.
 *
 * A list and not a table, unlike /pipeline. A table is right when every row has
 * the same six facts and the operator is comparing down a column; here the rows
 * differ in kind — one carries a subject, a preview, a reason and a draft, the
 * next carries a class and the sentence "logged only" — and forcing that into
 * fixed columns would mean six mostly-empty cells per spam row and a preview
 * clipped to a column width. The scanning column is still there: the chip is
 * left-aligned at a fixed width on every row, so the eye can run down the
 * classes without reading anything else.
 *
 * **Four levels of information, in the order the operator asks for them.** What
 * kind of message it was, who it was from, what it said, and what the system did
 * about it. The last line is the one this screen exists for: on the three silent
 * classes it is the only place in the entire app that records that a contact was
 * closed or a message was binned, so it is never omitted and never abbreviated
 * to a colour.
 *
 * **Nothing here is interactive beyond two links** — the contact and, when there
 * is still one waiting, the draft on Today. There are no actions on this page in
 * v1: it is a record, and a record you can edit from is a record you cannot
 * trust. Both links are ordinary anchors, so the whole list is keyboard-reachable
 * with Tab and needs no client JavaScript.
 *
 * A Server Component. Every string arrives finished — no clock, no timezone, no
 * `Intl` call — so there is nothing for server and client to disagree about, the
 * arrangement /pipeline and Today both already use.
 */

export type MessageListProps = {
  rows: readonly InboxRowView[];
  /** The row ceiling was reached: the window holds more than is shown. */
  truncated: boolean;
  /** Where "narrow the window" points when the list was cut short. Null when
   *  the window is already the narrowest one on offer, in which case there is
   *  nothing useful to suggest and the note says only what is true. */
  narrowerHref: string | null;
};

export function MessageList({ rows, truncated, narrowerHref }: MessageListProps) {
  return (
    <div className="rounded-lg border border-line bg-raised">
      <ul>
        {rows.map((row) => (
          <MessageRow key={row.id} row={row} />
        ))}
      </ul>

      {truncated ? (
        <p className="border-t border-line px-3 py-2 text-xs text-faint">
          Showing the {rows.length} most recent. More arrived inside this window
          {narrowerHref === null ? (
            '.'
          ) : (
            <>
              {' — '}
              <Link
                href={narrowerHref}
                className="text-accent transition-colors hover:text-accent-hover"
              >
                narrow the window
              </Link>{' '}
              to see all of a shorter one.
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function MessageRow({ row }: { row: InboxRowView }) {
  return (
    <li className="border-b border-line px-3 py-2.5 last:border-b-0">
      {/* Who and when. */}
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <ClassChip {...row.chip} />

        {row.contact === null ? (
          // The agent creates a contact for every sender it does not know, so
          // this is a row whose contact was deleted afterwards. Saying so is
          // better than an empty cell that reads as a rendering fault.
          <span className="text-sm text-faint">Contact no longer on file</span>
        ) : (
          <Link
            href={`/pipeline/${row.contact.id}`}
            className="text-sm text-ink transition-colors hover:text-accent"
          >
            {row.contact.primary}
          </Link>
        )}

        {row.contact !== null ? (
          <>
            {row.contact.secondary === null ? null : (
              <span className="text-xs text-muted">{row.contact.secondary}</span>
            )}
            <StageBadge stage={row.contact.stage} />
          </>
        ) : null}

        <span
          className="numeric ml-auto shrink-0 text-xs text-faint"
          title={row.relative === '' ? undefined : row.relative}
        >
          {row.stamp}
        </span>
      </div>

      {/* What they said. Subject in ink, one capped line of the body under it. */}
      {row.subject !== null ? (
        <p className="mt-1.5 text-base text-ink">{row.subject}</p>
      ) : (
        <p className="mt-1.5 text-base text-faint">No subject</p>
      )}

      {row.snippet === '' ? (
        <p className="mt-0.5 text-sm text-faint">
          No readable text — the message was an attachment, an image, or a format the parser
          could not decode.
        </p>
      ) : (
        <p className="mt-0.5 text-sm text-muted">
          {row.snippet}
          {row.snippetTruncated ? (
            <span className="sr-only"> (preview only — the full message is in Gmail)</span>
          ) : null}
        </p>
      )}

      {/* Why it was called that. Generated English that quotes the message, so
          it is rendered here and never written to a log. */}
      {row.reason !== null ? <p className="mt-1 text-xs text-faint italic">{row.reason}</p> : null}

      {/* What the system did. The line this screen exists for. */}
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-xs">
        {row.outcome !== null ? (
          <span className="text-muted" title={row.outcome.detail}>
            {row.outcome.segments.join(' · ')}
            <span className="sr-only"> — {row.outcome.detail}</span>
          </span>
        ) : (
          <span className="text-warning">
            No decision was recorded for this message. It was logged when it arrived and the
            classifier never finished, so nothing was drafted and nothing was changed.
          </span>
        )}

        {row.confidence !== null ? (
          <span className={cx(row.confidence.tone)}>{row.confidence.label}</span>
        ) : null}

        {row.draft !== null ? (
          row.draft.href === null ? (
            <span className={cx('ml-auto', row.draft.tone)}>{row.draft.label}</span>
          ) : (
            <Link
              href={row.draft.href}
              className={cx('ml-auto transition-colors hover:text-accent-hover', row.draft.tone)}
            >
              {row.draft.label}
            </Link>
          )
        ) : null}
      </div>
    </li>
  );
}
