/**
 * @agency/worker — the long-running Node service (Railway).
 *
 * Boots, validates env, exposes a small HTTP surface, and holds the in-process
 * schedule. As of step 8 it registers three jobs:
 *
 *   followup     the follow-up agent, once a day at 08:00 Europe/Athens
 *                (SPEC §4, PLAN §6 step 5). Drafts; sends nothing.
 *   send-queue   the send poller, every 60 seconds (PLAN §1, §6 step 6, §7.1).
 *                Takes the tasks the operator approved whose `send_after` has
 *                come round and hands them to Gmail. Sends; drafts nothing.
 *   inbox-sweep  the inbound reader, every 15 minutes (PLAN §6 step 8). Walks
 *                the Gmail history from a stored cursor, classifies what
 *                arrived and drafts replies. Reads mail; sends nothing.
 *
 * The first two are deliberately separate processes of thought. The morning run
 * decides what to say and costs money; the poller decides nothing and costs a
 * query. Putting the send on its own sixty-second timer is what lets approving a
 * card return instantly (PLAN §1: "approving must return instantly. Delay needs
 * durable scheduling, not a `setTimeout`") — the approval writes `send_after`
 * and the poller does the rest, so a redeploy between the two loses nothing.
 *
 * The sweep is not the primary trigger for the inbox and is not meant to be.
 * Gmail's `users.watch` posts to `/webhooks/gmail` within seconds of a message
 * arriving, and that is the path a reply normally takes. The sweep is the
 * insurance: against a lost Pub/Sub notification, against an outage at Google,
 * and against the worker having been mid-redeploy when the webhook fired. It
 * costs one `history.list` against an unchanged cursor, which returns nothing.
 * It is also where the `users.watch` registration is renewed, which is why
 * there is no fourth job — a Gmail watch expires after seven days, and a system
 * whose webhook silently stops after a week is precisely the failure this repo
 * keeps arguing against.
 *
 * Env: nothing in this process loads a .env file on its own. The `dev` and
 * `start` scripts pass `--env-file-if-exists=../../.env` (cwd is apps/worker,
 * so that is the repo root). On Railway there is no file and the platform
 * supplies the variables directly — hence `-if-exists` rather than `--env-file`.
 *
 * The Gmail credentials, the Web Push keys, the two Pub/Sub webhook variables
 * and the three GDPR footer variables are NOT asserted at boot. They are checked
 * by the code paths that use them: `runSendQueue` on the first tick with an
 * approved task waiting, `sendPush` before it signs anything, and the webhook
 * route on every delivery. A machine with no Gmail setup and no VAPID pair still
 * starts and still runs the morning agent — which is the state the repo is in
 * today, and the reason step 8 did not make the webhook variables a boot
 * assertion even though the route cannot work without them. Each of those three
 * degrades in a way that says so: the send queue files an alert card, `sendPush`
 * logs a no-op, and the webhook answers `503` and logs which variable is
 * missing, once.
 *
 * HTTP surface:
 *   GET  /health                — liveness. PUBLIC, and public means three fields.
 *   GET  /jobs/followup/run     — trigger the follow-up agent by hand. LOOPBACK ONLY.
 *   GET  /jobs/send-queue/run   — drain the send queue by hand.       LOOPBACK ONLY.
 *   GET  /jobs/inbox/run        — read the mailbox by hand.           LOOPBACK ONLY.
 *   POST /webhooks/gmail        — Gmail Pub/Sub push.       DELIBERATELY PUBLIC.
 *
 * `/webhooks/gmail` is the only route in this process that *does work* for an
 * internet caller, and it is the reason the prefixes are kept apart: everything
 * under `/jobs/` is loopback-only *by construction*, with no exceptions to
 * reason about, and the webhook lives outside that prefix rather than being
 * carved out of it. Its own two checks — a constant-time shared secret and a
 * fully verified Google OIDC token — are what protect it, and they are both in
 * `routes/gmail-webhook.ts` rather than here, so this file's routing table stays
 * a routing table.
 *
 * `/health` is the third case and it used to be described as though it were the
 * first. It has no check of any kind, by necessity — a platform health probe
 * arrives through the proxy like any other request — and this process must be
 * publicly routable because Pub/Sub pushes at it. So anybody who finds the
 * Railway hostname was being handed, unauthenticated: the timezone, whether the
 * system is in dry run, every job's next run time, and `last_run` for all three
 * jobs including the follow-up agent's `considered`/`drafted`/`skipped` counts
 * (the operator's pipeline volume), the send queue's `sent`/`refused`, and raw
 * `error` strings — which are PostgREST messages, and a Postgres constraint
 * violation quotes the offending value back at you.
 *
 * The split below is the fix: an unauthenticated caller gets liveness and
 * nothing else, and the full document is loopback-only like the job triggers.
 * The operator reads it the same way they trigger a run by hand.
 *
 * There is no digest job, and its absence is a decision. The daily notification
 * is sent by `runFollowupJob` at the end of the morning run, on both the success
 * and the failure path, rather than by a second timer at a fixed hour. Two
 * independent timers cannot be ordered: a slow morning — forty contacts, one
 * Sonnet call each, a retry — runs past any fixed offset, and the operator gets
 * "0 follow-ups ready" at 08:30 followed by four cards appearing at 08:34. The
 * digest is a consequence of the run, so it is a call at the end of the run.
 *
 * ---------------------------------------------------------------------------
 * Why there is a scheduler here instead of `node-cron`
 * ---------------------------------------------------------------------------
 *
 * PLAN §1 says the worker is a long-running process and the schedule lives
 * in-process with an explicit timezone rather than on the host clock. That is
 * exactly what `scheduleDailyAt` below does — it just does it without a
 * dependency.
 *
 * `node-cron` is not in `pnpm-lock.yaml` and this step is not allowed to run an
 * install. Declaring a dependency that is not installed is worse than not
 * declaring it: `pnpm typecheck` fails on the missing module and the worker
 * fails to boot, so the job would be "registered" in a process that does not
 * start. Fifty lines of `Intl`-based arithmetic, using the same
 * `zonedTimeToUtc` the cadence dates are written with, keeps the property that
 * actually matters — one clock, computed in `Europe/Athens`, for both the
 * trigger and the dates the trigger produces.
 *
 * If `node-cron` is later added to the lockfile, `scheduleDailyAt` and
 * `scheduleEvery` are the only things that have to change; nothing below them
 * knows how the timer is armed.
 *
 * ---------------------------------------------------------------------------
 * The host clock is never consulted
 * ---------------------------------------------------------------------------
 *
 * Every instant in here is computed from `appTimezone()` (which is `TZ`, or
 * `Europe/Athens`), not from `Date#getHours`. A Railway container runs in UTC;
 * a cron that fires at "08:00 host time" fires at 11:00 Athens in summer and
 * 10:00 in winter, drifting by an hour twice a year with nothing to show for it.
 *
 * The hour itself is imported from `followup-select.ts` rather than written
 * here. `FOLLOWUP_HOUR` is the hour that module *stamps on every
 * `next_touch_at` it writes*; if the trigger and the stamp disagree by even an
 * hour in the wrong direction, every contact scheduled for "tomorrow" is a day
 * late, silently and forever.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { appTimezone, assertEnv, isDryRun, MissingEnvError } from '@agency/core';

import { runFollowup, type FollowupSummary } from './jobs/followup.js';
import { FOLLOWUP_HOUR, zonedTimeToUtc } from './jobs/followup-select.js';
import {
  runSendQueue,
  SEND_QUEUE_INTERVAL_MS,
  type SendQueueSummary,
} from './jobs/send-queue.js';
import { redactEmails } from './jobs/send-queue-policy.js';
import { runDigest } from './jobs/digest.js';
import { getInboxStatus, runInboxTick, INBOX_SWEEP_INTERVAL_MS } from './jobs/inbox.js';
import { GMAIL_WEBHOOK_PATH, handleGmailWebhook } from './routes/gmail-webhook.js';

const SERVICE = '@agency/worker';
const STARTED_AT = new Date();

/**
 * PORT is injected by Railway; it is a platform variable, not app config, so
 * it is deliberately absent from PLAN.md §8.
 */
