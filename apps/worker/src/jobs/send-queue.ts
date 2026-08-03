/**
 * The send queue — PLAN §6 step 6, §7 and §7.1.
 *
 * Every sixty seconds: find the tasks the operator approved whose `send_after`
 * has come round, ask the guardrails whether each one may still leave, hand it
 * to Gmail, and record that it happened. It decides nothing about *what* is
 * sent — the operator did that when they approved the card, and `send_after`
 * decided when. This job's whole job is to do it exactly once.
 *
 * `send-queue-policy.ts` holds everything decidable without I/O — the ordering,
 * the refusal-to-action mapping, the failure classification, the alert gate —
 * and is unit tested there. This file is the orchestration.
 *
 * ---------------------------------------------------------------------------
 * The write order is load-bearing. Do not reorder it.
 * ---------------------------------------------------------------------------
 *
 * After a successful Gmail call, four writes happen in this order:
 *
 *   1. `interactions`  — the outbound row
 *   2. `contacts`      — last_touch_at, touch_count
 *   3. `tasks`         — status 'sent', resolved_at
 *   4. `contacts`      — next_touch_at, re-anchored on the send
 *
 * Only the position of the first one is load-bearing. Write 4 is last because
 * it is the only one that can be wrong without anybody being emailed twice: see
 * `rebaseNextTouch`.
 *
 * If this process is killed between the Gmail call and the `tasks` update — a
 * Railway redeploy, an OOM, a SIGKILL — or if that one `UPDATE` simply fails
 * three times, the next tick re-reads a task that is still marked `approved`
 * and would send it again. What stops it is the `already_sent` guardrail, which
 * finds the `interactions` row by its `meta.task_id` and refuses. That only
 * works if the interaction is written first. Any other order means a customer
 * gets the same email twice, which is the single most visible way this system
 * could embarrass its operator.
 *
 * The guard used to be `contact_cooldown` instead, and that was wrong in a way
 * that only showed up two days later: the cooldown is a rolling 48-hour window,
 * so it refused the stuck task twice and then let it through. A duplicate that
 * arrives 49 hours after the original, with an alert card filed 49 hours before
 * it, is worse than one that arrives immediately — nobody connects the two.
 *
 * For the same reason, a failure of the `interactions` insert *after* a
 * successful send does not abort the remaining writes: the task is still moved
 * to `sent`, because at that point the only thing left to protect is the
 * customer's inbox, and an alert is filed so the missing row is not silent. The
 * cap accounting is wrong for 24 hours; the alternative is a duplicate email.
 * Note the cost of that choice: a task with no `interactions` row is a task the
 * `already_sent` guard cannot recognise, so `sent` on the task row is the only
 * thing keeping it out of the queue. Both writes failing together is a database
 * that is down, and a database that is down selects nothing to send in the
 * first place.
 *
 * ---------------------------------------------------------------------------
 * Single-flight, and why the counts are counted rather than locked
 * ---------------------------------------------------------------------------
 *
 * `runSendQueue` is called by one timer and one loopback route, and
 * `index.ts` holds a module-level `sendQueueRunning` flag that makes the second
 * caller decline. That is what makes the guardrails' `select count(*)` correct
 * without a lock: there is exactly one writer, reading the counts immediately
 * before each individual send. Two concurrent ticks would both read the same
 * count, both find room under the cap, and both send — one message over, every
 * time, which is precisely what the cap exists to prevent.
 *
 * ---------------------------------------------------------------------------
 * Three smaller decisions the contract does not make
 * ---------------------------------------------------------------------------
 *
 * **No retry-once wrapper around the tick.** SPEC §8's "retry once, then alert"
 * is implemented for the follow-up agent because it runs once a day and a failed
 * run means a missed morning. Here the next tick is sixty seconds away and *is*
 * the retry, and every per-task failure is already caught, classified and
 * deferred inside the loop. A second immediate attempt would only duplicate
 * whatever the first one did.
 *
 * **An idle tick logs nothing.** A summary line every sixty seconds is 1,440
 * lines a day saying nothing happened, and a log nobody can read is a log
 * nobody reads. The tick logs when it did work, when it refused work, and once
 * when the kill switch changes state; `/health` carries `last_run` for the case
 * where the operator wants to know the poller is alive right now.
 *
 * **Send configuration is checked per tick that has work, not at boot, and
 * under dry run only the three variables a dry run actually uses.** The worker
 * must still start and run the 08:00 follow-up agent on a machine with no Gmail
 * credentials — that is the entire state of the repo as STATUS.md describes it
 * today. Asserting the six variables at boot would turn a half-configured
 * install into a worker that does not start at all; asserting the three OAuth
 * ones under `DRY_RUN=true` was almost worse, because it meant the dry run this
 * repo is supposed to be testable with could not run a single tick on the
 * machine it is being built on. `sendEmail` returns before it ever asks for a
 * token under dry run. The three GDPR footer variables are asserted either way —
 * `gmail.ts` refuses the send without them, dry run included, and it says why.
 *
 * **Ten sends a tick, but more than ten candidates.** A deferral does not move
 * `send_after`, so a deferred task stays the oldest row in the queue and is
 * re-selected first on every subsequent tick. Selecting exactly ten and stopping
 * meant ten contacts in their 48-hour cooldown could hold every slot
 * indefinitely while a perfectly sendable task behind them was never looked at,
 * and the tick summary read as ordinary deferral. The selection now takes up to
 * `MAX_CANDIDATES_PER_TICK` rows and walks past the deferrals; the ten is a
 * ceiling on messages handed to Gmail, which is what it was always for.
 */

