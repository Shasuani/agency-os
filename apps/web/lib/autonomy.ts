/**
 * The autonomy promotion prompt (SPEC §7, PLAN §7).
 *
 * "After the owner has approved a given task type 20 times without editing, the
 * UI surfaces a prompt offering promotion to level 2. Build the ladder, ship it
 * locked at 1." Both documents say the prompt is built and the promotion is not.
 * This module is the arithmetic behind the prompt; `/brain` renders it, and
 * nothing anywhere raises a level.
 *
 * **A streak, not a total.** "20 times without editing" is read here as twenty
 * consecutive approvals with no edit between them, counted back from the most
 * recent. A running total would count twenty unedited drafts spread across a
 * hundred rewritten ones as evidence of trust, which is the opposite of what it
 * is. An edit resets the count, which is also the honest reading: the operator
 * has just said the machine got it wrong.
 *
 * **`sent`, not `approved`.** The question is whether drafts of this type go out
 * as written. A task the operator approved sixty seconds ago has not been
 * through the send path yet, and one the guardrails refused never will be.
 *
 * **The comparison is `bodyChanged`, imported rather than repeated.** It is the
 * same normalisation the approve action uses to decide whether an edit happened,
 * and step 9 will read the same pairs. Two definitions of "edited" in one
 * codebase means the prompt eventually disagrees with the training data about
 * what the operator did.
 *
 * Pure and dependency-free apart from that import, so the threshold behaviour is
 * testable without a database — which matters, because the one thing this must
 * never do is offer a promotion that has not been earned.
 */

import { bodyChanged } from './task-view';

/** SPEC §7: twenty. */
export const PROMOTION_THRESHOLD = 20;

/**
 * How far back the streak is counted.
 *
 * A ceiling on the read, not on the rule: at the ramped cap of 10–40 sends a day
 * this covers several days, and a streak longer than this is already well past
 * the threshold. It exists so a page render cannot turn into a scan of every
 * message ever sent.
 */
export const PROMOTION_LOOKBACK = 60;

/** One resolved send, as the page reads it. */
export type ApprovalRecord = {
  type: string | null;
  draftBody: string | null;
  finalBody: string | null;
};

/**
 * Consecutive unedited sends per task type, newest first.
 *
 * `rows` must be ordered newest first — the caller's `order('resolved_at',
 * { ascending: false })`. A type's count stops at its first edited row; rows of
 * other types in between do not interrupt it, because the streak is per type.
 *
 * A row with no `type` is ignored rather than bucketed under a placeholder: it
 * cannot be promoted, and inventing a key for it would put a nameless entry in
 * front of the operator.
 */
export function unEditedStreaks(rows: readonly ApprovalRecord[]): Record<string, number> {
  const streaks: Record<string, number> = {};
  const broken = new Set<string>();

  for (const row of rows) {
    const type = typeof row.type === 'string' && row.type !== '' ? row.type : null;
    if (type === null || broken.has(type)) continue;

    // A row the operator never edited has `final_body` copied through byte for
    // byte by `approveTask`. A null `final_body` means the row was written by
    // something other than the approve path, and it is not evidence of anything.
    if (row.finalBody === null || bodyChanged(row.draftBody, row.finalBody)) {
      broken.add(type);
      continue;
    }

    streaks[type] = (streaks[type] ?? 0) + 1;
  }

  return streaks;
}

/** Has this type earned the prompt? */
export function readyForPromotion(streak: number): boolean {
  return streak >= PROMOTION_THRESHOLD;
}
