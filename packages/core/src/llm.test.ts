/**
 * Tests for the pure half of the LLM wrapper — the per-model request shaping.
 *
 * This is small but it is the part that fails at 08:00 on an unwatched cron. The
 * two models disagree about which parameters are legal, and getting it wrong is
 * either a 400 or a silent bill for thinking tokens nobody wanted. Neither shows
 * up in a typecheck.
 *
 * The network path is not tested here — that needs a real key and real money,
 * and it is what scripts/llm-probe.ts is for.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Db } from './db';
import { LlmError, MAX_COST_ROWS, assertUnderCostCap, requestShapeFor } from './llm';

describe('requestShapeFor — the model traps', () => {
  it('Sonnet 5 gets thinking explicitly disabled', () => {
    // Sonnet 5 runs ADAPTIVE thinking when `thinking` is omitted. For a short
    // structured draft that is spend nobody asked for, and it competes with the
    // draft for max_tokens. Omitting the key is not the same as disabling it.
    const shape = requestShapeFor('claude-sonnet-5');
    assert.deepEqual(shape['thinking'], { type: 'disabled' });
  });

  it('Haiku 4.5 is not sent an effort parameter', () => {
    // Haiku 4.5 predates output_config.effort and rejects it with a 400.
    const shape = requestShapeFor('claude-haiku-4-5');
    assert.equal('output_config' in shape, false);
    assert.equal('effort' in shape, false);
  });

  it('Haiku 4.5 is not sent a thinking config either', () => {
    // It uses the older budget_tokens form, which classification does not need.
    // Sending the adaptive form would 400.
    const shape = requestShapeFor('claude-haiku-4-5');
    assert.equal('thinking' in shape, false);
  });

  it('neither model is sent sampling parameters', () => {
    // Both reject non-default temperature / top_p / top_k with a 400. The
    // wrapper never offers them, so this asserts the shape stays clean if
    // someone adds a knob later.
    for (const model of ['claude-sonnet-5', 'claude-haiku-4-5'] as const) {
      const shape = requestShapeFor(model);
      assert.equal('temperature' in shape, false, `${model} must not send temperature`);
      assert.equal('top_p' in shape, false, `${model} must not send top_p`);
      assert.equal('top_k' in shape, false, `${model} must not send top_k`);
    }
  });

  it('returns a fresh object each call, so a caller cannot poison the next one', () => {
    const a = requestShapeFor('claude-sonnet-5');
    const b = requestShapeFor('claude-sonnet-5');
    assert.notEqual(a, b, 'must not share a mutable module-level object');
    (a as Record<string, unknown>)['temperature'] = 0.7;
    assert.equal('temperature' in b, false);
  });
});

// ---------------------------------------------------------------------------
// The cost cap — the only spend ceiling in the repo
// ---------------------------------------------------------------------------

/**
 * A PostgREST stand-in with two tables and one switch per table.
 *
 * Small on purpose: what is being asserted is which branch a failed read takes,
 * not query semantics.
 */
function costDb(script: {
  cap?: unknown;
  capError?: string;
  runs?: { cost_usd: unknown }[];
  runsError?: string;
}): Db {
  const query = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      limit: () => chain,
      maybeSingle: async () =>
        script.capError !== undefined
          ? { data: null, error: { message: script.capError } }
          : { data: script.cap === undefined ? null : { value: script.cap }, error: null },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(
          script.runsError !== undefined
            ? { data: null, error: { message: script.runsError } }
            : { data: script.runs ?? [], error: null },
        ).then(resolve),
    };
    void table;
    return chain;
  };

  return { from: (table: string) => query(table) } as unknown as Db;
}

const AT = new Date('2026-08-05T10:00:00.000Z');

describe('assertUnderCostCap — the ceiling fails closed', () => {
  it('refuses when the cap itself cannot be read', async () => {
    // Both queries used to discard their `error`, so a PostgREST error, a 5xx or
    // a dropped socket made `data` null — and null read as "there is no cap".
    // The window in which that read fails is the window in which something is
    // hammering the database, which is the window a runaway loop produces. This
    // is the guarantee `routes/gmail-webhook.ts` makes in writing about the one
    // publicly reachable route.
    await assert.rejects(
      () => assertUnderCostCap(costDb({ capError: 'connection reset by peer' }), AT),
      (error: unknown) => error instanceof LlmError && error.kind === 'cost_cap',
    );
  });

  it("refuses when today's spend cannot be read", async () => {
    // A sum we could not read is not evidence that nothing has been spent. Same
    // rule `guardrails.ts` already applies to the outbound send count.
    await assert.rejects(
      () => assertUnderCostCap(costDb({ cap: 2, runsError: 'statement timeout' }), AT),
      (error: unknown) => error instanceof LlmError && error.kind === 'cost_cap',
    );
  });

  it('refuses when there are more runs today than the sum can be trusted over', async () => {
    // `select('cost_usd')` with no bound is silently truncated by PostgREST's
    // db-max-rows if the project sets one, and a truncated sum under-counts,
    // which is a cap that never trips. Asking for one row more than the ceiling
    // turns that from invisible into a refusal.
    const runs = Array.from({ length: MAX_COST_ROWS + 1 }, () => ({ cost_usd: 0 }));
    await assert.rejects(
      () => assertUnderCostCap(costDb({ cap: 2, runs }), AT),
      (error: unknown) => error instanceof LlmError && error.kind === 'cost_cap',
    );
  });

  it('treats an unset cap as no ceiling, because that is a value somebody chose', async () => {
    // The distinction the whole function turns on: a row that is absent is a
    // decision, a row that could not be read is an outage.
    await assert.doesNotReject(() => assertUnderCostCap(costDb({}), AT));
  });

  it('refuses once the day is over the cap', async () => {
    await assert.rejects(
      () => assertUnderCostCap(costDb({ cap: 2, runs: [{ cost_usd: 1.5 }, { cost_usd: 0.6 }] }), AT),
      /Daily cost cap reached/,
    );
  });

  it('allows a day that is under it, ignoring rows with no cost recorded', async () => {
    await assert.doesNotReject(() =>
      assertUnderCostCap(costDb({ cap: 2, runs: [{ cost_usd: 0.1 }, { cost_usd: null }] }), AT),
    );
  });
});