const PORT = Number(process.env.PORT ?? 3001);

/** The minute within `FOLLOWUP_HOUR`. 08:00 exactly, per SPEC §4. */
const FOLLOWUP_MINUTE = 0;

/**
 * How long to wait before the single retry of a failed run.
 *
 * SPEC §8: "If an agent run errors, it retries once, then creates an alert
 * task." `runFollowup` only ever throws from the setup phase — the kill-switch
 * read, the contact query, the brain load, the settings read — because every
 * per-contact failure is caught inside its own loop iteration (PLAN §6 step 5,
 * constraint 3). So a retry here re-runs setup, not the model calls, and costs
 * nothing. Sixty seconds is long enough for a PostgREST blip to clear and short
 * enough that the retry still lands inside the morning.
 */
const RETRY_DELAY_MS = 60_000;

function log(message: string, extra?: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), service: SERVICE, message, ...extra };
  console.log(JSON.stringify(line));
}

/**
 * Fail fast at boot rather than at 08:00 the next morning. Only the variables
 * the worker needs to exist at startup are asserted here; Anthropic, Gmail and
 * Web Push credentials are validated by the code paths that use them, in the
 * steps that introduce them.
 */
function validateEnv(): void {
  try {
    assertEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], SERVICE);
  } catch (error) {
    if (error instanceof MissingEnvError) {
      log('env validation failed', { error: error.message, missing: error.missing });
    } else {
      log('env validation failed', { error: String(error) });
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/**
 * The calendar date at `instant`, as seen in `timeZone`.
 *
 * `formatToParts` rather than `format`, so the answer does not depend on a
 * locale's date order. Node ships full ICU, so `Europe/Athens` is real here and
 * not silently coerced to UTC.
 */
function localDateParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  let year = 1970;
  let month = 1;
  let day = 1;
  for (const part of formatter.formatToParts(instant)) {
    const value = Number(part.value);
    if (!Number.isFinite(value)) continue;
    if (part.type === 'year') year = value;
    else if (part.type === 'month') month = value;
    else if (part.type === 'day') day = value;
  }
  return { year, month, day };
}

/**
 * The next instant at which the local wall clock in `timeZone` reads
 * `hour:minute`, strictly after `after`.
 *
 * Exported for the same reason `nextTouch` is pure: "when does this fire next"
 * should be answerable without starting a process.
 *
 * Today's occurrence is tried first and only rolled forward when it has already
 * passed — `<=` rather than `<`, so a timer that fires a microsecond early
 * cannot re-arm itself for the same instant and spin.
 *
 * DST is handled by `zonedTimeToUtc`, and 08:00 is a safe hour in Greece either
 * way: the clocks move at 03:00/04:00 local, so 08:00 exists exactly once on
 * every day of the year. A job moved into the 03:00–04:00 window would need a
 * decision about the day the hour does not exist; this one does not.
 */
export function nextDailyRun(after: Date, hour: number, minute: number, timeZone: string): Date {
  const today = localDateParts(after, timeZone);
  const candidate = zonedTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
  if (candidate.getTime() > after.getTime()) return candidate;

  // Date.UTC normalises the rollover past the end of a month or a year.
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return zonedTimeToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hour,
    minute,
    timeZone,
  );
}

