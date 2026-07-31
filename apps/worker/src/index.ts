/**
 * @agency/worker — the long-running Node service (Railway).
 *
 * Boots, validates env, exposes a small HTTP surface, and holds the in-process
 * schedule. As of step 5 it registers one job: the follow-up agent at 08:00
 * Europe/Athens (SPEC §4, PLAN §6 step 5).
 *
 * Env: nothing in this process loads a .env file on its own. The `dev` and
 * `start` scripts pass `--env-file-if-exists=../../.env` (cwd is apps/worker,
 * so that is the repo root). On Railway there is no file and the platform
 * supplies the variables directly — hence `-if-exists` rather than `--env-file`.
 *
 * HTTP surface:
 *   GET /health              — liveness, plus the registered schedule
 *   GET /jobs/followup/run   — trigger the follow-up agent by hand. LOOPBACK ONLY.
 *
 * TODO(step 6): register the 60s send-queue poller for tasks where
 *               status='approved' AND send_after <= now()
 *               (node-cron → src/jobs/send-queue.ts).
 * TODO(step 7): daily digest job (src/jobs/digest.ts).
 * TODO(step 8): mount the Gmail Pub/Sub webhook route
 *               (src/routes/gmail-webhook.ts).
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
 * If `node-cron` is later added to the lockfile, `scheduleDailyAt` is the only
 * thing that has to change; nothing below it knows how the timer is armed.
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

// ---------------------------------------------------------------------------
// The follow-up job
// ---------------------------------------------------------------------------

type LastRun = {
  trigger: 'cron' | 'manual';
  started_at: string;
  duration_ms: number;
  status: 'ok' | 'error';
  summary: FollowupSummary | null;
  error: string | null;
};

let followupRunning = false;
let followupLastRun: LastRun | null = null;

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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
  } finally {
    followupRunning = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function handleRequest(req: IncomingMessage, res: ServerResponse, jobs: ScheduledJob[]): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
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
 * `nextDailyRun`, `scheduleDailyAt` and `isLoopbackRequest` are the parts of the
 * schedule worth asserting on, and a unit test that has to open a socket and
 * bind a port to import them is a unit test nobody runs. `realpathSync` because
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
