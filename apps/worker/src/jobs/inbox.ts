/**
 * The inbox agent — SPEC §5, PLAN §6 step 8, contract §8.4.
 *
 * A message arrives in the owner's Gmail. Google publishes a notification to
 * Pub/Sub, Pub/Sub pushes it at `routes/gmail-webhook.ts`, and this file does
 * the work: walk the history from our own cursor, read the new messages, match
 * or create a contact, classify each one with Haiku, apply the routing table,
 * and — for the six classes that deserve one — draft a reply with Sonnet and
 * file a pending task. It sends nothing. The operator approves a card and the
 * send queue does the rest, exactly as with a follow-up.
 *
 * Everything decidable without I/O is elsewhere and unit tested there:
 * `inbox-classify.ts` holds the routing table, the classification prompt and
 * the validation; `inbox-reply-prompt.ts` holds the reply prompt. This file is
 * the orchestration and the write order.
 *
 * ---------------------------------------------------------------------------
 * The claim, and why a duplicate is impossible
 * ---------------------------------------------------------------------------
 *
 * Pub/Sub is at-least-once and Gmail's history ranges overlap. The same message
 * *will* arrive twice, and deduping on the Pub/Sub `messageId` is not enough: a
 * redelivery keeps its id, but two genuinely different notifications legitimately
 * cover the same Gmail message.
 *
 * **The dedupe key is the Gmail message id and the claim is the `interactions`
 * row itself.** Three things, in this order, and the order is the whole design:
 *
 *   1. **Batch pre-filter.** One `select` over the whole batch drops anything
 *      already recorded before `messages.get` is called. This is what saves the
 *      HTTP round trip.
 *   2. **Claim by insert.** The `interactions` row goes in *before* the Haiku
 *      call. A unique partial index on `meta->>'gmail_message_id'` turns a
 *      concurrent second delivery into a `23505`, which is caught and treated as
 *      "somebody else has this one": no model call, no task, no push. This is
 *      what saves the charge, and it is race-proof in a way the pre-filter is
 *      not.
 *   3. Everything after that happens exactly once, because step 2 admitted
 *      exactly one caller.
 *
 * This is the same lesson `send-queue.ts`'s header records for outbound —
 * *write the interaction first and let the unique row be the lock* — pointed the
 * other way. There the write order exists so a customer never gets the same
 * email twice; here it exists so we never pay Sonnet twice for the same reply
 * and never put two identical cards in front of the operator.
 *
 * `runInboxTick` is also single-flight in-process, exactly like
 * `sendQueueRunning` in `index.ts`, so the common case never reaches the index.
 *
 * ---------------------------------------------------------------------------
 * What one webhook delivery can cost
 * ---------------------------------------------------------------------------
 *
 * The webhook is a public URL and a public URL that starts model calls is a new
 * way to spend money, so the bound is worth stating exactly:
 *
 *   - One run lists at most `MAX_HISTORY_IDS_PER_RUN` message ids (100) and
 *     processes at most `MAX_MESSAGES_PER_RUN` of them (25). Listing is one
 *     request; processing is what costs money.
 *   - A message already finished costs zero model calls — it is dropped by the
 *     pre-filter or by the claim. A message that has used all
 *     `MAX_MESSAGE_ATTEMPTS` attempts is finished for this purpose too.
 *   - A new message costs one Haiku classification (400 output tokens) and, for
 *     the six classes that draft, one Sonnet reply. A bare opt-out costs zero:
 *     `detectOptOut` is deterministic and runs before Haiku.
 *   - Concurrent deliveries collapse: `runInboxTick` declines while a run is in
 *     progress and remembers that somebody asked, so a thousand pushes in a
 *     second produce one run and one more after it — not a thousand, and not
 *     one with the last message stranded until the next sweep.
 *   - `call()` checks `settings.daily_cost_cap` before every request, and an
 *     `LlmError` of kind `cost_cap` halts the rest of the run here rather than
 *     letting every remaining message discover the same thing.
 *
 * So the ceiling per delivery is 25 Haiku + 25 Sonnet calls, and the ceiling per
 * day is the cost cap, whatever the rate of deliveries.
 *
 * ---------------------------------------------------------------------------
 * Logging, and this is stricter than anywhere else in the repo
 * ---------------------------------------------------------------------------
 *
 * Never logged, on any path including every error path: the subject, the body,
 * the snippet, the sender's display name, the sender's address, the sender's
 * domain, and **the classifier's `reason`**. That last one is the subtle one —
 * it is generated English that quotes the message it describes, so it is
 * customer data wearing a summary's clothes. It goes on the task and on
 * `interactions.meta`, which are the operator's own database, and nowhere else.
 *
 * Error messages are put through `redactEmails` before they are logged or put
 * on a card, because a Postgres unique violation writes the offending value
 * into its own message and this is the one job where that value is a customer's
 * address.
 *
 * May be logged: contact ids, task ids, the Gmail message and thread ids
 * (`send-queue.ts` and `gmail.ts` already log `gmail_message_id`), the class,
 * the confidence, and counts.
 *
 * ---------------------------------------------------------------------------
 * The claim is also the attempt counter, and that is what makes a retry real
 * ---------------------------------------------------------------------------
 *
 * The claim buys idempotency at a price that has to be paid back somewhere: a
 * message that fails *after* the row is written — a classifier answer that will
 * not parse, a `contacts` update that errors, a `tasks` insert that errors — is
 * already recorded, so the pre-filter drops it on every later sweep and the
 * work never happens. The first version of this file told the operator on an
 * alert card that the message would be tried again on the next sweep. It would
 * not have been. The worst shape of that is a `not_interested` reply whose
 * `contacts` update failed: the opt-out is never applied, the contact keeps
 * their `next_touch_at`, and the follow-up agent keeps writing to somebody who
 * said no — the one failure in this file with a legal edge.
 *
 * So `meta.attempts` is part of the claim from the first write. A recorded
 * message is only "done" when it has a class, or when it has used
 * `MAX_MESSAGE_ATTEMPTS` attempts; anything else is offered to the next run,
 * which takes the row over rather than inserting a second one. Three
 * consequences worth stating:
 *
 *   - **The retake is a compare-and-swap on the attempt count**, not a blind
 *     update. Two callers that both read `attempts: 1` cannot both write
 *     `attempts: 2`, so the property the unique index gives the insert — exactly
 *     one caller proceeds — survives on the retry path too.
 *   - **A row with no `attempts` field is not ours to retake.** It was written
 *     by something else, or by a hand-run query, and taking it over would mean
 *     reclassifying a message somebody else is holding.
 *   - **Three attempts, then the message is abandoned and said so.** Unbounded
 *     retries of a message that cannot be processed would be one Haiku call
 *     every fifteen minutes forever, and — because the cursor waits for the
 *     batch — would eventually stop new mail being read at all. The card filed
 *     at the last attempt says plainly that nothing further will happen, because
 *     a card that promises a retry the code cannot perform is worse than no card.
 *
 * A message we could not even *read* gets the same treatment: an `interactions`
 * row with no subject and no body, carrying the read error and the attempt
 * count. That is a judgement call the spec does not make. It costs a row that
 * shows up on `/inbox` as unclassified, and it buys the only bound available on
 * a message Gmail keeps refusing to hand over — without it, that one id fails on
 * every sweep, the cursor can never advance past it, the window it is listed in
 * grows until it hits `MAX_HISTORY_IDS_PER_RUN`, and everything that arrives
 * after that is never listed at all. Silence about a message that arrived is the
 * failure this whole file is written against, so the row is the honest outcome
 * as well as the safe one.
 *
 * ---------------------------------------------------------------------------
 * Six decisions the spec does not make
 * ---------------------------------------------------------------------------
 *
 * **`next_touch_at` is pushed to at least three days out when a reply task is
 * filed.** `followup.ts` skips a contact who already has a pending
 * `agent: 'followup'` draft, but an inbox task carries `agent: 'inbox'` — so
 * without this the morning agent drafts a cold nudge at somebody we are
 * mid-conversation with, and the operator gets two cards about the same person
 * on the same morning. Three days is the shortest interval in SPEC §4's table.
 *
 * **`last_touch_at` is not touched.** It means "we touched them" and it drives
 * the outbound cooldown. An inbound message is not an outbound touch, and
 * moving it would suppress a follow-up nobody sent.
 *
 * **A contact with `do_not_contact = true` who writes in is still logged and
 * still classified, but never drafted at.** They are talking to us, so the row
 * and the class are right; replying to somebody who opted out is the one
 * mistake here with a legal edge.
 *
 * **One address can match more than one contact row, and the opt-out is read
 * across all of them.** `contacts.email` has no unique index and nothing on the
 * create path checks for an existing address, so a shared `info@` typed twice or
 * a re-import produces two rows for one person. Taking whichever row the
 * database happened to return first would mean an old row marked
 * `do_not_contact` is invisible half the time — and answering that address is
 * the mistake with the legal edge again. So every matching row is read: the
 * opt-out is the union across them, and setting it applies to all of them. The
 * row the conversation is attributed to is chosen deterministically (see
 * `chooseContact`) rather than by whatever order came back.
 *
 * **A read failure that is about the mailbox stops the run; one that is about a
 * message costs that message.** A 401, a 429 or a network failure is not going
 * to be different for the twenty-fourth message than it was for the first, and
 * retrying it per message means twenty-five forced token refreshes against a
 * credential Google has already revoked, plus twenty-five identical cards. Those
 * kinds halt, exactly as the cost cap does. A 404 is the opposite: the message
 * was deleted between the history listing and the read, no number of retries
 * will produce it, and treating it as a failure would hold the cursor forever
 * over a message that no longer exists.
 *
 * **The cursor does not advance on a run that had a failure, or one that hit
 * the message ceiling — including a run where every message was a duplicate.**
 * That last clause is the one that was missing and it was silent mail loss:
 * `walkHistory` returns Gmail's *current* mailbox history id, not the end of the
 * page it walked, so a capped run whose 25 ids were all already recorded would
 * jump the cursor past everything it had not reached. Thirty messages in one
 * sweep window — a mailing-list burst, a Monday after a holiday — and the last
 * five are never read, never classified, never replied to, with nothing in the
 * log saying so. Re-listing is cheap and idempotent precisely because the claim
 * exists: the second pass costs one `select` and no model call.
 */

