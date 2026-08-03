/**
 * The daily digest — PLAN §6 step 7, SPEC §5.
 *
 * One notification after the morning run, saying how much is waiting. Not one
 * per task, not one per inbound message, and on a morning with nothing in it,
 * none at all.
 *
 * PLAN §6 step 7's acceptance test is that "4 follow-ups ready" arrives *once*,
 * at a sane hour, and SPEC §5 states the failure this is written against: "if the
 * app pings 20 times a day it gets muted and the project dies." Muting is
 * irreversible in practice — nobody goes back into site settings to re-enable a
 * notification that annoyed them — so every rule below is about spending the one
 * interruption a day well.
 *
 * ---------------------------------------------------------------------------
 * This is not a scheduled job, and it must never become one
 * ---------------------------------------------------------------------------
 *
 * `runDigest` is called by `runFollowupJob` in `apps/worker/src/index.ts` after
 * the run has finished, in **both** the success and the failure branch. It is
 * deliberately not a `scheduleDailyAt('digest', 8, 30, …)` entry.
 *
 * Two independent timers cannot be ordered. A slow morning — forty contacts, one
 * Sonnet call each, one retry — runs past any fixed offset, and the operator gets
 * "0 follow-ups ready" at 08:30 followed by four cards appearing on Today at
 * 08:34. Nothing errors. The notification is simply a lie, and the first lie is
 * what teaches somebody to ignore the next one.
 *
 * The digest is a *consequence* of the run, so it is a call at the end of the
 * run. That also makes the failure branch honest: a run that threw still gets a
 * notification, because "the morning run failed" is the single most important
 * thing this system can tell its operator, and silence is what it would say
 * otherwise.
 *
 * ---------------------------------------------------------------------------
 * Why the counts are read from the database and not from FollowupSummary
 * ---------------------------------------------------------------------------
 *
 * `FollowupSummary` knows what the follow-up agent did this morning. It cannot
 * know about the task the inbox agent filed at 15:00 yesterday, which is still
 * pending and still needs the operator. So `pending` and `inboundWaiting` are
 * counted at digest time, off `tasks`, and `drafted` is the only number that
 * comes from the run.
 *
 * This is also what makes step 8's deferred notifications work with no queue and
 * no migration: everything that chose not to interrupt at 15:00 is counted here
 * the next morning, for free, from the same table Today reads.
 *
 * ---------------------------------------------------------------------------
 * Decisions the contract does not make
 * ---------------------------------------------------------------------------
 *
 * **Nothing is sent when nothing happened.** `composeDigest` returns null when
 * the run succeeded, drafted nothing, and nothing is pending. That is the whole
 * point of the step: a "0 follow-ups ready" ping on a quiet Tuesday is the first
 * notification the operator learns to swipe away, and after that the useful ones
 * are swiped away too.
 *
 * **The kill switch does not suppress the digest.** It pauses drafting and
 * sending; a notification is neither. "Nothing happened this morning because you
 * paused it" is exactly what a paused operator needs told — the failure mode
 * otherwise is a kill switch left on for a fortnight with a silent system behind
 * it. The body says so rather than the title, because the count is still the
 * headline.
 *
 * **The copy is English**, matching the rest of the UI. The operator is Greek;
 * the app's chrome is not, and a notification that reads differently from the
 * screen it opens is worse than a consistent second language.
 *
 * **A failed digest files no alert card.** Every other job in this repo files
 * one on failure. This one does not: an alert card is itself a pending task, so
 * a digest that fails would add to the count the next digest reports, and a
 * notification about a broken notification is noise on the one screen that must
 * stay signal. The log line is the record.
 *
 * **`now` is accepted and barely used.** The digest's timing is decided entirely
 * by when the follow-up run finished, so there is no clock arithmetic here today.
 * It is on the options because every other job in this repo takes an injectable
 * clock, and because the first rule anybody adds — "never push before 08:00
 * local", say — needs one, and would otherwise reach for `Date#getHours`.
 *
 * ---------------------------------------------------------------------------
 * What the integration agent must register
 * ---------------------------------------------------------------------------
 *
 * Two lines in `runFollowupJob` in `apps/worker/src/index.ts`, after
 * `followupLastRun` is assigned, one in each branch:
 *
 *   success path:  await runDigest({ followup: summary });
 *   catch path:    await runDigest({ followup: null });
 *
 * `await`, not `void`: the process is a long-lived server, so nothing is racing
 * a shutdown, and awaiting means the digest's log line lands inside the run it
 * describes. `runDigest` never throws, so neither branch needs its own guard.
 *
 * No entry in the `jobs` array, no `scheduleDailyAt`, and no new environment
 * variable in `validateEnv()` — the digest degrades to a logged no-op on a
 * worker with no VAPID keys, which is the machine this is being built on.
 */

import { createServiceClient, isKillSwitchOn } from '@agency/core';
import type { Db } from '@agency/core';

import type { FollowupSummary } from './followup.js';
import { sendPush } from './push.js';
import type { PushOutcome, PushPayload, PushSender } from './push.js';

const AGENT = 'digest';

