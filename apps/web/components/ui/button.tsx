import type { ButtonHTMLAttributes } from 'react';

/**
 * Class-name joiner. It lives in this file because `button` is the first
 * primitive every screen imports; there is no `lib/` yet and one shared
 * three-line helper beats five private copies.
 *
 *   import { cx } from '@/components/ui/button';
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Chrome in this app is monochrome — see DESIGN.md. `primary` is ink, not the
 * accent colour, because colour is reserved as a data channel. `danger` is the
 * one exception: destructive actions earn a hue.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 rounded-md ' +
  'font-display font-medium whitespace-nowrap transition-colors ' +
  'disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40';

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-[var(--control-h-sm)] px-2.5 text-xs',
  md: 'h-[var(--control-h-md)] px-3.5 text-sm',
};

const VARIANTS: Record<ButtonVariant, string> = {
  // Solid ink. The single highest-commitment action on a screen.
  primary: 'bg-ink text-surface hover:opacity-90 active:opacity-80',
  // The default for almost everything.
  secondary: 'border border-line-strong bg-raised text-ink hover:bg-sunken',
  // Toolbar and row-level actions that must not add weight to a dense table.
  ghost: 'text-muted hover:bg-sunken hover:text-ink',
  // Destructive. Outlined, not filled — it should be reachable, not tempting.
  danger: 'border border-danger/40 bg-transparent text-danger hover:bg-danger-subtle',
};

/**
 * Returns the class string for a button-shaped element. Use it on `<Link>` or
 * anything else that is not a `<button>`, so anchors and buttons stay identical.
 */
export function buttonClass(
  opts: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {},
): string {
  const { variant = 'secondary', size = 'md', className } = opts;
  return cx(BASE, SIZES[size], VARIANTS[variant], className);
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  // `type` defaults to "button": an unlabelled <button> inside a form submits
  // it, which is the wrong default when Server Actions are doing the writing.
  return <button type={type} className={buttonClass({ variant, size, className })} {...props} />;
}
