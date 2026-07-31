/**
 * Token pricing and cost arithmetic.
 *
 * **Pure by construction.** No clock, no network, no SDK. Every input is passed
 * in, including the instant a call happened — so the daily spend cap and the
 * `agent_runs.cost_usd` column can be unit tested without an API key, the same
 * discipline as cadence.ts.
 *
 * The cap in PLAN.md §5 is only as good as this arithmetic: a cost calculation
 * that quietly under-reports would let a loop bug run past a ceiling that looks
 * like it is holding.
 */

/** The only two models v1 uses. PLAN.md §2 — no Opus anywhere. */
export const MODELS = ['claude-sonnet-5', 'claude-haiku-4-5'] as const;
export type Model = (typeof MODELS)[number];

export function isModel(value: unknown): value is Model {
  return typeof value === 'string' && (MODELS as readonly string[]).includes(value);
}

/** USD per million tokens. */
type Rate = { input: number; output: number };

/**
 * Claude Sonnet 5 launched with introductory pricing that expires. Encoding the
 * window rather than hard-coding one number means `cost_usd` matches the actual
 * invoice on both sides of the boundary — and that the row written today still
 * reads correctly next year, because the rate is derived from when the call
 * happened rather than from when the report is run.
 *
 * The end is exclusive: the last billed day at the intro rate is 2026-08-31, so
 * the standard rate applies from 2026-09-01T00:00:00Z.
 */
const SONNET_INTRO_ENDS_AT = Date.UTC(2026, 8, 1); // 2026-09-01T00:00:00Z

const RATES: Record<Model, { standard: Rate; intro?: { until: number; rate: Rate } }> = {
  'claude-sonnet-5': {
    standard: { input: 3, output: 15 },
    intro: { until: SONNET_INTRO_ENDS_AT, rate: { input: 2, output: 10 } },
  },
  'claude-haiku-4-5': {
    standard: { input: 1, output: 5 },
  },
};

/** Cache writes cost 1.25x base input (5-minute TTL); reads cost 0.1x. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** The usage shape the Messages API returns. Named fields, not the SDK type, so
 *  this module stays dependency-free and testable. */
export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  /** Tokens written to the prompt cache this call. Billed at 1.25x input. */
  cache_creation_input_tokens?: number | null;
  /** Tokens served from the prompt cache. Billed at 0.1x input. */
  cache_read_input_tokens?: number | null;
};

export function rateFor(model: Model, at: Date): Rate {
  const entry = RATES[model];
  const intro = entry.intro;
  if (intro !== undefined && at.getTime() < intro.until) return intro.rate;
  return entry.standard;
}

/** True while `model` is inside an introductory pricing window at `at`. */
export function isIntroPricing(model: Model, at: Date): boolean {
  const intro = RATES[model].intro;
  return intro !== undefined && at.getTime() < intro.until;
}

/**
 * Cost of one call, in USD.
 *
 * Cache-aware, because PLAN.md §2 puts the whole `brain` block behind a
 * `cache_control` breakpoint: on a 40-contact morning run all but the first call
 * bills most of its input at a tenth of the rate, and a formula that ignored
 * that would over-report by roughly the size of the brain, every run.
 *
 * Never returns NaN or a negative — a malformed usage object costs 0 rather than
 * poisoning the daily total with NaN, which would make every subsequent cap
 * comparison false and disable the ceiling silently.
 */
export function costUsd(model: Model, usage: TokenUsage, at: Date): number {
  const rate = rateFor(model, at);

  const n = (value: number | null | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

  const perToken = (usd: number): number => usd / 1_000_000;

  const input = n(usage.input_tokens) * perToken(rate.input);
  const output = n(usage.output_tokens) * perToken(rate.output);
  const cacheWrite =
    n(usage.cache_creation_input_tokens) * perToken(rate.input) * CACHE_WRITE_MULTIPLIER;
  const cacheRead =
    n(usage.cache_read_input_tokens) * perToken(rate.input) * CACHE_READ_MULTIPLIER;

  return input + output + cacheWrite + cacheRead;
}

/** Round to the cent for display. Never used for the cap comparison — that runs
 *  on the full-precision figure, so a run of sub-cent calls still accumulates. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}