import {
  appTimezone,
  assertEnv,
  createServiceClient,
  isDryRun,
  isKillSwitchOn,
  MissingEnvError,
} from '@agency/core';
import type { Db, InteractionInsert, Json, TaskInsert } from '@agency/core';
import { assertSendAllowed, SendRefusedError } from '@agency/core/guardrails';
import type { SendPermit } from '@agency/core/guardrails';
import { sendEmail } from '@agency/core/gmail';
import type { GmailSendResult } from '@agency/core/gmail';

import {
  AlertOnce,
  alertKey,
  clampLimit,
  failureAction,
  haltsTick,
  nextTouchCount,
  orderDueTasks,
  redactEmails,
  refusalAction,
  resolutionStatus,
  type DueTaskRow,
} from './send-queue-policy.js';
import { INTERACTION_HISTORY_LIMIT, planNextTouchAfterSend } from './followup-select.js';

const AGENT = 'send-queue';

/** How often `index.ts` arms the poller. PLAN §1: "polls every 60s". */
export const SEND_QUEUE_INTERVAL_MS = 60_000;

/**
 * Messages handed to Gmail per tick.
 *
 * The daily cap is the real ceiling and the guardrails enforce it per send;
 * this only bounds one tick's work, so a backlog of two hundred approved tasks
 * is drained over twenty minutes rather than fired at Gmail in one burst. Ten a
 * minute is far more than the ramped cap of 10–40 a day will ever allow through.
 */
export const MAX_TASKS_PER_TICK = 10;

/**
 * Rows one tick will look at, as opposed to send.
 *
 * A refusal that defers — a contact still inside their 48-hour cooldown — leaves
 * `send_after` where it was, so that task is still the oldest row next tick and
 * the tick after that. With a selection of exactly ten, ten such tasks starve
 * everything behind them forever. Looking further down the queue is the fix, and
 * it costs one wider `select id` against an index.
 *
 * Forty is the top of the ramp in PLAN §7.1: past that the daily cap refuses
 * every remaining task anyway, and `daily_cap` halts the tick.
 */
export const MAX_CANDIDATES_PER_TICK = 40;

/**
 * The three GDPR footer elements from PLAN §7.
 *
 * `gmail.ts` refuses to send without them, including under dry run — an EU
 * commercial message with no physical address is not a message this system may
 * send, and a dry run that skipped the check would be testing a code path
 * production does not have. Checked here as well so the operator gets one clear
 * alert naming the missing variables, instead of the same `MissingEnvError`
 * raised once per task with an alert card per task behind it.
 */
const COMPLIANCE_ENV_VARS = ['BUSINESS_NAME', 'BUSINESS_ADDRESS', 'PRIVACY_POLICY_URL'] as const;

