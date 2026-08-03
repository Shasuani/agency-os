/**
 * The frame of /brain while the two reads run.
 *
 * Deliberately inert: no shimmer, no pulse, no fade-in. DESIGN.md §5 allows
 * colour transitions and nothing else, and an animated skeleton on a page that
 * usually resolves in well under a second reads as slower than a still one.
 *
 * It exists because a `loading.tsx` applies to every route below it that has not
 * got one of its own, and `app/(app)/loading.tsx` is Today's — six panels of
 * task-card geometry, which is not what this page looks like. Without this file,
 * opening /brain flashed a queue of drafts that are not there and then replaced
 * it with a settings form. /pipeline has had its own for the same reason since
 * step 2.
 *
 * The kill switch is the one thing not drawn as a grey block. It is the reason
 * somebody opens this page in a hurry, and a placeholder that could be read as
 * "sends are paused" while the real answer is still loading would be a lie in the
 * one place this app cannot afford one. The heading says what is loading; the
 * state arrives when it is known.
 */

const BRAIN_KEYS = 8;

export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <p className="sr-only" role="status">
        Loading settings and brain.
      </p>

      <header className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl">Brain</h1>
          <p className="text-xs text-faint">
            What the agents know, and what they are allowed to do with it.
          </p>
        </div>
      </header>

      <section aria-hidden="true" className="flex flex-col gap-3">
        <h2 className="text-lg">Operations</h2>

        {/* The kill switch panel: header row, one sentence, one button. */}
        <div className="rounded-lg border border-line bg-raised">
          <div className="border-b border-line px-4 py-2">
            <span className="block h-2.5 w-28 rounded-xs bg-sunken" />
          </div>
          <div className="flex items-center justify-between gap-4 p-4">
            <span className="block h-2 w-full max-w-md rounded-xs bg-sunken" />
            <span className="block h-[var(--control-h-sm)] w-28 shrink-0 rounded-md bg-sunken" />
          </div>
        </div>

        {/* Volume, send window, autonomy — three panels of fields. */}
        {['w-20', 'w-32', 'w-24'].map((width) => (
          <div key={width} className="rounded-lg border border-line bg-raised">
            <div className="border-b border-line px-4 py-2">
              <span className={`block h-2.5 ${width} rounded-xs bg-sunken`} />
            </div>
            <div className="flex flex-col gap-3 p-4">
              {/* An input's own height. `--control-h` on its own does not exist
                  — only the -sm and -md pair — and an undefined custom property
                  makes the declaration invalid, which collapsed these blocks to
                  zero and made /brain jump the moment it resolved. */}
              <span className="block h-[var(--control-h-md)] w-full max-w-xs rounded-md border border-line-strong" />
              <span className="block h-2 w-full max-w-lg rounded-xs bg-sunken" />
            </div>
          </div>
        ))}
      </section>

      <section aria-hidden="true" className="flex flex-col gap-3">
        <h2 className="text-lg">Brain</h2>

        {Array.from({ length: BRAIN_KEYS }, (_, index) => (
          <div key={index} className="rounded-lg border border-line bg-raised">
            <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2">
              <span className="block h-2.5 w-36 rounded-xs bg-sunken" />
              <span className="block h-2 w-24 rounded-xs bg-sunken" />
            </div>
            <div className="p-4">
              {/* The editor: four rows at the textarea's own line height. */}
              <span className="block h-24 w-full rounded-md border border-line-strong" />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
