import { cx } from '@/components/ui/button';
import { COLUMNS, TD, TH } from '@/components/ui/table';

/**
 * The frame of /pipeline while the query runs.
 *
 * Deliberately inert: no shimmer, no pulse, no fade-in. DESIGN.md §5 allows
 * colour transitions and nothing else, and an animated skeleton on a page that
 * usually resolves in well under a second reads as slower than a still one. The
 * job here is only to hold the layout — same header height, same toolbar height,
 * same 34px rows — so that when the data lands nothing jumps under the cursor.
 *
 * The row and column classes come from components/ui/table, the same module
 * contact-table.tsx uses. They were hand-copied here, which meant the skeleton
 * silently drifted from the real table whenever either was edited — and a
 * skeleton that does not match is worse than none, because the jump it causes is
 * the exact thing it exists to prevent.
 *
 * The row count is fixed at eight: enough to look like a table, few enough that
 * a two-contact pipeline does not flash a wall of grey.
 */

const ROWS = 8;

/** Fixed widths, so the placeholder is identical on every render and on both
 *  sides of hydration. Varying them looks organic and costs a random source. */
const NAME_WIDTHS = ['w-52', 'w-40', 'w-64', 'w-44', 'w-56', 'w-36', 'w-48', 'w-60'] as const;

export default function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <p className="sr-only" role="status">
        Loading contacts.
      </p>

      <header className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl">Pipeline</h1>
          <p className="text-xs text-faint">Soonest follow-up first. Overdue at the top.</p>
        </div>
      </header>

      {/* Toolbar shell — matches the control heights in pipeline-filters. */}
      <div aria-hidden="true" className="flex flex-wrap items-center gap-2">
        <div className="h-[var(--control-h-md)] min-w-56 flex-1 rounded-md border border-line bg-raised sm:max-w-80" />
        <div className="h-[var(--control-h-md)] w-36 rounded-md border border-line bg-raised" />
        <div className="h-[var(--control-h-md)] w-40 rounded-md border border-line bg-raised" />
        <div className="ml-auto h-[var(--control-h-md)] w-28 rounded-md bg-sunken" />
      </div>

      <section>
        <div className="overflow-x-auto lg:overflow-x-visible">
          <table className="w-full border-separate border-spacing-0">
            <thead className="bg-raised">
              <tr>
                <th scope="col" className={cx(TH, COLUMNS.contact)}>
                  Contact
                </th>
                <th scope="col" className={cx(TH, COLUMNS.stage)}>
                  Stage
                </th>
                <th scope="col" className={cx(TH, COLUMNS.language)}>
                  Lang
                </th>
                <th scope="col" className={cx(TH, COLUMNS.nextTouch)}>
                  Next touch
                </th>
                <th scope="col" className={cx(TH, COLUMNS.lastTouch)}>
                  Last touch
                </th>
                <th scope="col" className={cx(TH, COLUMNS.value, 'text-right')}>
                  Value
                </th>
              </tr>
            </thead>

            <tbody aria-hidden="true">
              {Array.from({ length: ROWS }, (_, index) => (
                <tr key={index}>
                  <td className={cx(TD, COLUMNS.contact, 'pl-3')}>
                    <Bar className={NAME_WIDTHS[index % NAME_WIDTHS.length] ?? 'w-48'} />
                  </td>
                  <td className={cx(TD, COLUMNS.stage)}>
                    <Bar className="w-14" />
                  </td>
                  <td className={cx(TD, COLUMNS.language)}>
                    <Bar className="w-5" />
                  </td>
                  <td className={cx(TD, COLUMNS.nextTouch)}>
                    <Bar className="w-32" />
                  </td>
                  <td className={cx(TD, COLUMNS.lastTouch)}>
                    <Bar className="w-28" />
                  </td>
                  <td className={cx(TD, COLUMNS.value)}>
                    <Bar className="ml-auto w-12" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-3 py-2">
          <Bar className="w-56" />
        </div>
      </section>
    </div>
  );
}

function Bar({ className }: { className: string }) {
  return <span className={cx('block h-2 rounded-xs bg-sunken', className)} />;
}
