import { cx } from './button';

/**
 * One figure in a header: the number, then its label in small caps beside it.
 *
 * It lands here for the same reason `Panel` did and by the same rule that
 * file's header states — it had been declared twice, privately, before it was
 * extracted. `/pipeline` wrote it first; `/inbox` wrote it again during a step
 * where components/ui was frozen against parallel edits, and said so in a note
 * asking the third screen to do this. Two identical copies is already the point
 * at which they can drift, and a header figure is the kind of thing that drifts
 * quietly: one screen gains a tone, the other keeps `text-ink`, and the same
 * number means two different things depending on which page you are on.
 *
 * It is a `<dd>`/`<dt>` pair and therefore has to sit inside a `<dl>` — both
 * callers wrap their header row in one. The visible text is the number and the
 * `aria-hidden` caption; the real label is in the `<dt>`, screen-reader only,
 * because "14" followed by "days" reads as two things to a sighted operator and
 * has to read as one to everybody else.
 *
 * `tone` defaults to `text-ink`. Passing a hue is how a caller says this
 * particular figure is worth stopping on — `/inbox` tints its unclassified
 * count and nothing else. DESIGN.md §2: colour is meaning, not decoration.
 *
 * No directive. It holds no state and reads nothing.
 */
export function Stat({
  value,
  label,
  tone = 'text-ink',
  title,
}: {
  value: number;
  label: string;
  tone?: string;
  /** Native tooltip. A sentence explaining what the figure counts, never the
   *  figure itself — it is not reachable from a keyboard and nothing that
   *  matters may live only here. */
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
