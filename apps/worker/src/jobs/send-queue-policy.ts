/**
 * Send-queue policy — everything the 60-second poller decides that needs no
 * database, no network and no credentials.
 *
 * `send-queue.ts` is the orchestration: it reads rows, calls the guardrails,
 * calls Gmail and writes the three tables. Every *decision* it makes on the way
 * lives here as a pure function over plain data, for the same reason
 * `followup-select.ts` exists next door — the rules that decide whether a real
 * person gets a second copy of an email, or whether an approved task is thrown
 * away, should be provable without a running system. A rule that can only be
 * exercised by pointing the worker at production is a rule nobody exercises.
 *
 * The only import is a type, so this module loads under `tsx --test` with no
 * environment at all.
 *
 * ---------------------------------------------------------------------------
 * The three judgement calls in here, and what each one prevents
 * ---------------------------------------------------------------------------
 *
 * **1. The refusal table outranks `terminal` for reasons this file knows.**
 * `SendRefusedError` carries `terminal` precisely so the caller does not have to
 * map reasons itself, and for any reason added to `guardrails.ts` after this
 * file was written, `terminal` is what decides. But for the three reasons that
 * are about the world rather than the task — the kill switch, the daily cap, the
 * 48-hour per-contact cooldown — the table wins even if `terminal` says
 * otherwise. One flipped boolean in a guardrail refactor would otherwise resolve
 * every approved task in the queue to `skipped` in a single tick, and there is
 * no way back from that: the drafts are gone, the operator's approvals are gone,
 * and nothing errored. Deferring a task that should have been resolved costs one
 * wasted tick; the reverse costs the queue.
 *
 * **2. A Gmail failure about the installation defers; a failure about the
 * message resolves.** The contract says "anything non-retryable → skipped", and
 * for `message_too_large` or a 400 on a malformed message that is right — that
 * task will fail identically forever and retrying it is a log flood. But
 * `config` (a footer variable is unset) and `auth` (the refresh token was
 * revoked) are also non-retryable, and both mean *every* queued message fails.
 * Skipping the whole queue because `BUSINESS_ADDRESS` is empty would destroy a
 * morning's approvals over a one-line fix. Those defer, and the alert is filed
 * once per process so a broken installation does not file a card a minute.
 *
 * **3. An error that is not a `GmailError` defers.** A PostgREST blip, a DNS
 * failure, a bug in this worker — none of them are evidence that the message is
 * unsendable, and the guardrails have already resolved the tasks that genuinely
 * cannot be sent (no email address, opted out, wrong type). The failure mode
 * being avoided is a database hiccup silently marking a queue of real
 * follow-ups as skipped.
 */

import type { SendRefusalReason } from '@agency/core/guardrails';

/**
 * What a tick does to the task row.
 *
 *   defer    leave it `approved` with its `send_after` untouched; the next tick
 *            in sixty seconds is the retry.
 *   resolve  set `status: 'skipped'` and `resolved_at`, and file an alert. Not
 *            `rejected`: `rejected` is the operator's verdict on a draft and
 *            step 9 reads it as training signal. A guardrail refusal or a
 *            permanent transport failure is the machine declining, not a
 *            judgement about the writing.
 */
export type TaskAction = 'defer' | 'resolve';

/**
 * Refusals that are about the state of the world and will be true again
 * tomorrow. Everything else is permanent and resolves the task.
 *
 * `contact_cooldown` is in here because it is genuinely temporary: the contact
 * was emailed recently and this draft goes out when the window clears. It used
 * to be described as the duplicate-send guard as well, and that was wrong in a
 * way that took 48 hours to show — the window is rolling, so a task whose
 * `status = 'sent'` write failed was refused by the cooldown for two days and
 * then sent again. `already_sent` is the guard that does not expire; see
 * `guardrails.ts`.
 */
export const DEFERRABLE_REASONS: readonly SendRefusalReason[] = [
  'kill_switch',
  'daily_cap',
  'contact_cooldown',
];

/**
 * Refusals that make the rest of the tick pointless.
 *
 * Both are global: once the daily cap is reached or the kill switch is on, every
 * remaining task in the batch refuses identically. Continuing would be nine more
 * round trips to learn the same thing, and — worse — nine more alert cards if
 * anyone ever removes the dedupe gate.
 *
 * `contact_cooldown` is deliberately not here. It is per contact, and the next
 * task in the batch belongs to somebody else.
 */
export const HALTING_REASONS: readonly SendRefusalReason[] = ['kill_switch', 'daily_cap'];