import { createServiceClient, isKillSwitchOn, getSetting } from '@agency/core';
import type {
  Contact,
  ContactUpdate,
  Db,
  Interaction,
  InteractionInsert,
  Json,
  Language,
  TaskInsert,
} from '@agency/core';
import { LlmError, call } from '@agency/core/llm';
import type { CallOpts, Trigger } from '@agency/core/llm';
import {
  GmailReadError,
  currentHistoryId,
  detectOptOut,
  getMessage,
  guessLanguage,
  listHistory,
  readGmailWatch,
  watchMailbox,
  writeGmailWatch,
} from '@agency/core/gmail-read';
import type { GmailAddress, GmailWatchState, InboundMessage } from '@agency/core/gmail-read';

import {
  buildClassifyPrompt,
  parseClassification,
  routeInbound,
  stageAfterRoute,
} from './inbox-classify.js';
import type { Classification, InboundClass, InboundRoute } from './inbox-classify.js';
import { REPLY_WORD_LIMIT, buildReplyPrompt, parseReplyDraft } from './inbox-reply-prompt.js';
import { isWithinWordLimit } from './followup-prompt.js';
import { loadStyleExamples } from './style-examples.js';
import type { StyleExample } from './style-examples.js';
import { immediatePush, sendPush } from './push.js';
import type { PushSender } from './push.js';
import { AlertOnce, redactEmails } from './send-queue-policy.js';

const AGENT = 'inbox';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The sweep interval — insurance, not the mechanism.
 *
 * The webhook is how mail is normally noticed. This is what covers a lost
 * notification, a Pub/Sub outage, and a worker that was redeploying when the
 * push arrived. It costs one `history.list` against an unchanged cursor, which
 * returns an empty history, and it is also where the `users.watch` renewal
 * happens — so there is no third job.
 */
export const INBOX_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Messages one run will *process*.
 *
 * One Haiku call and possibly one Sonnet call each, so this is a money ceiling
 * as much as a rate-limit one. Anything over it is left for the next tick: the
 * cursor is not advanced, and the pre-filter means the re-read costs one
 * `select` and nothing else.
 *
 * It is applied to the messages that are *not yet recorded*, and that ordering
 * is the whole point. Capping the raw listing instead — which is what this did
 * first — livelocks a burst bigger than one run: run one takes the first 25 and
 * holds the cursor, run two lists the same window, fills its 25 with the same
 * already-recorded ids, finds nothing to do, and the tail is never reached on
 * any run. The cap has to bound work, not listing, or it stops being a cap and
 * becomes a wall.
 */
export const MAX_MESSAGES_PER_RUN = 25;

/**
 * Message ids one run will *list* before it stops looking.
 *
 * A separate, larger ceiling from the one above, for a separate reason: this one
 * bounds the size of the pre-filter's `in (…)` list, which goes into a URL.
 * Gmail returns at most 100 records per page, so this is one page's worth, and a
 * backlog deeper than it is drained 25 at a time over successive sweeps.
 */
const MAX_HISTORY_IDS_PER_RUN = 100;

/**
 * How close to expiry a Gmail watch may get before it is renewed.
 *
 * Gmail expires a watch after seven days. A system whose webhook silently stops
 * after a week — with no error, no log line and no missing-mail alarm — is
 * exactly the failure this repo keeps arguing against, and one day of margin
 * means four sweeps a day get a chance to fix it before it happens.
 */
export const WATCH_RENEWAL_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * How long the kill switch may hold the cursor still before the operator is
 * told what it is about to cost.
 *
 * Gmail keeps roughly a week of history and less on a busy mailbox. While the
 * switch is on nothing is read, so the stored cursor stops moving and the
 * window between it and now grows by a day a day. Past the history horizon the
 * next sweep gets a `404`, `recoverLostCursor` anchors a fresh cursor, and
 * every message that arrived during the pause is gone from this system with no
 * way to get it back. Four days leaves three to act in.
 */
export const PAUSED_CURSOR_WARNING_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * How often a watch whose stored expiry is null may be re-registered.
 *
 * See `renewWatchIfNeeded`. One hour is far inside the seven-day expiry, so a
 * genuinely missing registration is fixed well before it matters, and far
 * outside the fifteen-minute sweep, so the loop it replaces cannot come back.
 */
export const WATCH_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * When `watchMailbox` was last called for a watch with no stored expiry.
 *
 * Process-local, like the alert gate: there is no column for it and inventing
 * one would mean writing a number into a field documented as Gmail's own expiry.
 */
let lastWatchAttemptMs = 0;

/** See the header. The shortest cadence interval in SPEC §4's table. */
export const REPLY_NEXT_TOUCH_DAYS = 3;

/** Thread turns loaded for the reply prompt. */
const THREAD_LIMIT = 10;

/**
 * `history.list` pages one run will follow.
 *
 * The listing ceiling normally stops the walk after one page — Gmail returns up
 * to 100 records a page and `MAX_HISTORY_IDS_PER_RUN` is 100. This bounds the
 * pathological case: pages that are almost entirely records Gmail's own filters
 * dropped, followed by another page token. Without it a single webhook delivery
 * could make an unbounded number of requests to somebody else's API, which is
 * exactly the shape of spend a public route must not have.
 */
const MAX_HISTORY_PAGES = 5;

/**
 * How many times one Gmail message is attempted before it is abandoned.
 *
 * See the header. Every attempt is one claim write and at most one Haiku call,
 * so three is three model calls in the worst case and forty-five minutes of
 * sweeps in the best. Higher would let a message that cannot be processed hold
 * the cursor — and therefore every message behind it — for hours.
 */
export const MAX_MESSAGE_ATTEMPTS = 3;

/**
 * Read failures that are about the mailbox rather than about one message.
 *
 * `auth` is a revoked or wrongly-scoped refresh token: `gmailRequest` forces a
 * token refresh on the first 401, so continuing the batch would mint one new
 * token per message against a credential that is already dead. `rate_limit` and
 * `network` are the same argument without the credential. All three are fixed by
 * time or by the operator, never by the next message.
 */
const HALTING_READ_KINDS: ReadonlySet<string> = new Set(['auth', 'rate_limit', 'network', 'config']);

/** Contact rows read for one sender address. See the header. */
const MAX_CONTACT_MATCHES = 20;

/** Haiku's output budget for a class, a confidence, a sentence and a language. */
const CLASSIFY_MAX_TOKENS = 400;

/** SPEC §7: the ladder is built and locked at 1 for v1. */
const MAX_AUTONOMY_LEVEL = 1;

export type InboxSummary = {
  /**
   * Message ids this run listed, including the ones it dropped as duplicates
   * and the ones it left for the next sweep. It is not `duplicate + classified +
   * silent + failed` on a run that hit the work ceiling, and that is the point:
   * the difference is the backlog.
   */
  considered: number;
  /** Already finished: dropped by the pre-filter or refused by the claim. */
  duplicate: number;
  classified: number;
  drafted: number;
  /** not_interested | spam | not_business, plus our own sends. */
  silent: number;
  failed: number;
  cursorAdvanced: boolean;
};

/**
 * The shape of `call()` from `@agency/core/llm`.
 *
 * Named so it can be injected. `llm.ts` deliberately has no transport seam of
 * its own — it is the one place an SDK is imported, and adding a fake HTTP layer
 * there would mean a second way to reach the API — so the seam has to be here,
 * and it is the only way to exercise the classify-and-draft path with no API
 * key. That is an addition to the contract's `RunInboxOptions`, not a change:
 * every field is optional and production passes none of them.
 */
export type ModelCall = <T>(opts: CallOpts) => Promise<T>;

export type RunInboxOptions = {
  /** Injectable for tests. Defaults to the service-role client. */
  db?: Db;
  /** Injectable for tests. Defaults to the moment the run starts. */
  now?: Date;
  /** `agent_runs.trigger`. */
  trigger?: Trigger;
  /** Injectable for tests. Defaults to `sendPush`. */
  push?: PushSender;
  /** Injectable for tests. Defaults to `call` from `@agency/core/llm`. */
  llm?: ModelCall;
};

function log(message: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), agent: AGENT, message, ...extra }));
}

/**
 * Per-process alert dedupe, borrowed from the send queue rather than reinvented.
 *
 * A sweep every fifteen minutes with an ungated alert files ninety-six cards a
 * day for one broken Gmail credential, and a queue full of identical cards is a
 * queue the operator stops reading — which is the outage this gate exists to
 * prevent, in the file that first needed it.
 */
const processAlerts = new AlertOnce();

