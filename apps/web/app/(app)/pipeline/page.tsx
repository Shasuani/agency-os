import type { Metadata } from 'next';

import { appTimezone } from '@agency/core';
import type { Contact } from '@agency/core';

import { ContactTable, type PipelineRow } from '@/components/pipeline/contact-table';
import { EmptyState } from '@/components/pipeline/empty-state';
import { PipelineFilters } from '@/components/pipeline/pipeline-filters';
import { cx } from '@/components/ui/button';
import { listContacts } from '@/lib/contacts';
import {
  daysBetween,
  formatDay,
  formatEuro,
  futureLabel,
  pastLabel,
  toneFor,
  yearOf,
  type DueTone,
} from '@/lib/day';
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_SORT,
  LANGUAGE_LABELS,
  SORT_OPTIONS,
  STAGE_LABELS,
  dayKeyInZone,
  toContactSort,
  toStageFilter,
  toTagFilter,
  type ContactSort,
  type StageFilter,
} from '@/lib/validation';

/**
 * /pipeline — the list.
 *
 * This is the screen that answers "who am I forgetting?", so everything below is
 * arranged around one glance: contacts arrive sorted by `next_touch_at`
 * ascending, which puts the most overdue at the top, and the header states the
 * three counts that decide whether the rest of the morning has any work in it.
 *
 * Three structural decisions, each with a reason:
 *
 * 1. **The query lives in the URL.** `?stage=quoted&q=maria&sort=value` is the
 *    whole state of this page. Changing a filter navigates; this component
 *    re-runs; Postgres does the filtering against the indexes on `stage` and
 *    `next_touch_at` (PLAN.md §4). The view is therefore linkable, bookmarkable,
 *    and survives a refresh — and there is no client-side list state that can
 *    disagree with the server about what is being shown.
 *
 * 2. **Every date is formatted here, in Europe/Athens** (PLAN.md §7.1), and
 *    reaches the table as a finished string. The client component never sees a
 *    clock, a timezone, or an `Intl` call, so there is nothing for server and
 *    client to disagree about and no hydration mismatch is possible. It also
 *    means a laptop in another timezone cannot silently change what "3 days
 *    overdue" means — the operator's day is the operator's day.
 *
 * 3. **The formatting itself lives in lib/day.ts.** It used to be inlined here,
 *    in `[id]/page.tsx`, and in `next-touch-field.tsx`, and the three copies had
 *    already drifted: this page said "3 days ago" where the contact page said
 *    "3d ago" about the same column, and only two of the three rejected
 *    2026-02-31. One module, three callers.
 *
 * TODO(step 6): the Today dashboard gets the metric tiles and task cards. This
 * page stays a list; it does not grow a dashboard.
 */

export const metadata: Metadata = {
  title: 'Pipeline',
};

