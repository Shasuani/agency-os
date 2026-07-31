import Link from 'next/link';
import type { ReactNode } from 'react';

import { buttonClass } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

/**
 * The two ways /pipeline can have nothing to show. They are different facts and
 * they get different text.
 *
 * 1. **Nothing matches the filter.** The pipeline has contacts; this view does
 *    not. The only useful thing to say is what is being filtered on and where
 *    the way out is.
 * 2. **The pipeline is empty.** This is the state the owner sees on the first
 *    deploy, before the CSV is imported — so it is the one screen in the app
 *    with a job beyond reporting: it has to say what to do next, precisely
 *    enough to be done without leaving the page to look it up.
 *
 * Per DESIGN.md §7 neither one apologises, neither one has an illustration, and
 * neither one says "Oops". They state what is true.
 */

export type EmptyStateFilter = {
  /** Human label of the stage filter, or null when it is 'all'. */
  stageLabel: string | null;
  /** The active tag filter, or null when there is none. */
  tag: string | null;
  /** The raw search term, or null when there is none. */
  search: string | null;
};

export type EmptyStateProps = {
  /** null means the table is empty because the pipeline is. */
  filter: EmptyStateFilter | null;
  /** Where "Clear filters" goes — /pipeline with the params dropped. */
  clearHref: string;
};

export function EmptyState({ filter, clearHref }: EmptyStateProps) {
  return (
    <section className="rounded-lg border border-line bg-raised px-6 py-7">
      {filter === null ? <EmptyPipeline /> : <NoMatch filter={filter} clearHref={clearHref} />}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function EmptyPipeline() {
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg">No contacts yet.</h2>
      <p className="mt-1 text-muted">
        Nothing is being followed up, because there is nothing here to follow up. Two ways to
        change that:
      </p>

      <ol className="mt-5 flex flex-col gap-4">
        <Step
          index={1}
          title="Add the one you met this week"
          detail={
            <>
              Press <Kbd tone="ink">n</Kbd>, or use <span className="text-ink">New contact</span>. A
              name and a follow-up date is enough — email, value and notes can be filled in later.
            </>
          }
        />
        <Step
          index={2}
          title="Import the rest from the card stack"
          detail={
            <>
              From the repo root:{' '}
              <code className="rounded-xs border border-line bg-sunken px-1 font-mono text-xs text-ink">
                pnpm import:contacts ./contacts.csv
              </code>{' '}
              — that is a dry run and writes nothing. Add{' '}
              <code className="font-mono text-xs text-ink">--commit</code> once the preview reads
              right. Column mapping is in{' '}
              <code className="font-mono text-xs text-ink">scripts/CONTACTS_CSV.md</code>.
            </>
          }
        />
      </ol>

      <p className="mt-6 border-t border-line pt-4 text-xs text-faint">
        A contact with a follow-up date comes back to the top of this table on the morning it is
        due. A contact without one never does — which is the whole reason this screen exists.
      </p>

      <div className="mt-4">
        <Link href="/pipeline/new" className={buttonClass({ variant: 'primary' })}>
          New contact
        </Link>
      </div>
    </div>
  );
}

function NoMatch({ filter, clearHref }: { filter: EmptyStateFilter; clearHref: string }) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg">Nothing matches.</h2>

      <p className="mt-1 text-muted">
        No contact in the pipeline is{' '}
        {filter.stageLabel !== null ? (
          <>
            at stage <span className="text-ink">{filter.stageLabel}</span>
          </>
        ) : (
          'a match'
        )}
        {filter.tag !== null ? (
          <>
            {filter.stageLabel !== null ? ' and ' : ' '}tagged{' '}
            <span className="text-ink">{filter.tag}</span>
          </>
        ) : null}
        {filter.search !== null ? (
          <>
            {filter.stageLabel !== null || filter.tag !== null ? ' and matches ' : ' for '}
            <span className="text-ink">“{filter.search}”</span> by name, business, email or phone
          </>
        ) : null}
        . The filter lives in the URL, so this view is linkable — and reversible.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Link href={clearHref} className={buttonClass({ variant: 'secondary' })}>
          Clear filters
        </Link>
        <Link href="/pipeline/new" className={buttonClass({ variant: 'ghost' })}>
          New contact
        </Link>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Step({
  index,
  title,
  detail,
}: {
  index: number;
  title: string;
  detail: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="numeric mt-px w-4 shrink-0 text-right text-sm text-faint"
      >
        {index}
      </span>
      <div>
        <p className="font-display font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-muted">{detail}</p>
      </div>
    </li>
  );
}