/** Test seam: several cases in one file would otherwise share the gate. */
export function resetInboxAlerts(): void {
  processAlerts.reset();
  // The watch-renewal throttle is the same kind of process-local state and has
  // the same problem in a test file: one case's renewal would silently suppress
  // the next case's.
  lastWatchAttemptMs = 0;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * SPEC §8: "If an agent run errors, it retries once, then creates an alert task.
 * It never silently swallows the failure."
 *
 * The retry is argued away below `runInboxTick` — the fifteen-minute sweep is
 * the retry, and it is a better one than an immediate second attempt. The alert
 * is not optional and was missing: a run can fail before the per-message loop is
 * reached at all, and the two ways it does are both first-day states. A `403`
 * from `history.list` means `GMAIL_REFRESH_TOKEN` was minted for `gmail.send`
 * only, and a `settings.autonomy` row holding the wrong shape throws out of
 * `loadAutonomyLevel`. Either way the agent is dead every fifteen minutes,
 * `/health` is the only place that says so, and nobody looks at `/health` when
 * nothing appears to be wrong. A card on Today is where the operator is.
 *
 * Deduped on the message text rather than filed every sweep: a broken
 * credential is one condition, not ninety-six of them.
 */
export async function runInbox(options: RunInboxOptions = {}): Promise<InboxSummary> {
  const db = options.db ?? createServiceClient();

  const summary: InboxSummary = {
    considered: 0,
    duplicate: 0,
    classified: 0,
    drafted: 0,
    silent: 0,
    failed: 0,
    cursorAdvanced: false,
  };

  try {
    await runInboxBody(options, db, summary);
  } catch (error) {
    const message = redactEmails(error instanceof Error ? error.message : String(error));
    if (processAlerts.claim(`run:${message}`)) {
      await fileAlert(
        db,
        null,
        'The inbox agent could not run',
        `${message} No mail has been read since. The sweep tries again every fifteen minutes, ` +
          'so this clears itself once the cause is fixed.',
      );
    }
    throw error;
  }

  return summary;
}

async function runInboxBody(
  options: RunInboxOptions,
  db: Db,
  summary: InboxSummary,
): Promise<void> {
  const now = options.now ?? new Date();
  const trigger: Trigger = options.trigger ?? 'webhook';
  const push = options.push ?? sendPush;
  const llm: ModelCall = options.llm ?? call;

  const stored = await readGmailWatch(db);

  // Renewal first, so the very first run of a fresh install registers the watch
  // as well as storing a cursor — otherwise the webhook would not start working
  // until the sweep fifteen minutes later.
  const state = await renewWatchIfNeeded(db, stored, now);

  if (state === null) {
    // Bootstrap. Nothing has ever been read, so there is no window to have
    // missed and no alert to file: we start from here.
    const historyId = await currentHistoryId();
    await writeGmailWatch(db, {
      historyId,
      expiration: stored?.expiration ?? null,
      updatedAt: now.toISOString(),
    });
    summary.cursorAdvanced = true;
    log('stored the first mail cursor — nothing before now will be read', {
      history_id: historyId,
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // The kill switch, and why it is checked HERE and not at the top
  // ---------------------------------------------------------------------------
  //
  // SPEC §8 / PLAN §7 say the switch is checked at the top of every job, before
  // anything is read and long before anything is written, and every other job in
  // this repo does exactly that. This one has two Gmail calls in front of it, on
  // purpose, and the reason is that the switch used to lose the operator's mail.
  //
  // With the check first, a pause froze three things at once: no message was
  // classified (correct), the stored cursor never advanced (correct), and the
  // `users.watch` registration was never renewed (not correct — it is not a
  // decision about a customer, it is a subscription with a seven-day expiry).
  // So a switch left on for eight days expired the watch on day seven and blew
  // past Gmail's history horizon somewhere around day six. On the first sweep
  // after it came off, `listHistory` answered 404, `recoverLostCursor` anchored
  // a fresh cursor and filed a card saying that everything in the window had not
  // been read — and every message anybody had sent during the pause was gone.
  //
  // Neither call above contacts anybody, spends a model token or writes to a
  // contact. `renewWatchIfNeeded` re-registers a subscription on the operator's
  // own mailbox; the bootstrap branch anchors a cursor on a mailbox that has
  // never been read, which loses nothing because there was nothing behind it.
  // Everything the switch is actually about — reading messages, classifying
  // them, drafting at people — is on the other side of this return.
  if (await isKillSwitchOn(db)) {
    log('kill switch is on — no mail was read', { kill_switch: true });
    await warnIfCursorIsAging(db, state, now);
    return;
  }

  let walk: HistoryWalk;
  try {
    walk = await walkHistory(state.historyId);
  } catch (error) {
    if (error instanceof GmailReadError && error.kind === 'history_gone') {
      await recoverLostCursor(db, state, now);
      summary.cursorAdvanced = true;
      return;
    }
    throw error;
  }

  summary.considered = walk.messageIds.length;
  if (walk.messageIds.length === 0) {
    // The ordinary sweep outcome. The cursor still moves — Gmail's own historyId
    // advances on activity we filter out, and leaving it behind would make every
    // later list longer for no reason — *unless* the walk stopped early. Five
    // pages of nothing but our own sends with a page token still outstanding is
    // an empty batch that has not seen the end of the history, and advancing
    // past it discards whatever was on page six.
    await finishCursor(db, state, walk, now, summary);
    return;
  }

  const recorded = await loadRecordedMessages(db, walk.messageIds);
  const eligible: string[] = [];

  for (const id of walk.messageIds) {
    const row = recorded.get(id);
    // Never recorded, or recorded and unfinished with attempts left. See the
    // header: the claim is the attempt counter, not a headstone.
    if (row === undefined || (!row.classified && row.attempts < MAX_MESSAGE_ATTEMPTS)) {
      eligible.push(id);
      continue;
    }
    summary.duplicate += 1;
  }

  // The work ceiling, applied here rather than in the walk so that a backlog
  // drains 25 messages per sweep instead of re-reading the same 25 forever.
  const fresh = eligible.slice(0, MAX_MESSAGES_PER_RUN);
  if (eligible.length > fresh.length) {
    walk = { ...walk, capped: true };
    log('more new mail than one run processes — the rest is left for the next sweep', {
      new_messages: eligible.length,
      taken: fresh.length,
    });
  }

  if (fresh.length === 0) {
    // Every id in the window is accounted for. The cursor still only moves if
    // the walk reached the end of the history — the batch being all duplicates
    // says nothing about the messages the ceiling stopped us reading.
    await finishCursor(db, state, walk, now, summary);
    log('inbox run finished', { job: AGENT, trigger, ...summary });
    return;
  }

  // Loaded once for the whole run, which is what makes the cached prompt prefix
  // worth having across a burst (PLAN §2).
  const brain = await loadBrain(db);
  const autonomyLevel = await loadAutonomyLevel(db);
  const styleCache = new Map<Language, readonly StyleExample[]>();

  let halted: string | null = null;

  for (const messageId of fresh) {
    if (halted !== null) break;

    const existing = recorded.get(messageId) ?? null;
    // Set by `claimMessage` the moment the row is ours. What it decides is
    // whether the failure path still has to record the attempt: after the claim
    // the count is already written, before it there is nothing to bound the
    // retries with.
    const progress: MessageProgress = { claimed: false, message: null };
    const attemptsUsed = (existing?.attempts ?? 0) + 1;

    // PLAN §6 step 5 constraint 3, restated by `send-queue.ts` and true again
    // here: one bad message must cost one message. An unwrapped loop means a
    // single malformed email drops every other message in the batch, and the
    // cursor then does not advance, so the same bad message breaks the next run
    // too — a permanent stall with nothing in the log saying why.
    try {
      const outcome = await processMessage({
        db,
        messageId,
        brain,
        now,
        trigger,
        autonomyLevel,
        push,
        llm,
        styleCache,
        existing,
        progress,
      });

      if (outcome.kind === 'duplicate') {
        summary.duplicate += 1;
        continue;
      }
      if (outcome.kind === 'silent') {
        summary.silent += 1;
        log('nothing to do with a message', {
          gmail_message_id: messageId,
          reason: outcome.reason,
        });
        continue;
      }

      summary.classified += 1;
      if (outcome.drafted) summary.drafted += 1;
      // The three classes SPEC §5 handles without telling anybody: no draft, no
      // notification, and an `interactions` row as the only trace. Counted so a
      // morning of nothing but rejections is still visible as work done.
      if (!outcome.route.draftReply && outcome.route.notify === 'none') summary.silent += 1;

      log('classified', {
        gmail_message_id: messageId,
        contact_id: outcome.contactId,
        task_id: outcome.taskId,
        class: outcome.classification.class,
        confidence: outcome.classification.confidence,
        drafted: outcome.drafted,
        notified: outcome.notified,
      });
    } catch (error) {
      summary.failed += 1;
      const message = redactEmails(error instanceof Error ? error.message : String(error));
      const readKind = error instanceof GmailReadError ? error.kind : null;
      log('message failed', {
        gmail_message_id: messageId,
        error: message,
        gmail_error: readKind,
        attempt: attemptsUsed,
      });

      // Neither of these is a fault in the message, so neither may spend one of
      // its three attempts. A cost cap that lasts until midnight, or an hour of
      // Anthropic being down, would otherwise burn every attempt a message has
      // in forty-five minutes of sweeps and abandon a customer's email over a
      // condition that had nothing to do with it. The claim is handed back.
      if (
        error instanceof LlmError &&
        (error.kind === 'cost_cap' || error.kind === 'api_error') &&
        progress.message !== null
      ) {
        await releaseAttempt(db, progress.message, attemptsUsed);
      }

      if (error instanceof LlmError && error.kind === 'cost_cap') {
        // Thrown before anything was spent, and every remaining message would
        // fail identically. Stop rather than burn the rest of the run finding
        // that out, exactly as `followup.ts` does.
        halted = 'daily cost cap reached';
        if (processAlerts.claim('cost-cap')) {
          await fileAlert(db, null, 'The inbox agent stopped at the daily cost cap', message);
        }
        continue;
      }

      if (readKind !== null && HALTING_READ_KINDS.has(readKind)) {
        // A whole-mailbox condition. See the header: continuing costs one forced
        // token refresh, or one more request into a rate limit, per message, and
        // fills the queue with a card per message for one broken credential.
        // Nothing was claimed and no attempt is consumed — the message was never
        // really looked at, so the next sweep starts it from where it was.
        halted = `Gmail read failed (${readKind})`;
        if (processAlerts.claim(`gmail:${readKind}`)) {
          await fileAlert(
            db,
            null,
            'Mail could not be read from Gmail',
            `${message} The run stopped rather than repeating this for every message. ` +
              'Nothing has been lost: the sweep resumes from the same point every fifteen minutes.',
          );
        }
        continue;
      }

      // Before the claim there is no attempt count, so a message that fails here
      // every time would be fresh on every sweep forever, hold the cursor
      // forever, and eventually stop new mail being read at all. Recording the
      // attempt is what bounds it.
      if (!progress.claimed) {
        await recordFailedAttempt(db, messageId, existing, now, readKind ?? 'error');
      }

      // The LLM wrapper files its own alert after its retry, so a second one
      // here would put two cards in the queue for one failure.
      if (error instanceof LlmError) continue;

      const last = attemptsUsed >= MAX_MESSAGE_ATTEMPTS;
      const key = last ? `message:${messageId}:final` : `message:${messageId}`;
      if (processAlerts.claim(key)) {
        await fileAlert(
          db,
          null,
          last ? 'An inbound email was given up on' : 'An inbound email could not be processed',
          last
            ? `${message} Gmail message id ${messageId}. That was attempt ${attemptsUsed} of ` +
              `${MAX_MESSAGE_ATTEMPTS} and it will not be tried again. The message is on /inbox ` +
              'as unclassified — read it in Gmail and answer it by hand.'
            : `${message} Gmail message id ${messageId}. It will be tried again on the next ` +
              `sweep, up to ${MAX_MESSAGE_ATTEMPTS} attempts in total.`,
        );
      }
    }
  }

  await finishCursor(db, state, walk, now, summary, halted);
  log('inbox run finished', { job: AGENT, trigger, ...summary, halted });
}

/**
 * Move the cursor, or say why it stayed.
 *
 * One function for all three exits because the condition is the whole design and
 * it was previously written out three times, with the guard missing from two of
 * them. The cursor may only move when the run has seen the end of the history
 * *and* accounted for everything it found: a partial run that advanced it would
 * lose the messages it did not reach, permanently and silently, and the cost of
 * not advancing is one extra `select` on the next sweep.
 */
async function finishCursor(
  db: Db,
  state: GmailWatchState,
  walk: HistoryWalk,
  now: Date,
  summary: InboxSummary,
  halted: string | null = null,
): Promise<void> {
  if (summary.failed === 0 && halted === null && !walk.capped) {
    await advanceCursor(db, state, walk.historyId, now);
    summary.cursorAdvanced = true;
    return;
  }

  log('the mail cursor was left where it was', {
    failed: summary.failed,
    capped: walk.capped,
    halted,
  });
}

// ---------------------------------------------------------------------------
// The cursor and the watch
// ---------------------------------------------------------------------------

/**
 * Register or renew the Gmail watch when it is close to expiring.
 *
 * Failure here is logged and alerted but never stops the run: reading mail with
 * an expiring watch works perfectly, and refusing to read because the *next*
 * notification might not arrive would turn a future problem into a present one.
 *
 * Under `DRY_RUN` `watchMailbox` returns `historyId: null` — it is a Gmail
 * write and the house rule stubs it — which is why a null is never written over
 * a cursor we already have.
 */
async function renewWatchIfNeeded(
  db: Db,
  state: GmailWatchState | null,
  now: Date,
): Promise<GmailWatchState | null> {
  const expiring =
    state === null ||
    state.expiration === null ||
    state.expiration - now.getTime() < WATCH_RENEWAL_LEAD_MS;

  if (!expiring) return state;

  // A stored `expiration` of null is not the same as an expiring watch, and
  // treating it as one is a loop: `watchMailbox` returns a null expiration under
  // dry run by design, that null is written straight back, and the next sweep
  // reads it and renews again. Ninety-six sweeps a day, one `users.watch` POST
  // each, against the same mailbox, forever — a log line under dry run and a
  // real quota burn the day a live response arrives without the field. There is
  // nowhere honest to record "we tried" (the column means the watch's expiry,
  // not our last attempt), so the throttle is process-local: a restart tries
  // again immediately, which is what an operator fixing this would want.
  if (state !== null && state.expiration === null) {
    const since = now.getTime() - lastWatchAttemptMs;
    if (since < WATCH_RETRY_INTERVAL_MS) return state;
  }
  lastWatchAttemptMs = now.getTime();

  try {
    const result = await watchMailbox();
    const historyId = state?.historyId ?? result.historyId;

    if (historyId === null || historyId === '') {
      // First run under dry run: the watch is stubbed and gave us nothing to
      // start from. The bootstrap path takes it from `users.getProfile`.
      log('renewed the Gmail watch, with no cursor to store yet', { dry_run: result.dryRun });
      return null;
    }

    // `updatedAt` means "when the cursor was last moved", not "when this row was
    // last touched", so a renewal preserves it. It is the only record of how far
    // back a lost window goes, and the alert `recoverLostCursor` files names it:
    // stamping it here would make that sentence read "between now and now".
    const next: GmailWatchState = {
      historyId,
      expiration: result.expiration,
      updatedAt: state?.updatedAt ?? now.toISOString(),
    };
    await writeGmailWatch(db, next);
    log('renewed the Gmail watch', {
      dry_run: result.dryRun,
      expires_at: result.expiration === null ? null : new Date(result.expiration).toISOString(),
    });
    return next;
  } catch (error) {
    const message = redactEmails(error instanceof Error ? error.message : String(error));
    log('failed to renew the Gmail watch', { error: message });
    if (processAlerts.claim('watch-renewal')) {
      await fileAlert(
        db,
        null,
        'The Gmail watch could not be renewed',
        `${message} Gmail expires a watch after seven days, and when it does, new mail stops ` +
          'arriving with no other symptom. The sweep keeps reading in the meantime.',
      );
    }
    return state;
  }
}

/**
 * Has the cursor stood still long enough to be worth an alert?
 *
 * Pure, so the one number in it can be asserted without a database or a clock.
 * `updatedAt` is "when the cursor last moved", which under a pause is when the
 * pause started. A value that will not parse counts as aging: an unreadable
 * timestamp is not evidence that the window is safe.
 */
export function cursorIsAging(updatedAt: string | null, now: Date, limitMs: number): boolean {
  if (updatedAt === null) return false;
  const at = new Date(updatedAt).getTime();
  if (Number.isNaN(at)) return true;
  return now.getTime() - at >= limitMs;
}

/**
 * The card that says a pause is about to cost inbound mail.
 *
 * Filed only while the kill switch is on, and deduped per process, so an
 * ordinary paused afternoon files nothing and a week-long pause files one card
 * rather than three hundred and eighty-four.
 */
async function warnIfCursorIsAging(db: Db, state: GmailWatchState, now: Date): Promise<void> {
  if (!cursorIsAging(state.updatedAt, now, PAUSED_CURSOR_WARNING_MS)) return;
  if (!processAlerts.claim('paused-cursor-aging')) return;

  const days = Math.floor(PAUSED_CURSOR_WARNING_MS / (24 * 60 * 60 * 1000));
  await fileAlert(
    db,
    null,
    'The kill switch has been on long enough to start losing inbound mail',
    `No mail has been read for ${days} days or more because the kill switch is on. Gmail keeps ` +
      'about a week of history and then refuses to serve it, so everything that arrives from ' +
      'here on is at risk of never being read, classified or replied to. Turn the switch off in ' +
      '/brain, or accept the loss deliberately.',
  );
}

/**
 * The cursor was older than Gmail will serve.
 *
 * Gmail keeps roughly a week of history and less on a busy mailbox, and answers
 * `404` to anything older. The handling is deliberately not clever: take a fresh
 * cursor, process nothing, and say plainly what was lost.
 *
 * The alternative — walking the mailbox from the beginning — would classify and
 * draft replies to hundreds of months-old messages, filling the queue with work
 * that is stale and spending real money doing it. Losing the window and *saying
 * so* is the correct trade, and it is the same reasoning `followup.ts` uses when
 * it declines to draft rather than draft something hollow.
 */
async function recoverLostCursor(db: Db, state: GmailWatchState, now: Date): Promise<void> {
  const fresh = await currentHistoryId();
  await writeGmailWatch(db, {
    historyId: fresh,
    expiration: state.expiration,
    updatedAt: now.toISOString(),
  });

  log('the mail cursor was too old to use — a fresh one has been stored', {
    previous_updated_at: state.updatedAt,
    history_id: fresh,
  });

  await fileAlert(
    db,
    null,
    'The mail cursor was too old to use',
    `Gmail no longer keeps the history this system was reading from. Anything that arrived ` +
      `between ${state.updatedAt} and now has not been read, classified or replied to. ` +
      'Check Gmail by hand for anything from that window. Reading has resumed from now.',
  );
}

async function advanceCursor(
  db: Db,
  state: GmailWatchState,
  historyId: string | null,
  now: Date,
): Promise<void> {
  // Gmail sends no historyId on an empty page often enough that a null must not
  // become a cursor. Keeping the old one costs one longer list next time;
  // writing a null would cost the whole mailbox.
  const next = historyId ?? state.historyId;
  await writeGmailWatch(db, {
    historyId: next,
    expiration: state.expiration,
    updatedAt: now.toISOString(),
  });
}

type HistoryWalk = { messageIds: string[]; historyId: string | null; capped: boolean };

/**
 * Message ids added since the cursor, in arrival order, deduped and capped.
 *
 * `capped` means "this run did not see the end of the history", and it is what
 * stops the cursor moving: the next tick, or the fifteen-minute sweep, reads the
 * same window again and gets further. Note that the ceiling here is the listing
 * one — the work ceiling is applied by the caller, after the pre-filter has said
 * which of these are new. See `MAX_MESSAGES_PER_RUN`.
 */
async function walkHistory(startHistoryId: string): Promise<HistoryWalk> {
  const seen = new Set<string>();
  const messageIds: string[] = [];
  let pageToken: string | null = null;
  let historyId: string | null = null;
  let capped = false;

  for (let pages = 0; pages < MAX_HISTORY_PAGES; pages += 1) {
    const page = await listHistory({ startHistoryId, pageToken });
    if (page.historyId !== null) historyId = page.historyId;

    for (const id of page.messageIds) {
      if (seen.has(id)) continue;
      if (messageIds.length >= MAX_HISTORY_IDS_PER_RUN) {
        capped = true;
        break;
      }
      seen.add(id);
      messageIds.push(id);
    }

    // Stopping at the ceiling means there is almost certainly more to read, so
    // the caller must not advance the cursor. The next tick drains the rest.
    if (capped) break;
    pageToken = page.nextPageToken;
    if (pageToken === null) break;
  }

  // Either the ceiling stopped us or a page token is still outstanding: both
  // mean there is more history than this run took, and the cursor must stay put.
  if (pageToken !== null) capped = true;

  return { messageIds, historyId, capped };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** SPEC §4 step 2's "the whole brain", loaded once per run. */
async function loadBrain(db: Db): Promise<Record<string, string>> {
  const { data, error } = await db.from('brain').select('key, value');
  if (error) throw new Error(`Failed to load brain: ${redactEmails(error.message)}`);

  const brain: Record<string, string> = {};
  for (const row of data ?? []) brain[row.key] = row.value;
  return brain;
}

/**
 * SPEC §7: read from settings so the ladder is real, then clamped, so raising
 * the setting cannot make this agent send.
 */
async function loadAutonomyLevel(db: Db): Promise<number> {
  const autonomy = await getSetting(db, 'autonomy');
  return Math.min(autonomy.draft_email, MAX_AUTONOMY_LEVEL);
}

/**
 * What is already on record for each of these Gmail message ids.
 *
 * One query for the whole batch. This is the cheap half of the dedupe — it
 * saves a `messages.get` per duplicate — and it is *not* the safe half: two
 * runs can both pass it. The claim is what makes it correct.
 *
 * `attempts` is missing rather than zero on a row this code did not write, and
 * the two must not be confused: a missing count means "not ours to retake", a
 * zero would mean "help yourself". Missing is read as exhausted for that reason.
 */
type RecordedMessage = {
  interactionId: string | null;
  /** `meta.attempts`, or `MAX_MESSAGE_ATTEMPTS` when the row is not ours. */
  attempts: number;
  /** A class has been written, so the message is finished. */
  classified: boolean;
};

async function loadRecordedMessages(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, RecordedMessage>> {
  const recorded = new Map<string, RecordedMessage>();
  if (ids.length === 0) return recorded;

  const { data, error } = await db
    .from('interactions')
    .select('id, meta')
    .in('meta->>gmail_message_id', [...ids]);

  if (error) throw new Error(`Failed to check for recorded messages: ${redactEmails(error.message)}`);

  for (const row of data ?? []) {
    const meta = row.meta;
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) continue;
    const fields = meta as Record<string, unknown>;

    const id = fields['gmail_message_id'];
    if (typeof id !== 'string' || id === '') continue;

    const attempts = fields['attempts'];
    const counted =
      typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 0
        ? attempts
        : MAX_MESSAGE_ATTEMPTS;

    // Two rows for one message id cannot happen — the unique partial index is
    // what this whole design rests on — but if one ever did, the safe reading is
    // the one that does no work twice.
    const seen = recorded.get(id);
    recorded.set(id, {
      interactionId: typeof row.id === 'string' ? row.id : null,
      attempts: seen === undefined ? counted : Math.max(seen.attempts, counted),
      classified: (seen?.classified ?? false) || typeof fields['class'] === 'string',
    });
  }

  return recorded;
}

/**
 * The rest of this Gmail thread, oldest first.
 *
 * Scoped by `meta->>gmail_thread_id` rather than by contact, because the reply
 * needs *this conversation* and a chatty contact's unrelated thread from March
 * is noise the drafter would try to answer.
 */
async function loadThread(
  db: Db,
  threadId: string | null,
  excludeInteractionId: string | null,
): Promise<Interaction[]> {
  if (threadId === null || threadId === '') return [];

  const { data, error } = await db
    .from('interactions')
    .select('*')
    .eq('meta->>gmail_thread_id', threadId)
    .order('occurred_at', { ascending: false })
    .limit(THREAD_LIMIT + 1);

  if (error) throw new Error(`Failed to load the thread: ${redactEmails(error.message)}`);

  return (data ?? []).filter((row) => row.id !== excludeInteractionId).slice(0, THREAD_LIMIT);
}

/**
 * The operator's own edited drafts, in the language being replied in.
 *
 * Cached per run rather than per message: a burst of five Greek messages is one
 * query, not five, and the answer cannot change inside a run.
 *
 * Never fatal, and the empty result is cached on failure — the same policy
 * `followup.ts` applies and the one `style-examples.ts` states as the contract.
 * A style hint is a nicety; the reply to a customer's question is not. This path
 * has a sharper version of that argument than the follow-up agent does: a
 * failure here would fail the message *after* the claim, so a step 9 query
 * having a bad minute would cost a real inbound reply two of its three attempts.
 */
async function styleExamplesFor(
  db: Db,
  language: Language,
  cache: Map<Language, readonly StyleExample[]>,
): Promise<readonly StyleExample[]> {
  const cached = cache.get(language);
  if (cached !== undefined) return cached;

  let examples: readonly StyleExample[] = [];
  try {
    examples = await loadStyleExamples(db, language);
  } catch (error) {
    log('could not load style examples — drafting without them', {
      language,
      error: redactEmails(error instanceof Error ? error.message : String(error)),
    });
  }

  cache.set(language, examples);
  return examples;
}

// ---------------------------------------------------------------------------
// One message
// ---------------------------------------------------------------------------

type MessageOutcome =
  | { kind: 'duplicate' }
  | { kind: 'silent'; reason: string }
  | {
      kind: 'classified';
      classification: Classification;
      route: InboundRoute;
      contactId: string;
      taskId: string | null;
      drafted: boolean;
      notified: boolean;
    };

/**
 * What the loop's catch needs to know about how far a message got.
 *
 * `claimed` decides whether the failure path still has to record the attempt;
 * `message` is kept so an attempt can be handed back with the row's `meta`
 * rewritten in full rather than patched.
 */
type MessageProgress = { claimed: boolean; message: InboundMessage | null };

type ProcessArgs = {
  db: Db;
  messageId: string;
  brain: Record<string, string>;
  now: Date;
  trigger: Trigger;
  autonomyLevel: number;
  push: PushSender;
  llm: ModelCall;
  styleCache: Map<Language, readonly StyleExample[]>;
  /** The unfinished row an earlier attempt left, or null on a first attempt. */
  existing: RecordedMessage | null;
  /** Written to as the message is taken. See the loop's catch. */
  progress: MessageProgress;
};

async function processMessage(args: ProcessArgs): Promise<MessageOutcome> {
  const { db, messageId, now, existing } = args;
  const attempts = (existing?.attempts ?? 0) + 1;

  let message: InboundMessage;
  try {
    message = await getMessage(messageId);
  } catch (error) {
    if (error instanceof GmailReadError && error.kind === 'not_found') {
      // Deleted from the mailbox between the history listing and the read.
      // Retrying cannot produce it, and counting it as a failure would hold the
      // cursor over a message that no longer exists — which stalls every message
      // behind it until Gmail expires the history a week later.
      // One card per process, not one per message: clearing a screen of spam
      // from a phone while the sweep runs is twenty-five of these at once, and a
      // queue of twenty-five identical cards is a queue nobody reads. Every
      // occurrence is still in the log with its id.
      if (processAlerts.claim('message-gone')) {
        await fileAlert(
          db,
          null,
          'A message was gone before it could be read',
          `Gmail listed message id ${messageId} and then answered 404 for it, which normally ` +
            'means it was deleted in the seconds in between. It has not been read or classified ' +
            'and it will not be tried again. Any further ones today are in the worker log only.',
        );
      }
      return { kind: 'silent', reason: 'message_gone' };
    }
    throw error;
  }

  // Our own sends re-enter the history. Left unchecked they would become
  // inbound interactions, and the operator's own address would become a contact
  // the agent then writes follow-ups to.
  if (message.isOwnMessage) return { kind: 'silent', reason: 'own_message' };

  const sender = senderAddress(message.from);
  if (sender === null) {
    // No usable From header. The row is still claimed so the message is not
    // re-read on every sweep for the rest of the project's life, and so it is
    // visible on /inbox as something that arrived and was decided about.
    const claim = await claimMessage(db, null, message, now, existing, attempts);
    if (claim.kind === 'duplicate') return { kind: 'duplicate' };
    args.progress.claimed = true;
    args.progress.message = message;
    const unattributable: Classification = {
      class: 'not_business',
      confidence: 'high',
      reason: 'The message carried no usable sender address, so there is nobody to reply to.',
      language: 'el',
    };
    await writeClassificationMeta(
      db,
      claim.interactionId,
      message,
      unattributable,
      now,
      null,
      attempts,
    );
    return { kind: 'silent', reason: 'no_sender' };
  }

  const match = await matchOrCreateContact(db, sender, message, now);
  const contact = match.contact;

  // The claim. Everything expensive is on the other side of it.
  const claim = await claimMessage(db, contact.id, message, now, existing, attempts);
  if (claim.kind === 'duplicate') return { kind: 'duplicate' };
  args.progress.claimed = true;
  args.progress.message = message;

  const classification = await classify(args, contact, message);
  const route = routeInbound(classification.class);

  // The route is applied before the class is written, and the order is the
  // difference between an opt-out that survives a bad minute on the database and
  // one that does not. Writing the class first marks the message finished — the
  // next sweep reads it as done and never comes back — so a `contacts` update
  // that failed after it would mean `not_interested` was recorded and
  // `do_not_contact` never set, on a contact the follow-up agent then keeps
  // writing to. This way round, a failure leaves the row unclassified, which is
  // exactly what the pre-filter offers to the next run.
  await applyRoute(db, match, route, now);

  // SPEC §8's `do_not_contact` is permanent and checked wherever a message
  // might be produced. Drafting a reply to somebody who opted out is the one
  // mistake in this file with a legal edge, so the class does not get a vote —
  // and neither does which of their duplicate rows the query returned first.
  const mayDraft = route.draftReply && !match.optedOut;

  let taskId: string | null = null;
  if (mayDraft) {
    taskId = await draftReply(args, contact, message, classification, claim.interactionId, attempts);
  }

  // Same argument as the route, one step further along: `draftReply` writes the
  // class itself the moment the task row exists, and this covers every path that
  // filed no task. Either way the class lands last, so "has a class" means "was
  // seen all the way through" and nothing else.
  if (taskId === null) {
    await writeClassificationMeta(
      db,
      claim.interactionId,
      message,
      classification,
      now,
      null,
      attempts,
    );
  }

  let notified = false;
  if (route.notify === 'immediate') {
    notified = await notify(args, classification.class);
  }

  return {
    kind: 'classified',
    classification,
    route,
    contactId: contact.id,
    taskId,
    drafted: taskId !== null,
    notified,
  };
}

/**
 * The class, from a free deterministic check or from Haiku.
 *
 * `detectOptOut` runs first and, when it matches, no model is called at all.
 * The compliance footer this system appends to every outbound message promises
 * that replying STOP or ΔΙΑΓΡΑΦΗ works; a model call is not allowed to be the
 * thing that decides whether a legal opt-out was honoured, and a model that is
 * down, rate-limited or over the cost cap must not turn an opt-out into a
 * marketing reply.
 */
async function classify(
  args: ProcessArgs,
  contact: Contact,
  message: InboundMessage,
): Promise<Classification> {
  if (detectOptOut(message.body)) {
    return {
      class: 'not_interested',
      confidence: 'high',
      reason:
        'The message is a bare opt-out. It was matched by the opt-out check before any model ' +
        'was called, and the contact has been closed and marked do-not-contact.',
      language: contact.language ?? guessLanguage(message.body),
    };
  }

  const prompt = buildClassifyPrompt({ brain: args.brain, contact, message });

  const raw = await args.llm<unknown>({
    agent: AGENT,
    trigger: args.trigger,
    model: 'claude-haiku-4-5',
    system: prompt.system,
    user: prompt.user,
    schema: prompt.schema,
    maxTokens: CLASSIFY_MAX_TOKENS,
    contactId: contact.id,
  });

  const parsed = parseClassification(raw);
  if (!parsed.ok) {
    // Thrown rather than returned: it belongs in `failed`, the per-message catch
    // files the alert, and `call()` has already written the offending output to
    // `agent_runs` so it is recoverable.
    throw new Error(`Classifier output unusable: ${parsed.problem}`);
  }
  return parsed.classification;
}

/**
 * The Sonnet draft and the pending task. Returns the task id, or null when
 * nothing was filed.
 */
async function draftReply(
  args: ProcessArgs,
  contact: Contact,
  message: InboundMessage,
  classification: Classification,
  interactionId: string | null,
  attempts: number,
): Promise<string | null> {
  const { db, now } = args;

  const thread = await loadThread(db, message.threadId, interactionId);
  const styleExamples = await styleExamplesFor(db, classification.language, args.styleCache);

  const prompt = buildReplyPrompt({
    brain: args.brain,
    contact,
    message,
    classification,
    thread,
    styleExamples,
  });

  const raw = await args.llm<unknown>({
    agent: AGENT,
    trigger: args.trigger,
    model: 'claude-sonnet-5',
    system: prompt.system,
    user: prompt.user,
    schema: prompt.schema,
    contactId: contact.id,
  });

  const parsed = parseReplyDraft(raw);
  if (!parsed.ok) throw new Error(`Reply draft unusable: ${parsed.problem}`);
  const draft = parsed.draft;

  // Recorded on the card rather than thrown away, on the same reasoning
  // `followup-select.ts` gives: an over-long draft is a message the operator can
  // trim in ten seconds, and discarding it means either no reply this morning or
  // a second Sonnet call to be told the same thing.
  const overLong = !isWithinWordLimit(draft.body, REPLY_WORD_LIMIT);

  const reasoning = [
    classification.reason,
    draft.reason,
    overLong ? `The draft is over the ${REPLY_WORD_LIMIT}-word limit — trim it before sending.` : null,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ');

  const task: TaskInsert = {
    agent: AGENT,
    type: 'draft_email',
    contact_id: contact.id,
    title: `Reply: ${contactLabel(contact)}`,
    reasoning,
    draft_subject: draft.subject === '' ? replySubject(message.subject) : draft.subject,
    draft_body: draft.body,
    status: 'pending',
    autonomy_level: args.autonomyLevel,
  };

  const { data, error } = await db.from('tasks').insert(task).select('id').maybeSingle();
  if (error) throw new Error(`Failed to create the reply task: ${redactEmails(error.message)}`);

  const taskId = data?.id ?? null;

  if (interactionId !== null && taskId !== null) {
    await writeClassificationMeta(db, interactionId, message, classification, now, taskId, attempts);
  }

  await pushNextTouch(db, contact, now);

  return taskId;
}

/**
 * The immediate push for the two hot classes.
 *
 * The payload is built by `immediatePush` in `push.ts` rather than here, so the
 * immediate/deferred rule and its wording exist once. It carries counts and
 * classes only — never a name, an address, a subject or a body — because the
 * exposure is a lock screen in a café and the browser's notification store on
 * disk, not the transport, which is already end to end encrypted.
 *
 * A class with no immediate payload is not dropped: it is deferred to the
 * digest, which counts pending tasks and therefore picks it up for free. This
 * function is only reached when the route says `immediate`, so the null branch
 * is a disagreement between the two tables rather than an ordinary outcome, and
 * it is logged as one.
 *
 * `sendPush` never throws by contract; it is wrapped anyway, because a push
 * failure must not cost a message that was otherwise processed correctly. The
 * morning's drafts exist whether or not the phone buzzed.
 */
async function notify(args: ProcessArgs, cls: InboundClass): Promise<boolean> {
  const payload = immediatePush(cls);
  if (payload === null) {
    log('no immediate payload for a class the route wants to notify about', { class: cls });
    return false;
  }

  try {
    await args.push(payload);
    return true;
  } catch (error) {
    log('the immediate push failed', {
      class: cls,
      error: redactEmails(error instanceof Error ? error.message : String(error)),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

function senderAddress(from: GmailAddress | null): GmailAddress | null {
  if (from === null) return null;
  const email = typeof from.email === 'string' ? from.email.trim().toLowerCase() : '';
  if (email === '' || !email.includes('@')) return null;
  return { name: from.name, email };
}

/**
 * Every contact row for one address, plus the two facts read across all of them.
 *
 * `contact` is the row the conversation is attributed to; `duplicateIds` are the
 * others; `optedOut` is true if *any* of them says so. See the header for why
 * that is not the same as reading it off `contact`.
 */
type SenderMatch = {
  contact: Contact;
  duplicateIds: string[];
  optedOut: boolean;
};

/**
 * Which of several rows for one address the conversation belongs to.
 *
 * Postgres gives no ordering guarantee without an `order by`, so before this the
 * answer was whichever row the planner returned first — meaning a contact could
 * be attributed to their live row on Monday and to a stale duplicate on Tuesday,
 * with the reply drafted from the wrong history. The rule here is arbitrary but
 * it is *fixed*: a row that is not closed beats one that is, and the oldest row
 * wins after that because it is the one carrying the history. Ties break on id
 * so the answer never depends on the query plan.
 */
function chooseContact(rows: readonly Contact[]): Contact | undefined {
  const ranked = [...rows].sort((a, b) => {
    const closed = Number(a.stage === 'lost') - Number(b.stage === 'lost');
    if (closed !== 0) return closed;
    const created = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
    if (created !== 0) return created;
    return String(a.id).localeCompare(String(b.id));
  });
  return ranked[0];
}

/**
 * Find the contact who sent this, or create one.
 *
 * The lookup is exact first and case-insensitive second, and the second result
 * is re-checked in code. That is not belt and braces: PostgREST's `ilike` has no
 * escape syntax, and `_` — which is common in real addresses — is a wildcard, so
 * `maria_k@example.gr` would otherwise match `mariaXk@example.gr` and the reply
 * would go to a stranger. The pattern can only produce *extra* rows, never
 * fewer, so folding and comparing in code removes the whole class of mismatch.
 *
 * Both lookups read up to `MAX_CONTACT_MATCHES` rows rather than one. There is
 * no unique index on `contacts.email` and nothing on the create path checks for
 * an existing address, so duplicates exist; `limit(1)` was choosing between them
 * at random, and one of the things it was choosing between was whether this
 * person had opted out.
 */
async function matchOrCreateContact(
  db: Db,
  sender: GmailAddress,
  message: InboundMessage,
  now: Date,
): Promise<SenderMatch> {
  const exact = await db
    .from('contacts')
    .select('*')
    .eq('email', sender.email)
    .limit(MAX_CONTACT_MATCHES);
  if (exact.error) throw new Error(`Failed to look up the sender: ${redactEmails(exact.error.message)}`);

  let matches = exact.data ?? [];

  if (matches.length === 0) {
    const folded = await db
      .from('contacts')
      .select('*')
      .ilike('email', sender.email)
      .limit(MAX_CONTACT_MATCHES);
    if (folded.error) throw new Error(`Failed to look up the sender: ${redactEmails(folded.error.message)}`);
    matches = (folded.data ?? []).filter(
      (row) => typeof row.email === 'string' && row.email.trim().toLowerCase() === sender.email,
    );
  }

  const chosen = chooseContact(matches);
  if (chosen !== undefined) {
    if (matches.length > 1) {
      log('this address is on more than one contact row', {
        contact_id: chosen.id,
        rows: matches.length,
      });
    }
    return {
      contact: chosen,
      duplicateIds: matches.filter((row) => row.id !== chosen.id).map((row) => row.id),
      optedOut: matches.some((row) => row.do_not_contact === true),
    };
  }

  const insert = {
    email: sender.email,
    name: sender.name,
    language: guessLanguage(message.body),
    source: 'inbound' as const,
    stage: 'new' as const,
    stage_changed_at: now.toISOString(),
    tags: [],
  };

  const { data, error } = await db.from('contacts').insert(insert).select('*').maybeSingle();

  if (error !== null) {
    // `contacts_email_unique` (migration 20260803160000) makes one row per
    // address a database fact rather than a convention, which means this insert
    // now has a losing branch it did not have before: two messages from the same
    // new sender in one batch, or a webhook delivery racing the sweep. The
    // winner's row is the answer — the same answer this function would have
    // given a moment later — so it is read back rather than treated as a
    // failure. `claimMessage` is the thing that decides which of the two
    // messages is processed, and it is downstream of this.
    if (isUniqueViolation(error)) {
      const retry = await db
        .from('contacts')
        .select('*')
        .ilike('email', sender.email)
        .limit(MAX_CONTACT_MATCHES);
      if (retry.error) {
        throw new Error(`Failed to look up the sender: ${redactEmails(retry.error.message)}`);
      }
      const raced = chooseContact(
        (retry.data ?? []).filter(
          (row) => typeof row.email === 'string' && row.email.trim().toLowerCase() === sender.email,
        ),
      );
      if (raced !== undefined) {
        log('another delivery created this contact first', { contact_id: raced.id });
        return { contact: raced, duplicateIds: [], optedOut: raced.do_not_contact === true };
      }
    }
    throw new Error(`Failed to create the contact: ${redactEmails(error.message)}`);
  }

  if (data === null) throw new Error('The contact was created but not returned.');

  log('created a contact from an inbound message', { contact_id: data.id, source: 'inbound' });
  return { contact: data, duplicateIds: [], optedOut: data.do_not_contact === true };
}

/**
 * Apply the routing table to the contact row.
 *
 * `closeAs` and `promoteTo` are resolved by `stageAfterRoute`, which holds the
 * never-demote guard and is tested there. `do_not_contact` is only ever set,
 * never cleared — SPEC §8 says it is permanent, and an agent that could clear it
 * would be an agent that could un-honour an opt-out.
 *
 * **An opt-out is written to every row that carries the address**, not only to
 * the one the conversation was attributed to. A person who replies STOP has
 * opted out; that they exist twice in the database is our filing problem, and
 * leaving the second row contactable would let the follow-up agent write to them
 * next week. The stage change is not spread the same way: stage is about one
 * conversation, and there is no basis for moving a row this message was not
 * about.
 *
 * **This throws, and that is deliberate.** It is the one write in the per-message
 * sequence whose failure changes what the system is allowed to do next, so it
 * must count as a failed message and consume an attempt — which is what gets it
 * retried on the next sweep. `writeClassificationMeta` and `pushNextTouch` both
 * log and continue, because neither of them can let a message leave.
 */
async function applyRoute(
  db: Db,
  match: SenderMatch,
  route: InboundRoute,
  now: Date,
): Promise<void> {
  const contact = match.contact;
  const update: ContactUpdate = {};

  const stage = stageAfterRoute(contact.stage, route);
  if (stage !== null) {
    update.stage = stage;
    update.stage_changed_at = now.toISOString();
    // The old date belonged to the old stage, so a stage change re-dates the
    // contact — and this is the one place allowed to pull a date *in*.
    // `pushNextTouch` only ever pushes out, which is right when nothing about
    // the contact changed, and wrong the moment it does: a dormant lead who
    // writes "yes, let's do it" is promoted to `replied` here and would
    // otherwise keep the ninety-day heartbeat `followup.ts` gave them when they
    // went quiet. The warmest contact in the pipeline, scheduled for a nudge in
    // three months. `REPLY_NEXT_TOUCH_DAYS` is the `replied` step-0 interval
    // from SPEC §4's table, which is what the cadence would compute anyway.
    if (!route.doNotContact) {
      update.next_touch_at = new Date(
        now.getTime() + REPLY_NEXT_TOUCH_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
    }
  }
  if (route.doNotContact && contact.do_not_contact !== true) {
    update.do_not_contact = true;
    // A closed contact has no next touch. Leaving one behind means the morning
    // agent selects them, screens them out and logs a skip every day forever.
    update.next_touch_at = null;
  }

  if (Object.keys(update).length > 0) {
    const { error } = await db.from('contacts').update(update).eq('id', contact.id);
    if (error) throw new Error(`Failed to apply the route to the contact: ${redactEmails(error.message)}`);

    log('applied the inbound route', {
      contact_id: contact.id,
      stage: update.stage ?? null,
      do_not_contact: update.do_not_contact ?? null,
    });
  }

  if (!route.doNotContact || match.duplicateIds.length === 0) return;

  const { error } = await db
    .from('contacts')
    .update({ do_not_contact: true, next_touch_at: null })
    .in('id', match.duplicateIds);
  if (error) {
    throw new Error(`Failed to close the duplicate contact rows: ${redactEmails(error.message)}`);
  }

  log('closed duplicate rows for the same address', { rows: match.duplicateIds.length });
}

/**
 * Hold the follow-up agent off a conversation that is live.
 *
 * See the header: `followup.ts` only skips a contact who has a pending
 * *follow-up* draft, so without this the morning run drafts a cold nudge at
 * somebody we replied to yesterday. Only ever pushed out, never pulled in — a
 * contact already scheduled further away keeps their date.
 */
async function pushNextTouch(db: Db, contact: Contact, now: Date): Promise<void> {
  const floor = new Date(now.getTime() + REPLY_NEXT_TOUCH_DAYS * 24 * 60 * 60 * 1000);
  const current = contact.next_touch_at === null ? null : new Date(contact.next_touch_at);

  if (current !== null && Number.isFinite(current.getTime()) && current >= floor) return;

  const { error } = await db
    .from('contacts')
    .update({ next_touch_at: floor.toISOString() })
    .eq('id', contact.id);

  if (error) {
    // Not fatal. The draft exists and the operator can see it; the cost is one
    // possible duplicate card tomorrow morning.
    log('failed to push the next touch out', {
      contact_id: contact.id,
      error: redactEmails(error.message),
    });
  }
}

// ---------------------------------------------------------------------------
// The interactions row — the claim
// ---------------------------------------------------------------------------

type ClaimResult = { kind: 'claimed'; interactionId: string | null } | { kind: 'duplicate' };

/**
 * The `meta` object, built once so the claim and the classification cannot drift.
 *
 * A data contract with the `/inbox` page (contract §8.6): every field exists
 * from the first write, with nulls where the classification has not happened
 * yet, so a worker that died between the claim and the classify is visible as
 * *unclassified* rather than as nothing at all. `attempts` and `read_error` were
 * added with the retry bound; both are additive and `readInboundMeta` ignores
 * what it does not know about.
 */
function inboundMeta(fields: {
  messageId: string;
  threadId: string | null;
  rfcMessageId: string | null;
  classification: Classification | null;
  taskId: string | null;
  classifiedAt: string | null;
  attempts: number;
  readError: string | null;
}): Record<string, Json> {
  return {
    gmail_message_id: fields.messageId,
    gmail_thread_id: fields.threadId,
    rfc_message_id: fields.rfcMessageId,
    class: fields.classification?.class ?? null,
    confidence: fields.classification?.confidence ?? null,
    reason: fields.classification?.reason ?? null,
    task_id: fields.taskId,
    classified_at: fields.classifiedAt,
    attempts: fields.attempts,
    read_error: fields.readError,
  };
}

/**
 * Take this message, by inserting the `interactions` row or by taking over the
 * unfinished one an earlier attempt left behind.
 *
 * Written before the model is called, so a concurrent delivery loses the race
 * at the unique index rather than at a second invoice. The retake keeps that
 * property with a compare-and-swap on the attempt count: the update only matches
 * while `meta.attempts` still holds the value this run read, so of two callers
 * that both saw attempt 1, exactly one writes attempt 2 and the other is told it
 * is a duplicate — before either of them has called a model.
 */
async function claimMessage(
  db: Db,
  contactId: string | null,
  message: InboundMessage,
  now: Date,
  existing: RecordedMessage | null,
  attempts: number,
): Promise<ClaimResult> {
  const meta = inboundMeta({
    messageId: message.id,
    threadId: message.threadId,
    rfcMessageId: message.rfcMessageId,
    classification: null,
    taskId: null,
    classifiedAt: null,
    attempts,
    readError: null,
  });

  const columns = {
    contact_id: contactId,
    direction: 'in' as const,
    channel: 'email' as const,
    subject: message.subject,
    body: message.body,
    occurred_at: message.receivedAt || now.toISOString(),
    meta,
  };

  if (existing !== null && existing.interactionId !== null) {
    const { data, error } = await db
      .from('interactions')
      .update(columns)
      .eq('id', existing.interactionId)
      .eq('meta->>attempts', String(existing.attempts))
      .select('id')
      .maybeSingle();

    if (error !== null) {
      throw new Error(`Failed to take over the recorded message: ${redactEmails(error.message)}`);
    }
    // Nothing matched: the row's attempt count moved under us, so somebody else
    // is holding this message.
    if (data === null) return { kind: 'duplicate' };
    return { kind: 'claimed', interactionId: existing.interactionId };
  }

  const row: InteractionInsert = columns;
  const { data, error } = await db.from('interactions').insert(row).select('id').maybeSingle();

  if (error !== null) {
    if (isUniqueViolation(error)) return { kind: 'duplicate' };
    throw new Error(`Failed to record the message: ${redactEmails(error.message)}`);
  }

  return { kind: 'claimed', interactionId: data?.id ?? null };
}

/**
 * Hand the claim back, without giving up the row.
 *
 * The attempt count goes back to what it was before this run took the message,
 * so a condition that was never about this message — the daily cost cap, a model
 * outage — does not spend one of its three lives. The row itself stays: it is
 * still the dedupe key, it is still what `/inbox` shows as unclassified, and
 * deleting it would open the duplicate-charge window the claim exists to close.
 *
 * Best-effort. Failing to roll the count back costs the message one attempt,
 * which is the behaviour we had before and not worth failing the run over.
 */
async function releaseAttempt(
  db: Db,
  message: InboundMessage,
  attemptsUsed: number,
): Promise<void> {
  // The whole object is rewritten rather than patched, for the reason
  // `writeClassificationMeta` gives: a read-modify-write against `jsonb` is a
  // race with nothing to arbitrate it, and writing `{ attempts: n }` alone would
  // replace the column and take the dedupe key with it.
  const meta = inboundMeta({
    messageId: message.id,
    threadId: message.threadId,
    rfcMessageId: message.rfcMessageId,
    classification: null,
    taskId: null,
    classifiedAt: null,
    attempts: attemptsUsed - 1,
    readError: null,
  });

  try {
    const { error } = await db
      .from('interactions')
      .update({ meta })
      .eq('meta->>gmail_message_id', message.id)
      .eq('meta->>attempts', String(attemptsUsed));
    if (error !== null) throw new Error(error.message);
  } catch (error) {
    log('failed to hand back the attempt on a message', {
      gmail_message_id: message.id,
      error: redactEmails(error instanceof Error ? error.message : String(error)),
    });
  }
}

/**
 * Record an attempt at a message that could not be claimed.
 *
 * The message never became an `InboundMessage` — Gmail refused the read, or the
 * lookup that has to happen before the claim failed — so there is nothing to put
 * in `subject` or `body` and the row says so. See the header for why the row
 * exists at all: it is the only thing that can bound the retries of a message
 * that fails before the claim, and without a bound that one id holds the cursor,
 * and therefore every message behind it, forever.
 *
 * Best-effort by construction. If this write fails the cursor stays where it is
 * and the next sweep tries the whole thing again, which is the same outcome the
 * old code had and no worse.
 */
async function recordFailedAttempt(
  db: Db,
  messageId: string,
  existing: RecordedMessage | null,
  now: Date,
  readError: string,
): Promise<void> {
  const attempts = (existing?.attempts ?? 0) + 1;
  const meta = inboundMeta({
    messageId,
    threadId: null,
    rfcMessageId: null,
    classification: null,
    taskId: null,
    classifiedAt: null,
    attempts,
    readError,
  });

  try {
    if (existing !== null && existing.interactionId !== null) {
      const { error } = await db
        .from('interactions')
        .update({ meta })
        .eq('id', existing.interactionId)
        .eq('meta->>attempts', String(existing.attempts));
      if (error !== null) throw new Error(error.message);
      return;
    }

    const row: InteractionInsert = {
      contact_id: null,
      direction: 'in',
      channel: 'email',
      subject: null,
      body: null,
      occurred_at: now.toISOString(),
      meta,
    };
    const { error } = await db.from('interactions').insert(row);
    // A unique violation means another delivery recorded it first, which is the
    // outcome we wanted anyway.
    if (error !== null && !isUniqueViolation(error)) throw new Error(error.message);
  } catch (error) {
    log('failed to record the attempt at an unreadable message', {
      gmail_message_id: messageId,
      error: redactEmails(error instanceof Error ? error.message : String(error)),
    });
  }
}

/**
 * Postgres `23505`, however PostgREST chose to report it.
 *
 * The code is checked first because it is the reliable signal; the message text
 * is checked as well because a driver or a proxy in front of PostgREST can drop
 * the code, and mistaking a unique violation for a generic failure would turn a
 * correctly refused duplicate into a `failed` message and a stalled cursor.
 */
function isUniqueViolation(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code === '23505') return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return (
    message.includes('duplicate key value') ||
    message.includes('interactions_gmail_message_id_key')
  );
}

/**
 * Fill in the classification on the claimed row.
 *
 * The whole `meta` object is rewritten from what we already know rather than
 * read-modify-written, because a read-modify-write against `jsonb` is a race
 * with nothing to arbitrate it — and there is nothing in the row we did not put
 * there ourselves a moment ago.
 */
async function writeClassificationMeta(
  db: Db,
  interactionId: string | null,
  message: InboundMessage,
  classification: Classification,
  now: Date,
  taskId: string | null,
  attempts: number,
): Promise<void> {
  if (interactionId === null) return;

  const meta = inboundMeta({
    messageId: message.id,
    threadId: message.threadId,
    rfcMessageId: message.rfcMessageId,
    classification,
    taskId,
    classifiedAt: now.toISOString(),
    attempts,
    readError: null,
  });

  const { error } = await db.from('interactions').update({ meta }).eq('id', interactionId);
  if (error) {
    // The message was handled; only the record of *why* is incomplete. Throwing
    // here would count a processed message as failed and stall the cursor.
    log('failed to record the classification', {
      interaction_id: interactionId,
      error: redactEmails(error.message),
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contactLabel(contact: Pick<Contact, 'name' | 'business' | 'id'>): string {
  // Deliberately not the email address: this string goes on a task title that is
  // read on a screen the operator may be sharing.
  return contact.name ?? contact.business ?? contact.id;
}

function replySubject(subject: string | null): string {
  const trimmed = typeof subject === 'string' ? subject.trim() : '';
  if (trimmed === '') return 'Re: your message';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * SPEC §8: an error never disappears silently.
 *
 * Best-effort by construction, exactly as in `followup.ts` and `send-queue.ts`.
 * If the database is the broken thing then this insert fails too, and throwing
 * out of an error handler would abort the rest of the batch — which is the
 * failure the per-message structure exists to prevent.
 *
 * `contact_id` is null on every card this files and the text never carries a
 * sender's name, address or words: an alert card is read on a screen that may
 * be shared.
 */
async function fileAlert(
  db: Db,
  contactId: string | null,
  title: string,
  reasoning: string,
): Promise<void> {
  const task: TaskInsert = {
    agent: AGENT,
    type: 'alert',
    contact_id: contactId,
    title,
    reasoning,
    status: 'pending',
    autonomy_level: MAX_AUTONOMY_LEVEL,
  };

  try {
    const { error } = await db.from('tasks').insert(task);
    if (error) log('failed to file an alert task', { title, error: redactEmails(error.message) });
  } catch (error) {
    log('failed to file an alert task', {
      title,
      error: redactEmails(error instanceof Error ? error.message : String(error)),
    });
  }
}

// ---------------------------------------------------------------------------
// The tick — what index.ts calls
// ---------------------------------------------------------------------------

type LastRun = {
  trigger: 'cron' | 'webhook' | 'manual';
  started_at: string;
  duration_ms: number;
  status: 'ok' | 'error';
  summary: InboxSummary | null;
  error: string | null;
};

let inboxRunning = false;
let inboxPending: 'cron' | 'webhook' | 'manual' | null = null;
let inboxLastRun: LastRun | null = null;

/**
 * One inbox run, single-flight, never throwing.
 *
 * **Single-flight is load-bearing here in a way it is not for the follow-up
 * agent.** Three callers can fire at once: the webhook, the fifteen-minute
 * sweep and the manual loopback trigger. Two concurrent runs would walk the
 * same history from the same cursor and race on the claim — the unique index
 * would still stop the duplicate task, but only after both had paid for a Haiku
 * call each. Declining the second caller is what makes the common case free.
 *
 * **A caller that arrives mid-run is remembered, not dropped.** One flag, not a
 * queue: a thousand pushes in a second produce one run and one more after it,
 * which is what the header at the top of this file promises. Without the flag a
 * notification that lands while a sweep is in flight is simply lost, and SPEC
 * §5's immediate push for a new lead waits up to fifteen minutes for the next
 * sweep — and two deliveries inside one run's duration is the normal shape of a
 * burst, not an edge case. The rerun is cheap when there is nothing new: one
 * `history.list` against an unchanged cursor.
 *
 * **No retry-once wrapper**, unlike `runFollowupJob`. SPEC §8's retry exists
 * because the follow-up agent runs once a day and a failed run is a missed
 * morning. Here the next sweep is fifteen minutes away and *is* the retry, the
 * cursor was deliberately not advanced, and every per-message failure has
 * already been caught and counted inside the run. The alert SPEC §8 also asks
 * for is filed by `runInbox` itself.
 */
export async function runInboxTick(
  trigger: 'cron' | 'webhook' | 'manual',
  /**
   * The run itself. Injectable, and the injection is the point.
   *
   * The two properties this function has — decline while a run is in flight,
   * and remember exactly one caller that arrived during it — are the ones that
   * turn a burst of Pub/Sub deliveries into one run and one more, instead of a
   * thousand runs or one run with the last message stranded. Neither was
   * asserted, because `runInbox()` with no `db` builds a service-role client
   * and asking for one throws without `SUPABASE_SERVICE_ROLE_KEY`. So the
   * behaviour that bounds what the public webhook can cost was the only part of
   * this file with no test.
   *
   * `RunInboxOptions` already carries `db`, `llm` and `push` for the same
   * reason, but none of them helps here: what a single-flight test needs to
   * control is *when the run finishes*, and that is the promise, not its
   * dependencies. Hence a seam at this level. Production calls this with one
   * argument — `triggerInbox` and `index.ts` both do — so the entry point is
   * unchanged, and the parameter can only substitute the run, never skip the
   * flag.
   */
  run: (t: 'cron' | 'webhook' | 'manual') => Promise<InboxSummary> = (t) =>
    runInbox({ trigger: t === 'cron' ? 'cron' : t }),
): Promise<void> {
  if (inboxRunning) {
    // A cron sweep does not displace a webhook: the webhook is the one with a
    // waiting message behind it, and the trigger is only ever a label on a log
    // line and an `agent_runs` row.
    if (inboxPending === null || inboxPending === 'cron') inboxPending = trigger;
    log('inbox run queued — one is already in progress', { trigger });
    return;
  }

  inboxRunning = true;

  try {
    let next: 'cron' | 'webhook' | 'manual' | null = trigger;

    while (next !== null) {
      const current = next;
      inboxPending = null;
      const startedAt = new Date();

      try {
        const summary = await run(current);
        inboxLastRun = {
          trigger: current,
          started_at: startedAt.toISOString(),
          duration_ms: Date.now() - startedAt.getTime(),
          status: 'ok',
          summary,
          error: null,
        };
      } catch (error) {
        const message = redactEmails(error instanceof Error ? error.message : String(error));
        inboxLastRun = {
          trigger: current,
          started_at: startedAt.toISOString(),
          duration_ms: Date.now() - startedAt.getTime(),
          status: 'error',
          summary: null,
          error: message,
        };
        log('inbox run failed', { job: AGENT, trigger: current, error: message });
        // Whatever was queued while this run was failing would fail the same
        // way. The sweep is the retry; a loop here would be a hot one.
        break;
      }

      next = inboxPending;
    }
  } finally {
    inboxPending = null;
    inboxRunning = false;
  }
}

/**
 * Start a run and do not wait for it.
 *
 * This is what the webhook calls after it has written its `204`. Pub/Sub's ack
 * deadline is ten seconds and a run is minutes, so awaiting it there would
 * guarantee a redelivery of everything, every time.
 */
export function triggerInbox(trigger: 'webhook' | 'manual'): void {
  void runInboxTick(trigger);
}

/** For `/health`, alongside `followup` and `sendQueue`. */
export function getInboxStatus(): { running: boolean; lastRun: LastRun | null } {
  return { running: inboxRunning, lastRun: inboxLastRun };
}

/**
 * ---------------------------------------------------------------------------
 * What the integration agent must register in `apps/worker/src/index.ts`
 * ---------------------------------------------------------------------------
 *
 *   1. The sweep, in the `jobs` array:
 *        scheduleEvery('inbox-sweep', INBOX_SWEEP_INTERVAL_MS, () => runInboxTick('cron')),
 *   2. A loopback-only manual trigger mirroring the two that exist:
 *        GET /jobs/inbox/run → isLoopbackRequest → void runInboxTick('manual') → 202
 *   3. `/health` gains `inbox: getInboxStatus()`.
 *
 * Nothing Gmail-related goes into `validateEnv()`: the worker must still boot
 * and still run the 08:00 agent on a machine with no Gmail setup.
 */
