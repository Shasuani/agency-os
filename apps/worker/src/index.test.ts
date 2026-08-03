/**
 * The worker entrypoint's decidable parts.
 *
 * `index.ts` has carried three exports "for tests" since step 1 and had no test
 * file, because importing the entrypoint looks like it should boot a server.
 * It does not: `main()` runs only behind `isEntrypoint()`, which compares
 * `import.meta.url` against `process.argv[1]` — under the test runner that is
 * this file, so the import is inert. Asserting that here is most of the value:
 * if someone later moves a `createServer` call to module scope, this suite
 * hangs and says so.
 *
 * Nothing in here touches the network, a database, or a clock the test does not
 * supply.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleRequest, isLoopbackRequest, nextDailyRun, shouldSendDigest } from './index.js';

// ---------------------------------------------------------------------------
// The digest is withheld on a manual run
// ---------------------------------------------------------------------------

test('the daily digest fires only for the scheduled run', async (t) => {
  await t.test('the 08:00 cron run pushes', () => {
    assert.equal(shouldSendDigest('cron'), true);
  });

  await t.test('a hand-triggered run does not', () => {
    // GET /jobs/followup/run is a debugging tool. It is used at whatever hour
    // the debugging happens, and a push at 23:40 saying "The morning run
    // failed" — about a morning that has not happened — is how the operator
    // learns to mute the channel. PLAN §6 step 7: one notification, sane hour.
    assert.equal(shouldSendDigest('manual'), false);
  });
});

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

test('nextDailyRun lands on the local wall clock, not the host clock', async (t) => {
  const ATHENS = 'Europe/Athens';

  await t.test('summer: 08:00 Athens is 05:00 UTC', () => {
    const after = new Date('2026-07-14T04:00:00.000Z');
    assert.equal(nextDailyRun(after, 8, 0, ATHENS).toISOString(), '2026-07-14T05:00:00.000Z');
  });

  await t.test('winter: the same wall clock is 06:00 UTC', () => {
    const after = new Date('2026-01-14T04:00:00.000Z');
    assert.equal(nextDailyRun(after, 8, 0, ATHENS).toISOString(), '2026-01-14T06:00:00.000Z');
  });

  await t.test("today's occurrence having passed rolls to tomorrow", () => {
    const after = new Date('2026-07-14T05:00:01.000Z');
    assert.equal(nextDailyRun(after, 8, 0, ATHENS).toISOString(), '2026-07-15T05:00:00.000Z');
  });

  await t.test('a timer that fires a microsecond early cannot re-arm on itself', () => {
    // `<=` rather than `<` in the comparison. With `<`, an instant exactly on
    // the target returns itself, the delay computes to 0, and the run spins.
    const onTheDot = new Date('2026-07-14T05:00:00.000Z');
    assert.equal(nextDailyRun(onTheDot, 8, 0, ATHENS).toISOString(), '2026-07-15T05:00:00.000Z');
  });

  await t.test('rolls over the end of a month and a year', () => {
    const after = new Date('2026-12-31T06:00:01.000Z');
    assert.equal(nextDailyRun(after, 8, 0, ATHENS).toISOString(), '2027-01-01T06:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// The loopback gate on /jobs/*
// ---------------------------------------------------------------------------

function request(remoteAddress: string | undefined, headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

test('isLoopbackRequest admits only the local machine', async (t) => {
  await t.test('accepts IPv4, IPv6 and the dual-stack mapped form', () => {
    assert.equal(isLoopbackRequest(request('127.0.0.1')), true);
    assert.equal(isLoopbackRequest(request('127.0.0.53')), true);
    assert.equal(isLoopbackRequest(request('::1')), true);
    assert.equal(isLoopbackRequest(request('::ffff:127.0.0.1')), true);
  });

  await t.test('refuses anything else, including a private address', () => {
    assert.equal(isLoopbackRequest(request('10.0.0.4')), false);
    assert.equal(isLoopbackRequest(request('192.168.1.10')), false);
    assert.equal(isLoopbackRequest(request('203.0.113.7')), false);
    assert.equal(isLoopbackRequest(request(undefined)), false);
    assert.equal(isLoopbackRequest(request('')), false);
  });

  await t.test('a forwarding header refuses even a loopback peer', () => {
    // Behind a proxy the peer address is the proxy. Check 1 usually catches
    // that on its own, but a future listen('127.0.0.1') with a sidecar would
    // pass it for every request on the internet.
    assert.equal(isLoopbackRequest(request('127.0.0.1', { 'x-forwarded-for': '8.8.8.8' })), false);
    assert.equal(isLoopbackRequest(request('::1', { 'x-forwarded-host': 'example.com' })), false);
    assert.equal(isLoopbackRequest(request('::1', { forwarded: 'for=8.8.8.8' })), false);
  });

  await t.test('an address that merely starts with 127 in another octet is not loopback', () => {
    assert.equal(isLoopbackRequest(request('12.7.0.1')), false);
    assert.equal(isLoopbackRequest(request('1270.0.0.1')), false);
  });
});

// ---------------------------------------------------------------------------
// /health is public, and public means three fields
// ---------------------------------------------------------------------------

/**
 * The smallest `req`/`res` pair `handleRequest` actually uses.
 *
 * A real `http.Server` is not needed to assert a routing decision, and a test
 * that bound a port would be asserting something about the operating system.
 */
function call(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
): { status: number; body: Record<string, unknown> } {
  const req = { method, url, headers: { host: 'worker.example', ...headers }, socket: { remoteAddress } };
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string) {
      payload = chunk ?? '';
      return res;
    },
  };

  handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, []);
  return { status, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) };
}

test('/health answers an internet caller with liveness and nothing else', async (t) => {
  // This process must be publicly routable, because Pub/Sub pushes at it. The
  // file header used to claim `/webhooks/gmail` was the only route reachable
  // from the internet; `/health` had no check of any kind and was handing out
  // the timezone, the dry-run flag, every job's next run time, and `last_run`
  // for all three jobs — the follow-up agent's considered/drafted/skipped counts
  // are the operator's pipeline volume, and the `error` fields are raw PostgREST
  // messages, which quote the row that failed.
  const proxied = call('GET', '/health', { 'x-forwarded-for': '203.0.113.9' }, '10.0.0.4');

  await t.test('it still says the process is alive', () => {
    assert.equal(proxied.status, 200);
    assert.equal(proxied.body['status'], 'ok');
    assert.equal(typeof proxied.body['uptime_s'], 'number');
  });

  await t.test('and volunteers nothing operational', () => {
    for (const key of ['dry_run', 'timezone', 'jobs', 'followup', 'sendQueue', 'inbox', 'routes', 'started_at']) {
      assert.equal(key in proxied.body, false, `${key} is on the public health document`);
    }
  });
});

test('/health from loopback is the full document, like the job triggers', () => {
  // The operator reads it the same way they trigger a run by hand: over
  // `railway ssh`. Same boundary as `/jobs/*`, so there is one rule in this file
  // rather than two.
  const local = call('GET', '/health');

  assert.equal(local.status, 200);
  assert.equal(local.body['timezone'] !== undefined, true);
  assert.equal(local.body['followup'] !== undefined, true);
  assert.equal(local.body['sendQueue'] !== undefined, true);
  assert.equal(local.body['inbox'] !== undefined, true);
});

test('the job triggers stay loopback-only', () => {
  for (const path of ['/jobs/followup/run', '/jobs/send-queue/run', '/jobs/inbox/run']) {
    const forwarded = call('GET', path, { 'x-forwarded-for': '203.0.113.9' }, '10.0.0.4');
    assert.equal(forwarded.status, 403, path);
  }
});
