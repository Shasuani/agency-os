import type { Metadata } from 'next';

import { appTimezone } from '@agency/core';
import { partsInZone } from '@agency/core/zone';

import { InboxEmptyState } from '@/components/inbox/empty-state';
import { InboxFilters } from '@/components/inbox/inbox-filters';
import { MessageList } from '@/components/inbox/message-list';
import { Stat } from '@/components/ui/stat';
import { contactLine } from '@/lib/contact-vocab';
import { daysBetween, formatDay, pastLabel, yearOf } from '@/lib/day';
import { MAX_INBOX_ROWS, listInbound, getInboxSummary, type InboundRow } from '@/lib/inbox';
import {
  CONFIDENCE_LABELS,
  CONFIDENCE_TONE,
  INBOUND_CLASS_LABELS,
  INBOUND_CLASS_OUTCOME,
  classOutcome,
  INBOUND_CLASS_TONE,
  MAX_INBOX_DAYS,
  UNCLASSIFIED_LABEL,
  UNCLASSIFIED_TONE,
  classFilterLabel,
  draftState,
  inboxHref,
  toInboxClassFilter,
  toInboxDays,
  type InboundClass,
  type InboxChip,
  type InboxClassFilter,
  type InboxRowView,
} from '@/lib/inbox-vocab';
import { clock } from '@/lib/task-view';
import { dayKeyInZone, dayKeyOf } from '@/lib/validation';

/**
 * `/inbox` — the record of what came in and what was decided about it.
 *
 * Today is the action queue: the things that still need a person. This screen is
 * the other half, and it exists because those two sets are not the same. Three of
 * the nine inbound classes — `not_interested`, `spam`, `not_business` — create no
 * task at all, so a rejection that quietly closed a contact and a message that
 * was binned leave no trace anywhere else in the app. SPEC §5 says the silent
 * handling matters as much as the loud handling; a silent decision nobody can
 * inspect is indistinguishable from a bug. So this page reads `interactions`,
 * where a row is written for every inbound message regardless of class, and not
 * `tasks`, which by construction cannot know about the quiet ones.
 *
 * It follows from that premise that **the page is built to be disagreed with**.
 * Every row carries the class, the classifier's own sentence explaining it, how
 * sure it was, and what the system did as a result — the stage change, the
 * do-not-contact flag, the draft and its fate. A classification the operator
 * thinks is wrong has to be catchable in one pass down the list, so the three
 * facts that make it catchable are on the row rather than behind a click. There
 * is nothing to open: a record you can act from is a record with a second job,
 * and the actions live on Today where they belong.
 *
 * **A Server Component rendering a `<div>`.** `app/(app)/layout.tsx` owns the one
 * `<main id="content">` in the tree; a second one is invalid HTML and breaks the
 * landmark navigation the skip link exists for (DESIGN.md §8).
 *
 * **Every date is resolved here, on the server, in the operator's timezone**, and
 * reaches the components as a finished string — the arrangement /pipeline and
 * Today both use. Never `Date#getHours`: `partsInZone` from `@agency/core/zone`
 * is the one clock this app is allowed, and a laptop in another airport must not
 * change what "09:14" means.
 *
 * **The query is the whole state of the page.** `?class=spam&days=90` is a link,
 * which matters here more than on /pipeline: the views worth keeping are audit
 * questions somebody will want to come back to.
 *
 * Row cap 100, window capped at 90 days. No customer data reaches a `console.*`
 * call — not a name, not an address, not a subject, and not the classifier's
 * `reason`, which is generated English that quotes the message it describes.
 */

export const metadata: Metadata = {
  title: 'Inbox',
};