/**
 * `GmailError.kind` values that describe the installation rather than the
 * message. See judgement call 2 in the header.
 *
 * `rate_limit` and `network` are already `retryable` on the error itself; they
 * are listed anyway so the alert-dedupe key does not depend on two different
 * fields agreeing.
 */
export const ENVIRONMENTAL_GMAIL_KINDS: readonly string[] = [
  'config',
  'auth',
  'network',
  'rate_limit',
];

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** The two columns the selection query asks for. */
export type DueTaskRow = { id: string; send_after: string | null };

/**
 * The ids to attempt this tick, oldest `send_after` first.
 *
 * PostgREST already applied `send_after is not null`, `send_after <= now`, the
 * ordering and the limit. This re-applies all four to the rows that came back,
 * which is not paranoia about the database — it is a guard against the query in
 * `send-queue.ts` being edited. A dropped `.not('send_after', 'is', null)` would
 * send tasks that were never scheduled; a dropped `.lte` would send them before
 * their window, which is the whole thing PLAN §7.1 exists to prevent, and
 * neither would fail a typecheck or a review at a glance.
 *
 * A row whose `send_after` does not parse is dropped rather than sent. An
 * unparseable timestamp means the row is corrupt, and "send it now" is the wrong
 * answer to "I cannot tell when this was meant to go".
 *
 * Ties break on id so the order is total and a test can assert it.
 */
export function orderDueTasks(
  rows: readonly DueTaskRow[],
  now: Date,
  limit: number,
): string[] {
  const nowMs = now.getTime();

  const due: { id: string; at: number }[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '') continue;
    if (typeof row.send_after !== 'string') continue;
    const at = Date.parse(row.send_after);
    if (!Number.isFinite(at)) continue;
    if (at > nowMs) continue;
    due.push({ id: row.id, at });
  }

  due.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at - b.at));

  return due.slice(0, Math.max(0, limit)).map((row) => row.id);
}

/**
 * How many tasks one tick may attempt.
 *
 * The daily cap is the real ceiling and it is enforced per send by the
 * guardrails; this only bounds the work of a single tick so a backlog of two
 * hundred approved tasks does not turn one poll into a two-hundred-request
 * burst against Gmail. A caller asking for more than the maximum gets the
 * maximum rather than an error — the manual trigger is an operator convenience,
 * not an API.
 */
export function clampLimit(requested: number | undefined, max: number): number {
  if (requested === undefined) return max;
  if (!Number.isFinite(requested)) return max;
  return Math.min(max, Math.max(1, Math.floor(requested)));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * What a guardrail refusal does to the task.
 *
 * `terminal` is the guardrail's own answer and is honoured for any reason this
 * file does not recognise, so a reason added to `guardrails.ts` later still
 * behaves correctly here without an edit. For the three reasons in
 * `DEFERRABLE_REASONS` the table wins — see judgement call 1 in the header.
 */
export function refusalAction(reason: SendRefusalReason, terminal: boolean): TaskAction {
  if (DEFERRABLE_REASONS.includes(reason)) return 'defer';
  return terminal ? 'resolve' : 'defer';
}

/** Does this refusal mean the remaining tasks in the batch would refuse too? */
export function haltsTick(reason: SendRefusalReason): boolean {
  return HALTING_REASONS.includes(reason);
}

/**
 * The status a resolved refusal is written with.
 *
 * `skipped` for all but one, for the reason `resolveTask` in `send-queue.ts`
 * spells out: `rejected` is the operator's verdict on a draft and step 9 reads
 * it as training signal, and a guardrail refusal says nothing about the writing.
 *
 * `already_sent` is the exception and it is not a detail. That refusal means an
 * outbound `interactions` row for this task exists — the message reached the
 * customer, and only the `tasks` update failed. Writing `skipped` would leave
 * the operator's Today screen claiming a follow-up they can see in their own
 * Sent folder was never sent, and would put a false row in front of step 9.
 * `sent` is what actually happened.
 */
export function resolutionStatus(reason: SendRefusalReason): 'sent' | 'skipped' {
  return reason === 'already_sent' ? 'sent' : 'skipped';
}

/**
 * `GmailError.kind`, or null when the error is not one.
 *
 * Duck-typed on `name` rather than `instanceof GmailError`, because this module
 * must stay free of value imports: importing `@agency/core/gmail` for a class
 * would pull the whole send path — and its module-level token cache — into every
 * test run of this file.
 */
export function gmailErrorKind(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; kind?: unknown };
  if (candidate.name !== 'GmailError') return null;
  return typeof candidate.kind === 'string' ? candidate.kind : null;
}