export type DigestFacts = {
  /** The summary runFollowup returned, or null when the run threw. */
  followup: FollowupSummary | null;
  /** tasks.status = 'pending', counted at digest time — all agents. */
  pending: number;
  /** Of those, agent = 'inbox'. The deferred half of §8's notification rule. */
  inboundWaiting: number;
  killSwitchOn: boolean;
};

export type DigestSummary = {
  pushed: boolean;
  pending: number;
  drafted: number;
  push: PushOutcome | null;
};

export type RunDigestOptions = {
  db?: Db;
  now?: Date;
  /** Passed by the caller — the digest does not re-run the agent. */
  followup: FollowupSummary | null;
  /** Injectable for tests. Defaults to `sendPush`. */
  push?: PushSender;
};

function log(message: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), agent: AGENT, message, ...extra }));
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * First match wins, and the last row is the one that matters:
 *
 *   the run threw            → "The morning run failed"
 *   it drafted something     → "4 follow-ups ready"
 *   it drafted nothing, but
 *     something is pending   → "7 things need you"
 *   otherwise                → null, and nothing is sent
 *
 * Singular and plural are spelled out rather than suffixed because "1 follow-ups
 * ready" is the kind of small wrongness that makes a tool feel unattended, and
 * this string is the only sentence most days that the operator reads from this
 * system before opening it.
 */
export function composeDigest(facts: DigestFacts): PushPayload | null {
  const pending = safeCount(facts.pending);
  const inboundWaiting = safeCount(facts.inboundWaiting);
  const body = digestBody(pending, inboundWaiting, facts.killSwitchOn);

  if (facts.followup === null) {
    return { title: 'The morning run failed', body, url: '/', tag: 'digest' };
  }

  const drafted = safeCount(facts.followup.drafted);
  if (drafted > 0) {
    return {
      title: `${drafted} follow-up${drafted === 1 ? '' : 's'} ready`,
      body,
      url: '/',
      tag: 'digest',
    };
  }

  if (pending > 0) {
    return {
      title: pending === 1 ? '1 thing needs you' : `${pending} things need you`,
      body,
      url: '/',
      tag: 'digest',
    };
  }

  return null;
}

/**
 * `7 waiting · 2 from the inbox · sending is paused`.
 *
 * The two suffixes appear only when they are true. A body that always carries
 * every field trains the eye to stop reading it, and a lock screen truncates.
 */
function digestBody(pending: number, inboundWaiting: number, killSwitchOn: boolean): string {
  const parts = [`${pending} waiting`];
  if (inboundWaiting > 0) parts.push(`${inboundWaiting} from the inbox`);
  if (killSwitchOn) parts.push('sending is paused');
  return parts.join(' · ');
}

/**
 * A count that reached here as null, a float or a negative is a bug somewhere
 * else, and the right response is a notification that says something plausible
 * rather than "NaN things need you".
 */
function safeCount(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Never throws. The morning's drafts are already written and already on Today by
 * the time this is called; a notification failure must not turn a successful run
 * into a failed one in `/health` or in the log.
 */
export async function runDigest(options: RunDigestOptions): Promise<DigestSummary> {
  const drafted = options.followup === null ? 0 : safeCount(options.followup.drafted);
  const summary: DigestSummary = { pushed: false, pending: 0, drafted, push: null };

  try {
    const db = options.db ?? createServiceClient();
    const push = options.push ?? sendPush;

    const pending = await countTasks(db, null);
    const inboundWaiting = await countTasks(db, 'inbox');
    summary.pending = pending;

    const payload = composeDigest({
      followup: options.followup,
      pending,
      inboundWaiting,
      killSwitchOn: await readKillSwitch(db),
    });

    if (payload === null) {
      log('nothing worth a notification this morning', { pending, drafted });
      return summary;
    }

    summary.push = await push(payload, { db });
    summary.pushed = summary.push.sent > 0;

    log('digest sent', {
      title: payload.title,
      pending,
      drafted,
      inbound_waiting: inboundWaiting,
      subscriptions: summary.push.subscriptions,
      sent: summary.push.sent,
      removed: summary.push.removed,
      failed: summary.push.failed,
      dry_run: summary.push.dryRun,
    });

    return summary;
  } catch (error) {
    log('the digest could not be sent', {
      error: error instanceof Error ? error.message : String(error),
    });
    return summary;
  }
}

/**
 * `head: true` — the count and not the rows.
 *
 * Selecting the tasks to length them would ship every pending draft body into
 * this process to produce a single integer, which is the argument
 * `apps/web/lib/tasks.ts` already makes about counts on Today.
 */
async function countTasks(db: Db, agent: string | null): Promise<number> {
  let query = db.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  if (agent !== null) query = query.eq('agent', agent);

  const { count, error } = await query;
  if (error) throw new Error(`Failed to count pending tasks: ${error.message}`);
  return safeCount(count ?? 0);
}

/**
 * A kill switch that cannot be read is not a reason to skip the notification.
 *
 * `send-queue.ts` fails closed on this and is right to — it decides whether mail
 * leaves. Here the switch decides four words at the end of a body, so an
 * unreadable one is logged and treated as off. Claiming "sending is paused" on a
 * system that is not paused would be the worse error of the two.
 */
async function readKillSwitch(db: Db): Promise<boolean> {
  try {
    return await isKillSwitchOn(db);
  } catch (error) {
    log('the kill switch could not be read — the digest will not mention it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