/**
 * The three Gmail credentials, needed only when a message really leaves.
 *
 * Under `DRY_RUN=true` `sendEmail` returns before `accessToken()` is called, so
 * requiring these would stop the dry run doing the one thing it is for: running
 * the whole tick — guardrails, footer, encoding, all three writes — on a machine
 * that has no Gmail setup, which is the machine this was built on.
 */
const GMAIL_ENV_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'] as const;

/** Attempts for each of the three post-send writes, including the first. */
const WRITE_ATTEMPTS = 3;

/** Between those attempts. Short: the tick is holding a message that has left. */
const WRITE_RETRY_DELAY_MS = 400;

/**
 * The autonomy level stamped on an alert card this job files.
 *
 * Level 1 — "draft, wait for approval" — is the only level v1 operates at
 * (SPEC §7), and an alert is a card the operator reads and dismisses, so the
 * number is descriptive rather than a permission. Hard-coded rather than read
 * from `settings.autonomy.alert` because a failed send should not need a
 * settings round trip to be reported, and because a settings read is exactly the
 * kind of thing that is also broken when everything else is.
 */
const ALERT_AUTONOMY_LEVEL = 1;

export type SendQueueSummary = {
  /** Rows the selection returned and this tick was willing to look at. */
  claimed: number;
  /** Of those, the ones a guardrail was actually asked about. */
  attempted: number;
  sent: number;
  /** Guardrail refusals, terminal or not. */
  refused: number;
  /** Threw — transport, database, anything. */
  failed: number;
  /** Left `approved` for a later tick: cap, cooldown, or a retryable error. */
  deferred: number;
};

export type RunSendQueueOptions = {
  /** Injectable for tests. Defaults to the service-role client. */
  db?: Db;
  /** Injectable for tests. Defaults to the moment the tick starts. */
  now?: Date;
  /** Sends this tick may perform. Bounded by `MAX_TASKS_PER_TICK`; the manual
   *  trigger may ask for fewer. */
  limit?: number;
  /**
   * The alert-dedupe gate. Defaults to the module-level one, which is what
   * makes "one card per outage per process" true in production.
   *
   * Injectable for the same reason `db` and `now` are: the tests that matter
   * here run several ticks in a row and assert on how many cards came out of
   * them, and a gate shared with the previous test would make every one of those
   * assertions depend on file order.
   */
  alerts?: AlertOnce;
};

/**
 * Per-process alert dedupe. See `AlertOnce` — a sixty-second poller with an
 * ungated alert files sixty cards an hour for one outage.
 *
 * Every path in this file that files a card goes through it, including the two
 * that resolve a task first: both of those writes are best-effort, so a resolve
 * that keeps failing means the same task refuses again on the next tick and
 * would otherwise file the same card sixty times an hour.
 */
const processAlerts = new AlertOnce();

/**
 * The last kill-switch state this process logged, so a paused system says so
 * once rather than once a minute.
 */
let lastKillSwitchLogged: boolean | null = null;

