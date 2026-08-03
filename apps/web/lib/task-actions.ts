'use server';

/**
 * The four things the operator can do to a task. Every export here is a Server
 * Action.
 *
 * The directive is deliberate and scoped, exactly as in ./contact-actions.ts:
 * these four are POST endpoints because a keystroke has to be able to reach
 * them. The reads live in ./tasks.ts without it, so the client bundle does not
 * also publish an action id for "hand me the whole queue".
 *
 * Seven decisions worth knowing before editing this file.
 *
 * **Plain arguments, not `FormData`.** Approval is a keystroke, not a form
 * submit. The card is a Client Component holding the edited body in state
 * (controlled, for the reason contact-form.tsx documents: React resets an
 * uncontrolled `<form action>` once the action settles, which would discard an
 * edit on a failed save). Server Actions take serializable arguments, so
 * `FormData` would buy nothing and would force a `useActionState` shape on a
 * component that does not want one.
 *
 * **Approve and approve-with-edit are one action, and the server decides which
 * happened.** `bodyChanged` normalises line endings and trailing whitespace,
 * then compares. A client that decides for itself whether an edit occurred is a
 * client whose opinion can be wrong, and step 9 reads exactly that comparison as
 * "the owner rewrote this draft" — a training signal that fires on every
 * approval is worse than none.
 *
 * **`final_body` is always written**, not only when the operator edited. SPEC §3
 * calls that column "what the owner actually sent", so writing it always means
 * the send queue has exactly one field to read and cannot possibly send text the
 * operator never saw. When nothing changed, `draft_body` is copied through
 * **byte for byte** rather than the normalised string, so step 9's plain
 * `final_body !== draft_body` stays exactly true and exactly false.
 *
 * **The kill switch blocks approval, not just sending.** The guardrails re-check
 * it immediately before the Gmail call regardless; this is the early, honest
 * half. Approving eight things that then silently never leave is worse than a
 * refusal you can read.
 *
 * **Writes return `{ ok }`, they do not throw.** A refusal is normal traffic. A
 * thrown error in a Server Action reaches the operator as a generic "an error
 * occurred", which is useless when what happened is "the send window in /brain
 * has no days in it".
 *
 * **Every write asks the database what it changed.** `.eq('status', 'pending')`
 * on the update is the lock the read above it is not, but supabase-js reports
 * `{ error: null }` whether that filter matched one row or none — so a second
 * tab that approved the same card a moment earlier produced a cheerful "Sends in
 * about 7 minutes" for a write that did nothing, with a `send_after` on screen
 * that no row anywhere holds. `.select('id')` makes the result observable and
 * the actions report the truth: somebody else already handled it.
 *
 * **`saveDraft` writes `final_body` and leaves the task pending.** SPEC §6 lists
 * "save edit" as one of the card's buttons and it is the only one that was
 * missing: without it, an edit lived in React state and was gone on a reload or
 * a navigation, silently, after the operator had rewritten a paragraph. It has
 * one consequence worth stating, because step 9 reads `final_body !==
 * draft_body` as "the owner rewrote this": a saved draft that is later rejected
 * now carries an edit. That is the honest record — they did rewrite it and then
 * decide against sending it — and losing the edit to protect a signal that step
 * 9 has not been built yet would be the wrong trade.
 *
 * Nothing about a contact or a draft is ever logged here. Not a name, not an
 * address, not a subject, not in an error path.
 */

import { revalidatePath } from 'next/cache';

import { appTimezone } from '@agency/core';
import type { TaskStatus } from '@agency/core';
import { SendWindowError, nextSendSlot, windowForAgent } from '@agency/core/send-window';

import { readSettingsWith } from './settings';
import { requireOperator } from './supabase/server';
import { bodyChanged, validateBody } from './task-view';
import { isUuid } from './validation';

/** The Today page. The only path any of these three actions touches. */
const TODAY_PATH = '/';

export type TaskActionResult =
  | {
      ok: true;
      id: string;
      status: TaskStatus;
      /** `tasks.send_after` as written, or null for reject and skip. */
      sendAfter: string | null;
      /** One sentence for the card: "Sends in about 7 minutes." */
      note: string;
    }
  | { ok: false; error: string };

