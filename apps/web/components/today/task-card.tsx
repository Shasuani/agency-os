'use client';

/**
 * One task, and the only place in this app with visual weight (SPEC §6).
 *
 * Everything on it arrives as a finished string. The card never formats a date,
 * never asks what time it is, never re-evaluates a guardrail — the page did all
 * of that on the server, in the operator's timezone, and handed the result over
 * as `TaskCardData`. That is what makes server and client output identical and a
 * hydration mismatch impossible, and it is the same rule contact-table.tsx
 * follows for /pipeline.
 *
 * **Controlled, and the state lives in the list.** The body is a prop and every
 * keystroke goes up to task-list.tsx. Two reasons, and the second is the real
 * one: an uncontrolled textarea gets reset by React when a `<form action>`
 * settles, which would throw away an edit on a failed save (contact-form.tsx
 * documents that trap at length); and `Enter` approves the *selected* card from
 * anywhere on the page, which means the list has to be able to read the edited
 * body of a card it does not have focus inside. State in the card would need an
 * imperative handle per card to do the same job.
 *
 * **The subject is read-only, and the card says so.** There is no
 * `final_subject` column, overwriting `draft_subject` would destroy the
 * provenance step 9 needs, and step 6 may not add a migration. Making it look
 * editable and then discarding the edit would be worse than the honest label.
 *
 * **The guardrail strip is a warning, not a lie.** It is computed from the same
 * pure `evaluateSend` the worker uses, against counts the page read a moment
 * ago, so it can be a few seconds stale — it decides what the card *says*, never
 * whether a message leaves. A `block` disables the approve button, because
 * approving would achieve nothing; a `wait` leaves it alone, because approving
 * is correct and the queue holds the message until the cap or the cooldown
 * clears. Colour is never the only signal: both tones carry their own words.
 */

import Link from 'next/link';

import { Button, cx } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Textarea } from '@/components/ui/input';
import { StageBadge } from '@/components/ui/stage-badge';
import { bodyChanged } from '@/lib/task-view';
import type { GuardTone, TaskCardData } from '@/lib/task-view';

/** How tall the draft box starts. Six rows holds a 120-word follow-up without
 *  scrolling, which is the length PLAN §6 step 5 asks the agent for. */
const MIN_ROWS = 6;
const MAX_ROWS = 20;

const GUARD_TONE: Record<GuardTone, string> = {
  block: 'border-danger/40 bg-danger-subtle text-danger',
  wait: 'border-warning/40 bg-warning-subtle text-warning',
};

export type TaskOutcome = { tone: 'ok' | 'error'; text: string };

export type TaskCardProps = {
  data: TaskCardData;
  selected: boolean;
  /** The live body, edited or not. Owned by task-list.tsx. */
  body: string;
  /** An action is in flight for this card. */
  busy: boolean;
  /** What the last action on this card said. */
  outcome: TaskOutcome | null;
  onSelect: () => void;
  onBodyChange: (value: string) => void;
  onApprove: () => void;
  /** SPEC §6's "save edit": keep the rewrite, send nothing. */
  onSave: () => void;
  onSkip: () => void;
  onReject: () => void;
  /**
   * The list focuses this for j/k. The textarea is reached by id instead —
   * `components/ui` is frozen for step 6 and `<Textarea>` does not accept a
   * `ref` in its prop type, and `bodyElementId` is deterministic, so a
   * `getElementById` is honest rather than a workaround for a missing wire.
   */
  registerCard: (node: HTMLElement | null) => void;
};

/** The id of a card's draft textarea. Exported so task-list.tsx focuses the
 *  same element this component labels. */
export function bodyElementId(taskId: string): string {
  return `task-${taskId}-body`;
}