function log(message: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), agent: AGENT, message, ...extra }));
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export async function runSendQueue(options: RunSendQueueOptions = {}): Promise<SendQueueSummary> {
  const db = options.db ?? createServiceClient();
  const now = options.now ?? new Date();
  const sendBudget = clampLimit(options.limit, MAX_TASKS_PER_TICK);
  const alerts = options.alerts ?? processAlerts;

  const summary: SendQueueSummary = {
    claimed: 0,
    attempted: 0,
    sent: 0,
    refused: 0,
    failed: 0,
    deferred: 0,
  };

  // PLAN §7: checked at the top of every cron job and again inside every send.
  // This one saves the queries; the guardrail's is the one that is authoritative
  // if the operator flips it mid-tick.
  //
  // A `settings.kill_switch` that is not a boolean makes `getSetting` throw, and
  // failing closed there is right — a switch we cannot read is not a switch we
  // may assume is off. What was wrong is that the throw left the process with a
  // `/health` line and nothing else: sending stops completely and the operator's
  // only view of the system says nothing. It files a card now, once, and still
  // sends nothing.
  let killSwitch: boolean;
  try {
    killSwitch = await isKillSwitchOn(db);
  } catch (error) {
    const message = redactEmails(error instanceof Error ? error.message : String(error));
    log('the kill switch could not be read — nothing will be sent', { error: message });
    if (alerts.claim('kill-switch-unreadable')) {
      await fileAlert(
        db,
        'The kill switch could not be read',
        `${message} Nothing is being sent until this is fixed, because a switch that cannot be ` +
          'read cannot be assumed to be off. Check settings.kill_switch in /brain — it must be ' +
          'true or false.',
      );
    }
    return summary;
  }

  if (killSwitch !== lastKillSwitchLogged) {
    log(killSwitch ? 'kill switch is on — sending is paused' : 'kill switch is off', {
      kill_switch: killSwitch,
    });
    lastKillSwitchLogged = killSwitch;
  }
  if (killSwitch) return summary;

  await reportUnscheduledApprovals(db, alerts);

  const taskIds = await selectDueTaskIds(db, now, MAX_CANDIDATES_PER_TICK);
  summary.claimed = taskIds.length;
  if (taskIds.length === 0) return summary;

  if (!(await assertSendConfigured(db, alerts))) {
    // Nothing is resolved and nothing is touched: the tasks are still approved
    // and still due, and they go out on the first tick after the variables are
    // set.
    summary.deferred = taskIds.length;
    log('nothing sent — the send configuration is incomplete', { claimed: summary.claimed });
    return summary;
  }

  let halted: string | null = null;

  for (const taskId of taskIds) {
    // The ceiling is on messages sent, not on rows looked at — see the header.
    // Deferred tasks keep their place at the head of the queue, so counting them
    // against this budget is what let ten of them starve everything behind them.
    if (summary.sent >= sendBudget) break;

    // The step-5 lesson, restated because it is the one that matters most here:
    // one corrupt row must never abort the batch. An unwrapped loop means a
    // single malformed task silently drops everybody else's mail for the day,
    // and nothing in the log says so.
    summary.attempted += 1;
    try {
      await sendOne(db, taskId, now);
      summary.sent += 1;
    } catch (error) {
      if (error instanceof SendRefusedError) {
        summary.refused += 1;
        const action = refusalAction(error.reason, error.terminal);

        if (action === 'defer') {
          summary.deferred += 1;
          log('deferred', { task_id: taskId, reason: error.reason });

          if (haltsTick(error.reason)) {
            halted = error.reason;
            if (alerts.claim(`refusal:${error.reason}`)) {
              await fileAlert(
                db,
                haltTitle(error.reason),
                `${error.detail} ${describeHaltedBacklog(taskIds.length, summary)}`,
              );
            }
            break;
          }
          continue;
        }

        log('refused', { task_id: taskId, reason: error.reason });
        const status = resolutionStatus(error.reason);
        await resolveTask(db, taskId, status, now);

        // Gated, like every other alert this job files. `resolveTask` is
        // best-effort by design — it logs its own failure rather than throwing
        // into an error handler — so a task whose resolve write keeps failing is
        // re-selected, re-refused and re-alerted every sixty seconds. Ungated,
        // that is 1,440 identical cards a day burying the real ones, which is
        // the exact outage `AlertOnce` exists to prevent.
        if (alerts.claim(`refusal:${taskId}`)) {
          await fileAlert(
            db,
            status === 'sent'
              ? 'A queued email had already been sent'
              : 'A queued email was not sent',
            `${error.detail} The task has been marked ${status}; task id ${taskId}.`,
          );
        }
        continue;
      }

      summary.failed += 1;
      // Redacted because a Postgres constraint violation writes the offending
      // value into its own message, and that message goes to the log and onto
      // an alert card. See `redactEmails`.
      const message = redactEmails(error instanceof Error ? error.message : String(error));
      log('task failed', { task_id: taskId, error: message });

      if (failureAction(error) === 'defer') {
        summary.deferred += 1;
        if (alerts.claim(alertKey(taskId, error))) {
          await fileAlert(
            db,
            'A queued email could not be sent',
            `${message} It is still approved and will be tried again; task id ${taskId}.`,
          );
        }
        continue;
      }

      await resolveTask(db, taskId, 'skipped', now);
      if (alerts.claim(`failure:${taskId}`)) {
        await fileAlert(
          db,
          'A queued email was rejected and will not be retried',
          `${message} The task has been marked skipped; task id ${taskId}.`,
        );
      }
    }
  }

  log('send queue tick finished', { job: AGENT, ...summary, halted, dry_run: isDryRun() });
  return summary;
}