/** Never cached, never prerendered: every row is customer data read under RLS as
 *  the signed-in operator. A static copy of this page would be a copy of the
 *  contact list sitting in a build artefact. */
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PipelinePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;

  const stage: StageFilter = toStageFilter(first(params['stage']));
  const sort: ContactSort = toContactSort(first(params['sort']));
  // The raw term, capped at what the input allows. `listContacts` normalises it
  // (and strips PostgREST's filter delimiters) before it reaches the database.
  const q = (first(params['q']) ?? '').slice(0, 100);
  const tag = toTagFilter(first(params['tag']));

  const contacts = await listContacts({ stage, tag, search: q, sort, limit: DEFAULT_LIST_LIMIT });

  const timeZone = appTimezone();
  const today = dayKeyInZone(new Date(), timeZone);
  const rows = contacts.map((contact) => toRow(contact, today, timeZone));

  const overdue = rows.filter((row) => row.nextTouch?.tone === 'overdue').length;
  const dueSoon = rows.filter((row) => row.nextTouch?.tone === 'due').length;
  const unscheduled = rows.filter((row) => row.nextTouch === null && !row.doNotContact).length;

  const filtered = stage !== 'all' || tag !== '' || q.trim() !== '';

  // Built from what was read, not from SUGGESTED_TAGS: offering a tag nobody
  // carries would produce a filter that always returns nothing. The active tag
  // is unioned in so the select can still show its own value when the filter
  // narrowed the list down to rows that no longer include it.
  const presentTags = new Set<string>();
  for (const contact of contacts) for (const t of contact.tags ?? []) presentTags.add(t);
  if (tag !== '') presentTags.add(tag);
  const tagOptions = [
    { value: '', label: 'All tags' },
    ...[...presentTags].sort().map((t) => ({ value: t, label: t })),
  ];
  // A full page of rows means the ceiling was hit, not that the pipeline is
  // exactly that size. Say so rather than quietly showing a prefix.
  const truncated = contacts.length >= DEFAULT_LIST_LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl">Pipeline</h1>
          <p className="text-xs text-faint">Soonest follow-up first. Overdue at the top.</p>
        </div>

        {rows.length > 0 ? (
          <dl className="flex items-baseline gap-5">
            <Stat value={rows.length} label={rows.length === 1 ? 'contact' : 'contacts'} />
            {overdue > 0 ? <Stat value={overdue} label="overdue" tone="text-danger" /> : null}
            {dueSoon > 0 ? <Stat value={dueSoon} label="due soon" tone="text-warning" /> : null}
            {unscheduled > 0 ? (
              <Stat
                value={unscheduled}
                label="no date"
                tone="text-faint"
                title="No follow-up scheduled — the morning run will pass these by"
              />
            ) : null}
          </dl>
        ) : null}
      </header>

      <PipelineFilters
        query={{ stage, tag, sort, q }}
        tagOptions={tagOptions}
        sortOptions={SORT_OPTIONS}
        defaultSort={DEFAULT_SORT}
      />

      {rows.length === 0 ? (
        <EmptyState
          filter={
            filtered
              ? {
                  stageLabel: stage === 'all' ? null : STAGE_LABELS[stage],
                  tag: tag === '' ? null : tag,
                  search: q.trim() === '' ? null : q.trim(),
                }
              : null
          }
          clearHref="/pipeline"
        />
      ) : (
        /* No panel around the table, and that is not an omission: any ancestor
           with a non-visible `overflow` becomes the scrollport a `position:
           sticky` header resolves against, and this table's header has to stick
           to the viewport. The hairlines carry the structure on their own,
           which is what DESIGN.md §4 asks of a table anyway. */
        <section aria-label="Contacts">
          <ContactTable rows={rows} truncated={truncated} />
        </section>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Stat({
  value,
  label,
  tone = 'text-ink',
  title,
}: {
  value: number;
  label: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5" title={title}>
      <dt className="sr-only">{label}</dt>
      <dd className={cx('numeric text-md', tone)}>{value}</dd>
      <span aria-hidden="true" className="label-caps text-muted">
        {label}
      </span>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Row mapping
 * ----------------------------------------------------------------------- */

/** A URL param can legally arrive repeated (`?q=a&q=b`). Take the first. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toRow(contact: Contact, today: string, timeZone: string): PipelineRow {
  const name = blankToNull(contact.name);
  const business = blankToNull(contact.business);

  return {
    id: contact.id,
    // Nothing in the schema guarantees a name — an imported row can carry only a
    // business, and the CSV can carry neither. The cell still has to say
    // something a person can click.
    primary: name ?? business ?? 'Unnamed contact',
    secondary: name !== null ? business : null,
    stage: contact.stage,
    language:
      contact.language === null
        ? null
        : { short: contact.language.toUpperCase(), full: LANGUAGE_LABELS[contact.language] },
    nextTouch: toNextTouch(contact.next_touch_at, today, timeZone),
    lastTouch: toLastTouch(contact.last_touch_at, today, timeZone),
    value: contact.value_estimate === null ? null : formatEuro(contact.value_estimate),
    tags: contact.tags ?? [],
    doNotContact: contact.do_not_contact === true,
    // A follow-up date with nowhere to send. Not an input error — see the note
    // on `parseContactForm` — but the one row-level fact worth surfacing here,
    // because from step 5 the agent will skip precisely these, and the operator
    // should find that out from the list rather than from silence.
    unsendable:
      contact.next_touch_at !== null &&
      contact.do_not_contact !== true &&
      blankToNull(contact.email) === null,
  };
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toNextTouch(
  iso: string | null,
  today: string,
  timeZone: string,
): { date: string; relative: string; tone: DueTone } | null {
  const day = toDayKey(iso, timeZone);
  if (day === null) return null;

  const offset = daysBetween(today, day);
  if (offset === null) return null;

  return {
    // DESIGN.md §2, the date rule — resolved in lib/day.ts so the list, the
    // contact page and the follow-up field cannot disagree about it.
    date: formatDay(day, yearOf(today)),
    relative: futureLabel(offset),
    tone: toneFor(offset),
  };
}

function toLastTouch(
  iso: string | null,
  today: string,
  timeZone: string,
): { date: string; relative: string } | null {
  const day = toDayKey(iso, timeZone);
  if (day === null) return null;

  const offset = daysBetween(today, day);
  if (offset === null) return null;

  return { date: formatDay(day, yearOf(today)), relative: pastLabel(offset) };
}

/** A stored timestamptz → the calendar day it falls on in the operator's zone. */
function toDayKey(iso: string | null, timeZone: string): string | null {
  if (iso === null) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  return dayKeyInZone(instant, timeZone);
}
