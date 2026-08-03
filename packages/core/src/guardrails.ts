/**
 * Guardrails — the last thing that runs before a message leaves the building.
 *
 * PLAN §7 lists eight guardrails. Five of them belong to the send path and are
 * implemented here: no send without an approved task, the daily volume cap, the
 * one-per-contact-per-48h rule, `do_not_contact`, and the kill switch. The other
 * three live where they can actually be enforced — the compliance footer is
 * appended inside `gmail.ts` (a check here could be forgotten by whoever writes
 * the next caller), the daily cost ceiling is in the LLM wrapper, and retry-then-
 * alert is the job runner's.
 *
 * The module is split in half on purpose:
 *
 *   evaluateSend(facts)          pure. No clock, no database, no I/O.
 *   collectSendFacts(db, opts)   the queries, and nothing else.
 *   assertSendAllowed(db, opts)  one over the other. Throws on refusal.
 *
 * The reason for the split is the same reason `cadence.ts` is pure: the rule
 * that decides whether a stranger receives an email should be provable without a
 * running system. Everything interesting is in the pure half, and the test file
 * beside this one exercises all fourteen refusals with no network, no database
 * and no key.
 *
 * ---------------------------------------------------------------------------
 * Why `assertSendAllowed` throws when the pure half returns
 * ---------------------------------------------------------------------------
 *
 * A refusal is a fact, and a pure function that throws its facts is miserable to
 * test — you cannot write a table over it. So `evaluateSend` returns a
 * discriminated union and the tests read like the spec.
 *
 * The I/O entry point is the opposite case. It is called `assertSendAllowed`,
 * and an assert whose result can be ignored by not assigning it is not an
 * assert; it is a suggestion. `if (await canSend(...))` is one forgotten `if`
 * away from sending an email to somebody who asked never to hear from you again,
 * and that mistake is invisible in review because the line still reads
 * plausibly. Throwing `SendRefusedError` means the only way to proceed past a
 * refusal is to catch it deliberately. The caller branches on `decision.terminal`
 * rather than re-deriving a policy from the reason code, which is why `terminal`
 * is on the decision and not in a lookup table somebody else has to keep in step.
 *
 * ---------------------------------------------------------------------------
 * Counting, not locking — the obvious review comment, answered
 * ---------------------------------------------------------------------------
 *
 * Both rate limits are `select count(*)` immediately before the send, with no
 * lock, no reservation row and no transaction. Read on its own that is a
 * textbook race: two workers count 9 against a cap of 10 and both send.
 *
 * It is safe here structurally, not by luck. There is exactly one writer of
 * outbound `interactions` rows — the send queue in `apps/worker`, which is a
 * single-flight poller (a module-level `running` flag, one task at a time, the
 * next tick refusing to start while the previous one is in flight). One writer
 * means the count cannot move between the read and the write. If a second sender
 * is ever added — a "send now" button, a second worker instance, step 8's
 * webhook deciding to reply inline — this becomes a real race and the fix is a
 * reservation row or an advisory lock, not a bigger comment. That is the
 * condition to watch for; it is written here rather than left to be rediscovered.
 *
 * The windows are rolling, not calendar days: "sent in the last 24 hours",
 * counted from the instant of the check. A calendar-day cap resets at midnight
 * and lets 20 messages leave inside four hours across the boundary, which is
 * exactly the burst the deliverability ramp in PLAN §7.1 exists to prevent.
 *
 * One consequence worth stating because it surprises people: dry-run sends still
 * write `interactions` rows, so a day of dry-run testing consumes the daily cap
 * and trips the 48h cooldown for the contacts involved. That is deliberate — the
 * point of a dry run is to exercise the real arithmetic — but it means a cap of
 * 10 can be exhausted by testing. Wait out the window or delete the rows.
 *
 * ---------------------------------------------------------------------------
 * The order of the checks is a decision, not an accident
 * ---------------------------------------------------------------------------
 *
 * Permanent reasons are checked before rate reasons, and the cheapest permanent
 * reason is checked first. The reason is what the operator sees: a contact who
 * is marked `do_not_contact` *and* happens to fall on a day the cap is full must
 * report `do_not_contact`, because "we are at today's limit, try later" invites
 * exactly the wrong response — waiting a day and letting it through.
 *
 * The kill switch is checked before everything, including whether the task is
 * approved, because it is the operator's one-toggle stop and it should behave
 * identically for every task in the queue. It is the only refusal that is both
 * first and non-terminal: the queue must still be there when the switch goes
 * back on.
 *
 * ---------------------------------------------------------------------------
 * Two locks on the opt-out door, and only one list of synonyms
 * ---------------------------------------------------------------------------
 *
 * `contacts.do_not_contact` is the real flag. It is checked here, at send time,
 * immediately before the Gmail call, and never at draft time only — a draft
 * written on Monday can be approved on Thursday, and the opt-out may have
 * arrived on Tuesday.
 *
 * The suppression *tag* is the second lock, for opt-outs recorded during a phone
 * call or in a CSV import before anyone flipped the boolean. `findSuppressionTag`
 * is imported from `./cadence` and the synonym list is not retyped here — the
 * header of `SUPPRESSION_TAGS` says in as many words that this module must
 * import it, and two drifting lists of ways to say "never email me" is the kind
 * of bug that only shows up in a complaint.
 *
 * ---------------------------------------------------------------------------
 * The autonomy lock (SPEC §7)
 * ---------------------------------------------------------------------------
 *
 * The ladder is 0 ask before drafting / 1 draft and wait for approval / 2 send
 * then notify / 3 do silently. v1 ships it built and locked at 1: nothing leaves
 * this system to a third party above level 1.
 *
 * The lock is encoded three ways so raising it has to be a decision:
 *
 *  - `V1_MAX_AUTONOMY` is the literal `1`, not a `number`, and a type-level
 *    assertion below fails to compile the moment it is changed. Whoever raises
 *    it must also delete the assertion, which is a line of code they have to
 *    look at.
 *  - `guardrails.test.ts` asserts the value and names the spec clause, so the
 *    change breaks a test with an explanation attached rather than silently.
 *  - A level *above* 1 in `settings.autonomy` is clamped, not refused
 *    (`effectiveAutonomy`). Refusing would be tempting — it looks stricter — but
 *    it would turn a fat-fingered `2` in `/brain` into a queue of approved
 *    messages that silently never leave, which is the failure this whole app
 *    exists to prevent. Clamping is safe because a raised setting cannot create
 *    an auto-send path: the only thing that moves a task to `approved` is the
 *    operator clicking approve, and an unapproved task is refused at check 2.
 *    Level 2 means something only once something *other than the operator* can
 *    approve, and nothing in v1 can.
 *
 * A level *below* 1 does refuse. Level 0 is "ask before drafting", and a task
 * type set to 0 is one the operator has said they want a conversation about
 * first; honouring an approval on it anyway would make the setting decorative.
 *
 * ---------------------------------------------------------------------------
 * What `detail` is, and what must never be in it
 * ---------------------------------------------------------------------------
 *
 * Every refusal carries both a machine-readable `reason` and a human `detail`.
 * The reason is what the send queue branches on and what gets logged. The detail
 * is rendered on an alert task card in `/`, so it is written for the operator on
 * a Tuesday morning and not for whoever is reading a stack trace.
 *
 * It contains no email address, no name, no subject and no body. This is not
 * decoration: an alert task is a database row that gets read by a page, a push
 * notification and eventually by whatever reads `agent_runs`, and "refusing to
 * send to maria@example.gr" copies a customer's address into three more places
 * for no benefit. The test file asserts that no `detail` contains an `@`.
 *
 * For the same reason no raw database value is interpolated into a detail —
 * not the status, not the task type, not the contact's tags. `cadence.ts` sets
 * that precedent explicitly ("the raw stage value is deliberately not
 * interpolated into it"): a value that arrived from PostgREST is not something
 * to render into the UI. The two exceptions are numbers the operator set
 * themselves (the daily cap) and the suppression tag, which is one of *our*
 * constants and is quoted so the operator can find it on the contact.
 *
 * This module never calls `console.*` at all. The caller logs, with ids and
 * counts.
 *
 * ---------------------------------------------------------------------------
 * `already_sent` — the guard the 48-hour window was quietly doing badly
 * ---------------------------------------------------------------------------
 *
 * The send queue writes `interactions` first and `tasks.status = 'sent'` last,
 * so that a process killed in between is caught on the next tick by a guardrail
 * rather than sending a second copy. That was originally the per-contact
 * cooldown — and the cooldown is a *rolling 48-hour window*, so it stops being
 * true 48 hours later and the still-`approved` task goes out again, to the same
 * person, with nothing having errored. Three attempts of one failing `UPDATE`
 * is all it takes to get there.
 *
 * `already_sent` is the guard that does not expire: `interactions.meta.task_id`
 * records which task produced which outbound row, and a task that already has
 * one has already been sent, forever. It is terminal, and the send queue repairs
 * the row by marking it `sent` rather than `skipped` — the message did leave, so
 * that is the truth.
 *
 * It costs one extra count query per send. That is the price of the rule this
 * whole file exists for, and the rule is "exactly once".
 *
 * It does not cover every window. If the Gmail call itself fails after Gmail
 * accepted the message — a socket reset while the response was being read —
 * there is no `interactions` row to find, and the task is retried on the next
 * tick. `gmail.ts` closes the part of that window it can (a 2xx whose body does
 * not parse is treated as sent, because it was); the remainder needs an
 * idempotency key the Gmail API does not offer.
 *
 * ---------------------------------------------------------------------------
 * Three judgement calls the step-6 contract does not make
 * ---------------------------------------------------------------------------
 *
 * **1. `task_not_found` and a null status are the same refusal.** The contract
 * says a missing row is handed to `evaluateSend` with `status: null` and must
 * refuse as `task_not_found`. `tasks.status` is also nullable in the schema, so
 * a real row with a null status lands on the same reason. Both are "there is no
 * approval here and re-reading will not produce one", both are terminal, and the
 * detail is worded to cover both honestly rather than claiming the row is gone.
 *
 * **2. The body is passed through verbatim; the subject is trimmed.** Only the
 * *emptiness* test trims the body — the operator's own trailing newline is
 * theirs and `final_body` is what SPEC §3 calls "what the owner actually sent".
 * The subject is trimmed because it becomes a MIME header, and leading
 * whitespace in a header is a folding bug waiting to happen. A null or empty
 * subject is not a refusal: Gmail accepts a subjectless message and the Today
 * card is where an empty subject should be noticed, not here.
 *
 * **3. A count that comes back null throws.** PostgREST returns a count when one
 * is asked for; a null count with no error means we do not know how many
 * messages went out today. Treating that as zero fails open on a rate limit,
 * which is the one place fail-open is indefensible. It throws, the send queue
 * counts it as a failure, and the task stays approved for the next tick.
 *
 * ---------------------------------------------------------------------------
 * Not on the barrel
 * ---------------------------------------------------------------------------
 *
 * `packages/core/src/index.ts` does not export this module, for the same reason
 * it does not export `llm.ts`. This is the send path. It should be reachable by
 * writing the subpath `@agency/core/guardrails` on purpose, not by autocomplete
 * in a Server Action. The only value import here is `./cadence`, which is pure;
 * `./settings` is a value import that is itself type-only against `./db`, and
 * `./db` and `./types` are imported for types alone. Nothing in this file's
 * import graph loads `@supabase/supabase-js` or the Anthropic SDK, which is what
 * lets the test file import it with no environment at all.
 */

