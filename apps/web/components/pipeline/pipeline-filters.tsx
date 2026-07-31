'use client';

/**
 * The pipeline toolbar: search, stage filter, sort, and the one high-commitment
 * action on the screen.
 *
 * **Every control writes to the URL and nothing else.** There is no local list
 * state here: changing a filter navigates, the Server Component re-runs
 * `listContacts` with the new params, and Postgres does the filtering against
 * the indexes on `stage` and `next_touch_at`. The consequence the operator
 * feels is that any view is a link — `?stage=quoted&sort=value` can be
 * bookmarked, pasted, and survives a refresh.
 *
 * The current query arrives as props rather than through `useSearchParams()`, so
 * this component reads no ambient state and the page owns exactly one source of
 * truth for what is being shown.
 *
 * Keyboard: `/` focuses search, Escape leaves it, `n` starts a new contact. The
 * row shortcuts (j/k/Enter) live in the table. This half of the pair is here
 * because it owns the input and the link — and because it renders even when the
 * table does not, so `n` still works from an empty pipeline.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { buttonClass, cx } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Select } from '@/components/ui/select';
import { STAGE_FILTER_OPTIONS, type StageFilter } from '@/lib/contact-vocab';
import type { ContactSort } from '@/lib/validation';

const PIPELINE_PATH = '/pipeline';
const SEARCH_ID = 'pipeline-search';
const STAGE_ID = 'pipeline-stage';
const TAG_ID = 'pipeline-tag';
const SORT_ID = 'pipeline-sort';

/** Long enough not to fire on every keystroke, short enough that the list feels
 *  attached to the keyboard. */
const SEARCH_DEBOUNCE_MS = 250;

export type PipelineQuery = {
  stage: StageFilter;
  tag: string;
  sort: ContactSort;
  /** The raw `q` param, not the normalised form — so what is typed round-trips
   *  through the URL unchanged and the input never fights the server. */
  q: string;
};

export type PipelineFiltersProps = {
  query: PipelineQuery;
  /** `SORT_OPTIONS` from lib/validation, passed in by the page: that module
   *  value-imports @agency/core, which has no business in a client bundle. The
   *  stage vocabulary is imported directly instead, because lib/contact-vocab
   *  imports types only and is safe here. */
  sortOptions: readonly { value: string; label: string }[];
  /** Every tag present in the pipeline, built by the page from the rows it read.
   *  Includes the active tag even when nothing on screen carries it, so the
   *  select can always show its own value. */
  tagOptions: readonly { value: string; label: string }[];
  defaultSort: ContactSort;
};

export function PipelineFilters({
  query,
  sortOptions,
  tagOptions,
  defaultSort,
}: PipelineFiltersProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [term, setTerm] = useState(query.q);

  // The ref sits on the wrapper, not the input: `<Input>` is a plain function
  // component typed on `InputHTMLAttributes`, which does not carry `ref`, and a
  // keyboard shortcut is not a reason to widen a shared primitive's API. The
  // input is the only one inside this element, so the lookup cannot be wrong.
  const boxRef = useRef<HTMLDivElement>(null);
  const searchInput = useCallback((): HTMLInputElement | null => {
    return boxRef.current?.querySelector('input') ?? null;
  }, []);

  // Keep the box in step with the URL when the change came from outside it —
  // the back button, or the "Clear" link. Never while the operator is mid-word:
  // the guard is that what they have typed already resolves to what the URL says.
  useEffect(() => {
    setTerm((current) => (current.trim() === query.q ? current : query.q));
  }, [query.q]);

  const hrefFor = useCallback(
    (next: Partial<PipelineQuery>): string => {
      const stage = next.stage ?? query.stage;
      const tag = next.tag ?? query.tag;
      const sort = next.sort ?? query.sort;
      const q = (next.q ?? query.q).trim();

      const params = new URLSearchParams();
      if (stage !== 'all') params.set('stage', stage);
      if (tag !== '') params.set('tag', tag);
      if (sort !== defaultSort) params.set('sort', sort);
      if (q !== '') params.set('q', q);

      const search = params.toString();
      return search === '' ? PIPELINE_PATH : `${PIPELINE_PATH}?${search}`;
    },
    [query, defaultSort],
  );

  const go = useCallback(
    (next: Partial<PipelineQuery>, mode: 'push' | 'replace') => {
      const href = hrefFor(next);
      startTransition(() => {
        // scroll: false — retyping a search must not throw the operator back to
        // the top of a list they were half way down.
        if (mode === 'push') router.push(href, { scroll: false });
        else router.replace(href, { scroll: false });
      });
    },
    [hrefFor, router],
  );

  // Debounced search. `replace`, not `push`: one history entry per keystroke
  // makes the back button useless.
  useEffect(() => {
    if (term.trim() === query.q) return;
    const timer = setTimeout(() => go({ q: term }, 'replace'), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, query.q, go]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT');

      if (event.key === 'Escape' && target instanceof HTMLElement && target.id === SEARCH_ID) {
        target.blur();
        return;
      }
      if (typing) return;

      if (event.key === '/') {
        event.preventDefault();
        const input = searchInput();
        input?.focus();
        input?.select();
        return;
      }
      if (event.key === 'n') {
        event.preventDefault();
        router.push('/pipeline/new');
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router, searchInput]);

  const filtered = query.stage !== 'all' || query.tag !== '' || query.q.trim() !== '';

  return (
    <div
      aria-busy={pending || undefined}
      className={cx(
        'flex flex-wrap items-center gap-2 transition-opacity',
        pending && 'opacity-70',
      )}
    >
      <div ref={boxRef} className="relative min-w-56 flex-1 sm:max-w-80">
        <label htmlFor={SEARCH_ID} className="sr-only">
          Search contacts
        </label>
        <Input
          id={SEARCH_ID}
          type="search"
          value={term}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search name, business, email"
          onChange={(event) => setTerm(event.target.value)}
          className="pr-7"
        />
        {term === '' ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
          >
            <Kbd>/</Kbd>
          </span>
        ) : null}
      </div>

      <div className="w-36">
        <label htmlFor={STAGE_ID} className="sr-only">
          Filter by stage
        </label>
        <Select
          id={STAGE_ID}
          value={query.stage}
          options={STAGE_FILTER_OPTIONS}
          onChange={(event) => go({ stage: event.target.value as StageFilter }, 'push')}
        />
      </div>

      <div className="w-36">
        <label htmlFor={TAG_ID} className="sr-only">
          Filter by tag
        </label>
        {/* A select, not a free-text box: filtering matches exactly, so offering
            only tags that exist means the filter can never return an empty list
            because of a typo. `tagOptions` is built from the rows on screen. */}
        <Select
          id={TAG_ID}
          value={query.tag}
          options={tagOptions}
          onChange={(event) => go({ tag: event.target.value }, 'push')}
        />
      </div>

      <div className="w-40">
        <label htmlFor={SORT_ID} className="sr-only">
          Sort by
        </label>
        <Select
          id={SORT_ID}
          value={query.sort}
          options={sortOptions}
          onChange={(event) => go({ sort: event.target.value as ContactSort }, 'push')}
        />
      </div>

      {filtered ? (
        <Link href={PIPELINE_PATH} className={buttonClass({ variant: 'ghost', size: 'md' })}>
          Clear
        </Link>
      ) : null}

      <Link
        href="/pipeline/new"
        className={cx(buttonClass({ variant: 'primary' }), 'ml-auto')}
      >
        New contact
        <span aria-hidden="true" className="ml-1 font-mono text-2xs opacity-60">
          n
        </span>
      </Link>
    </div>
  );
}
