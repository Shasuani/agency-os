import type { ReactNode } from 'react';

import { cx } from './button';

/**
 * A bordered block with a hairline header row: a `label-caps` title on the left,
 * an optional note on the right, and the content below it.
 *
 * It was declared twice before it landed here — privately inside
 * components/pipeline/contact-form.tsx and again in components/brain/ —
 * because two people needed the same block during a step where components/ui was
 * frozen against parallel edits. That was the right call at the time and this is
 * the other half of it: the two copies had already diverged on the heading level
 * and on whether a note could be a node, and a third screen would have made it
 * three shapes for one border.
 *
 * Two props exist only because both callers are right about their case:
 *
 * - `level` picks `<h2>` or `<h3>`. /pipeline's form panels sit directly under
 *   the page's `<h1>`; /brain's sit inside a section that already has an `<h2>`.
 *   A panel that always emits `<h3>` breaks the heading outline on one page and
 *   one that always emits `<h2>` breaks it on the other, and the outline is what
 *   a screen reader navigates by (DESIGN.md §8).
 * - `tone="warning"` is for the kill switch, which is the one control in the app
 *   that has to be visible from across the room when it is on. Everything else
 *   is `normal`, and there is deliberately no `positive` tone: chrome does not
 *   celebrate.
 *
 * No directive. It holds no state and reads nothing, so it renders on the server
 * for a page and is equally usable inside a Client Component.
 */
export function Panel({
  title,
  note,
  level = 2,
  tone = 'normal',
  children,
}: {
  title: string;
  /** Right-aligned, small, `text-faint`. A hint, never an instruction. */
  note?: ReactNode;
  level?: 2 | 3;
  tone?: 'normal' | 'warning';
  children: ReactNode;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';

  return (
    <section
      className={cx(
        'rounded-lg border',
        tone === 'warning' ? 'border-warning/50 bg-warning-subtle' : 'border-line bg-raised',
      )}
    >
      <div
        className={cx(
          'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-4 py-2',
          tone === 'warning' ? 'border-warning/30' : 'border-line',
        )}
      >
        <Heading className={cx('label-caps', tone === 'warning' ? 'text-warning' : 'text-muted')}>
          {title}
        </Heading>
        {note !== undefined ? <span className="text-xs text-faint">{note}</span> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
