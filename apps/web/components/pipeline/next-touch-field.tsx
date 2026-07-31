'use client';

import { useState } from 'react';

import { Button, cx } from '@/components/ui/button';
import { fieldId } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  DUE_TEXT_TONE,
  addDays,
  daysBetween,
  formatDayWithWeekday,
  futureLabel,
  toneFor,
  yearOf,
} from '@/lib/day';

/**
 * `contacts.next_touch_at` — a date, four quick-set buttons, and a readout.
 *
 * In step 2 this is the only thing that writes the column, and it is entirely
 * manual: the operator meets someone, decides "chase them in a week", picks a
 * date. The quick-set intervals are the cadence defaults from PLAN.md §4
 * (+3 / +7 / +14 / +30) so the common case is one keystroke away and nobody is
 * counting days on a calendar.
 *
 * The day arithmetic is lib/day.ts — the same module the list and the contact
 * page format their dates with, so "in 5 days" means the same thing on all
 * three screens. It is pure and works on `'YYYY-MM-DD'` strings that have
 * already had their timezone resolved on the server, which is why this component
 * can run in the browser without ever seeing a clock.
 *
 * TODO(step 3, step 5): `next_touch_at` becomes computed. `packages/core/cadence.ts`
 * (step 3) derives the interval from stage / touch_count / source — new leads
 * +3/+7/+14 then dormant, quoted +5/+10/+21, nfc_card +14, won +30, dormant +90
 * — and the follow-up agent (step 5) writes the column after each morning run,
 * pushing the date out with a logged reason when it decides not to write. This
 * field stays afterwards as the manual override; the buttons below should then
 * be re-derived from cadence.ts rather than hardcoded here.
 *
 * Two deliberate omissions:
 *
 * - **No `min` attribute.** A past date is rejected on create by
 *   lib/validation.ts, but an existing contact whose follow-up quietly slipped
 *   into last week must still be saveable when all you came to change was the
 *   stage. `min` would make that row fail native constraint validation and block
 *   the submit entirely, which is exactly the trap lib/contact-actions.ts avoids
 *   by only re-checking the date when the edit is what moved it.
 * - **No time of day.** The stored value is 08:00 in the operator's timezone
 *   (`FOLLOWUP_HOUR` in lib/validation.ts), the hour the morning run happens.
 *   A minute picker would be four extra keystrokes for a number nothing reads.
 */

/** PLAN.md §4 cadence defaults, in days. */
const QUICK_INTERVALS = [3, 7, 14, 30] as const;

export type NextTouchFieldProps = {
  /** Form field name. Matches the column, and the key lib/validation.ts reports
   *  errors under, so `<Field>`-style ids line up without wiring. */
  name?: string;
  /** 'YYYY-MM-DD' as the date reads in the operator's timezone, or null. */
  defaultValue?: string | null;
  /** Today, 'YYYY-MM-DD', computed on the server in the operator's timezone.
   *  Passed in rather than read from the browser clock: a laptop in another
   *  timezone must not silently shift what "+7 days" means. */
  today: string;
  error?: string;
  /** Inert, and does not submit — used when the contact has opted out. */
  disabled?: boolean;
  /** Why it is inert. Shown in place of the readout. */
  disabledNote?: string;
  /**
   * No email address on the form right now.
   *
   * Not an error — a date on a contact with only a phone number still brings
   * them back to the top of /pipeline on the right morning, which is a reminder
   * worth having. But email is the only outbound channel in v1 (SPEC §2), so the
   * agent from step 5 will have nothing to send, and the operator should learn
   * that here rather than from silence three weeks later.
   */
  noEmail?: boolean;
};

export function NextTouchField({
  name = 'next_touch_at',
  defaultValue = null,
  today,
  error,
  disabled = false,
  disabledNote,
  noEmail = false,
}: NextTouchFieldProps) {
  const [value, setValue] = useState<string>(defaultValue ?? '');

  const id = fieldId(name);
  const errorId = `${id}-error`;
  const readoutId = `${id}-readout`;
  const noteId = `${id}-note`;

  const currentYear = yearOf(today);
  const formatted = value === '' ? null : formatDayWithWeekday(value, currentYear);
  const offset = value === '' ? null : daysBetween(today, value);

  const showNoEmail = noEmail && !disabled && value !== '';

  const describedBy = [
    error !== undefined ? errorId : null,
    readoutId,
    showNoEmail ? noteId : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="label-caps text-muted">
          Follow-up date
        </label>
        <span className="text-xs text-faint">Set by hand</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          name={name}
          type="date"
          numeric
          className="w-40"
          value={value}
          disabled={disabled}
          invalid={error !== undefined}
          aria-describedby={describedBy}
          onChange={(event) => setValue(event.currentTarget.value)}
        />

        <div
          role="group"
          aria-label="Quick follow-up intervals"
          className="inline-flex overflow-hidden rounded-md border border-line-strong bg-raised"
        >
          {QUICK_INTERVALS.map((days, index) => {
            const target = addDays(today, days);
            const selected = target !== null && target === value;
            const preview = target === null ? null : formatDayWithWeekday(target, currentYear);

            return (
              <Button
                key={days}
                variant="ghost"
                size="sm"
                disabled={disabled || target === null}
                aria-pressed={selected}
                title={preview ?? undefined}
                className={cx(
                  'rounded-none px-2.5',
                  index > 0 && 'border-l border-line',
                  selected && 'bg-sunken text-ink',
                )}
                onClick={() => {
                  if (target !== null) setValue(target);
                }}
              >
                +{days}d
              </Button>
            );
          })}
        </div>

        {value !== '' && !disabled ? (
          <Button variant="ghost" size="sm" onClick={() => setValue('')}>
            Clear
          </Button>
        ) : null}
      </div>

      <p
        id={readoutId}
        className={cx(
          'numeric text-xs',
          disabled || formatted === null || offset === null
            ? 'text-faint'
            : DUE_TEXT_TONE[toneFor(offset)],
        )}
      >
        {disabled
          ? (disabledNote ?? 'No follow-up can be scheduled.')
          : formatted === null || offset === null
            ? 'No follow-up scheduled — the morning run will pass this contact by.'
            : `${formatted} · ${futureLabel(offset)}`}
      </p>

      {showNoEmail ? (
        <p id={noteId} className="text-xs text-warning">
          No email address yet — this date is a reminder for you. Email is the only outbound
          channel, so the follow-up agent will have nothing to send until one is filled in.
        </p>
      ) : null}

      {error !== undefined ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
