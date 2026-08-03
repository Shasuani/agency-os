import { cx } from '@/components/ui/button';
import type { InboxChip } from '@/lib/inbox-vocab';

/**
 * The class the inbox agent decided, as one chip.
 *
 * It is built like `<StageBadge>` and for the same reason: the chip is the first
 * thing read on a row, so it has to be legible at 10px in a dense list and it
 * has to survive greyscale. Hue alone would not — `spam` and `not_interested`
 * are both "we did nothing for you" and the operator has to tell them apart at a
 * glance, so they differ in fill and border as well (hollow faint against hollow
 * danger). The colours themselves come from `INBOUND_CLASS_TONE` in
 * lib/inbox-vocab, not from here: a chip renders a class, it does not get to
 * decide what the classes are or what they mean.
 *
 * The utility classes are spelled out rather than composed with `label-caps` so
 * the size step and the tone colour cannot lose a source-order fight with it —
 * the same reason `<StageBadge>` spells them out.
 *
 * No directive: it holds no state and reads nothing, so it renders on the server.
 */
export function ClassChip({ label, tone, title }: InboxChip) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex shrink-0 items-center rounded-sm border font-display font-medium',
        'h-4 px-1.5 text-2xs leading-none tracking-[0.07em] uppercase',
        tone,
      )}
    >
      {label}
    </span>
  );
}