import { findSuppressionTag } from './cadence';
import { getSettings } from './settings';
import type { Db } from './db';
import type { AutonomyLevel, Contact, TaskStatus, TaskType } from './types';

// ---------------------------------------------------------------------------
// The numbers, as named constants so tests assert against names
// ---------------------------------------------------------------------------

/** Rolling window for the daily volume cap — PLAN §7 says "last 24h". */
export const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Rolling window for the per-contact rule — SPEC §8's 48 hours. */
export const CONTACT_COOLDOWN_MS = 48 * 60 * 60 * 1000;

/** SPEC §8: "max 1 message per contact per 48h". */
export const MAX_PER_CONTACT_PER_WINDOW = 1;

/**
 * SPEC §7: nothing leaves the system above level 1 in v1.
 *
 * Deliberately the literal `1` and not a `number` — see `AutonomyLockedAtOne`
 * directly below, and the header.
 */
export const V1_MAX_AUTONOMY = 1 as const satisfies AutonomyLevel;

/**
 * Compile-time half of the lock. `AutonomyLockedAtOne<L extends 1>` only accepts
 * the literal 1, so changing `V1_MAX_AUTONOMY` to 2 stops the package
 * type-checking until this assertion is also deleted. That is the point: raising
 * the ceiling on what this system does without a human should cost somebody a
 * deliberate edit and a paragraph in a commit message, not a typo in a config.
 */