type ScheduledJob = {
  readonly name: string;
  readonly schedule: string;
  readonly timeZone: string;
  nextRunAt: Date;
  cancel: () => void;
};

/**
 * Run `task` every day at `hour:minute` local to `timeZone`.
 *
 * One `setTimeout`, re-armed after each fire, rather than a repeating interval:
 * an interval accumulates drift and, more importantly, has no idea that the
 * offset changed under it when the clocks went back. Recomputing the target
 * from the timezone after every run means a DST change costs exactly one
 * shorter or longer wait and nothing else.
 *
 * `task` is awaited before the next timer is armed, so two copies of the same
 * job can never overlap even if a run takes longer than a day. It is called
 * inside a try/catch it cannot escape — a throwing job must not stop the
 * schedule, or one bad morning would silently end all future mornings.
 */
export function scheduleDailyAt(
  name: string,
  hour: number,
  minute: number,
  timeZone: string,
  task: () => Promise<void>,
): ScheduledJob {
  let timer: NodeJS.Timeout | null = null;
  let cancelled = false;

  const job: ScheduledJob = {
    name,
    schedule: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} daily`,
    timeZone,
    nextRunAt: nextDailyRun(new Date(), hour, minute, timeZone),
    cancel: () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };

  const arm = (): void => {
    if (cancelled) return;
    job.nextRunAt = nextDailyRun(new Date(), hour, minute, timeZone);
    const delayMs = Math.max(0, job.nextRunAt.getTime() - Date.now());

    timer = setTimeout(() => {
      void (async () => {
        try {
          await task();
        } catch (error) {
          log('scheduled job threw', {
            job: name,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          arm();
        }
      })();
    }, delayMs);
  };

  arm();
  return job;
}

/**
 * Run `task` every `intervalMs`, starting one interval from now.
 *
 * Modelled on `scheduleDailyAt` and for the same reasons: one `setTimeout`
 * re-armed *after* the awaited task, never `setInterval`. `setInterval` keeps
 * firing while a slow tick is still running, so a send that takes ninety seconds
 * would be overlapped by the next poll — and two concurrent ticks both pass the
 * daily-cap check with the same count and send one message too many, which is
 * the whole reason the cap exists. `runSendQueueJob` also declines an overlap,
 * so this is the outer of two guards; the inner one covers the manual trigger.
 *
 * `task` is called inside a try/catch it cannot escape. A throwing tick must not
 * end the schedule — sending would stop and nothing would say so until somebody
 * noticed the queue was not draining.
 *
 * The first run is deliberately one interval away rather than immediate: at boot
 * the process may still be a moment from having a database connection, and
 * anything approved is at least two minutes from its send time anyway (PLAN
 * §7.1's jitter floor).
 *
 * `timeZone` is reported on `/health` for consistency with the daily job and is
 * not consulted: an interval does not care what the wall clock reads. The send
 * *window* is a timezone decision, but it was made at approval time and is
 * already baked into `tasks.send_after` as an absolute instant.
 */
export function scheduleEvery(
  name: string,
  intervalMs: number,
  task: () => Promise<void>,
): ScheduledJob {
  let timer: NodeJS.Timeout | null = null;
  let cancelled = false;

  const job: ScheduledJob = {
    name,
    schedule: `every ${Math.round(intervalMs / 1000)}s`,
    timeZone: appTimezone(),
    nextRunAt: new Date(Date.now() + intervalMs),
    cancel: () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };

  const arm = (): void => {
    if (cancelled) return;
    job.nextRunAt = new Date(Date.now() + intervalMs);

    timer = setTimeout(() => {
      void (async () => {
        try {
          await task();
        } catch (error) {
          log('scheduled job threw', {
            job: name,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          arm();
        }
      })();
    }, intervalMs);
  };

  arm();
  return job;
}

// ---------------------------------------------------------------------------
// The follow-up job
// ---------------------------------------------------------------------------

/** What `/health` reports about the last run of a job. */
type LastRun<Summary> = {
  trigger: 'cron' | 'manual';
  started_at: string;
  duration_ms: number;
  status: 'ok' | 'error';
  summary: Summary | null;
  error: string | null;
};

let followupRunning = false;
let followupLastRun: LastRun<FollowupSummary> | null = null;

/**
 * One follow-up run, with SPEC §8's retry-once around it.
 *
 * **Single-flight.** The 08:00 timer and a manual `/jobs/followup/run` can
 * collide. Two concurrent runs would select the same due contacts — the second
 * one before the first has pushed any dates out — and pay Sonnet twice for two
 * identical drafts of the same message. Declining the second is the whole fix.
 *
 * **The summary is one structured line.** `runFollowup` logs its own
 * per-contact lines; this is the one a human greps for on the morning something
 * looked wrong, and the one step 7 will turn into "4 follow-ups ready".
 *
 * Note on the retry: `runFollowup` files its own alert task before it rethrows,
 * so a run that fails twice files two alert cards. That is deliberate rather
 * than hidden — the alternative is teaching this function about the internals
 * of that one, and two cards for a database outage is a smaller problem than a
 * silent one.
 *
 * **This is also where the daily push goes out**, on both paths, and there is a
 * reason it is here and not on a timer of its own — see the note in the file
 * header. `runDigest` is awaited rather than fired and forgotten: it never
 * throws, it is one query and at most one HTTP request, and awaiting it keeps
 * its log line inside the run it is describing instead of arriving after the
 * "run finished" line it is about. The failure path passes `followup: null`,
 * which is what turns the notification into "The morning run failed" — a
 * morning that went wrong is the morning the operator most needs telling about,
 * and a digest that only fires on success is a digest that goes quiet exactly
 * when it matters.
 *
 * **Only the cron run pushes.** `GET /jobs/followup/run` exists to be triggered
 * by hand, which in practice means while debugging, at whatever hour the
 * debugging is happening. PLAN §6 step 7 asks for one notification "at a sane
 * hour"; a manual run at 23:40 that buzzes the operator's phone with "4
 * follow-ups ready" — or worse, with "The morning run failed" when nothing of
 * the sort happened that morning — is how a notification channel earns itself
 * muted, and a muted channel is the same as no channel. The run itself is
 * identical either way; only the push is withheld, and the log line says so.
 */
async function runFollowupJob(trigger: 'cron' | 'manual'): Promise<void> {
  if (followupRunning) {
    log('follow-up run skipped — one is already in progress', { trigger });
    return;
  }

  followupRunning = true;
  const startedAt = new Date();

  try {
    let summary: FollowupSummary;
    try {
      summary = await runFollowup({ trigger });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('follow-up run failed — retrying once', { trigger, error: message });
      await sleep(RETRY_DELAY_MS);
      summary = await runFollowup({ trigger });
    }

    followupLastRun = {
      trigger,
      started_at: startedAt.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      status: 'ok',
      summary,
      error: null,
    };

    log('follow-up run finished', {
      job: 'followup',
      trigger,
      considered: summary.considered,
      drafted: summary.drafted,
      skipped: summary.skipped,
      failed: summary.failed,
      duration_ms: followupLastRun.duration_ms,
      dry_run: isDryRun(),
    });

    await maybeDigest(trigger, summary);
  } catch (error) {
    // Redacted here rather than at the log line: this string is put on
    // `/health` and into the worker's stdout, and a PostgREST error quotes the
    // row that failed — which on this path is a contact. `inbox.ts` already did
    // this for its own `last_run`; the other two jobs did not.
    const message = redactEmails(error instanceof Error ? error.message : String(error));
    followupLastRun = {
      trigger,
      started_at: startedAt.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      status: 'error',
      summary: null,
      error: message,
    };

    // Not rethrown. `runFollowup` has already filed the alert task SPEC §8 asks
    // for, and throwing past here would only reach `scheduleDailyAt`'s catch,
    // which logs the same thing less usefully.
    log('follow-up run failed after retry', {
      job: 'followup',
      trigger,
      error: message,
      duration_ms: followupLastRun.duration_ms,
    });

    await maybeDigest(trigger, null);
  } finally {
    followupRunning = false;
  }
}

/**
 * Send the daily digest, but only for the scheduled run.
 *
 * Exported so the rule is assertable without booting the process — the whole
 * point is that a `manual` trigger reaches no push endpoint, and that is a
 * claim worth a test rather than a comment.
 */
export function shouldSendDigest(trigger: 'cron' | 'manual'): boolean {
  return trigger === 'cron';
}

async function maybeDigest(
  trigger: 'cron' | 'manual',
  followup: FollowupSummary | null,
): Promise<void> {
  if (!shouldSendDigest(trigger)) {
    log('digest withheld — manual run', { job: 'followup', trigger });
    return;
  }
  await runDigest({ followup });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The send queue
// ---------------------------------------------------------------------------

let sendQueueRunning = false;
let sendQueueLastRun: LastRun<SendQueueSummary> | null = null;

/**
 * One tick of the send poller.
 *
 * **Single-flight, and this is the load-bearing part of the whole job.** The
 * sixty-second timer and a manual `/jobs/send-queue/run` can collide, and so can
 * two ticks if one of them is slow. Two concurrent ticks would select the same
 * approved tasks, both read the same "sent in the last 24h" count, both find
 * room under the daily cap, and both hand the same message to Gmail — the
 * customer gets it twice and the cap is exceeded. Declining the second caller is
 * the entire fix, and it is why `runSendQueue`'s counting rather than locking is
 * correct: there is exactly one writer.
 *
 * **No retry-once wrapper**, unlike `runFollowupJob`. SPEC §8's retry exists
 * because the follow-up agent runs once a day and a failed run is a missed
 * morning. Here the next tick is sixty seconds away and *is* the retry, every
 * per-task failure is already caught and classified inside `runSendQueue`, and
 * an immediate second attempt after a partial tick is exactly how a message goes
 * out twice.
 *
 * Nothing about the failure is rethrown. `runSendQueue` files its own alert
 * cards; throwing past here would only reach `scheduleEvery`'s catch, which
 * logs the same thing with less context.
 */
async function runSendQueueJob(trigger: 'cron' | 'manual'): Promise<void> {
  if (sendQueueRunning) {
    log('send queue tick skipped — one is already in progress', { trigger });
    return;
  }

  sendQueueRunning = true;
  const startedAt = new Date();

  try {
    const summary = await runSendQueue();

    sendQueueLastRun = {
      trigger,
      started_at: startedAt.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      status: 'ok',
      summary,
      error: null,
    };
  } catch (error) {
    const message = redactEmails(error instanceof Error ? error.message : String(error));
    sendQueueLastRun = {
      trigger,
      started_at: startedAt.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      status: 'error',
      summary: null,
      error: message,
    };

    log('send queue tick failed', {
      job: 'send-queue',
      trigger,
      error: message,
      duration_ms: sendQueueLastRun.duration_ms,
    });
  } finally {
    sendQueueRunning = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Is this request from the machine the process is running on?
 *
 * `/jobs/followup/run` starts real work and spends real money, and it takes no
 * body, so a browser on any page could otherwise trigger it with an `<img>` tag.
 * There is no auth in this service (SPEC §10: auth beyond a single Supabase
 * user is out of scope), so the boundary is the network interface.
 *
 * Two checks, and the second is the one that matters in production:
 *
 *   1. The peer address must be loopback — 127.0.0.0/8 or ::1, including the
 *      IPv4-mapped `::ffff:127.x` form Node reports on a dual-stack socket.
 *   2. A forwarding header must be absent. Behind Railway's proxy the peer
 *      address is the proxy, not the client — usually a private address that is
 *      not loopback, so check 1 already refuses it. But a future
 *      `server.listen('127.0.0.1')` with a sidecar proxy would pass check 1 for
 *      every request on the internet. `x-forwarded-for` is the proxy admitting
 *      the request came from somewhere else; that is enough to refuse.
 *
 * Reachable in practice via `railway ssh` / `docker exec` and a curl, which is
 * how the operator triggers a run by hand.
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  if (req.headers['x-forwarded-for'] !== undefined) return false;
  if (req.headers['x-forwarded-host'] !== undefined) return false;
  if (req.headers['forwarded'] !== undefined) return false;

  const raw = req.socket.remoteAddress;
  if (typeof raw !== 'string' || raw === '') return false;

  const address = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * The routing table.
 *
 * Exported for one reason: the `/health` split — liveness for the internet, the
 * full document for loopback — is a security property, and a security property
 * that is only asserted by reading the function is a security property one
 * refactor away from being gone. The test drives fake `req`/`res` objects; the
 * server still calls it the same way.
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse, jobs: ScheduledJob[]): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // First, and deliberately not behind `isLoopbackRequest`. This is the one
  // route in the process that is meant to be reachable from the internet, and
  // its own two checks — a constant-time shared secret, then a fully verified
  // Google OIDC token — are what protect it. Putting it ahead of the `/jobs/*`
  // branches keeps those branches uniformly loopback-only, so a future audit of
  // this function has no exception to reason about.
  //
  // Not awaited: `handleGmailWebhook` writes its own response, including its
  // `204`, before it starts any work, and it never throws past its own catch.
  // A non-POST to this path falls through to the 404 below, which is the honest
  // answer — a browser that lands on the URL learns nothing.
  if (req.method === 'POST' && url.pathname === GMAIL_WEBHOOK_PATH) {
    void handleGmailWebhook(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    // See the file header. Liveness is a public question; the operator's
    // pipeline volume, schedule and error strings are not.
    if (!isLoopbackRequest(req)) {
      json(res, 200, {
        status: 'ok',
        service: SERVICE,
        uptime_s: Math.round(process.uptime()),
      });
      return;
    }

    const inboxStatus = getInboxStatus();
    json(res, 200, {
      status: 'ok',
      service: SERVICE,
      started_at: STARTED_AT.toISOString(),
      uptime_s: Math.round(process.uptime()),
      dry_run: isDryRun(),
      timezone: appTimezone(),
      jobs: jobs.map((job) => ({
        name: job.name,
        schedule: job.schedule,
        timezone: job.timeZone,
        next_run_at: job.nextRunAt.toISOString(),
      })),
      followup: {
        running: followupRunning,
        last_run: followupLastRun,
      },
      sendQueue: {
        running: sendQueueRunning,
        last_run: sendQueueLastRun,
      },
      // The state lives in `inbox.ts` rather than here: the webhook can start a
      // run without going through this file at all, so a module-level flag in
      // `index.ts` would be reporting on a schedule it is not the only trigger
      // for. Re-keyed to `last_run` so all three job reports in this document
      // have the same shape — `getInboxStatus()` returns `lastRun`, and one
      // camelCase key among two snake_case ones is the kind of thing a script
      // reads past.
      inbox: {
        running: inboxStatus.running,
        last_run: inboxStatus.lastRun,
      },
      routes: {
        // The public one, named on /health so "is the webhook mounted" is
        // answerable without reading the source or provoking a delivery.
        gmail_webhook: { method: 'POST', path: GMAIL_WEBHOOK_PATH, public: true },
      },
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/jobs/followup/run') {
    if (!isLoopbackRequest(req)) {
      log('rejected a non-local job trigger', {
        path: url.pathname,
        remote: req.socket.remoteAddress ?? null,
      });
      json(res, 403, { error: 'forbidden', detail: 'This route is reachable from localhost only.' });
      return;
    }

    if (followupRunning) {
      json(res, 409, { error: 'already_running', detail: 'A follow-up run is in progress.' });
      return;
    }

    // Accepted, not awaited. A run of up to MAX_CONTACTS_PER_RUN contacts is
    // one Sonnet call each; holding the socket open for it would hit Node's
    // 300-second `requestTimeout` and report a failure for a run that was in
    // fact still working. The result goes to the log as one structured line and
    // to `/health` as `followup.last_run`.
    void runFollowupJob('manual');
    json(res, 202, {
      status: 'accepted',
      detail: 'Follow-up run started. Watch the worker log, or poll /health.',
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/jobs/send-queue/run') {
    // Loopback-only for the same reason as the follow-up trigger, and one
    // sharper: this route sends real email to real customers. It takes no body,
    // so without the check any page in any browser could fire it with an
    // `<img>` tag.
    if (!isLoopbackRequest(req)) {
      log('rejected a non-local job trigger', {
        path: url.pathname,
        remote: req.socket.remoteAddress ?? null,
      });
      json(res, 403, { error: 'forbidden', detail: 'This route is reachable from localhost only.' });
      return;
    }

    if (sendQueueRunning) {
      json(res, 409, { error: 'already_running', detail: 'A send queue tick is in progress.' });
      return;
    }

    // Accepted, not awaited, like the follow-up trigger. A tick is up to ten
    // Gmail round trips; holding the socket open for it risks reporting a
    // failure for a tick that is still sending. The result goes to the log and
    // to `/health` as `sendQueue.last_run`.
    void runSendQueueJob('manual');
    json(res, 202, {
      status: 'accepted',
      detail: 'Send queue tick started. Watch the worker log, or poll /health.',
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/jobs/inbox/run') {
    // Loopback-only like the other two. This one reads a real mailbox and can
    // spend real Anthropic money on classification and drafting, and it takes
    // no body — so without the check any page in any browser could fire it with
    // an `<img>` tag. It is also the local substitute for the webhook: the
    // whole of step 8 can be exercised on a laptop with no Pub/Sub topic, no
    // OIDC audience and no public URL, which is the entire reason it exists.
    if (!isLoopbackRequest(req)) {
      log('rejected a non-local job trigger', {
        path: url.pathname,
        remote: req.socket.remoteAddress ?? null,
      });
      json(res, 403, { error: 'forbidden', detail: 'This route is reachable from localhost only.' });
      return;
    }

    // No 409 branch, unlike the other two triggers. `runInboxTick` is already
    // single-flight against three callers and declines an overlap by logging
    // one line — the webhook has no way to be told "409" and neither does the
    // sweep, so answering it here would be the only place the behaviour differs
    // and would say something this route cannot promise by the time the run
    // actually starts.
    void runInboxTick('manual');
    json(res, 202, {
      status: 'accepted',
      detail: 'Inbox run started. Watch the worker log, or poll /health.',
    });
    return;
  }

  json(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function main(): void {
  validateEnv();

  const timeZone = appTimezone();

  const jobs: ScheduledJob[] = [
    scheduleDailyAt('followup', FOLLOWUP_HOUR, FOLLOWUP_MINUTE, timeZone, () =>
      runFollowupJob('cron'),
    ),
    scheduleEvery('send-queue', SEND_QUEUE_INTERVAL_MS, () => runSendQueueJob('cron')),
    // `runInboxTick` is its own single-flight wrapper — it has to be, because
    // the webhook and the manual trigger reach it without passing through this
    // file — so there is no `runInboxJob` here to mirror the two above.
    scheduleEvery('inbox-sweep', INBOX_SWEEP_INTERVAL_MS, () => runInboxTick('cron')),
  ];

  const server = createServer((req, res) => handleRequest(req, res, jobs));

  server.listen(PORT, () => {
    log('worker alive', {
      port: PORT,
      dry_run: isDryRun(),
      timezone: timeZone,
      node: process.version,
      jobs_registered: jobs.length,
      jobs: jobs.map((job) => ({
        name: job.name,
        schedule: job.schedule,
        timezone: job.timeZone,
        next_run_at: job.nextRunAt.toISOString(),
      })),
    });
  });

  const shutdown = (signal: string): void => {
    log('shutting down', { signal });
    for (const job of jobs) job.cancel();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // The listening server is what keeps this process resident, and the job timer
  // is deliberately not unref'd so a future headless variant still fires.
}

/**
 * Boot only when this file is the process entrypoint.
 *
 * `nextDailyRun`, `scheduleDailyAt`, `scheduleEvery` and `isLoopbackRequest` are
 * the parts of the schedule worth asserting on, and a unit test that has to open
 * a socket and bind a port to import them is a unit test nobody runs. `realpathSync` because
 * pnpm workspaces are a forest of symlinks and the two URLs would otherwise
 * differ by a resolved path segment.
 *
 * A failure to recognise the entrypoint would mean a worker that starts and
 * does nothing, which is exactly the silent failure this repo keeps arguing
 * against — so it is verified by actually booting the process and reading
 * /health, not by inspection.
 */
function isEntrypoint(): boolean {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) main();
