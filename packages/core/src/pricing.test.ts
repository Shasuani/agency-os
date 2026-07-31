/**
 * Cost arithmetic tests.
 *
 * These matter more than they look: `settings.daily_cost_cap` is only a ceiling
 * if the number it compares against is right, and a cost function that
 * under-reports turns the cap into decoration.
 *
 * Every figure below is hand-calculated in the comment above it, per PLAN.md §6
 * step 4's acceptance criterion — "a cost within a cent of hand-calculation".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { costUsd, isIntroPricing, isModel, rateFor } from './pricing';

/** Inside the Sonnet introductory window (ends 2026-09-01T00:00:00Z). */
const DURING_INTRO = new Date('2026-07-31T12:00:00Z');
/** After it. */
const AFTER_INTRO = new Date('2026-09-01T00:00:00Z');

describe('model vocabulary', () => {
  it('accepts only the two models v1 uses', () => {
    assert.equal(isModel('claude-sonnet-5'), true);
    assert.equal(isModel('claude-haiku-4-5'), true);
  });

  it('rejects Opus, which PLAN §2 forbids in v1', () => {
    assert.equal(isModel('claude-opus-5'), false);
    assert.equal(isModel('claude-opus-4-8'), false);
  });

  it('rejects nonsense', () => {
    assert.equal(isModel(''), false);
    assert.equal(isModel(null), false);
    assert.equal(isModel(42), false);
  });
});

describe('rates', () => {
  it('Sonnet 5 bills at the intro rate before 2026-09-01', () => {
    assert.deepEqual(rateFor('claude-sonnet-5', DURING_INTRO), { input: 2, output: 10 });
    assert.equal(isIntroPricing('claude-sonnet-5', DURING_INTRO), true);
  });

  it('Sonnet 5 bills at the standard rate from 2026-09-01', () => {
    assert.deepEqual(rateFor('claude-sonnet-5', AFTER_INTRO), { input: 3, output: 15 });
    assert.equal(isIntroPricing('claude-sonnet-5', AFTER_INTRO), false);
  });

  it('the intro boundary is exclusive — the last intro day is 2026-08-31', () => {
    const lastIntroMoment = new Date('2026-08-31T23:59:59Z');
    assert.equal(isIntroPricing('claude-sonnet-5', lastIntroMoment), true);
  });

  it('Haiku 4.5 has one rate and no intro window', () => {
    assert.deepEqual(rateFor('claude-haiku-4-5', DURING_INTRO), { input: 1, output: 5 });
    assert.deepEqual(rateFor('claude-haiku-4-5', AFTER_INTRO), { input: 1, output: 5 });
    assert.equal(isIntroPricing('claude-haiku-4-5', DURING_INTRO), false);
  });
});

describe('costUsd — hand-calculated', () => {
  it('Sonnet at intro rates: 10k in + 1k out', () => {
    // 10_000 / 1e6 * $2  = $0.02
    //  1_000 / 1e6 * $10 = $0.01
    //                    = $0.03
    const cost = costUsd(
      'claude-sonnet-5',
      { input_tokens: 10_000, output_tokens: 1_000 },
      DURING_INTRO,
    );
    assert.equal(cost.toFixed(4), '0.0300');
  });

  it('the same call after the intro window costs 50% more', () => {
    // 10_000 / 1e6 * $3  = $0.03
    //  1_000 / 1e6 * $15 = $0.015
    //                    = $0.045
    const cost = costUsd(
      'claude-sonnet-5',
      { input_tokens: 10_000, output_tokens: 1_000 },
      AFTER_INTRO,
    );
    assert.equal(cost.toFixed(4), '0.0450');
  });

  it('Haiku classification: 2k in + 100 out', () => {
    // 2_000 / 1e6 * $1 = $0.002
    //   100 / 1e6 * $5 = $0.0005
    //                  = $0.0025
    const cost = costUsd(
      'claude-haiku-4-5',
      { input_tokens: 2_000, output_tokens: 100 },
      DURING_INTRO,
    );
    assert.equal(cost.toFixed(4), '0.0025');
  });

  it('cache writes cost 1.25x input', () => {
    // 10_000 / 1e6 * $2 * 1.25 = $0.025
    const cost = costUsd(
      'claude-sonnet-5',
      { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 10_000 },
      DURING_INTRO,
    );
    assert.equal(cost.toFixed(4), '0.0250');
  });

  it('cache reads cost 0.1x input — the whole point of caching the brain', () => {
    // 10_000 / 1e6 * $2 * 0.1 = $0.002
    const cost = costUsd(
      'claude-sonnet-5',
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10_000 },
      DURING_INTRO,
    );
    assert.equal(cost.toFixed(4), '0.0020');
  });

  it('a cached morning run is far cheaper than an uncached one', () => {
    // PLAN §2's claim, checked rather than assumed. Same brain, 2nd contact on.
    const uncached = costUsd(
      'claude-sonnet-5',
      { input_tokens: 12_000, output_tokens: 300 },
      DURING_INTRO,
    );
    const cached = costUsd(
      'claude-sonnet-5',
      { input_tokens: 2_000, output_tokens: 300, cache_read_input_tokens: 10_000 },
      DURING_INTRO,
    );
    assert.ok(cached < uncached, 'cached call should be cheaper');
    // $0.0270 uncached vs $0.0090 cached — roughly a third.
    assert.equal(uncached.toFixed(4), '0.0270');
    assert.equal(cached.toFixed(4), '0.0090');
  });
});

describe('costUsd — malformed usage never poisons the daily total', () => {
  // A NaN cost makes every later `spent >= cap` comparison false, which would
  // disable the ceiling silently. Zero is the only safe answer here.
  it('returns 0, not NaN, for NaN token counts', () => {
    const cost = costUsd(
      'claude-sonnet-5',
      { input_tokens: Number.NaN, output_tokens: Number.NaN },
      DURING_INTRO,
    );
    assert.equal(Number.isNaN(cost), false);
    assert.equal(cost, 0);
  });

  it('ignores negative token counts rather than crediting them', () => {
    const cost = costUsd(
      'claude-sonnet-5',
      { input_tokens: -10_000, output_tokens: 1_000 },
      DURING_INTRO,
    );
    assert.ok(cost > 0, 'a negative input must not cancel out a real output cost');
    assert.equal(cost.toFixed(4), '0.0100');
  });

  it('treats null and undefined cache fields as zero', () => {
    const cost = costUsd(
      'claude-sonnet-5',
      {
        input_tokens: 1_000,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: undefined,
      },
      DURING_INTRO,
    );
    assert.equal(cost.toFixed(4), '0.0020');
  });

  it('a zero-token call costs nothing and is still a number', () => {
    const cost = costUsd('claude-haiku-4-5', { input_tokens: 0, output_tokens: 0 }, DURING_INTRO);
    assert.equal(cost, 0);
  });

  it('Infinity does not produce an Infinite cost', () => {
    const cost = costUsd(
      'claude-sonnet-5',
      { input_tokens: Number.POSITIVE_INFINITY, output_tokens: 10 },
      DURING_INTRO,
    );
    assert.equal(Number.isFinite(cost), true);
  });
});