function fail(error: string): TaskActionResult {
  return { ok: false, error };
}

/**
 * Approve a draft, edited or not, and schedule it.
 *
 * Approving does not send. It sets `status = 'approved'` and `send_after`, and
 * the worker's 60-second poller does the rest (PLAN §7.1). `send_after` is an
 * absolute instant and is never re-evaluated: a second business-hours check at
 * send time, with its own jitter, would reject tasks sitting at the window
 * boundary and they would never leave at all.
 *
 * `resolved_at` stays null. It is stamped when the message actually leaves,
 * which is what makes "done today" mean what it says.
 */
export async function approveTask(taskId: string, body: string): Promise<TaskActionResult> {
  if (!isUuid(taskId)) return fail('That task id is not valid.');

  const { supabase } = await requireOperator();

  const settings = await readSettingsWith(supabase);
  if (settings.killSwitch) {
    return fail(
      'The kill switch is on. Nothing can be scheduled to send until you turn it off in /brain.',
    );
  }

  const { data: task, error: readError } = await supabase
    .from('tasks')
    .select('id, agent, type, status, draft_body, contact_id, contacts(id, timezone)')
    .eq('id', taskId)
    .maybeSingle();

  if (readError !== null) return fail(`Could not load that task: ${readError.message}`);
  if (task === null) return fail('That task no longer exists.');
  if (task.status !== 'pending') return fail('That task has already been handled.');
  if (task.type !== 'draft_email') return fail('Only a drafted email can be approved.');

  const parsed = validateBody(body);
  if (!parsed.ok) return fail(parsed.error);

  // Unedited approvals copy the stored draft through unchanged. See the header:
  // step 9 reads `final_body !== draft_body`, and it has to be a byte
  // comparison, not an approximate one.
  const edited = bodyChanged(task.draft_body, parsed.value);
  const finalBody = edited ? parsed.value : (task.draft_body ?? parsed.value);

  // A contact embedded through a foreign key comes back as one object, but the
  // generated relationship types are not always narrow enough to say so.
  const contact = (Array.isArray(task.contacts) ? task.contacts[0] : task.contacts) ?? null;

  let slot;
  try {
    slot = nextSendSlot({
      from: new Date(),
      // Free text in the database. `nextSendSlot` falls back to the operator's
      // zone when Intl rejects it rather than refusing the send: a bad value
      // means a botched import, not a contact who deserves to be forgotten.
      timeZone: contact?.timezone ?? null,
      fallbackTimeZone: appTimezone(),
      // Per agent, not one window for everything. The seeded Tue–Thu window is
      // an outreach rhythm; applying it to an answer means a customer who asks a
      // question on Thursday evening is answered the following Tuesday. See
      // `windowForAgent`.
      window: windowForAgent(task.agent, settings.sendWindow),
    });
  } catch (error) {
    if (error instanceof SendWindowError) {
      return fail(
        'The send window in /brain has no days selected, so nothing can be scheduled.',
      );
    }
    throw error;
  }

  const { data: updated, error: writeError } = await supabase
    .from('tasks')
    .update({
      status: 'approved',
      final_body: finalBody,
      send_after: slot.sendAfter.toISOString(),
    })
    .eq('id', taskId)
    // Re-assert the status in the write itself. Two tabs open on the same
    // morning is not a hypothetical, and the read above is not a lock.
    .eq('status', 'pending')
    // And read back what the filter matched. Without this the action cannot
    // tell "approved" from "somebody else approved it three seconds ago", and
    // reports the second as the first.
    .select('id');

  if (writeError !== null) return fail(`Could not approve that task: ${writeError.message}`);
  if ((updated ?? []).length === 0) {
    return fail('That task was handled somewhere else a moment ago. Reload the page.');
  }

  revalidatePath(TODAY_PATH);

  return {
    ok: true,
    id: taskId,
    status: 'approved',
    sendAfter: slot.sendAfter.toISOString(),
    note: slot.reason,
  };
}

