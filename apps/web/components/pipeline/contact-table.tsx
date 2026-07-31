'use client';

/**
 * The pipeline table.
 *
 * This is the screen that answers "who am I forgetting?", so the whole design
 * of it is in service of one glance: rows arrive already sorted by
 * `next_touch_at` ascending, which puts the most overdue contact at the top, and
 * overdue carries a 2px danger rail on the left edge plus a danger-toned date.
 * A rail down the left margin is readable at arm's length without tinting the
 * row, which would fight the stage badges and the selection colour.
 *
 * **No dates are computed here.** Every string in a cell — the absolute date,
 * the relative hint, the currency — is formatted on the server in
 * app/(app)/pipeline/page.tsx, in Europe/Athens (PLAN.md §7.1), and arrives as a
 * finished string. That is what keeps server and client output identical: this
 * component never sees a clock, so there is nothing for it to disagree about.
 *
 * Keyboard (SPEC §6): j/k move the selection, Enter opens it. `/` and `n` belong
 * to the toolbar, which owns the search input and the new-contact link.
 * Selection moves real DOM focus onto the row's link, so Enter is the browser's
 * own behaviour rather than a re-implementation of it, and the global focus ring
 * marks the row for free.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Stage } from '@agency/core';

import { cx } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { StageBadge } from '@/components/ui/stage-badge';
import { COLUMNS, TD, TH } from '@/components/ui/table';
import { DUE_TEXT_TONE, type DueTone } from '@/lib/day';

/** One row, fully formatted. Everything here is display-ready. */
export type PipelineRow = {
  id: string;
  /** `name`, or `business` when there is no name. Never empty. */
  primary: string;
  /** `business`, or null when it was promoted into `primary`. */
  secondary: string | null;
  stage: Stage | null;
  /** Free-form work tags. Empty array, never null. */
  tags: readonly string[];
  language: { short: string; full: string } | null;
  nextTouch: { date: string; relative: string; tone: DueTone } | null;
  lastTouch: { date: string; relative: string } | null;
  /** Formatted currency, or null when no estimate is set. */
  value: string | null;
  doNotContact: boolean;
  /** Has a follow-up date but no email — the agent will have nowhere to send. */
  unsendable: boolean;
};

const RAIL_TONE: Record<DueTone, string> = {
  overdue: 'bg-danger',
  due: 'bg-warning',
  later: 'bg-transparent',
};

/** A keystroke aimed at an input is the operator typing, not a shortcut. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export type ContactTableProps = {
  rows: readonly PipelineRow[];
  /** The read hit its ceiling; there are more contacts than are shown. */
  truncated?: boolean;
};