export function TaskCard({
  data,
  selected,
  body,
  busy,
  outcome,
  onSelect,
  onBodyChange,
  onApprove,
  onSave,
  onSkip,
  onReject,
  registerCard,
}: TaskCardProps) {
  const bodyId = bodyElementId(data.id);
  const titleId = `task-${data.id}-title`;

  const blocked = data.guard?.tone === 'block';
  const emptyBody = body.trim() === '';
  // The same comparison the approve action makes on the server, so "Save edit"
  // is offered for exactly the changes that would be stored as an edit.
  const edited = bodyChanged(data.body, body);
  const canApprove = data.kind === 'draft_email' && !blocked && !emptyBody && !busy;

  return (
    <article
      ref={registerCard}
      // Focusable but not in the tab order: Tab should walk the controls, and
      // j/k moves this. Focusing the card is what marks the selection — the
      // global focus ring does the work, so the border is a second signal and
      // not the only one.
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-current={selected ? 'true' : undefined}
      aria-busy={busy || undefined}
      onFocus={onSelect}
      onClick={onSelect}
      className={cx(
        'relative scroll-mt-20 rounded-lg border bg-raised shadow-card transition-colors',
        selected ? 'border-accent' : 'border-line',
        busy && 'opacity-70',
      )}
    >
      {selected ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-0.5 rounded-l-lg bg-accent"
        />
      ) : null}

      {/* Header: who filed it, what it is about, when. */}
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
        <span className="label-caps rounded-sm border border-line bg-sunken px-1.5 py-0.5 text-muted">
          {data.agent}
        </span>

        <h3 id={titleId} className="text-md text-ink">
          {data.title}
        </h3>

        <span className="numeric ml-auto text-xs text-faint">{data.filedAt}</span>
      </header>

      <div className="flex flex-col gap-3 px-4 py-3.5">
        {/* Who it is to, and the one-line context the agent had. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {data.contact !== null ? (
            <>
              <Link
                href={`/pipeline/${data.contact.id}`}
                prefetch={false}
                className="rounded-xs text-base text-ink hover:underline"
              >
                {data.contact.primary}
              </Link>
              {data.contact.secondary !== null ? (
                <span className="text-base text-muted">· {data.contact.secondary}</span>
              ) : null}
              <StageBadge stage={data.contact.stage} />
            </>
          ) : (
            <span className="text-base text-faint">No contact attached</span>
          )}

          {data.context.length > 0 ? (
            <span className="text-xs text-faint">{data.context.join(' · ')}</span>
          ) : null}
        </div>

        {data.reasoning !== null ? (
          <p className="text-sm text-muted">{data.reasoning}</p>
        ) : null}

        {data.guard !== null ? (
          <p
            role="note"
            className={cx(
              'rounded-md border px-2.5 py-1.5 text-sm',
              GUARD_TONE[data.guard.tone],
            )}
          >
            <span className="font-display font-medium">{data.guard.label}.</span>{' '}
            {data.guard.detail}
          </p>
        ) : null}

        {data.kind === 'draft_email' ? (
          <>
            {/* Read-only, and labelled as such rather than styled as such. */}
            <div className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-line bg-sunken px-2.5 py-1.5">
              <span className="label-caps text-muted">Subject</span>
              {data.subject === null ? (
                <span className="text-sm text-warning">No subject line on this draft</span>
              ) : (
                <span className="text-base text-ink">{data.subject}</span>
              )}
              <span className="ml-auto text-2xs text-faint">not editable in v1</span>
            </div>

            <div>
              <label htmlFor={bodyId} className="label-caps text-muted">
                Draft
              </label>
              <Textarea
                id={bodyId}
                value={body}
                rows={rowsFor(body)}
                spellCheck
                disabled={busy}
                invalid={emptyBody}
                onChange={(event) => onBodyChange(event.target.value)}
                className="mt-1"
              />
              {emptyBody ? (
                <p className="mt-1 text-xs text-danger">
                  An empty message cannot be sent. Write something, or reject it.
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-xs text-faint">
            Nothing to send — this is a note. Dismiss it once you have read it.
          </p>
        )}

        {outcome !== null ? (
          <p
            className={cx('text-sm', outcome.tone === 'ok' ? 'text-positive' : 'text-danger')}
            role="status"
          >
            {outcome.text}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-0.5">
          <p className="flex flex-wrap items-baseline gap-1 text-2xs text-faint">
            {data.kind === 'draft_email' ? (
              <>
                <Kbd>e</Kbd> edit · <Kbd>⌘</Kbd>
                <Kbd>s</Kbd> save · <Kbd>↵</Kbd> approve · <Kbd>s</Kbd> skip · <Kbd>r</Kbd>{' '}
                reject
              </>
            ) : (
              <>
                <Kbd>s</Kbd> dismiss
              </>
            )}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {data.kind === 'draft_email' ? (
              <>
                <Button variant="danger" size="sm" disabled={busy} onClick={onReject}>
                  Reject
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={onSkip}>
                  Skip
                </Button>
                {/* SPEC §6's third button. It is only offered once the text has
                    actually changed: a "Save edit" that is always live invites
                    a click that writes the draft back over itself, and step 9
                    reads `final_body !== draft_body` as "the owner rewrote
                    this". */}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || !edited || emptyBody}
                  onClick={onSave}
                >
                  Save edit
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!canApprove}
                  // A disabled button explains nothing on hover for a keyboard
                  // user, so the guard strip above carries the reason in words.
                  title={blocked ? data.guard?.detail : undefined}
                  onClick={onApprove}
                >
                  {busy ? 'Approving…' : 'Approve and send'}
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="sm" disabled={busy} onClick={onSkip}>
                {busy ? 'Dismissing…' : 'Dismiss'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/** Grow with the draft so a long message does not sit in a six-row porthole,
 *  and stop before a card takes over the screen. Counting newlines rather than
 *  measuring: no layout read, no resize observer, identical on both sides of
 *  hydration. */
function rowsFor(body: string): number {
  const lines = body.split('\n').length + Math.floor(body.length / 90);
  return Math.min(Math.max(lines + 1, MIN_ROWS), MAX_ROWS);
}
