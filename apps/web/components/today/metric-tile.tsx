import Link from 'next/link';

import { cx } from '@/components/ui/button';

/**
 * One of the three numbers at the top of Today.
 *
 * **No shadow.** `shadow-card` is reserved for the task cards, which SPEC §6
 * says are the one place in this app with visual weight — a tile that competes
 * with them for attention makes the screen harder to read down, and the whole
 * design of Today is that the eye lands on the first card. A hairline and a
 * raised surface are enough to say "this is a panel".
 *
 * The figure is `text-3xl numeric`: the display face with tabular figures, which
 * is the one place DESIGN.md §3 asks for 34px.
 *
 * **Not a `<dl>`.** The obvious markup for a label-and-number is a description
 * list, and it is wrong here: a `<dl>` may only contain `<dt>`, `<dd>` and
 * grouping `<div>`s, so the tile could not also be a link without producing
 * invalid HTML — and an invalid landmark is a worse trade than a plain
 * paragraph. Two `<p>` elements read as "Open leads, 12", which is the sentence.
 *
 * `href` turns the whole tile into a link. Only "open leads" uses it, because
 * only "open leads" has somewhere obvious to go, and a tile that looks clickable
 * and is not is worse than a plain one.
 */

export type MetricTileProps = {
  label: string;
  value: number;
  /** One short line under the figure. Already formatted; never a clock. */
  sub?: string | null;
  /** Where clicking goes. Omit for a tile that is only a number. */
  href?: string;
  /** `text-warning` when the number is a problem rather than a fact. */
  tone?: 'ink' | 'warning';
};

const TILE =
  'flex flex-col justify-between gap-3 rounded-lg border border-line bg-raised px-4 py-3.5 transition-colors';

export function MetricTile({ label, value, sub = null, href, tone = 'ink' }: MetricTileProps) {
  const body = (
    <>
      <p className="label-caps text-muted">{label}</p>
      <div>
        <p className={cx('numeric text-3xl', tone === 'warning' ? 'text-warning' : 'text-ink')}>
          {value}
        </p>
        {sub !== null ? <p className="mt-1 text-xs text-faint">{sub}</p> : null}
      </div>
    </>
  );

  if (href === undefined) {
    return <div className={TILE}>{body}</div>;
  }

  return (
    <Link href={href} prefetch={false} className={cx(TILE, 'hover:bg-sunken')}>
      {body}
    </Link>
  );
}