export function ContactTable({ rows, truncated = false }: ContactTableProps) {
  const [selected, setSelected] = useState(-1);
  const links = useRef<Array<HTMLAnchorElement | null>>([]);

  const move = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      setSelected((current) => {
        if (current < 0) return delta > 0 ? 0 : rows.length - 1;
        return Math.min(Math.max(current + delta, 0), rows.length - 1);
      });
    },
    [rows.length],
  );

  // Focus follows selection. Also scrolls the row into view, which is why the
  // link carries scroll-mt — the nav and the table head are both sticky.
  //
  // The bounds check is not paranoia: filtering or searching replaces the rows
  // under a live selection, and index 12 of a two-row list would otherwise focus
  // a ref left behind by an unmounted link.
  useEffect(() => {
    if (selected < 0) return;
    if (selected >= rows.length) {
      setSelected(-1);
      return;
    }
    links.current[selected]?.focus();
  }, [selected, rows.length]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      const key = event.key;

      if (key === 'j' || (key === 'ArrowDown' && selected >= 0)) {
        event.preventDefault();
        move(1);
        return;
      }
      if (key === 'k' || (key === 'ArrowUp' && selected >= 0)) {
        event.preventDefault();
        move(-1);
        return;
      }
      if (key === 'Escape' && selected >= 0) {
        setSelected(-1);
        return;
      }
      if (key === 'Enter' && selected >= 0) {
        const link = links.current[selected];
        // When the row's link already has focus the browser opens it itself;
        // stepping in here would navigate twice.
        if (link != null && document.activeElement !== link) {
          event.preventDefault();
          link.click();
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [move, selected]);

  return (
    <div>
      {/* The scroll container is conditional on purpose. An element with a
          non-visible overflow on either axis becomes the scrollport that a
          `position: sticky` header resolves against, so an unconditional
          `overflow-x-auto` here would silently stop the column headers sticking
          to the viewport. The fixed columns come to 640px, so from `lg` up the
          table always fits and the header can stick; below that, horizontal
          scroll matters more than a sticky head. */}
      <div className="overflow-x-auto lg:overflow-x-visible">
        <table className="w-full border-separate border-spacing-0">
          {/* Sticky under the 44px nav. bg-raised is opaque, so rows pass
              underneath rather than showing through. */}
          <thead className="sticky top-11 z-10 bg-raised">
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

          <tbody>
            {rows.map((row, index) => {
              const isSelected = index === selected;
              const tone = row.nextTouch?.tone ?? null;

              return (
                <tr
                  key={row.id}
                  onClick={() => setSelected(index)}
                  className={cx(
                    'group transition-colors',
                    isSelected ? 'bg-accent-subtle' : 'hover:bg-raised',
                  )}
                >
                  {/* max-w-0 + w-full is what lets a table cell truncate: the
                      cell absorbs the leftover width instead of being sized by
                      its content. */}
                  <td className={cx(TD, COLUMNS.contact, 'relative max-w-0 pl-3')}>
                    {tone !== null && tone !== 'later' ? (
                      <span
                        aria-hidden="true"
                        className={cx('absolute inset-y-0 left-0 w-0.5', RAIL_TONE[tone])}
                      />
                    ) : null}

                    <span className="block truncate">
                      <Link
                        ref={(node) => {
                          links.current[index] = node;
                        }}
                        href={`/pipeline/${row.id}`}
                        prefetch={false}
                        onFocus={() => setSelected(index)}
                        className="scroll-mt-20 rounded-xs text-ink group-hover:underline"
                      >
                        {row.primary}
                      </Link>
                      {row.secondary !== null ? (
                        <span className="text-muted"> · {row.secondary}</span>
                      ) : null}
                      {row.tags.length > 0 ? (
                        <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                          {row.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-xs border border-rule bg-raised px-1 py-px text-xs text-muted"
                              title={`Tagged ${tag}`}
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      ) : null}
                      {row.doNotContact ? (
                        <span
                          className="label-caps ml-2 text-warning"
                          title="Opted out — no follow-up will ever be sent"
                        >
                          opted out
                        </span>
                      ) : null}
                      {row.unsendable ? (
                        <span
                          className="label-caps ml-2 text-faint"
                          title="Follow-up date set, but no email address — this is a reminder for you; the agent has nothing to send"
                        >
                          no email
                        </span>
                      ) : null}
                    </span>
                  </td>

                  <td className={cx(TD, COLUMNS.stage)}>
                    <StageBadge stage={row.stage} />
                  </td>

                  <td className={cx(TD, COLUMNS.language)}>
                    {row.language === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <span className="label-caps text-faint" title={row.language.full}>
                        {row.language.short}
                      </span>
                    )}
                  </td>

                  <td className={cx(TD, COLUMNS.nextTouch)}>
                    {row.nextTouch === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <span className={DUE_TEXT_TONE[row.nextTouch.tone]}>
                        <span className="numeric">{row.nextTouch.date}</span>
                        <span className="ml-2 text-xs">{row.nextTouch.relative}</span>
                      </span>
                    )}
                  </td>

                  <td className={cx(TD, COLUMNS.lastTouch)}>
                    {row.lastTouch === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <>
                        <span className="numeric text-muted">{row.lastTouch.date}</span>
                        <span className="ml-2 text-xs text-faint">{row.lastTouch.relative}</span>
                      </>
                    )}
                  </td>

                  <td className={cx(TD, COLUMNS.value, 'text-right')}>
                    {row.value === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <span className="numeric text-ink">{row.value}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-3 py-2">
        <p className="flex flex-wrap items-baseline gap-1 text-2xs text-faint">
          <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>enter</Kbd> open · <Kbd>n</Kbd> new ·{' '}
          <Kbd>/</Kbd> search
        </p>
        {truncated ? (
          <p className="text-xs text-muted">
            Showing the first <span className="numeric">{rows.length}</span>. Narrow it with a
            stage or a search.
          </p>
        ) : null}
      </div>
    </div>
  );
}
