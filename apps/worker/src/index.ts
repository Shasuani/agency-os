/**
 * @agency/worker — the long-running Node service (Railway).
 *
 * Step 1 scope: boot, validate env, expose GET /health, stay alive.
 * It registers no cron jobs and does no work yet.
 *
 * Env: nothing in this process loads a .env file on its own. The `dev` and
 * `start` scripts pass `--env-file-if-exists=../../.env` (cwd is apps/worker,
 * so that is the repo root). On Railway there is no file and the platform
 * supplies the variables directly — hence `-if-exists` rather than `--env-file`.
 *
 * TODO(step 5): register the 08:00 Europe/Athens follow-up cron
 *               (node-cron → src/jobs/followup.ts).
 * TODO(step 6): register the 60s send-queue poller for tasks where
 *               status='approved' AND send_after <= now()
 *               (node-cron → src/jobs/send-queue.ts).
 * TODO(step 7): daily digest job (src/jobs/digest.ts).
 * TODO(step 8): mount the Gmail Pub/Sub webhook route
 *               (src/routes/gmail-webhook.ts).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appTimezone, assertEnv, isDryRun, MissingEnvError } from '@agency/core';

const SERVICE = '@agency/worker';
const STARTED_AT = new Date();

/**
 * PORT is injected by Railway; it is a platform variable, not app config, so
 * it is deliberately absent from PLAN.md §8.
 */
const PORT = Number(process.env.PORT ?? 3001);

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

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      service: SERVICE,
      started_at: STARTED_AT.toISOString(),
      uptime_s: Math.round(process.uptime()),
      dry_run: isDryRun(),
      timezone: appTimezone(),
      jobs: [],
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

function main(): void {
  validateEnv();

  const server = createServer(handleRequest);

  server.listen(PORT, () => {
    log('worker alive', {
      port: PORT,
      dry_run: isDryRun(),
      timezone: appTimezone(),
      node: process.version,
      jobs_registered: 0,
    });
  });

  const shutdown = (signal: string): void => {
    log('shutting down', { signal });
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // No unref, no timers to clear: the listening server is what keeps this
  // process resident. It must not exit on its own.
}

main();
