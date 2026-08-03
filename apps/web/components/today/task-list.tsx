'use client';

/**
 * The queue, the selection, and the one keyboard loop on this screen.
 *
 * SPEC §6 makes the shortcuts a feature rather than a nicety, and PLAN §6 step 6
 * makes the acceptance criterion explicit: **the daily loop completes in ninety
 * seconds without touching the mouse.** Everything in this file is in service of
 * that, and every deviation below is a decision, not an accident.
 *
 * ## The shortcut map
 *
 *   j / ArrowDown     next card
 *   k / ArrowUp       previous card
 *   e                 focus the selected card's draft, cursor at the end
 *   Escape            leave the draft (back to the card), or drop the selection
 *   Enter             approve the selected card
 *   Cmd/Ctrl+Enter    approve from inside the draft
 *   Cmd/Ctrl+S        save the edit without sending it
 *   s                 skip
 *   r                 reject
 *
 * ## Why it is built this way
 *
 * **Selection moves real DOM focus**, onto the card element itself, exactly as
 * contact-table.tsx moves focus onto a row's link. Three things fall out of that
 * for free: the global focus ring marks the selection so colour is never the
 * only signal, the browser scrolls the card into view, and a screen reader
 * announces the card it has landed on. A selection that is only a CSS class is
 * invisible to half the people who might use it.
 *
 * **A keystroke aimed at an input is the operator typing.** `isTypingTarget` is
 * four lines copied from contact-table.tsx rather than imported from it — that
 * file belongs to /pipeline, and a shared helper reached across feature
 * directories is how two screens end up unable to change independently.
 *
 * **`s` and `r` require an explicit selection; `e` does not.** Pressing `e` with
 * nothing selected is unambiguously "let me edit the first one", so it selects
 * the first card *and* puts the cursor in its draft — one keystroke, as
 * described, rather than the two it silently took before. The focus effect below
 * consumes `pendingEdit` for that reason: selecting a card focuses the card, so
 * a `focus()` called before the render would be undone by it. Pressing `r` with
 * nothing selected would reject a draft the operator has not looked at, and a
 * destructive action must never act on a selection the operator did not make.
 *
 * **`Cmd/Ctrl+S` saves the edit and sends nothing** (SPEC §6's "save edit"). The
 * browser's own Save dialog is not a thing anybody wants on this page, and an
 * edit that only exists in this component's state is one reload away from gone.
 *
 * **`Enter` on a focused button is left to the browser.** If the operator has
 * tabbed to "Reject" and presses Enter, this handler must not also approve. The
 * check is on the event target, not on a flag.
 *
 * **The edited bodies live here, keyed by task id**, not in the cards. `Enter`
 * approves the selected card from anywhere on the page, so the list has to be
 * able to read the edited body of a card it does not have focus inside. It also
 * survives the router refetching the queue after an action: an entry is only
 * consulted while its task is still pending.
 *
 * **A success is logged above the queue; a failure stays on its card.** They go
 * to different places because the card goes to different places: approving
 * revalidates `/`, the task stops being pending, and the card is gone on the
 * next render — taking "Sends Tuesday from 09:07" with it. That sentence is the
 * one the operator most needs, because with the seeded Tue–Thu window an
 * approval on a Monday does not leave until Tuesday (PLAN §7.1), so it is held
 * in client state above the list where the refetch cannot take it. A failure is
 * the opposite case: the task is still pending, the card is still there, and the
 * message belongs next to the button that did not work.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { Kbd } from '@/components/ui/kbd';
import { approveTask, rejectTask, saveDraft, skipTask } from '@/lib/task-actions';
import type { TaskCardData } from '@/lib/task-view';

import { TaskCard, bodyElementId } from './task-card';

/** How many outcome lines to keep above the queue. Enough to see the last few
 *  approvals of one morning's loop, few enough that it never becomes the page. */
const MAX_OUTCOMES = 6;

/** A keystroke aimed at an input is the operator typing, not a shortcut. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** A logged success. The key is a counter rather than the task id, because the
 *  same task can be acted on twice (a failed approve, then a successful one) and
 *  React needs one stable key per line, not per task. */
