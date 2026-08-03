'use server';

/**
 * Writing the `settings` and `brain` tables. Every export here is a Server
 * Action.
 *
 * The directive is deliberate and scoped, the same split as
 * ./contact-actions.ts: these three functions are POST endpoints because a form
 * and a toggle have to reach them. The reads live in ./settings.ts without it,
 * so the client bundle does not also publish an action id for "give me the
 * operator's business facts".
 *
 * Rules this module holds to:
 *
 * - **Every export re-checks the operator.** A Server Action can be invoked with
 *   a crafted request without any page ever rendering, so authorisation is
 *   asserted in the function rather than inferred from routing. Anon key, under
 *   RLS.
 * - **Writes return `{ ok }`, they do not throw.** A rejected cost cap is normal
 *   traffic, not an exception. A thrown error in a Server Action reaches the
 *   operator as a generic "an error occurred", which is useless when what
 *   happened is "the send window has no days in it".
 * - **Nothing is logged.** Not a brain value, not a setting, not in an error
 *   path.
 *
 * ## Three keys, three write paths, on purpose
 *
 * `kill_switch` has its own action rather than being a field on the operations
 * form. It is the one control in the app whose whole value is that it works
 * immediately: PLAN §7 has it checked at the top of every cron job and every
 * send, and the reason to reach for it is that something is going wrong right
 * now. A toggle that only takes effect when the rest of a form validates is a
 * toggle that fails at exactly the moment it matters. `parseSettingsForm` reads
 * the flag from a hidden field so its result is a truthful snapshot, and this
 * module never writes it from there.
 *
 * The brain keys are eight independent forms rather than one, because they are
 * eight unrelated pieces of prose and saving `pricing` should not be blocked by
 * something half-typed in `case_studies`.
 *
 * `SettingsActionResult` is declared in ./settings-validation.ts rather than
 * here: a `'use server'` module is meant to export nothing but async functions,
 * and a type export — erased though it is — is not worth testing that rule
 * against.
 */

import { revalidatePath } from 'next/cache';

import type { Json } from '@agency/core';

import { requireOperator } from './supabase/server';
import type { SettingsActionResult, SettingsErrors } from './settings-validation';
import { parseBrainKey, parseBrainValue, parseSettingsForm } from './settings-validation';

const BRAIN_PATH = '/brain';

function fail(errors: SettingsErrors): { ok: false; errors: SettingsErrors } {
  return { ok: false, errors };
}

/**
 * The kill switch (PLAN §7). One click, no form.
 *
 * `revalidatePath('/', 'layout')` as well as `/brain`, because the indicator
 * lives in the nav and the nav lives in the app-group layout — without it the
 * switch would flip on this page while every other screen kept rendering a
 * cached shell that says sending is normal.
 *
 * Turning it on does not stop anything already in flight; it stops the next
 * check. Tasks already `approved` with a `send_after` in the past stay queued
 * and go out when it is turned back off, which is the behaviour the send queue
 * documents (a kill-switch refusal is not terminal — the operator will turn it
 * back on and the queue should still be there).
 */
export async function setKillSwitch(on: boolean): Promise<SettingsActionResult> {
  if (typeof on !== 'boolean') return fail({ kill_switch: 'That is not an on/off value.' });

  const { supabase } = await requireOperator();

  const { error } = await supabase
    .from('settings')
    .upsert({ key: 'kill_switch', value: on, updated_at: new Date().toISOString() }, {
      onConflict: 'key',
    });

  if (error !== null) {
    return fail({ kill_switch: `Could not save the kill switch: ${error.message}` });
  }

  revalidatePath(BRAIN_PATH);
  revalidatePath('/', 'layout');
  return { ok: true };
}

/**
 * `daily_send_cap`, `daily_cost_cap`, `send_window`, `autonomy` — one form, one
 * write.
 *
 * Four rows in a single upsert rather than four round trips. It is not a
 * transaction and does not need to be: each key is independently valid, they are
 * validated together before any of them is written, and PostgREST sends the
 * array as one statement.
 *
 * `kill_switch` is deliberately not in the list. See the module header.
 */
export async function saveOperationalSettings(formData: FormData): Promise<SettingsActionResult> {
  const { supabase } = await requireOperator();

  const parsed = parseSettingsForm(formData);
  if (!parsed.ok) return parsed;

  const now = new Date().toISOString();
  const value = parsed.value;

  const { error } = await supabase.from('settings').upsert(
    [
      { key: 'daily_send_cap', value: value.dailySendCap as Json, updated_at: now },
      { key: 'daily_cost_cap', value: value.dailyCostCap as Json, updated_at: now },
      { key: 'send_window', value: value.sendWindow as unknown as Json, updated_at: now },
      { key: 'autonomy', value: value.autonomy as unknown as Json, updated_at: now },
    ],
    { onConflict: 'key' },
  );

  if (error !== null) return fail({ form: `Could not save the settings: ${error.message}` });

  revalidatePath(BRAIN_PATH);
  return { ok: true };
}

/**
 * One brain key.
 *
 * Plain arguments rather than `FormData`: the editor is a Client Component
 * holding the text in state (controlled, for the reason contact-form.tsx
 * documents — React resets an uncontrolled `<form action>` when the action
 * settles, which on a rejected save would discard everything just typed), and
 * Server Actions take serializable arguments. A `FormData` round trip would buy
 * nothing here.
 *
 * The key is validated against the eight, not trusted: the argument arrives from
 * the browser and a POST can carry anything. An arbitrary key would create a
 * `brain` row that no agent reads and no seeder overwrites.
 *
 * **An empty value is a legitimate save, not a mistake.** It is how the operator
 * says "I have nothing true to state about this", and the drafting agent then
 * stays quiet on that subject instead of inventing a claim to a real customer.
 * Nothing here refuses it, and the page does not nag about it.
 *
 * What this does *not* do is touch `brain/*.md` on disk. That directory is the
 * source of truth for the seeder, and `pnpm seed --commit` overwrites every key
 * from it. The page says so plainly, because an editor that silently loses work
 * on the next seed is a trap.
 */
export async function saveBrainEntry(key: string, value: string): Promise<SettingsActionResult> {
  const parsedKey = parseBrainKey(key);
  if (!parsedKey.ok) return fail({ brain: parsedKey.error });

  const parsedValue = parseBrainValue(value);
  if (!parsedValue.ok) return fail({ brain: parsedValue.error });

  const { supabase } = await requireOperator();

  const { error } = await supabase.from('brain').upsert(
    {
      key: parsedKey.value,
      value: parsedValue.value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' },
  );

  if (error !== null) return fail({ brain: `Could not save: ${error.message}` });

  revalidatePath(BRAIN_PATH);
  return { ok: true };
}
