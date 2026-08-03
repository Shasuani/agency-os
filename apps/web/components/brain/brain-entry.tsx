'use client';

/**
 * One brain key: the label, what the agent does with it, a textarea, and a save.
 *
 * Eight of these, one per key, each saving on its own. They are eight unrelated
 * pieces of prose and a half-typed `case_studies` must not block saving
 * `pricing`.
 *
 * **An empty key is a deliberate state and this component never nags about it.**
 * SPEC §4 and brain/README.md both say so: an empty key makes the drafting agent
 * stay quiet on that subject instead of inventing a claim to a real customer. So
 * an empty editor gets a plain `text-faint` note saying what the silence means —
 * not a warning colour, not a red border, and nothing that auto-fills it. The
 * placeholder is a shape, not a suggestion to accept.
 *
 * The textarea is controlled, for the reason contact-form.tsx documents: React
 * resets an uncontrolled `<form action>` when the action settles, which on a
 * rejected save would discard prose the operator may have spent ten minutes on.
 * That is also why this saves through a plain argument rather than `FormData` —
 * see `saveBrainEntry`.
 *
 * Nothing here mentions the file on disk; the section header above says it once,
 * where it belongs, rather than eight times.
 */

import { useState, useTransition } from 'react';

import { Button, cx } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Textarea } from '@/components/ui/input';
import { saveBrainEntry } from '@/lib/settings-actions';
import { MAX_BRAIN_CHARS } from '@/lib/settings-validation';

import { brainMeta } from './brain-vocab';

export type BrainEntryProps = {
  entryKey: string;
  value: string;
  /** Already formatted on the server, in the operator's timezone. Null when the
   *  key has never been written. */
  updatedLabel: string | null;
};

export function BrainEntry({ entryKey, value: stored, updatedLabel }: BrainEntryProps) {
  const meta = brainMeta(entryKey);
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(stored);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  // Compared against the same normalisation the server applies, so a trailing
  // newline the textarea invented does not read as an unsaved change.
  const dirty = normalise(value) !== normalise(stored);
  const empty = normalise(value) === '';
  const overLimit = value.length > MAX_BRAIN_CHARS;

  function save(): void {
    setError(undefined);
    startTransition(async () => {
      const result = await saveBrainEntry(entryKey, value);
      if (result.ok) {
        setSaved(true);
        return;
      }
      setError(result.errors.brain ?? 'Could not save.');
    });
  }

  return (
    <section className="rounded-lg border border-line bg-raised">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-2">
        <div className="flex items-baseline gap-2">
          <h3 className="label-caps text-muted">{meta.label}</h3>
          <code className="font-mono text-2xs text-faint">{entryKey}</code>
        </div>
        <span className="text-xs text-faint">
          {updatedLabel === null ? 'Never saved from here' : `Updated ${updatedLabel}`}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-4">
        <p className="max-w-prose text-xs text-muted">{meta.blurb}</p>

        <Textarea
          aria-label={meta.label}
          rows={8}
          value={value}
          invalid={overLimit || error !== undefined}
          placeholder={meta.placeholder}
          spellCheck
          onChange={(event) => {
            setValue(event.target.value);
            setSaved(false);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!pending) save();
            }
          }}
        />

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-xs text-faint">
            {error !== undefined ? (
              <span role="alert" className="text-danger">
                {error}
              </span>
            ) : empty ? (
              // Not a warning. An empty key is how you tell the agent it has
              // nothing true to say about this.
              'Empty — the agent will say nothing about this rather than guess.'
            ) : (
              <>
                <span className={cx('numeric', overLimit && 'text-danger')}>
                  {value.length.toLocaleString('en-US')}
                </span>
                {' characters'}
                {dirty ? <span className="text-muted"> · unsaved</span> : null}
                {saved && !dirty ? <span className="text-muted"> · saved</span> : null}
              </>
            )}
          </p>

          <div className="flex items-center gap-2">
            <span className="flex items-baseline gap-1 text-2xs text-faint">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
            <Button
              size="sm"
              variant={dirty ? 'primary' : 'secondary'}
              disabled={pending || overLimit}
              onClick={save}
            >
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The server's `parseBrainValue` normalisation, so "unsaved" means what it
 *  says. Kept to the two rules that file documents — line endings and trailing
 *  blank space — and nothing more. */
function normalise(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t\n]+$/, '');
}
