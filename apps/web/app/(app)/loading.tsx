/**
 * The frame of Today while the four reads run.
 *
 * Deliberately inert: no shimmer, no pulse, no fade-in. DESIGN.md §5 allows
 * colour transitions and nothing else, and an animated skeleton on a page that
 * usually resolves in well under a second reads as slower than a still one. The
 * job here is only to hold the layout — same header, same three tiles, same card
 * geometry — so that when the queue lands nothing jumps under the cursor.
 *
 * Two cards, not five. The morning batch is a handful, and a wall of grey
 * rectangles on a two-task day promises more work than there is.
 *
 * **This boundary covers the whole `(app)` group**, because `/` is the group's
 * index and there is no segment to put it in that Next would still match. Every
 * other route therefore needs its own `loading.tsx` or it renders this one:
 * /pipeline has had one since step 2 and /brain got one at integration. A route
 * added later and left without one will flash a queue of drafts that are not
 * there — that is the failure mode, and it is cheap to avoid.
 */

const CARDS = 2;

export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <p className="sr-only" role="status">
        Loading today.
      </p>

      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl">Today</h1>
        <p className="text-xs text-faint">
          Newest first. j/k to move, e to edit, Enter to approve.
        </p>
      </header>

      <div aria-hidden="true" className="grid gap-3 sm:grid-cols-3">
        {['Needs you', 'Open leads', 'Done today'].map((label) => (
          <div
            key={label}
            className="flex flex-col justify-between gap-3 rounded-lg border border-line bg-raised px-4 py-3.5"
          >
            <p className="label-caps text-muted">{label}</p>
            <div>
              {/* 34px tall, so the figure landing does not move the tile. */}
              <span className="block h-[2.125rem] w-10 rounded-xs bg-sunken" />
              <span className="mt-1 block h-2 w-40 rounded-xs bg-sunken" />
            </div>
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="flex flex-col gap-3">
        {Array.from({ length: CARDS }, (_, index) => (
          <div key={index} className="rounded-lg border border-line bg-raised shadow-card">
            <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
              <span className="block h-4 w-16 rounded-sm bg-sunken" />
              <span className="block h-2.5 w-56 rounded-xs bg-sunken" />
              <span className="ml-auto block h-2 w-8 rounded-xs bg-sunken" />
            </div>

            <div className="flex flex-col gap-3 px-4 py-3.5">
              <span className="block h-2.5 w-72 rounded-xs bg-sunken" />
              <span className="block h-2 w-full max-w-lg rounded-xs bg-sunken" />
              {/* The draft box: six rows at the textarea's own line height. */}
              <span className="block h-36 w-full rounded-md border border-line-strong" />
              <div className="flex justify-end gap-2">
                <span className="block h-[var(--control-h-sm)] w-16 rounded-md bg-sunken" />
                <span className="block h-[var(--control-h-sm)] w-14 rounded-md bg-sunken" />
                <span className="block h-[var(--control-h-sm)] w-32 rounded-md bg-sunken" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