type AutonomyLockedAtOne<L extends 1> = L;
type AutonomyLockAssertion = AutonomyLockedAtOne<typeof V1_MAX_AUTONOMY>;
/** Referenced so the assertion cannot be pruned as unused. */
export type V1AutonomyCeiling = AutonomyLockAssertion;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Every way a send can be refused.
 *
 * A runtime array rather than a bare union so the test file can prove every one
 * of them is reachable; the union is derived from it, so the two cannot drift.
 * The order is the order the checks run in, which is also the order of
 * precedence — see the header.
 */
export const SEND_REFUSAL_REASONS = [
  'kill_switch',
  'task_not_found',
  'task_not_approved',
  'already_sent',
  'task_wrong_type',
  'no_contact',
  'contact_missing',
  'do_not_contact',
  'suppression_tag',
  'no_email_address',
  'autonomy_off',
  'empty_body',
  'daily_cap',
  'contact_cooldown',
] as const;

export type SendRefusalReason = (typeof SEND_REFUSAL_REASONS)[number];

/** Everything the decision needs, and nothing that needs a database to obtain. */
export type SendGuardFacts = {
  now: Date;
  killSwitch: boolean;
  /** settings.autonomy for the task's type, already read. Not clamped. */
  autonomyLevel: AutonomyLevel;
  /** settings.daily_send_cap. */
  dailySendCap: number;
  task: {
    id: string;
    type: TaskType | null;
    status: TaskStatus | null;
    contactId: string | null;
    subject: string | null;
    /** final_body ?? draft_body, already resolved by the caller. */
    body: string | null;
  };
  /**
   * An outbound `interactions` row already carries this task id, so the message
   * has left even if `tasks.status` never made it to `sent`. Does not expire.
   */
  alreadySent: boolean;
  /** null when the task's contact_id does not resolve to a row. */
  contact: {
    id: string;
    email: string | null;
    doNotContact: boolean | null;
    tags: readonly string[] | null;
  } | null;
  /** interactions: direction='out', channel='email', occurred_at > now - 24h. */
  sentInLast24h: number;
  /** the same query scoped to this contact, window 48h. */
  sentToContactInLast48h: number;
};

