/**
 * Everything the Today screen decides that does not need a database, a clock or
 * a timezone.
 *
 * The rule this module exists to enforce is the one lib/day.ts already states
 * for /pipeline: **every string the operator reads is produced on the server and
 * reaches the Client Component finished.** The task card never formats a date,
 * never asks what time it is, and never re-derives whether a send is allowed. So
 * there is nothing for server and client to disagree about, no hydration
 * mismatch is possible, and a laptop in another timezone cannot change what
 * "filed at 08:02" means.
 *
 * It is also where the logic that would otherwise be buried inside a Server
 * Action goes, so it can be tested: the body comparison that step 9 depends on,
 * the body validation the approve path applies, and the copy that tells the
 * operator why a card cannot be approved.
 *
 * **Pure, dependency-free, and safe in a client bundle.** Every import here is
 * `import type`, which TypeScript erases — that matters, because components/today
 * imports this module and `@agency/core`'s barrel value-imports the Supabase
 * service-role client factory. Do not add a value import from `@agency/core` to
 * this file; take the constant as an argument instead. Note that
 * `SendRefusalReason` comes from `@agency/core/guardrails`, which is the send
 * path: a type from it is free, and a value from it would put the module that
 * decides whether a stranger gets an email into the browser bundle.
 *
 * Two things this module deliberately does **not** own:
 *
 * - **Naming a contact.** `contactLine` and `blankToNull` live in
 *   ./contact-vocab, which is where the rest of "what the operator reads when
 *   the data does not say" lives, and which /pipeline and the contact page both
 *   already import. The rule had been written out three times; it is written
 *   once now.
 * - **Reading `settings`.** The shape checks and the `OperationalSettings` type
 *   live in ./settings-validation, next to the write-path validation for the
 *   same four keys, and the one read is in ./settings. This screen and /brain
 *   had grown a reader each, parsing the same rows to slightly different
 *   standards; the send window that the Today card promises and the send window
 *   the /brain form saves have to be the same value or one of the two screens is
 *   lying.
 */

import type { Stage, TaskStatus } from '@agency/core';
import type { SendRefusalReason } from '@agency/core/guardrails';

// ---------------------------------------------------------------------------
// The draft body
// ---------------------------------------------------------------------------

/** A follow-up is under 120 words (PLAN §6 step 5). Anything near this ceiling
 *  is a paste accident or something broken upstream, not an email. */
export const MAX_BODY_CHARS = 20_000;

/**
 * The form a body is compared and stored in.
 *
 * CRLF to LF, and trailing whitespace at the end of the message removed. A
 * textarea returns `\r\n` on Windows and browsers differ about whether a
 * trailing newline survives a round trip, so without this the operator changing
 * nothing at all still produces `final_body !== draft_body` — and step 9 reads
 * exactly that comparison as "the owner edited this draft". A style-training
 * signal that fires on every approval is worse than none.
 *
 * Interior whitespace is untouched. Paragraph breaks are the operator's.
 */
