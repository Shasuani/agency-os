import type { Stage } from '@agency/core';

import { STAGE_LABELS } from '@/lib/contact-vocab';

import { cx } from './button';

/**
 * The seven pipeline stages from `@agency/core` types (SPEC §3):
 * new → contacted → replied → quoted → won | lost | dormant.
 *
 * The treatment encodes the progression rather than assigning seven arbitrary
 * colours, which would turn a dense table into confetti:
 *
 *   nothing has happened yet   hollow, neutral            new
 *   we moved                   filled, neutral            contacted
 *   they moved                 tinted, accent             replied
 *   money on the table         SOLID accent               quoted
 *   terminal, good             SOLID positive             won
 *   terminal, bad              HOLLOW danger              lost
 *   parked                     hollow, dashed, faint      dormant
 *
 * `won` and `lost` differ in fill as well as hue — solid green vs. outlined red
 * — so they are still one glance apart in greyscale or with red/green colour
 * blindness. That is the one distinction in this component that has to survive
 * every viewing condition, because it is the difference between a client and a
 * dead lead.
 */

const STAGE_STYLES: Record<Stage, string> = {
  new: 'border-line text-faint',
  contacted: 'border-transparent bg-sunken text-muted',
  replied: 'border-accent/25 bg-accent-subtle text-accent',
  quoted: 'border-accent bg-accent text-accent-fg',
  won: 'border-positive bg-positive text-positive-fg',
  lost: 'border-danger/55 text-danger',
  dormant: 'border-line-strong border-dashed text-faint',
};

/**
 * The stage vocabulary is NOT defined here.
 *
 * `CONTACT_STAGES`, `STAGE_LABELS` and `STAGE_OPTIONS` live in
 * `lib/contact-vocab.ts`, which is also what the server-side validator mirrors
 * the `contacts_stage_check` constraint through. This file used to keep its own
 * copies of the list and the labels; they happened to agree, and only one of the
 * two carried the `satisfies readonly Stage[]` constraint tying it to the
 * migration — so the next stage added would have made the dropdown and the
 * validator disagree, silently. A badge component renders a stage; it does not
 * get to decide what the stages are.
 */

export type StageBadgeProps = {
  /** `contacts.stage` is nullable in the schema; null renders as "unset". */
  stage: Stage | null;
  size?: 'sm' | 'md';
  className?: string;
};

export function StageBadge({ stage, size = 'sm', className }: StageBadgeProps) {
  const tone = stage === null ? 'border-dashed border-line text-faint' : STAGE_STYLES[stage];

  return (
    <span
      className={cx(
        // Spelled out rather than using the `label-caps` utility so the size
        // step and the tone colour cannot lose a source-order fight with it.
        'inline-flex items-center rounded-sm border font-display font-medium',
        'uppercase tracking-[0.07em] leading-none',
        size === 'sm' ? 'h-4 px-1.5 text-2xs' : 'h-5 px-2 text-xs',
        tone,
        className,
      )}
    >
      {stage === null ? 'unset' : STAGE_LABELS[stage]}
    </span>
  );
}
