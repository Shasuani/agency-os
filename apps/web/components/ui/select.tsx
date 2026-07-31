import type { ReactNode, SelectHTMLAttributes } from 'react';

import { cx } from './button';

/**
 * A native `<select>`, styled.
 *
 * Native on purpose: it is keyboard-operable for free, type-ahead works, it
 * posts inside a `<form>` to a Server Action with no client JS, and the option
 * list follows `color-scheme` (set in globals.css) so it themes itself. A
 * custom listbox would cost all four.
 *
 * Pass `options` for the common case, or `children` for anything grouped.
 */

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  options?: readonly SelectOption[];
  /**
   * An empty-valued first option, and it is **selectable** — picking it back
   * means "unset", which is a legitimate edit for an optional column. Use it
   * only for fields the database allows to be null (`contacts.source`), never
   * as a "choose one" prompt on a required field: nothing here stops the empty
   * value being submitted, and the server would have to reject it.
   */
  placeholder?: string;
  invalid?: boolean;
  children?: ReactNode;
};

export function Select({
  options,
  placeholder,
  invalid = false,
  className,
  children,
  ...props
}: SelectProps) {
  return (
    <span className="relative block">
      <select
        aria-invalid={invalid || undefined}
        className={cx(
          'h-[var(--control-h-md)] w-full appearance-none rounded-md border bg-raised',
          'pr-7 pl-2.5 text-md text-ink transition-colors',
          'disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted',
          invalid ? 'border-danger bg-danger-subtle/40' : 'border-line-strong hover:border-ink/25',
          className,
        )}
        {...props}
      >
        {placeholder !== undefined ? (
          <option value="">{placeholder}</option>
        ) : null}
        {options?.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>

      {/* Chevron. currentColor via text-faint, so it flips with the theme. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="pointer-events-none absolute top-1/2 right-2.5 h-3 w-3 -translate-y-1/2 text-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 4.75 6 7.75 9 4.75" />
      </svg>
    </span>
  );
}
