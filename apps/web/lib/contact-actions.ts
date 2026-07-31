'use server';

/**
 * Writing the `contacts` table. Every export here is a Server Action.
 *
 * The directive is deliberate and scoped: these two functions are POST endpoints
 * because a form has to be able to reach them. The reads live in ./contacts.ts
 * without it, so the client bundle does not also publish an action id for
 * "give me every contact".
 *
 * Rules this module holds to:
 *
 * - **Every export re-checks the operator.** A Server Action can be invoked with
 *   a crafted request without any page ever rendering, so authorisation is
 *   asserted in the function rather than inferred from routing. Anon key only,
 *   under RLS.
 * - **Writes return `{ ok }`, they do not throw.** Validation failures are
 *   normal traffic, not exceptions — a thrown error in a Server Action reaches
 *   the operator as a generic "an error occurred", which is useless when what
 *   happened is "that date is in the past".
 * - **Nothing about a contact is ever logged.** Not a name, not an address, not
 *   in an error path.
 */

import { revalidatePath } from 'next/cache';

import { requireOperator } from './supabase/server';
import { fail, isPastDay, isUuid, parseContactForm, type ActionResult } from './validation';

const PIPELINE_PATH = '/pipeline';

/**
 * Create a contact.
 *
 * `touch_count` and `last_touch_at` are left to the database: they are the
 * agents' bookkeeping, not the operator's. `timezone` is derived from `country`
 * in validation (PLAN.md §7.1).
 */
export async function createContact(formData: FormData): Promise<ActionResult> {
  const { supabase } = await requireOperator();

  const parsed = parseContactForm(formData, 'create');
  if (!parsed.ok) return parsed;

  const { data, error } = await supabase
    .from('contacts')
    .insert(parsed.value)
    .select('id')
    .single();

  if (error !== null || data === null) {
    return fail({ form: `Could not save the contact: ${error?.message ?? 'unknown error'}` });
  }

  revalidatePath(PIPELINE_PATH);
  return { ok: true, id: data.id };
}

/**
 * Edit a contact. Whole-form write, not a patch.
 *
 * Two rules need the stored row, so it is read first:
 *
 * 1. `do_not_contact` is permanent (PLAN.md §7). Once set it cannot be cleared
 *    from this form — an opt-out that a stray checkbox can undo is not an
 *    opt-out, and re-contacting someone who asked you not to is the one mistake
 *    here with a legal edge to it.
 * 2. A `next_touch_at` already in the past is only rejected if this edit is
 *    what moved it there. Otherwise every stale contact would become
 *    unsaveable, including when all you wanted to change was the stage.
 */
export async function updateContact(id: string, formData: FormData): Promise<ActionResult> {
  if (!isUuid(id)) return fail({ form: 'That contact id is not valid.' });

  const { supabase } = await requireOperator();

  const { data: existing, error: readError } = await supabase
    .from('contacts')
    .select('id, next_touch_at, do_not_contact')
    .eq('id', id)
    .maybeSingle();

  if (readError !== null) {
    return fail({ form: `Could not load the contact: ${readError.message}` });
  }
  if (existing === null) return fail({ form: 'That contact no longer exists.' });

  const parsed = parseContactForm(formData, 'update');
  if (!parsed.ok) return parsed;

  const value = parsed.value;

  if (existing.do_not_contact === true && value.do_not_contact === false) {
    return fail({
      do_not_contact:
        'Do-not-contact is permanent. It cannot be cleared from here once the contact has opted out.',
    });
  }

  // Compare **instants**, not strings. `parseDateInput` produces
  // '2026-08-14T05:00:00.000Z'; PostgREST renders the same instant as
  // '2026-08-14T05:00:00+00:00'. A `!==` on those is always true, which made
  // `dateChanged` always true, which made every overdue contact unsaveable —
  // exactly the trap rule 2 above exists to avoid.
  const toMs = (iso: string | null): number | null => {
    if (iso === null) return null;
    const ms = new Date(iso).getTime();
    return Number.isNaN(ms) ? null : ms;
  };

  const dateChanged = toMs(value.next_touch_at) !== toMs(existing.next_touch_at ?? null);
  if (dateChanged && value.next_touch_at !== null && isPastDay(value.next_touch_at)) {
    return fail({ next_touch_at: 'That date has already passed. Pick today or later.' });
  }

  const { error } = await supabase.from('contacts').update(value).eq('id', id);

  if (error !== null) return fail({ form: `Could not save the contact: ${error.message}` });

  revalidatePath(PIPELINE_PATH);
  return { ok: true, id };
}