// ---------------------------------------------------------------------------
// One task
// ---------------------------------------------------------------------------

/**
 * Guardrails, Gmail, then the three writes.
 *
 * Only ids are selected, so this re-reads the whole task row through
 * `assertSendAllowed`. That re-read is not a redundancy — PLAN §7 row 1 makes it
 * the guardrail: "the send function takes a taskId, re-reads the row, and throws
 * unless status = 'approved'". Anything selected a moment ago and rejected since
 * must not go out, and the only way to know is to look again.
 */
async function sendOne(db: Db, taskId: string, now: Date): Promise<void> {
  const permit = await assertSendAllowed(db, { taskId, now });

  // Step 8's replies have to be replies. See `loadReplyTarget`.
  const replyTo = await loadReplyTarget(db, taskId);

  // `permit.to`, not `permit.contact.email`. They are the same address today,
  // and the difference is that one of them has been checked: the permit carries
  // the trimmed, '@'-checked string that `evaluateSend` actually approved, while
  // the column is typed `string | null` and re-deriving from it would quietly
  // move the validation out of the guardrails and into this loop, where it would
  // be one refactor away from not happening at all. The guardrail decides who
  // gets the message; the sender does what it was told.
  const result = await sendEmail({
    to: permit.to,
    toName: permit.contact.name,
    subject: permit.subject,
    body: permit.body,
    language: permit.contact.language,
    threadId: replyTo.threadId,
    inReplyTo: replyTo.inReplyTo,
    taskId: permit.taskId,
  });

  const problems = await recordSend(db, permit, result, now);

  log('sent', {
    task_id: permit.taskId,
    contact_id: permit.contact.id,
    gmail_message_id: result.id,
    dry_run: result.dryRun,
    raw_bytes: result.rawBytes,
    sent_in_last_24h: permit.sentInLast24h + 1,
    daily_send_cap: permit.dailySendCap,
  });

  if (problems.length > 0) {
    // The message left. Everything below is bookkeeping that failed, and the
    // operator has to know because the cap arithmetic and the pipeline are now
    // out of step with reality.
    log('the message was sent but the record is incomplete', {
      task_id: permit.taskId,
      contact_id: permit.contact.id,
      problems,
    });
    await fileAlert(
      db,
      'An email was sent but not fully recorded',
      `The message left, but ${problems.join('; ')}. ` +
        `Check the contact in /pipeline; task id ${permit.taskId}.`,
    );
  }
}

/** What Gmail needs to make an outbound message land in an existing thread. */
type ReplyTarget = { threadId: string | null; inReplyTo: string | null };

/**
 * The Gmail thread this task is answering, if it is answering one.
 *
 * ---------------------------------------------------------------------------
 * Why this is a lookup and not a column
 * ---------------------------------------------------------------------------
 *
 * Both fields were passed as `null` here until this was written, so every
 * approved inbox reply left as a brand new message: subject `Re: …`, no
 * `In-Reply-To`, no `References`, its own thread. Two things that costs, and
 * the second is the expensive one:
 *
 *   - The recipient sees two unrelated conversations for one exchange, in a
 *     system whose entire premise is that its output does not read as a
 *     machine.
 *   - `recordSend` writes `gmail_thread_id: result.threadId` on the outbound
 *     row, so the reply was filed under the *new* thread. `inbox.ts`'s
 *     `loadThread` selects on that field, so when the customer wrote back the
 *     drafter was shown a thread containing our reply and not their original
 *     question — and `inbox-reply-prompt.ts` is built on being shown the whole
 *     conversation.
 *
 * `tasks` has no thread column and step 6 may not add a migration to get one,
 * but it does not need one: `inbox.ts` writes `task_id` into the inbound
 * `interactions` row's `meta` in the same step that files the task, alongside
 * `gmail_thread_id` and `rfc_message_id`. That row is the join, and it is
 * already indexed by the filter the `already_sent` guardrail uses.
 *
 * **A follow-up task legitimately finds nothing**, and the empty result is the
 * whole answer: no inbound row carries its id, so it is a new conversation and
 * goes out as one. Same for a reply whose inbound row lost its `meta` update.
 *
 * **A read failure returns nulls rather than throwing.** The message is
 * approved, the guardrails have already passed, and refusing to send it because
 * the threading hint could not be read would hold a customer's answer for a
 * bookkeeping query. An unthreaded reply is a small cosmetic loss; a reply that
 * never leaves is not.
 */