/** Is this error about the installation rather than about this one message? */
export function isEnvironmentalFailure(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const named = error as { name?: unknown; retryable?: unknown };
    if (named.name === 'MissingEnvError') return true;
    if (named.retryable === true) return true;
  }
  const kind = gmailErrorKind(error);
  return kind !== null && ENVIRONMENTAL_GMAIL_KINDS.includes(kind);
}

/**
 * What a thrown error does to the task. See judgement calls 2 and 3.
 *
 * Only a `GmailError` that is neither retryable nor environmental resolves the
 * task — in practice `message_too_large` and a non-429 4xx from
 * `users.messages.send`. Both mean this exact message will be rejected on every
 * future tick, forever.
 */
export function failureAction(error: unknown): TaskAction {
  const kind = gmailErrorKind(error);
  if (kind === null) return 'defer';
  if (isEnvironmentalFailure(error)) return 'defer';
  return 'resolve';
}

/**
 * The dedupe key for the alert card a failure files.
 *
 * Environmental failures collapse onto the kind, so a Gmail outage or a missing
 * footer variable files exactly one card no matter how many tasks hit it or how
 * many ticks pass. Everything else is keyed per task, because a single task
 * failing repeatedly is a fact about that task and the operator needs to see it
 * once — not sixty times an hour, which is what an ungated alert on a
 * sixty-second poller produces.
 */
export function alertKey(taskId: string, error: unknown): string {
  if (isEnvironmentalFailure(error)) {
    const kind = gmailErrorKind(error);
    return `environment:${kind ?? 'unknown'}`;
  }
  return `task:${taskId}`;
}

/**
 * One alert per key, per process.
 *
 * Process lifetime and not longer, deliberately: a restart is the operator
 * intervening, and after an intervention a still-broken installation should say
 * so again. Unbounded in size, which is fine — the keys are task ids that failed
 * permanently, and a process that accumulates enough of those to matter has a
 * much larger problem than memory.
 */
export class AlertOnce {
  readonly #filed = new Set<string>();

  /** True the first time a key is seen, false every time after. */
  claim(key: string): boolean {
    if (this.#filed.has(key)) return false;
    this.#filed.add(key);
    return true;
  }

  get size(): number {
    return this.#filed.size;
  }

  /** Only for tests and for a future manual "tell me again" trigger. */
  reset(): void {
    this.#filed.clear();
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * `contacts.touch_count` after a successful send.
 *
 * Read-modify-write, which is safe only because this poller is the single
 * writer of that column and is single-flight. There is no RPC for an atomic
 * increment and step 6 may not add a migration to get one; see the header of
 * `send-queue.ts`.
 *
 * A null count means the column was never set and this is the first touch. A
 * corrupt one — negative, fractional, NaN, or a string that arrived through an
 * untyped path — is floored back into a sane integer rather than written
 * through. `touch_count` is only ever displayed and logged, never used for
 * cadence arithmetic (that is derived from `interactions`, PLAN §6 step 5
 * constraint 2), so recovering from nonsense beats propagating it.
 */
export function nextTouchCount(current: number | null | undefined): number {
  if (typeof current !== 'number' || !Number.isFinite(current)) return 1;
  return Math.max(0, Math.floor(current)) + 1;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Best-effort removal of email addresses from an error message.
 *
 * The house rule is that customer data never reaches a `console.*` call — ids
 * and counts only. Everything this job logs deliberately obeys that: task ids,
 * contact ids, counts, refusal reasons, never a subject, a body, a name or an
 * address.
 *
 * The one thing that does not obey it by construction is a database error
 * message, because Postgres writes the offending value into the text of a
 * constraint violation — `Key (email)=(…) already exists` — and that string
 * then goes into the worker log and onto an alert card the operator may have on
 * screen in front of somebody else. The send path is the one place in the system
 * where a recipient's address is in scope at the moment something fails, so this
 * is where the guard belongs.
 *
 * It is a last line of defence and not a licence: nothing in this job should be
 * passing customer data to a logger in the first place. Deliberately crude — one
 * pattern, replaced wholesale. A cleverer parser would be a second thing to get
 * wrong, and over-redacting an error message costs nothing that the `agent_runs`
 * and `interactions` rows do not already record properly.
 */
export function redactEmails(text: string): string {
  return text.replace(/[^\s<>()[\],;:"']+@[^\s<>()[\],;:"']+\.[^\s<>()[\],;:"'.]+/g, '[address]');
}