export function normalizeBody(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

/** Did the operator actually change the draft? The one definition of "edited",
 *  used by the approve path so the client never gets to have an opinion on it. */
export function bodyChanged(draft: string | null, submitted: string): boolean {
  return normalizeBody(draft ?? '') !== normalizeBody(submitted);
}

export type BodyResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Validate a body on its way to `tasks.final_body`.
 *
 * An empty message is refused here rather than at send time on purpose: the
 * guardrails would refuse it too (`empty_body`), but they would do it sixty
 * seconds later, silently, from a worker the operator is not looking at. A
 * blank email is the single most embarrassing thing this system could send, and
 * the cheapest place to stop it is the keystroke that approves it.
 */
export function validateBody(raw: unknown): BodyResult {
  if (typeof raw !== 'string') return { ok: false, error: 'The message is missing.' };

  const value = normalizeBody(raw);
  if (value.trim() === '') {
    return { ok: false, error: 'An empty message cannot be sent. Write something, or reject it.' };
  }
  if (value.length > MAX_BODY_CHARS) {
    return {
      ok: false,
      error: `That message is over ${MAX_BODY_CHARS.toLocaleString('en-GB')} characters. Something upstream is wrong.`,
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Guardrail notices
// ---------------------------------------------------------------------------

/**
 * `block` — approving would achieve nothing, so the button is disabled.
 * `wait`  — the task is fine and the world is not. Approving is correct; the
 *           queue holds it and sends it when the window opens.
 */
export type GuardTone = 'block' | 'wait';

export type GuardNotice = {
  tone: GuardTone;
  /** Three or four words, shown in the strip's own weight. */
  label: string;
  /** One sentence. Never contains an email address — this is on screen, but the
   *  same sentence ends up on an alert task, and PLAN §7 keeps addresses out. */
  detail: string;
};

/**
 * Refusal reason to card copy.
 *
 * `evaluateSend` already returns a `detail` written for the operator, and this
 * table deliberately does not use it. That sentence is written for an alert task
 * filed *after* a send was refused ("This contact has opted out."); the card is
 * read *before* an approval and has to say what the button will and will not do.
 * The two audiences want different tenses.
 *
 * `kill_switch` is `wait` in `SendDecision` — the queue keeps the task and sends
 * it once the switch goes back off — but it is `block` here, because
 * `approveTask` refuses while the switch is on. Approving eight things that
 * silently never leave is worse than a refusal.
 */
export const SEND_BLOCK_COPY: Record<SendRefusalReason, GuardNotice> = {
  kill_switch: {
    tone: 'block',
    label: 'Kill switch on',
    detail: 'Nothing can be scheduled to send until you turn it off in /brain.',
  },
  task_not_found: {
    tone: 'block',
    label: 'Task missing',
    detail: 'This task no longer exists. Reload the page.',
  },
  task_wrong_type: {
    tone: 'block',
    label: 'Not an email',
    detail: 'This task has no recipient and no draft, so there is nothing to send.',
  },
  task_not_approved: {
    tone: 'block',
    label: 'Already handled',
    detail: 'This task has already been resolved. Reload the page.',
  },
  already_sent: {
    // Not reachable from a pending card — the preview passes `alreadySent:
    // false`, and a task with an outbound record behind it is not pending. It is
    // written anyway because the reason exists and the table has to be total,
    // and because a card that ever did show this must not show a blank strip.
    tone: 'block',
    label: 'Already sent',
    detail: 'This message has already gone out. Nothing further will be sent for it.',
  },
  no_contact: {
    tone: 'block',
    label: 'No contact',
    detail: 'This task is not attached to a contact, so there is nowhere to send it.',
  },
  contact_missing: {
    tone: 'block',
    label: 'Contact deleted',
    detail: 'The contact this draft was written for no longer exists.',
  },
  do_not_contact: {
    tone: 'block',
    label: 'Opted out',
    detail: 'This contact has asked not to be contacted. Reject the draft.',
  },
  suppression_tag: {
    tone: 'block',
    label: 'Tagged opted out',
    detail: 'A tag on this contact records an opt-out. Reject the draft.',
  },
  no_email_address: {
    tone: 'block',
    label: 'No email address',
    detail: 'Add an address on the contact, or reject this and follow up another way.',
  },
  empty_body: {
    tone: 'block',
    label: 'Empty draft',
    detail: 'There is nothing to send. Write the message, or reject it.',
  },
  autonomy_off: {
    tone: 'block',
    label: 'Autonomy off',
    detail: 'Drafted email is set to level 0 in /brain, so nothing of this type may be sent.',
  },
  daily_cap: {
    tone: 'wait',
    label: 'Daily cap reached',
    detail: "Today's send cap is used up. Approving still works — this waits in the queue.",
  },
  contact_cooldown: {
    tone: 'wait',
    label: 'Contacted recently',
    detail: 'This contact was emailed in the last 48 hours. Approving holds it until then.',
  },
};

/** Reasons that leave the approve button usable. */
export function blocksApproval(reason: SendRefusalReason): boolean {
  return SEND_BLOCK_COPY[reason].tone === 'block';
}

/**
 * The strip for one refusal, with the one reason whose copy depends on a number.
 *
 * `daily_cap` covers two different situations that `guardrails.ts` cannot tell
 * apart at the refusal site and this page can. A cap of 10 with 10 sent today is
 * temporary: the rolling window drains and the message goes. A cap of **0** is
 * `settings-validation.ts`'s documented soft pause — deliberate, indefinite, and
 * not something waiting will fix. Telling the operator "this waits in the queue"
 * for a state they set on purpose and can only leave by editing a setting is the
 * card lying to them about their own configuration.
 *
 * The tone stays `wait` in both cases: approving still works and the draft is
 * still queued, which is what the tone controls.
 */
export function sendBlockNotice(reason: SendRefusalReason, dailySendCap: number): GuardNotice {
  const base = SEND_BLOCK_COPY[reason];
  if (reason !== 'daily_cap' || dailySendCap > 0) return base;
  return {
    tone: base.tone,
    label: 'Sending paused',
    detail: 'The daily send cap is 0, so nothing leaves. Raise it in /brain to start sending.',
  };
}

// ---------------------------------------------------------------------------
// Card text
// ---------------------------------------------------------------------------

/** Which agent filed this. `tasks.agent` is free text, so unknown values are
 *  shown rather than swallowed — a badge reading `inbox` is more use than one
 *  reading `Agent`. */
export function agentLabel(agent: string | null): string {
  const value = (agent ?? '').trim();
  if (value === '') return 'System';
  if (value === 'followup') return 'Follow-up';
  if (value === 'inbox') return 'Inbox';
  return value;
}

/**
 * `'08:02'` from the hour and minute a zone-aware caller already resolved.
 *
 * Takes numbers, not a Date, so this module keeps its promise of never touching
 * a clock: the page reads the parts through `partsInZone` from
 * `@agency/core/zone` and passes them in.
 */
export function clock(hour: number, minute: number): string {
  const pad = (n: number): string => String(Math.trunc(n)).padStart(2, '0');
  return `${pad(hour)}:${pad(minute)}`;
}

/**
 * What happened to a task, by status alone.
 *
 * **Read these through `sendOutcome` below, not directly.** `sent` is not the
 * whole story — under `DRY_RUN` a task is marked `sent` for a message that
 * never left — and a screen that indexes this table itself is a screen that
 * says "Sent" about an email nobody received. The tables stay exported because
 * they are the vocabulary and the tests assert against them; the decision is
 * one function.
 */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Waiting',
  approved: 'Queued',
  sent: 'Sent',
  rejected: 'Rejected',
  skipped: 'Skipped',
};

/**
 * Tone for a resolved status. `sent` is the only one that earns a hue, and it is
 * `positive` because it is the outcome the morning exists to produce. `rejected`
 * and `skipped` are not failures and are not painted as such — they are the
 * operator exercising judgement, which is the whole point of level 1.
 */
export const TASK_STATUS_TONE: Record<TaskStatus, string> = {
  pending: 'text-muted',
  approved: 'text-muted',
  sent: 'text-positive',
  rejected: 'text-faint',
  skipped: 'text-faint',
};

/**
 * What actually happened to a resolved task, dry run included.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 * ---------------------------------------------------------------------------
 *
 * `DRY_RUN` defaults to true (PLAN §7) and the whole of steps 5 through 9 was
 * built with it on. Under it the send path does everything except the last
 * step: it takes the permit, checks the daily cap and the 48-hour cooldown,
 * builds the MIME message, appends the compliance footer, writes the
 * `interactions` row and marks the task `sent` — and never opens a socket. So
 * `tasks.status = 'sent'` is true of a message that left and equally true of a
 * message that did not, and until now every screen in this app said the same
 * word for both.
 *
 * That is the failure this function exists to end. An operator reading
 * "Sent · Μαρία · Follow-up" has no way to know whether Μαρία has the email,
 * and the first time they find out is when they mention it on the phone. The
 * row that knows is `interactions.meta.dry_run`, written by `send-queue.ts` on
 * every send in either mode; nothing rendered it.
 *
 * ---------------------------------------------------------------------------
 * The two judgement calls
 * ---------------------------------------------------------------------------
 *
 * 1. **The word changes, rather than a badge being added.** "Sent (dry run)"
 *    still leads with "Sent", and a list is read by its first column. `Dry run`
 *    is what happened; the row's title still says what the task was.
 *
 * 2. **It is `text-muted`, not `text-warning`.** The tempting choice is a
 *    warning hue, and it is wrong for a specific reason: with `DRY_RUN=true` as
 *    the default, *every* row on a development machine would be yellow, and a
 *    colour that is always on is a colour the eye stops seeing — the same
 *    argument `CONFIDENCE_TONE` makes for only tinting `low`. What is doing the
 *    work here is the *withholding* of `text-positive`. Green is reserved for
 *    the outcome the morning exists to produce, and a dry run is not it.
 *
 * A dry run is only ever recorded for a send, so `rejected` and `skipped` pass
 * straight through — the flag has no meaning on them and the caller is not
 * asked to know that.
 */
export const DRY_RUN_LABEL = 'Dry run';

export function sendOutcome(
  status: TaskStatus,
  dryRun: boolean,
): { label: string; tone: string } {
  if (status === 'sent' && dryRun) {
    return { label: DRY_RUN_LABEL, tone: 'text-muted' };
  }
  return { label: TASK_STATUS_LABELS[status], tone: TASK_STATUS_TONE[status] };
}

/**
 * The line under "Handled today" when some of it did not leave the machine.
 *
 * Empty string when nothing was a dry run, so the ordinary case reads exactly
 * as it did before and the sentence only appears when it has something to say.
 */
export function dryRunNote(dryRuns: number): string {
  if (dryRuns <= 0) return '';
  return dryRuns === 1
    ? '1 was a dry run — nothing left the machine'
    : `${dryRuns} were dry runs — nothing left the machine`;
}

/** `'9 things'`, `'1 thing'`. The empty state's sentence is built from this. */
export function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// The card, as the client receives it
// ---------------------------------------------------------------------------

/**
 * `draft_email` is the only task type with a recipient and a body. `alert` and
 * `reminder` tasks are notes: they are read and dismissed, and rendering an
 * approve button on one would offer to send a message that does not exist.
 */
export type TaskCardKind = 'draft_email' | 'note';

export type TaskCardData = {
  id: string;
  kind: TaskCardKind;
  agent: string;
  title: string;
  /** `'08:02'` in the operator's timezone, resolved on the server. */
  filedAt: string;
  contact: {
    id: string;
    primary: string;
    secondary: string | null;
    /** Passed through for `<StageBadge>`. A union of string literals, which
     *  TypeScript erases — no value from @agency/core reaches the browser. */
    stage: Stage | null;
  } | null;
  /** Pre-formatted fragments joined with a middot on the card. */
  context: readonly string[];
  reasoning: string | null;
  /** `draft_subject`, trimmed. null means the draft has no subject line. */
  subject: string | null;
  /** `final_body ?? draft_body ?? ''`. What the operator sees and edits. */
  body: string;
  /** Why this cannot (or should not yet) be sent. null when it is clear. */
  guard: GuardNotice | null;
};