/** Never cached, never prerendered: every row is customer correspondence read
 *  under RLS as the signed-in operator, and a static copy of this page would be
 *  a copy of the business's mail sitting in a build artefact. */
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function InboxPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;

  const classFilter: InboxClassFilter = toInboxClassFilter(first(params['class']));
  const days = toInboxDays(first(params['days']));

  const now = new Date();

  // Two independent reads. Sequentially they would be two round trips deep on a
  // page whose whole promise is that it already knows.
  const [rows, summary] = await Promise.all([
    listInbound({ classFilter, days }, now),
    getInboxSummary(days, now),
  ]);

  const timeZone = appTimezone();
  const today = dayKeyInZone(now, timeZone);
  const messages = rows.map((row) => toView(row, today, timeZone));

  // A full page of rows means the ceiling was hit, not that this is everything
  // in the window. Say so rather than quietly showing a prefix.
  const truncated = rows.length >= MAX_INBOX_ROWS;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl">Inbox</h1>
          <p className="text-xs text-faint">
            What came in, and what was decided about it. Newest first.
          </p>
        </div>

        {summary.total > 0 ? (
          <dl className="flex items-baseline gap-5">
            <Stat
              value={summary.total}
              label={summary.total === 1 ? 'message' : 'messages'}
              title={`Inbound email recorded in the last ${summary.days} days`}
            />
            {summary.silent > 0 ? (
              <Stat
                value={summary.silent}
                label="handled silently"
                tone="text-muted"
                title="Classified not interested, spam or not business: no reply was drafted, no task was filed and you were not notified. This page is the only record."
              />
            ) : null}
            {summary.unclassified > 0 ? (
              <Stat
                value={summary.unclassified}
                label="unclassified"
                tone="text-warning"
                title="Logged on arrival and never classified — the run stopped between the two writes. Nothing was drafted and nothing was changed."
              />
            ) : null}
          </dl>
        ) : null}
      </header>

      <InboxFilters query={{ classFilter, days }} />

      {messages.length === 0 ? (
        <InboxEmptyState
          days={days}
          classLabel={classFilterLabel(classFilter)}
          clearHref={inboxHref({ classFilter: 'all', days })}
          widestHref={inboxHref({ classFilter, days: MAX_INBOX_DAYS })}
          atWidest={days >= MAX_INBOX_DAYS}
        />
      ) : (
        <section aria-label="Inbound email">
          <MessageList
            rows={messages}
            truncated={truncated}
            narrowerHref={days > 7 ? inboxHref({ classFilter, days: 7 }) : null}
          />
        </section>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Row mapping. Everything below runs on the server and returns finished strings.
 * ----------------------------------------------------------------------- */

/** A URL param can legally arrive repeated (`?class=a&class=b`). Take the first. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toView(row: InboundRow, today: string, timeZone: string): InboxRowView {
  const { meta } = row;
  const names = contactLine(row.contact?.name ?? null, row.contact?.business ?? null);
  const stamp = toStamp(row.occurredAt, today, timeZone);
  const draft = draftState(meta.class, meta.taskId, row.draftStatus, row.draftDryRun);

  return {
    id: row.id,
    chip: toChip(meta.class, meta.unknownClass),
    contact:
      row.contact === null
        ? null
        : {
            id: row.contact.id,
            primary: names.primary,
            secondary: names.secondary,
            stage: row.contact.stage,
          },
    stamp: stamp.label,
    relative: stamp.relative,
    subject: row.subject === null || row.subject.trim() === '' ? null : row.subject.trim(),
    snippet: row.snippet,
    snippetTruncated: row.snippetTruncated,
    reason: meta.reason,
    // `meta.taskId !== null`, not the class: an opted-out contact is classified
    // and never drafted at, and the caption has to say so or it contradicts the
    // draft state on the same row.
    outcome: meta.class === null ? null : classOutcome(meta.class, meta.taskId !== null),
    confidence:
      meta.confidence === null
        ? null
        : { label: CONFIDENCE_LABELS[meta.confidence], tone: CONFIDENCE_TONE[meta.confidence] },
    draft:
      draft === null
        ? null
        : {
            // The anchor is the heading `components/today/task-card.tsx` gives
            // each card. If that id ever changes the link degrades to the top of
            // Today, which is where the operator was going anyway — worth a soft
            // coupling to avoid a second identifier that would have to be kept
            // in step across two screens.
            href: draft.actionable && meta.taskId !== null ? `/#task-${meta.taskId}-title` : null,
            label: draft.label,
            tone: draft.tone,
          },
  };
}

/**
 * The chip, including the two states that are not classes.
 *
 * `unknownClass` is kept apart from "never classified" on purpose: one is a
 * worker that stopped mid-message, the other is a worker running ahead of this
 * build. Folding them together would hide a deploy skew behind something that
 * looks like a crash, and send the operator after the wrong problem.
 */
function toChip(cls: InboundClass | null, unknownClass: string | null): InboxChip {
  if (cls !== null) {
    return {
      label: INBOUND_CLASS_LABELS[cls],
      tone: INBOUND_CLASS_TONE[cls],
      title: INBOUND_CLASS_OUTCOME[cls].detail,
    };
  }

  if (unknownClass !== null) {
    return {
      label: unknownClass,
      tone: UNCLASSIFIED_TONE,
      title: `The agent classified this as “${unknownClass}”, which this build of the dashboard has no label for. The worker is running a newer set of classes than the web app.`,
    };
  }

  return {
    label: UNCLASSIFIED_LABEL,
    tone: UNCLASSIFIED_TONE,
    title:
      'Logged when it arrived and never classified. The interaction row is written before the classifier runs — it is what stops a duplicate — so this is what a run that stopped between the two writes leaves behind.',
  };
}

/**
 * A stored `timestamptz` → the absolute date and clock time, plus the relative
 * hint that sits beside them (DESIGN.md §7: relative time is a hint next to the
 * absolute date, never a replacement for it).
 *
 * `occurred_at` has a default in the schema but is nullable, so a row written by
 * hand can arrive without one. It renders as an em dash rather than as today's
 * date: guessing a timestamp on a page whose job is to be the record would be
 * the worst possible place to guess.
 */
function toStamp(
  iso: string | null,
  today: string,
  timeZone: string,
): { label: string; relative: string } {
  const missing = { label: '—', relative: 'no date recorded' };
  if (iso === null) return missing;

  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return missing;

  const day = dayKeyOf(iso, timeZone);
  if (day === null) return missing;

  const parts = partsInZone(instant, timeZone);
  const offset = daysBetween(today, day);

  return {
    label: `${formatDay(day, yearOf(today))} · ${clock(parts.hour, parts.minute)}`,
    relative: offset === null ? '' : pastLabel(offset),
  };
}