async function loadReplyTarget(db: Db, taskId: string): Promise<ReplyTarget> {
  const empty: ReplyTarget = { threadId: null, inReplyTo: null };

  const { data, error } = await db
    .from('interactions')
    .select('meta')
    .eq('direction', 'in')
    .eq('meta->>task_id', taskId)
    .order('occurred_at', { ascending: false })
    .limit(1);

  if (error !== null) {
    log('could not read the thread this task replies to — sending it unthreaded', {
      task_id: taskId,
      error: redactEmails(error.message),
    });
    return empty;
  }

  const meta = (data ?? [])[0]?.meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return empty;

  const fields = meta as Record<string, unknown>;
  const threadId = typeof fields['gmail_thread_id'] === 'string' ? fields['gmail_thread_id'] : null;
  const inReplyTo = typeof fields['rfc_message_id'] === 'string' ? fields['rfc_message_id'] : null;

  return {
    threadId: threadId === '' ? null : threadId,
    inReplyTo: inReplyTo === '' ? null : inReplyTo,
  };
}

/**
 * The four writes, in the order the header insists on.
 *
 * Every one of them is retried, and none of them aborts the others. Returns a
 * list of what failed, in prose, for the alert card — never an error, because
 * throwing from here would mark a task that was genuinely sent as failed and the
 * next tick would send it again.
 */
async function recordSend(
  db: Db,
  permit: SendPermit,
  result: GmailSendResult,
  now: Date,
): Promise<string[]> {
  const problems: string[] = [];
  const nowIso = now.toISOString();

  // 1 — the row the cooldown and the daily cap are counted off. `body` is the
  // operator's text as they approved it: the compliance footer is appended
  // inside `sendEmail` and is deliberately not stored, because step 9 reads
  // these pairs as training data and boilerplate the operator never wrote would
  // pollute it.
  const interaction: InteractionInsert = {
    contact_id: permit.contact.id,
    direction: 'out',
    channel: 'email',
    subject: permit.subject,
    body: permit.body,
    occurred_at: nowIso,
    meta: {
      task_id: permit.taskId,
      gmail_message_id: result.id,
      gmail_thread_id: result.threadId,
      rfc_message_id: result.messageId,
      dry_run: result.dryRun,
    } satisfies Record<string, Json>,
  };

  const interactionError = await attemptWrite(() => db.from('interactions').insert(interaction));
  if (interactionError !== null) {
    problems.push(`the interaction row was not written (${interactionError})`);
  }

  // 2 — read-modify-write, safe only because this poller is the single writer of
  // these two columns and is single-flight. There is no RPC for an atomic
  // increment and step 6 may not add a migration to get one.
  const contactError = await attemptWrite(() =>
    db
      .from('contacts')
      .update({
        last_touch_at: nowIso,
        touch_count: nextTouchCount(permit.contact.touch_count),
      })
      .eq('id', permit.contact.id),
  );
  if (contactError !== null) {
    problems.push(`the contact's last touch was not updated (${contactError})`);
  }

  // 3 — last, because until this lands the task is still `approved` and the
  // cooldown from write 1 is the only thing standing between the customer and a
  // second copy. If it fails the card stays in the queue and refuses forever
  // with `contact_cooldown`, which is visible in the log rather than silent.
  const taskError = await attemptWrite(() =>
    db.from('tasks').update({ status: 'sent', resolved_at: nowIso }).eq('id', permit.taskId),
  );
  if (taskError !== null) {
    problems.push(`the task was not marked sent (${taskError})`);
  }

  // 4 — the cadence clock. See `planNextTouchAfterSend`: without this the
  // intervals in SPEC §4's table are all served one step early, and an approval
  // that waits for the send window produces the next chase the morning after
  // this one lands. Deliberately last, and deliberately not a reason to abort
  // anything above it: the message has gone, and a date that did not move is a
  // contact scheduled sooner than they should be, not a contact who gets two
  // emails.
  const rebaseProblem = await rebaseNextTouch(db, permit, now);
  if (rebaseProblem !== null) problems.push(rebaseProblem);

  return problems;
}