type LoggedOutcome = { key: number; text: string };

export type TaskListProps = {
  tasks: readonly TaskCardData[];
};

export function TaskList({ tasks }: TaskListProps) {
  const [selected, setSelected] = useState(-1);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [done, setDone] = useState<readonly LoggedOutcome[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  const cards = useRef<Array<HTMLElement | null>>([]);
  const outcomeKey = useRef(0);
  /** Set by `e` when it also had to make the selection. Consumed by the focus
   *  effect, which would otherwise pull focus back onto the card. */
  const pendingEdit = useRef(false);

  /** The live body of a task: the operator's edit if there is one, otherwise
   *  what the server sent. Never `''` by accident — a missing key is "unedited",
   *  and an empty string is a real edit the operator made. */
  const bodyOf = useCallback(
    (task: TaskCardData): string => bodies[task.id] ?? task.body,
    [bodies],
  );

  const move = useCallback(
    (delta: number) => {
      if (tasks.length === 0) return;
      setSelected((current) => {
        if (current < 0) return delta > 0 ? 0 : tasks.length - 1;
        return Math.min(Math.max(current + delta, 0), tasks.length - 1);
      });
    },
    [tasks.length],
  );

  /** `e`, and the click target of the Draft label. */
  const editSelected = useCallback(
    (index: number) => {
      const task = tasks[index];
      if (task === undefined || task.kind !== 'draft_email') return;
      const node = document.getElementById(bodyElementId(task.id));
      if (!(node instanceof HTMLTextAreaElement)) return;
      node.focus();
      // Cursor at the end: the commonest edit is a sentence added to the close,
      // and landing at character zero means every edit starts with a Cmd+End.
      node.setSelectionRange(node.value.length, node.value.length);
    },
    [tasks],
  );

  // Focus follows selection. The bounds check is not paranoia: approving a task
  // removes it from the queue under a live selection, and index 4 of a
  // three-card list would otherwise focus a ref left behind by an unmounted
  // card.
  useEffect(() => {
    if (selected < 0) return;
    if (selected >= tasks.length) {
      setSelected(tasks.length === 0 ? -1 : tasks.length - 1);
      return;
    }
    // `e` from no selection asked for the draft, not the card. Both cannot have
    // focus, and the card would win because this effect runs after the render.
    if (pendingEdit.current) {
      pendingEdit.current = false;
      editSelected(selected);
      return;
    }
    cards.current[selected]?.focus();
  }, [editSelected, selected, tasks.length]);

  const logDone = useCallback((text: string) => {
    outcomeKey.current += 1;
    const key = outcomeKey.current;
    setDone((current) => [{ key, text }, ...current].slice(0, MAX_OUTCOMES));
  }, []);

  /**
   * Run one action against one task.
   *
   * Guarded on `busyId` rather than on a per-card flag: two actions in flight at
   * once means the operator held a key down, and the second would race the first
   * to the same row. One at a time is also what the ninety-second loop actually
   * looks like.
   */
  const run = useCallback(
    (index: number, kind: 'approve' | 'save' | 'skip' | 'reject') => {
      const task = tasks[index];
      if (task === undefined || busyId !== null) return;
      if ((kind === 'approve' || kind === 'save') && task.kind !== 'draft_email') return;
      if (kind === 'approve' && task.guard?.tone === 'block') return;

      const body = bodyOf(task);
      if ((kind === 'approve' || kind === 'save') && body.trim() === '') return;

      setBusyId(task.id);

      startTransition(async () => {
        const result =
          kind === 'approve'
            ? await approveTask(task.id, body)
            : kind === 'save'
              ? await saveDraft(task.id, body)
              : kind === 'skip'
                ? await skipTask(task.id)
                : await rejectTask(task.id);

        setBusyId(null);

        if (result.ok) {
          setErrors((current) => {
            if (current[task.id] === undefined) return current;
            const next = { ...current };
            delete next[task.id];
            return next;
          });
          logDone(`${task.contact?.primary ?? task.title} — ${result.note}`);
        } else {
          setErrors((current) => ({ ...current, [task.id]: result.error }));
        }
      });
    },
    [tasks, busyId, bodyOf, logDone],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey) return;

      const typing = isTypingTarget(event.target);

      // Cmd/Ctrl+Enter approves from inside the draft, which is where the
      // operator is standing after an edit.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        if (selected >= 0) {
          event.preventDefault();
          run(selected, 'approve');
        }
        return;
      }

      // Cmd/Ctrl+S from anywhere, including from inside the draft, which is
      // where the operator is standing when they decide to keep an edit rather
      // than send it. The browser's Save dialog is not wanted here.
      if ((event.key === 's' || event.key === 'S') && (event.metaKey || event.ctrlKey)) {
        if (selected >= 0) {
          event.preventDefault();
          run(selected, 'save');
        }
        return;
      }
      if (event.metaKey || event.ctrlKey) return;

      if (event.key === 'Escape') {
        if (typing) {
          (event.target as HTMLElement).blur();
          cards.current[selected]?.focus();
          return;
        }
        setSelected(-1);
        return;
      }

      if (typing) return;

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          if (event.key === 'ArrowDown' && selected < 0) return;
          event.preventDefault();
          move(1);
          return;

        case 'k':
        case 'ArrowUp':
          if (event.key === 'ArrowUp' && selected < 0) return;
          event.preventDefault();
          move(-1);
          return;

        case 'e':
          event.preventDefault();
          if (selected < 0) {
            // Select the first card and edit it, in one keystroke. The focus
            // effect does the second half — see the header.
            pendingEdit.current = true;
            setSelected(0);
            return;
          }
          editSelected(selected);
          return;

        case 's':
          if (selected < 0) return;
          event.preventDefault();
          run(selected, 'skip');
          return;

        case 'r':
          if (selected < 0) return;
          event.preventDefault();
          run(selected, 'reject');
          return;

        case 'Enter': {
          if (selected < 0) return;
          // A focused button is the browser's to activate. Approving here as
          // well would fire two actions from one keystroke.
          if (event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') return;
          if (event.target instanceof HTMLAnchorElement) return;
          event.preventDefault();
          run(selected, 'approve');
          return;
        }

        default:
          return;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editSelected, move, run, selected]);

  return (
    <div className="flex flex-col gap-3">
      {done.length > 0 ? (
        <ul
          aria-live="polite"
          aria-label="Just handled"
          className="flex flex-col gap-0.5 rounded-md border border-line bg-sunken px-3 py-2"
        >
          {done.map((entry) => (
            <li key={entry.key} className="text-sm text-positive">
              {entry.text}
            </li>
          ))}
        </ul>
      ) : null}

      {tasks.map((task, index) => (
        <TaskCard
          key={task.id}
          data={task}
          selected={index === selected}
          body={bodyOf(task)}
          busy={busyId === task.id}
          outcome={
            errors[task.id] === undefined ? null : { tone: 'error', text: errors[task.id] ?? '' }
          }
          onSelect={() => setSelected(index)}
          onBodyChange={(value) =>
            setBodies((current) => ({ ...current, [task.id]: value }))
          }
          onApprove={() => run(index, 'approve')}
          onSave={() => run(index, 'save')}
          onSkip={() => run(index, 'skip')}
          onReject={() => run(index, 'reject')}
          registerCard={(node) => {
            cards.current[index] = node;
          }}
        />
      ))}

      <p className="flex flex-wrap items-baseline gap-1 px-1 text-2xs text-faint">
        <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>e</Kbd> edit · <Kbd>⌘</Kbd>
        <Kbd>s</Kbd> save the edit · <Kbd>↵</Kbd> approve · <Kbd>⌘</Kbd>
        <Kbd>↵</Kbd> approve from the draft · <Kbd>s</Kbd> skip · <Kbd>r</Kbd> reject ·{' '}
        <Kbd>esc</Kbd> leave the draft
      </p>
    </div>
  );
}