export type SendAllowed = {
  allowed: true;
  contactId: string;
  /** Trimmed. Guaranteed non-empty and to contain '@'. */
  to: string;
  subject: string;
  body: string;
};

export type SendRefused = {
  allowed: false;
  reason: SendRefusalReason;
  /** One sentence for the operator. Contains no email address and no body. */
  detail: string;
  /**
   * false  the task is fine and the world is not — leave it `approved` and try
   *        again on a later tick (`kill_switch`, `daily_cap`, `contact_cooldown`).
   * true   nothing about a retry will help — resolve the task and alert.
   */
  terminal: boolean;
};

export type SendDecision = SendAllowed | SendRefused;

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

function refuse(reason: SendRefusalReason, detail: string, terminal: boolean): SendRefused {
  return { allowed: false, reason, detail, terminal };
}

/**
 * The autonomy level this system will actually act on.
 *
 * Clamped to `V1_MAX_AUTONOMY`, never refused for being too high. See the
 * header for why clamping is the safe direction and why it cannot create an
 * auto-send path.
 */
export function effectiveAutonomy(level: AutonomyLevel): AutonomyLevel {
  return level > V1_MAX_AUTONOMY ? V1_MAX_AUTONOMY : level;
}

/**
 * The start of a rolling window — everything at or after this instant counts.
 *
 * Exported because it is the arithmetic that decides whether a message sent 47
 * hours ago blocks one now and a message sent 49 hours ago does not, and that
 * boundary deserves a test that does not need a database to run.
 */
export function windowStart(now: Date, windowMs: number): Date {
  return new Date(now.getTime() - windowMs);
}

