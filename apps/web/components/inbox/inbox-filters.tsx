'use client';

/**
 * The two controls on `/inbox`: which class, and how far back.
 *
 * **Both write to the URL and nothing else** — the arrangement
 * components/pipeline/pipeline-filters.tsx already establishes and the reason it
 * is worth repeating: changing a filter navigates, the Server Component re-runs
 * the query, and Postgres does the filtering. There is no client-side list state
 * that can disagree with the server about what is being shown, and every view of
 * this page is a link. That matters more here than on /pipeline, because the
 * views worth keeping are audit questions — "show me everything that was called
 * spam in the last 90 days" is a URL somebody will want to come back to.
 *
 * The current query arrives as props rather than through `useSearchParams()`, so
 * this component reads no ambient state and the page owns one source of truth
 * for what is on screen.
 *
 * **No keyboard shortcuts here, unlike /pipeline and Today. [decision]** Those
 * two are worked through every morning under time pressure; this one is opened
 * when a question comes up, and a single-letter binding on a read-only page is a
 * key that does something surprising on the ninety-nine days nobody wanted it.
 * The two selects and the links are natively focusable, which is the whole
 * accessibility requirement met with no code.
 *
 * Vocabulary comes from lib/inbox-vocab, never from the core barrel — that
 * barrel value-imports the service-role Supabase client factory and this file
 * ends up in a browser bundle (DESIGN.md §6).
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { buttonClass, cx } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  DEFAULT_INBOX_DAYS,
  INBOX_CLASS_FILTER_OPTIONS,
  INBOX_DAY_OPTIONS,
  INBOX_PATH,
  inboxHref,
  toInboxClassFilter,
  toInboxDays,
  type InboxQuery,
} from '@/lib/inbox-vocab';

const CLASS_ID = 'inbox-class';
const DAYS_ID = 'inbox-days';

export type InboxFiltersProps = {
  query: InboxQuery;
};

export function InboxFilters({ query }: InboxFiltersProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function go(next: Partial<InboxQuery>) {
    const href = inboxHref({ ...query, ...next });
    startTransition(() => {
      // scroll: false — changing the window must not throw the operator back to
      // the top of a list they were half way down.
      router.push(href, { scroll: false });
    });
  }

  const filtered = query.classFilter !== 'all' || query.days !== DEFAULT_INBOX_DAYS;

  // `?days=3` is a legal window that is not one of the four offered. Union it in
  // so the select can always show its own value; without this the control would
  // display "Last 7 days" over a page showing three, which is a filter lying
  // about what is on screen.
  const dayOptions = INBOX_DAY_OPTIONS.some((option) => option.value === String(query.days))
    ? INBOX_DAY_OPTIONS
    : [{ value: String(query.days), label: `Last ${query.days} days` }, ...INBOX_DAY_OPTIONS];

  return (
    <div
      aria-busy={pending || undefined}
      className={cx('flex flex-wrap items-center gap-2 transition-opacity', pending && 'opacity-70')}
    >
      <div className="w-44">
        <label htmlFor={CLASS_ID} className="sr-only">
          Filter by what it was classified as
        </label>
        <Select
          id={CLASS_ID}
          value={query.classFilter}
          options={INBOX_CLASS_FILTER_OPTIONS}
          onChange={(event) => go({ classFilter: toInboxClassFilter(event.target.value) })}
        />
      </div>

      <div className="w-36">
        <label htmlFor={DAYS_ID} className="sr-only">
          How far back to look
        </label>
        <Select
          id={DAYS_ID}
          value={String(query.days)}
          options={dayOptions}
          onChange={(event) => go({ days: toInboxDays(event.target.value) })}
        />
      </div>

      {filtered ? (
        <Link href={INBOX_PATH} className={buttonClass({ variant: 'ghost', size: 'md' })}>
          Clear
        </Link>
      ) : null}
    </div>
  );
}