/**
 * Keep an edit without sending it — SPEC §6's "save edit".
 *
 * Writes `final_body` and nothing else: the task stays `pending`, no
 * `send_after` is computed, and the card stays in the queue. It is for the
 * morning where the operator rewrites two paragraphs, decides they want to
 * check a price before it goes, and closes the laptop. Before this existed that
 * rewrite lived in React state and a reload discarded it without a word.
 *
 * `draft_body` is never touched. It is the record of what the agent actually
 * wrote, step 9 reads the pair, and an edit that overwrote the original would
 * destroy the only copy of the thing being learned from.
 *
 * The kill switch is deliberately *not* checked here. Saving text sends nothing,
 * and refusing to let the operator keep their own writing because sending is
 * paused would be the app being obstructive for the sake of consistency.
 */
export async function saveDraft(taskId: string, body: string): Promise<TaskActionResult> {
  if (!isUuid(taskId)) return fail('That task id is not valid.');

  const { supabase } = await requireOperator();

  const parsed = validateBody(body);
  if (!parsed.ok) return fail(parsed.error);

  const { data: updated, error: writeError } = await supabase
    .from('tasks')
    .update({ final_body: parsed.value })
    .eq('id', taskId)
    // Only a task still waiting on the operator. A saved edit on an approved
    // task would change the text the send queue is about to read, minutes after
    // the approval that was supposed to fix it.
    .eq('status', 'pending')
    .select('id');

  if (writeError !== null) return fail(`Could not save that edit: ${writeError.message}`);
  if ((updated ?? []).length === 0) {
    return fail('That task is no longer waiting for you, so the edit was not saved.');
  }

  revalidatePath(TODAY_PATH);

  return { ok: true, id: taskId, status: 'pending', sendAfter: null, note: 'Edit saved.' };
}

/**
 * "This draft is wrong."
 *
 * Leaves the contact alone. `followup.ts` already moved `next_touch_at` when it
 * drafted, and a rejected draft deliberately does not consume a cadence step —
 * no `interactions` row is written, so the derived per-stage touch count is
 * unchanged and the contact comes back around on schedule.
 *
 * `final_body` is not touched: the draft as the agent wrote it is the record of
 * what was rejected, and step 9 needs it intact.
 */
export async function rejectTask(taskId: string): Promise<TaskActionResult> {
  return resolveTask(taskId, 'rejected', 'Rejected.');
}

/**
 * "Not now." Also how an `alert` or `reminder` task is dismissed.
 *
 * The only difference from reject is intent, and the difference matters to step
 * 9: `rejected` means the draft was wrong and is training signal, `skipped`
 * means not today and is not. Both leave the contact alone.
 */
export async function skipTask(taskId: string): Promise<TaskActionResult> {
  return resolveTask(taskId, 'skipped', 'Skipped.');
}

/**
 * Reject and skip differ by one word, so they share the write.
 *
 * Both accept any task type — an `alert` has no draft and no recipient, and
 * dismissing it is the only thing that can be done to it.
 */
async function resolveTask(
  taskId: string,
  status: Extract<TaskStatus, 'rejected' | 'skipped'>,
  note: string,
): Promise<TaskActionResult> {
  if (!isUuid(taskId)) return fail('That task id is not valid.');

  const { supabase } = await requireOperator();

  const { data: task, error: readError } = await supabase
    .from('tasks')
    .select('id, status')
    .eq('id', taskId)
    .maybeSingle();

  if (readError !== null) return fail(`Could not load that task: ${readError.message}`);
  if (task === null) return fail('That task no longer exists.');
  if (task.status !== 'pending') return fail('That task has already been handled.');

  const { data: updated, error: writeError } = await supabase
    .from('tasks')
    .update({ status, resolved_at: new Date().toISOString() })
    .eq('id', taskId)
    .eq('status', 'pending')
    .select('id');

  if (writeError !== null) return fail(`Could not update that task: ${writeError.message}`);
  if ((updated ?? []).length === 0) {
    return fail('That task was handled somewhere else a moment ago. Reload the page.');
  }

  revalidatePath(TODAY_PATH);

  return { ok: true, id: taskId, status, sendAfter: null, note };
}