/**
 * PLAN §7's send-path guardrails as a function.
 *
 * The order below is the contract, not an implementation detail — see the
 * header. Each check is one test case in `guardrails.test.ts`.
 */
export function evaluateSend(facts: SendGuardFacts): SendDecision {
  const { task, contact } = facts;

  // 1. The operator's one toggle. Non-terminal: they will turn it back on and
  //    the queue should still be there when they do.
  if (facts.killSwitch) {
    return refuse(
      'kill_switch',
      'The kill switch is on, so nothing is being sent. This stays in the queue until you turn it off in /brain.',
      false,
    );
  }

  // 2. No row, or a row with no status at all. Both mean there is no approval
  //    here and re-reading will not produce one. See judgement call 1.
  if (task.status === null) {
    return refuse(
      'task_not_found',
      'This task could not be read back, or has no status recorded, so there is nothing to send.',
      true,
    );
  }

  // 3. PLAN §7, row 1: "the send function takes a taskId, re-reads the row, and
  //    throws unless status = 'approved'". Re-reading is the guardrail, not a
  //    redundancy — the caller selected this id a moment ago and the row may
  //    have been rejected in the meantime.
  if (task.status !== 'approved') {
    return refuse(
      'task_not_approved',
      'This task has not been approved, and only an approved task is ever sent.',
      true,
    );
  }

  // 3b. The message already left, whatever the status column says. Checked
  //     immediately after the approval check because it is the same question —
  //     "should this leave now?" — answered from the durable record instead of
  //     from a column that a failed write can leave stale. See the header.
  if (facts.alreadySent) {
    return refuse(
      'already_sent',
      'This message has already been sent — an outbound record for it exists — so it will not be sent again.',
      true,
    );
  }

  // 4. `reminder` and `alert` tasks have no recipient and no draft. Sending one
  //    would mean inventing both.
  if (task.type !== 'draft_email') {
    return refuse(
      'task_wrong_type',
      'Only a drafted email can be sent, and this task is not one.',
      true,
    );
  }

  if (task.contactId === null) {
    return refuse(
      'no_contact',
      'This task is not linked to a contact, so there is nobody to send it to.',
      true,
    );
  }

  if (contact === null) {
    return refuse(
      'contact_missing',
      'The contact this task was written for no longer exists.',
      true,
    );
  }

  // 5. The permanent flag. Checked here, at send time, every time.
  if (contact.doNotContact === true) {
    return refuse(
      'do_not_contact',
      'This contact is marked do-not-contact and must never be emailed.',
      true,
    );
  }

  // 6. The second lock on the same door. The synonym list lives in cadence.ts.
  const suppressed = findSuppressionTag(contact.tags ?? undefined);
  if (suppressed !== null) {
    return refuse(
      'suppression_tag',
      `Tagged "${suppressed}" — this contact must not be emailed.`,
      true,
    );
  }

  const to = typeof contact.email === 'string' ? contact.email.trim() : '';
  if (to === '' || !to.includes('@')) {
    return refuse(
      'no_email_address',
      'This contact has no usable email address on file, so the draft cannot be sent.',
      true,
    );
  }

  // 7. Level 0 is "ask before drafting". Levels above 1 are clamped, not
  //    refused — see the header.
  if (effectiveAutonomy(facts.autonomyLevel) < 1) {
    return refuse(
      'autonomy_off',
      'Autonomy for this kind of task is set to 0 — ask first — so nothing is sent, even with an approval on it.',
      true,
    );
  }

  // 8. A blank email is the single most embarrassing thing this system could
  //    send. Only the emptiness test trims; the body itself goes out verbatim.
  const body = task.body ?? '';
  if (body.trim() === '') {
    return refuse(
      'empty_body',
      'The message body is empty, so there is nothing to send.',
      true,
    );
  }

  // 9. Rate limits last, and non-terminal: the task is fine, the world is busy.
  if (facts.sentInLast24h >= facts.dailySendCap) {
    // A cap of 0 is a documented setting, not an error: `settings-validation.ts`
    // sets `MIN_DAILY_SEND_CAP = 0` and describes it as pausing sending without
    // touching the kill switch. But `0 >= 0` refuses on the same branch as a cap
    // that has genuinely filled up, and the sentence for that case — "this goes
    // out once the last 24 hours drop below it" — promises a retry that can
    // never happen, on a queue that will now halt on the first task every tick
    // for as long as the setting stands. Same refusal, honest sentence.
    return refuse(
      'daily_cap',
      facts.dailySendCap <= 0
        ? 'The daily send cap is 0, which pauses sending. Nothing leaves until you raise it in /brain.'
        : `The daily send cap of ${facts.dailySendCap} has already been reached. This goes out once the last 24 hours drop below it.`,
      false,
    );
  }

  if (facts.sentToContactInLast48h >= MAX_PER_CONTACT_PER_WINDOW) {
    return refuse(
      'contact_cooldown',
      'This contact was emailed in the last 48 hours. One message per contact per 48 hours, so this waits.',
      false,
    );
  }

  return {
    allowed: true,
    contactId: contact.id,
    to,
    subject: (task.subject ?? '').trim(),
    body,
  };
}

