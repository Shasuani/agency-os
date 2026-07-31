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

import { requestShapeFor } from './llm';

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