/**
 * Move `next_touch_at` onto the message that actually left.
 *
 * Re-reads the contact's interactions rather than reusing anything from the
 * permit, because the row written a moment ago is the one that advances the
 * step and the permit predates it. One indexed read per send, at most forty
 * sends a day.
 *
 * Returns a sentence for the alert card, or null when there was nothing to do —
 * which is the common case for the contact whose cadence has run out, and for
 * every send where the stored date is already further out than the new one.
 */
async function rebaseNextTouch(db: Db, permit: SendPermit, now: Date): Promise<string | null> {
  const { data, error } = await db
    .from('interactions')
    .select('direction, occurred_at')
    .eq('contact_id', permit.contact.id)
    .order('occurred_at', { ascending: false })
    .limit(INTERACTION_HISTORY_LIMIT);

  if (error !== null) {
    return `the follow-up date was not re-anchored to this send (${error.message})`;
  }

  const plan = planNextTouchAfterSend({
    contact: permit.contact,
    interactions: data ?? [],
    sentAt: now,
    timeZone: appTimezone(),
  });

  if (plan === null) return null;

  const writeError = await attemptWrite(() =>
    db
      .from('contacts')
      .update({ next_touch_at: plan.at.toISOString() })
      .eq('id', permit.contact.id),
  );
  if (writeError !== null) {
    return `the follow-up date was not re-anchored to this send (${writeError})`;
  }

  log('re-anchored the follow-up date on the send', {
    task_id: permit.taskId,
    contact_id: permit.contact.id,
    days: plan.days,
    next_touch_at: plan.at.toISOString(),
  });

  return null;
}

/**
 * One write, up to `WRITE_ATTEMPTS` times. Returns null on success, or the last
 * error message.
 *
 * Both failure shapes are handled: PostgREST reports most problems as a
 * `{ error }` on a resolved promise, and a dropped socket as a rejection.
 */
async function attemptWrite(
  write: () => PromiseLike<{ error: { message: string } | null }>,
): Promise<string | null> {
  let last = 'unknown error';

  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    try {
      const { error } = await write();
      if (error === null) return null;
      last = redactEmails(error.message);
    } catch (error) {
      last = redactEmails(error instanceof Error ? error.message : String(error));
    }
    if (attempt < WRITE_ATTEMPTS) await sleep(WRITE_RETRY_DELAY_MS);
  }

  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Approved tasks whose send time has come, oldest first.
 *
 * Only ids: `assertSendAllowed` re-reads the row, and that re-read is the
 * guardrail. Selecting the body here would be one wasted transfer and a second
 * copy of the draft in memory that could drift from the one actually sent.
 *
 * Served by `tasks_status_send_after_idx`.
 */
