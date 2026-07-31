import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

import { cx } from './button';

/**
 * Text inputs and textareas.
 *
 * `invalid` is the only state prop: it paints the border and sets
 * `aria-invalid`. Wrap these in `<Field>` (./field) rather than hand-rolling a
 * label — Field wires the id, the hint and the error message for you.
 *
 * `numeric` switches the control to the display face with tabular figures. Use
 * it for anything the operator reads as a number: dates, currency, counts.
 */

const CONTROL_BASE =
  'w-full rounded-md border bg-raised text-ink transition-colors ' +
  'placeholder:text-faint ' +
  'disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted ' +
  'read-only:bg-sunken';

function controlTone(invalid: boolean): string {
  return invalid
    ? 'border-danger bg-danger-subtle/40 hover:border-danger'
    : 'border-line-strong hover:border-ink/25';
}

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  invalid?: boolean;
  /** Display face + tabular figures. For dates, money, counts. */
  numeric?: boolean;
};

export function Input({ invalid = false, numeric = false, className, ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cx(
        CONTROL_BASE,
        controlTone(invalid),
        'h-[var(--control-h-md)] px-2.5 text-md',
        numeric && 'numeric',
        className,
      )}
      {...props}
    />
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export function Textarea({ invalid = false, className, rows = 4, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cx(
        CONTROL_BASE,
        controlTone(invalid),
        'resize-y px-2.5 py-2 text-md leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}