// ---------------------------------------------------------------------------
// The I/O half
// ---------------------------------------------------------------------------

export class SendRefusedError extends Error {
  readonly reason: SendRefusalReason;
  readonly detail: string;
  readonly terminal: boolean;
  readonly taskId: string;

  constructor(taskId: string, decision: SendRefused) {
    super(`Refusing to send task ${taskId}: ${decision.reason} — ${decision.detail}`);
    this.name = 'SendRefusedError';
    this.taskId = taskId;
    this.reason = decision.reason;
    this.detail = decision.detail;
    this.terminal = decision.terminal;
  }
}

/**
 * What the caller gets when the send is permitted. One read, no re-query.
 *
 * `to` is on here as well as inside the contact row on purpose: it is the
 * trimmed, `@`-checked address the decision actually approved, and the caller
 * must send to that rather than re-derive one from `contact.email` and lose the
 * validation. The full row comes too, because `gmail.ts` needs `language` and
 * the send queue needs `timezone`, `name` and `touch_count`.
 */
export type SendPermit = {
  taskId: string;
  /** The full row. The caller needs language, timezone, name and touch_count. */
  contact: Contact;
  /** Trimmed, non-empty, contains '@'. Send to this, not to `contact.email`. */
  to: string;
  subject: string;
  body: string;
  /** Counts as they stood at the check, for the log line. */
  sentInLast24h: number;
  dailySendCap: number;
};

/** Counts an outbound email window. Throws rather than guessing — judgement call 3. */
async function countOutboundEmails(
  db: Db,
  since: Date,
  contactId: string | null,
): Promise<number> {
  let query = db
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'out')
    .eq('channel', 'email')
    .gte('occurred_at', since.toISOString());

  if (contactId !== null) query = query.eq('contact_id', contactId);

  const { count, error } = await query;

  if (error) throw new Error(`Failed to count outbound email: ${error.message}`);
  if (count === null) {
    throw new Error(
      'Failed to count outbound email: the database returned no count. Refusing to send ' +
        'rather than assume the rate limits are clear.',
    );
  }
  return count;
}

/**
 * Has an outbound row already been written for this task?
 *
 * `interactions.meta.task_id` is written by the send queue immediately after the
 * Gmail call, before anything touches `tasks`. So this answers "did this exact
 * task's message leave?" from the row that is written first and never rewritten,
 * rather than from a status column three retries away from being wrong.
 *
 * Filtered on the JSON path rather than read and compared in memory: the point
 * is that the answer is independent of any time window, and a bounded "last N
 * rows for this contact" read would reintroduce one.
 *
 * Throws rather than guessing, for the same reason `countOutboundEmails` does —
 * a count we could not read is not evidence that nothing was sent.
 */
async function hasOutboundRecordForTask(db: Db, taskId: string): Promise<boolean> {
  const { count, error } = await db
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'out')
    .eq('channel', 'email')
    .eq('meta->>task_id', taskId);

  if (error) throw new Error(`Failed to check whether this task was already sent: ${error.message}`);
  if (count === null) {
    throw new Error(
      'Failed to check whether this task was already sent: the database returned no count. ' +
        'Refusing to send rather than risk a second copy.',
    );
  }
  return count > 0;
}

