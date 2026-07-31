import type { ReactNode } from 'react';

import { cx } from './button';

/**
 * A key cap. Keyboard shortcuts are a feature in this app (SPEC §6), so the
 * hints that advertise them have to look like one thing everywhere — this was
 * declared three times, in the table footer, the form footer and the empty
 * state, in two different colours.
 *
 * `text-muted` by default, because a hint is chrome. Pass `tone="ink"` where the
 * shortcut is the instruction rather than a footnote — the empty state tells a
 * first-time operator to press `n`, and that is the sentence's verb.
 */
export function Kbd({
  children,
  tone = 'muted',
  className,
}: {
  children: ReactNode;
  tone?: 'muted' | 'ink';
  className?: string;
}) {
  return (
    <kbd
      className={cx(
        'rounded-xs border border-line bg-sunken px-1 font-mono text-2xs',
        tone === 'ink' ? 'text-ink' : 'text-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