async function selectDueTaskIds(db: Db, now: Date, limit: number): Promise<string[]> {
  const { data, error } = await db
    .from('tasks')
    .select('id, send_after')
    .eq('status', 'approved')
    .not('send_after', 'is', null)
    .lte('send_after', now.toISOString())
    .order('send_after', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Failed to select due tasks: ${redactEmails(error.message)}`);

  const rows: DueTaskRow[] = data ?? [];
  return orderDueTasks(rows, now, limit);
}

/**
 * Approved tasks with no `send_after`.
 *
 * Such a row can never be selected by the query above and would sit in the
 * queue forever, approved and unsent, with nothing anywhere saying so. Nothing
 * in step 6 writes one — `approveTask` always computes a slot — so this count
 * should always be zero. It is here because "always zero" is exactly the
 * assumption that stops being true when a later step adds a second approval
 * path, and silence is the failure mode this repo keeps arguing against.
 *
 * One alert per process, so a stuck row does not file a card a minute.
 */
async function reportUnscheduledApprovals(db: Db, alerts: AlertOnce): Promise<void> {
  const { count, error } = await db
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'approved')
    .is('send_after', null);

  if (error) {
    log('failed to count approved tasks with no send time', { error: redactEmails(error.message) });
    return;
  }

  const stuck = count ?? 0;
  if (stuck === 0) return;

  log('approved tasks have no send time and can never be selected', { stuck });
  if (!alerts.claim('unscheduled-approvals')) return;

  await fileAlert(
    db,
    'Approved tasks with no send time',
    `${stuck} task${stuck === 1 ? ' is' : 's are'} approved with no scheduled send time, so the ` +
      `send queue can never pick ${stuck === 1 ? 'it' : 'them'} up. Reject and re-approve ${
        stuck === 1 ? 'it' : 'them'
      } on Today to give ${stuck === 1 ? 'it' : 'them'} one.`,
  );
}

/**
 * Are the variables this tick actually needs set?
 *
 * Six for a live send, three under dry run — see the header and the two lists.
 * Checked once per tick that has work rather than at boot. On failure the tasks
 * are left exactly as they are and one alert names the missing variables.
 * Variable *names* are not secrets and never values: nothing in this file logs
 * the contents of a credential.
 */
async function assertSendConfigured(db: Db, alerts: AlertOnce): Promise<boolean> {
  const required = isDryRun()
    ? COMPLIANCE_ENV_VARS
    : ([...COMPLIANCE_ENV_VARS, ...GMAIL_ENV_VARS] as const);

  try {
    assertEnv(required, 'the send queue');
    return true;
  } catch (error) {
    const missing = error instanceof MissingEnvError ? error.missing : [];
    log('the send configuration is incomplete', {
      missing,
      error: error instanceof Error ? error.message : String(error),
    });

    if (alerts.claim('send-config')) {
      await fileAlert(
        db,
        'Sending is not configured',
        `Approved emails are waiting, but ${missing.join(', ')} ${
          missing.length === 1 ? 'is' : 'are'
        } not set on the worker. Nothing has been lost — set ${
          missing.length === 1 ? 'it' : 'them'
        } and the queue drains on the next tick. See PLAN.md §8.`,
      );
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Writes shared by the failure paths
// ---------------------------------------------------------------------------

/**
 * `skipped` or `sent`, never `rejected` — `resolutionStatus` decides which.
 *
 * `rejected` is the operator's verdict on a draft and step 9 reads it as
 * training signal — "this writing was wrong". A guardrail refusal or a permanent
 * transport failure says nothing about the writing, and recording it as a
 * rejection would teach the next draft the wrong lesson.
 *
 * Resolving is not optional: a terminal refusal that left the task `approved`
 * would be re-selected and re-refused every sixty seconds forever. It is still
 * best-effort — throwing out of an error handler would abort the rest of the
 * batch — which is why the caller's alert is gated rather than filed per tick.
 */
async function resolveTask(
  db: Db,
  taskId: string,
  status: 'sent' | 'skipped',
  now: Date,
): Promise<void> {
  const error = await attemptWrite(() =>
    db.from('tasks').update({ status, resolved_at: now.toISOString() }).eq('id', taskId),
  );
  if (error !== null) {
    log('failed to resolve a task after a permanent refusal', { task_id: taskId, status, error });
  }
}

/**
 * SPEC §8: an error never disappears silently.
 *
 * Best-effort by construction, exactly as in `followup.ts`. If the database is
 * the broken thing then this insert fails too, and throwing out of an error
 * handler would abort the rest of the batch — which is the failure this whole
 * per-task structure exists to prevent. The console line is the fallback record.
 *
 * `contact_id` is deliberately null on every card this files. A refusal carries
 * a task id and a reason, not a contact, and the alert text must not contain a
 * recipient's address or name in any case: an alert card is read on a screen
 * that may be shared, and "we refused to email maria@example.gr" is customer
 * data on a wall.
 */
async function fileAlert(db: Db, title: string, reasoning: string): Promise<void> {
  const task: TaskInsert = {
    agent: AGENT,
    type: 'alert',
    contact_id: null,
    title,
    reasoning,
    status: 'pending',
    autonomy_level: ALERT_AUTONOMY_LEVEL,
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

function haltTitle(reason: string): string {
  return reason === 'daily_cap' ? 'The daily send cap has been reached' : 'Sending is paused';
}

function describeHaltedBacklog(claimed: number, summary: SendQueueSummary): string {
  const waiting = claimed - summary.sent;
  return `${waiting} approved email${waiting === 1 ? '' : 's'} ${
    waiting === 1 ? 'is' : 'are'
  } still waiting and will go out as soon as they can. Nothing has been lost.`;
}