/**
 * Gather everything `evaluateSend` needs.
 *
 * Six round trips at most, and every one of them is a fact that can change
 * between the draft and the send: the task, the settings, the contact, whether
 * this task has already produced an outbound row, and the two rate-limit counts.
 * A task with no contact skips two of them.
 *
 * The contact row is returned alongside the facts because `assertSendAllowed`
 * hands the whole row to the caller and re-reading it would be a fifth query
 * that could disagree with the one the decision was made on.
 */
export async function collectSendFacts(
  db: Db,
  opts: { taskId: string; now?: Date },
): Promise<{ facts: SendGuardFacts; contactRow: Contact | null }> {
  const now = opts.now ?? new Date();

  const { data: task, error: taskError } = await db
    .from('tasks')
    .select('id, type, status, contact_id, draft_subject, draft_body, final_body')
    .eq('id', opts.taskId)
    .maybeSingle();

  if (taskError) throw new Error(`Failed to read task: ${taskError.message}`);

  const settings = await getSettings(db);
  const contactId = task?.contact_id ?? null;

  let contactRow: Contact | null = null;
  if (contactId !== null) {
    const { data, error } = await db
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .maybeSingle();

    if (error) throw new Error(`Failed to read contact: ${error.message}`);
    contactRow = data;
  }

  const alreadySent = await hasOutboundRecordForTask(db, opts.taskId);

  const sentInLast24h = await countOutboundEmails(
    db,
    windowStart(now, DAILY_CAP_WINDOW_MS),
    null,
  );
  const sentToContactInLast48h =
    contactId === null
      ? 0
      : await countOutboundEmails(db, windowStart(now, CONTACT_COOLDOWN_MS), contactId);

  // A task type outside the union means a row the settings map has no level
  // for. 0 refuses as `autonomy_off`, which is the quiet direction to be wrong.
  const autonomyLevel: AutonomyLevel =
    task?.type == null ? 0 : (settings.autonomy[task.type] ?? 0);

  const facts: SendGuardFacts = {
    now,
    killSwitch: settings.kill_switch,
    autonomyLevel,
    dailySendCap: settings.daily_send_cap,
    task: {
      id: opts.taskId,
      type: task?.type ?? null,
      status: task?.status ?? null,
      contactId,
      subject: task?.draft_subject ?? null,
      // SPEC §3: final_body is "what the owner actually sent". The approve
      // action always writes it; draft_body is the fallback for a row written
      // by any other path, so the send queue has exactly one field to read.
      body: task?.final_body ?? task?.draft_body ?? null,
    },
    alreadySent,
    contact:
      contactRow === null
        ? null
        : {
            id: contactRow.id,
            email: contactRow.email,
            doNotContact: contactRow.do_not_contact,
            tags: contactRow.tags,
          },
    sentInLast24h,
    sentToContactInLast48h,
  };

  return { facts, contactRow };
}

/**
 * The one entry point to the send path.
 *
 * There is no `sendRaw` and there is no boolean to forget to check. Callers
 * catch `SendRefusedError` explicitly and branch on `terminal`; any other error
 * is a genuine failure (a database error, an unreadable count) and the task
 * stays approved for the next tick.
 *
 * @throws {SendRefusedError} when any guardrail refuses.
 */
export async function assertSendAllowed(
  db: Db,
  opts: { taskId: string; now?: Date },
): Promise<SendPermit> {
  const { facts, contactRow } = await collectSendFacts(db, opts);
  const decision = evaluateSend(facts);

  if (!decision.allowed) throw new SendRefusedError(opts.taskId, decision);

  if (contactRow === null) {
    // Unreachable: `evaluateSend` refuses `contact_missing` when the row is
    // absent. Kept as a throw rather than a non-null assertion so that a future
    // edit which reorders the checks fails loudly instead of sending a message
    // with no recipient row behind it.
    throw new Error(
      `Guardrails allowed task ${opts.taskId} with no contact row. This is a bug in evaluateSend.`,
    );
  }

  return {
    taskId: opts.taskId,
    contact: contactRow,
    to: decision.to,
    subject: decision.subject,
    body: decision.body,
    sentInLast24h: facts.sentInLast24h,
    dailySendCap: facts.dailySendCap,
  };
}
