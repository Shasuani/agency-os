/**
 * The two class strings that define a table row's density, in one place.
 *
 * DESIGN.md §4: 34px rows, `label-caps text-muted` headers, a `border-b
 * border-line` hairline between rows, no zebra striping. The pipeline table and
 * its loading skeleton both need these, and the skeleton exists precisely so
 * nothing jumps when the data lands — which it would the moment one of the two
 * copies was edited and the other was not.
 *
 * No directive: a plain module, importable from both a Server Component
 * (loading.tsx) and a Client Component (contact-table.tsx).
 */

/** `<th>` — sits in a `bg-raised` sticky `<thead>`. */
export const TH = 'h-7 border-b border-line px-2 text-left align-middle label-caps text-muted';

/** `<td>` — 34px, hairline under, never wraps. */
export const TD =
  'h-[var(--row-h)] border-b border-line px-2 align-middle whitespace-nowrap';

/** The column widths, so the skeleton and the table cannot disagree about the
 *  grid either. `w-full` on the first column is what makes the rest fixed. */
export const COLUMNS = {
  contact: 'w-full',
  stage: 'w-24',
  language: 'w-12',
  nextTouch: 'w-52',
  lastTouch: 'w-44',
  value: 'w-28',
} as const;
