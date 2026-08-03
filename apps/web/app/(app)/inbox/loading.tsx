import { cx } from '@/components/ui/button';

/**
 * The frame of /inbox while the query runs.
 *
 * Deliberately inert: no shimmer, no pulse, no fade-in. DESIGN.md §5 allows
 * colour transitions and nothing else, and an animated skeleton on a page that
 * usually resolves in well under a second reads as slower than a still one. The
 * only job here is to hold the layout — same header, same toolbar heights, rows
 * of roughly the right depth — so nothing jumps under the cursor when the data
 * lands.
 *
 * The heading and the strapline are the real ones, not placeholders, because
 * they are already true before the query returns and a grey bar where a title
 * will be is a bar the operator has to re-read a moment later.
 *
 * Six rows, and the bar widths are fixed rather than varied: a random source
 * would make the placeholder differ between the server render and hydration,
 * which is the one thing a skeleton must not do.
 */

const ROWS = 6;

const SUBJECT_WIDTHS = ['w-64', 'w-80', 'w-52', 'w-72', 'w-60', 'w-76'] as const;
const SNIPPET_WIDTHS = ['w-full', 'w-11/12', 'w-10/12', 'w-full', 'w-9/12', 'w-11/12'] as const;

export default function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <p className="sr-only" role="status">
        Loading the inbox.
      </p>

      <header className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl">Inbox</h1>
          <p className="text-xs text-faint">
            What came in, and what was decided about it. Newest first.
          </p>
        </div>
      </header>

      {/* Toolbar shell — matches the two control widths in inbox-filters. */}
      <div aria-hidden="true" className="flex flex-wrap items-center gap-2">
        <div className="h-[var(--control-h-md)] w-44 rounded-md border border-line bg-raised" />
        <div className="h-[var(--control-h-md)] w-36 rounded-md border border-line bg-raised" />
      </div>

      <div aria-hidden="true" className="rounded-lg border border-line bg-raised">
        {Array.from({ length: ROWS }, (_, index) => (
          <div key={index} className="border-b border-line px-3 py-2.5 last:border-b-0">
            <div className="flex items-center gap-2.5">
              <Bar className="h-4 w-16 rounded-sm" />
              <Bar className="w-32" />
              <Bar className="ml-auto w-20" />
            </div>
            <Bar
              className={cx('mt-2', SUBJECT_WIDTHS[index % SUBJECT_WIDTHS.length] ?? 'w-64')}
            />
            <Bar
              className={cx('mt-1.5', SNIPPET_WIDTHS[index % SNIPPET_WIDTHS.length] ?? 'w-full')}
            />
            <Bar className="mt-2 w-56" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Bar({ className }: { className: string }) {
  return <span className={cx('block h-2 rounded-xs bg-sunken', className)} />;
}
