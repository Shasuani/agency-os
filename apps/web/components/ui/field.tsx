import {
  Children,
  cloneElement,
  isValidElement,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';

import { cx } from './button';

/**
 * Label + hint + error wrapper.
 *
 * Ids are derived from `name` rather than `useId()`. That is deliberate: it is
 * stable across server render and hydration, it means a Server Action can
 * return `{ fieldErrors: { email: '…' } }` and the message lands in the right
 * place with no wiring, and it lets you link to `#f-email` from elsewhere.
 *
 *   <Field name="email" label="Email" hint="Used for follow-ups" error={errors?.email}>
 *     <Input type="email" />
 *   </Field>
 *
 * The single child element is cloned and given `id`, `name`, `aria-describedby`
 * and — if it is one of our components rather than a raw DOM element — the
 * `invalid` prop. Pass `id`/`name` explicitly on the child to override.
 *
 * Error text is not a decoration: when `error` is set the message is announced,
 * so never pass an empty string to mean "no error". Use `undefined`.
 */

export function fieldId(name: string): string {
  return `f-${name}`;
}

export type FieldProps = {
  /** Also becomes the control's `name`, and the root of every id. */
  name: string;
  label: string;
  /** Static help. Always visible; keep it under a line. */
  hint?: string;
  /** Validation message. Presence of this string is what marks the field bad. */
  error?: string;
  required?: boolean;
  /** Right-aligned slot on the label row — a "clear" link, a unit, a count. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function Field({
  name,
  label,
  hint,
  error,
  required = false,
  action,
  className,
  children,
}: FieldProps) {
  const id = fieldId(name);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Error before hint: a screen reader should hear what is wrong first.
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');

  const control = injectFieldProps(children, {
    id,
    name,
    describedBy: describedBy === '' ? undefined : describedBy,
    invalid: error !== undefined,
    required,
  });

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="label-caps text-muted">
          {label}
          {required ? (
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
          ) : null}
        </label>
        {action ? <span className="text-xs text-faint">{action}</span> : null}
      </div>

      {control}

      {error ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A checkbox reads left-to-right, not label-above-control, so it does not go
 * through `Field`. Same id convention, same error slot.
 */
export type CheckboxFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'id' | 'name' | 'className'
> & {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  className?: string;
};

export function CheckboxField({
  name,
  label,
  hint,
  error,
  className,
  ...props
}: CheckboxFieldProps) {
  const id = fieldId(name);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={name}
          type="checkbox"
          aria-describedby={describedBy === '' ? undefined : describedBy}
          aria-invalid={error !== undefined || undefined}
          className="h-3.5 w-3.5 shrink-0 rounded-xs border border-line-strong accent-accent"
          {...props}
        />
        <label htmlFor={id} className="text-base text-ink select-none">
          {label}
        </label>
      </div>
      {error ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="pl-5.5 text-xs text-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

type Injected = {
  id: string;
  name: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
};

/**
 * Clones the one element child and fills in the accessibility wiring. Anything
 * the child already sets wins, so an explicit `id` or `name` is never
 * clobbered. If the children are not a single element (a fragment, a string,
 * two controls side by side) they are returned untouched — set the ids
 * yourself with `fieldId(name)` in that case.
 */
function injectFieldProps(children: ReactNode, injected: Injected): ReactNode {
  const only = Children.toArray(children);
  const first = only[0];
  if (only.length !== 1 || first === undefined || !isValidElement(first)) return children;

  const element = first as ReactElement<Record<string, unknown>>;
  const existing = element.props;

  const next: Record<string, unknown> = {
    id: existing['id'] ?? injected.id,
    name: existing['name'] ?? injected.name,
    'aria-describedby': existing['aria-describedby'] ?? injected.describedBy,
  };

  if (injected.required && existing['required'] === undefined) next['required'] = true;

  if (injected.invalid) {
    next['aria-invalid'] = true;
    // `invalid` is our own prop. Putting it on a raw <input> would render an
    // unknown DOM attribute, so only components get it.
    if (typeof element.type !== 'string') next['invalid'] = true;
  }

  return cloneElement(element, next);
}
