/**
 * The one place a model gets called.
 *
 * PLAN.md §5: nothing else in this codebase imports `@anthropic-ai/sdk`. Every
 * agent goes through `call()`, which means every call is logged to `agent_runs`
 * with its model, tokens, cost and duration — and, crucially, that there is one
 * place to fix when a model's parameter rules change rather than five.
 *
 * What this wrapper is actually protecting against:
 *
 * 1. **Model-specific parameter traps.** Sonnet 5 runs adaptive thinking when
 *    `thinking` is omitted, which is wasted spend on a short drafting call and
 *    eats the `max_tokens` budget the draft needs. Haiku 4.5 rejects
 *    `output_config.effort` outright. Both models reject non-default
 *    `temperature`/`top_p`/`top_k` with a 400. Callers get none of these knobs.
 *
 * 2. **Unstructured output.** Every call must pass a JSON Schema. There is no
 *    "just give me the text" path, because that is the path where an agent
 *    starts parsing prose with a regex.
 *
 * 3. **Silent failure.** A refusal, a truncation, a schema mismatch and a
 *    network error are four different things, and each writes an `agent_runs`
 *    row saying which. SPEC §8: retry once, then file an alert task, never
 *    swallow.
 *
 * 4. **Runaway spend.** The daily ceiling is checked before every call, not
 *    after. A loop bug at 03:00 stops at the cap instead of at the invoice.
 *
 * Not affected by `DRY_RUN`. Dry-run stubs the Gmail send (PLAN.md §7) — the
 * whole point is that agents still run and still produce real drafts to look at.
 */

import Anthropic from '@anthropic-ai/sdk';

import { createServiceClient } from './db';
import type { Db } from './db';
import { appTimezone } from './env';
import { costUsd, isModel, type Model, type TokenUsage } from './pricing';
import { partsInZone, zonedTimeToUtc } from './zone';

export { MODELS, isModel, costUsd, formatUsd, type Model } from './pricing';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type Trigger = 'cron' | 'webhook' | 'manual';

/**
 * A system-prompt block. Set `cache` on the last stable block — normally the
 * `brain` — and everything up to it is billed at a tenth of the rate on every
 * subsequent call in the run (PLAN.md §2).
 *
 * Order matters and is the caller's responsibility: stable content first,
 * per-contact content after. A timestamp in an early block invalidates the
 * cache for every block behind it.
 */
export type SystemBlock = { text: string; cache?: boolean };

export type CallOpts = {
  /** Which agent is calling — 'followup', 'inbox', … Written to agent_runs. */
  agent: string;
  trigger: Trigger;
  model: Model;
  system: SystemBlock[];
  user: string;
  /** JSON Schema. Required — there is no unstructured path. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Recorded on the run row so a bad output can be traced to its contact. */
  contactId?: string | null;
};

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'cost_cap'
      | 'refusal'
      | 'truncated'
      | 'invalid_json'
      | 'schema_mismatch'
      | 'api_error',
    readonly runId?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const DEFAULT_MAX_TOKENS = 2000;

// ---------------------------------------------------------------------------
// Per-model request shaping — the traps this wrapper exists to hide
// ---------------------------------------------------------------------------

/**
 * Build the model-specific half of the request.
 *
 * Exported and pure so the parameter rules are unit-testable without an API key.
 * Getting these wrong is a 400 at 08:00 on a cron nobody is watching.
 */
export function requestShapeFor(model: Model): Record<string, unknown> {
  if (model === 'claude-sonnet-5') {
    // Adaptive thinking is ON when `thinking` is omitted on Sonnet 5. Disabled
    // explicitly: these are short structured drafts, and thinking tokens would
    // both cost money and compete with the draft for max_tokens.
    return { thinking: { type: 'disabled' } };
  }
  // Haiku 4.5 predates `output_config.effort` and errors if it is sent. It also
  // uses the older thinking config, which classification does not need.
  return {};
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

let cachedClient: Anthropic | null = null;

function client(): Anthropic {
  if (cachedClient === null) {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined || apiKey === '') {
      throw new LlmError(
        'ANTHROPIC_API_KEY is not set. See PLAN.md §8.',
        'api_error',
      );
    }
    cachedClient = new Anthropic({ apiKey, maxRetries: 0 }); // retries are ours, so they get logged
  }
  return cachedClient;
}

/**
 * Rows of `agent_runs` the spend query will read for one day.
 *
 * A busy day is a few hundred: forty contacts at one or two calls each, plus
 * inbound. Five thousand is far past anything this system can legitimately
 * produce, and reaching it means either a loop — which is the thing the cap
 * exists to stop — or a PostgREST `db-max-rows` ceiling truncating the answer.
 * Either way the sum is no longer the day's spend, and see `assertUnderCostCap`
 * for what happens then.
 */
export const MAX_COST_ROWS = 5000;

/**
 * The start of today, in the operator's zone.
 *
 * Everything else in this repo — the 08:00 run, the send window, the cadence
 * dates — is `Europe/Athens`, and a cap that resets at 03:00 local in summer is
 * a cap that behaves differently in July than in January for no reason anybody
 * could reconstruct from the setting's name.
 */
function startOfLocalDay(now: Date, timeZone: string): Date {
  const parts = partsInZone(now, timeZone);
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, timeZone);
}

/**
 * Sum today's spend from `agent_runs` and compare against `settings.daily_cost_cap`.
 *
 * Checked BEFORE the call rather than after: the failure this guards against is
 * a retry loop, and a loop that checks afterwards has already spent the money.
 *
 * ---------------------------------------------------------------------------
 * Both reads fail CLOSED, and this is the whole point of the function
 * ---------------------------------------------------------------------------
 *
 * This is the only spend ceiling in the repo. `LlmError.kind === 'cost_cap'` is
 * thrown from nowhere else, and `routes/gmail-webhook.ts` promises in writing
 * that a loop pointed at the public webhook URL by somebody holding both
 * credentials "still cannot spend more than `settings.daily_cost_cap` in a day".
 *
 * Both queries used to discard their `error`. A PostgREST error, a 5xx, a pooler
 * restart or a dropped socket on either one made `data` null, and null read as
 * *there is no cap* on the first query and as *nothing has been spent* on the
 * second. So the one guarantee the public route makes held only while two
 * unchecked reads succeeded — and the window in which they fail is exactly the
 * window in which something is hammering the database, which is the window a
 * runaway loop produces. `guardrails.ts` states the same rule for the send count
 * and follows it: a count we could not read is not evidence that nothing went
 * out.
 *
 * So: a read that errors throws `cost_cap` and halts the agent. An unset or
 * non-numeric `daily_cost_cap` still means no ceiling — that is a value somebody
 * chose, not a value we failed to read — and the seed writes one.
 *
 * The row ceiling is the third failure of the same shape. `select('cost_usd')`
 * with no bound is silently truncated by PostgREST's `db-max-rows` if the
 * project sets one, and a truncated sum under-counts, which is a cap that never
 * trips. Asking for one row more than the ceiling turns that from invisible into
 * a refusal.
 */
export async function assertUnderCostCap(
  /** Injectable so the fail-closed branches can be proved without a database. */
  db?: Db,
  /** Injectable so the day boundary can be asserted at a known instant. */
  now: Date = new Date(),
): Promise<void> {
  const supabase = db ?? createServiceClient();

  const { data: setting, error: settingError } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_cost_cap')
    .maybeSingle();

  if (settingError !== null) {
    throw new LlmError(
      `Could not read settings.daily_cost_cap (${settingError.message}). Refusing to call a ` +
        'model rather than run with no spend ceiling.',
      'cost_cap',
    );
  }

  const cap = typeof setting?.value === 'number' ? setting.value : null;
  if (cap === null) return; // unset means no ceiling; the seed sets one

  const since = startOfLocalDay(now, appTimezone());

  const { data: runs, error: runsError } = await supabase
    .from('agent_runs')
    .select('cost_usd')
    .gte('created_at', since.toISOString())
    .limit(MAX_COST_ROWS + 1);

  if (runsError !== null) {
    throw new LlmError(
      `Could not read today's spend from agent_runs (${runsError.message}). Refusing to call a ` +
        'model rather than assume the daily cost cap is clear.',
      'cost_cap',
    );
  }

  const rows = runs ?? [];
  if (rows.length > MAX_COST_ROWS) {
    throw new LlmError(
      `There are more than ${MAX_COST_ROWS} agent runs today, which is far past anything this ` +
        'system produces legitimately. Today\'s spend can no longer be summed reliably, so no ' +
        'further model calls are made. Look for a loop before raising anything.',
      'cost_cap',
    );
  }

  const spent = rows.reduce(
    (total, row) => total + (typeof row.cost_usd === 'number' ? row.cost_usd : 0),
    0,
  );

  if (spent >= cap) {
    throw new LlmError(
      `Daily cost cap reached: $${spent.toFixed(4)} of $${cap.toFixed(2)}. ` +
        'No further model calls today. Raise settings.daily_cost_cap to continue.',
      'cost_cap',
    );
  }
}

/**
 * Call a model and get back schema-valid JSON, with the run logged either way.
 *
 * Retries exactly once on a transient failure, then gives up and files an alert
 * task. It does not retry a refusal or a cost-cap stop — those are decisions,
 * not glitches, and repeating them just spends money to be told no twice.
 */
export async function call<T>(opts: CallOpts): Promise<T> {
  if (!isModel(opts.model)) {
    throw new LlmError(`Unknown model: ${String(opts.model)}`, 'api_error');
  }

  await assertUnderCostCap();

  let lastError: LlmError | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await client().messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: opts.system.map((block) => ({
          type: 'text' as const,
          text: block.text,
          ...(block.cache === true ? { cache_control: { type: 'ephemeral' as const } } : {}),
        })),
        messages: [{ role: 'user', content: opts.user }],
        output_config: { format: { type: 'json_schema', schema: opts.schema } },
        ...requestShapeFor(opts.model),
        // temperature / top_p / top_k are deliberately never sent: both models
        // reject non-default values with a 400.
      } as Anthropic.MessageCreateParamsNonStreaming);

      const durationMs = Date.now() - startedAt;
      const usage = response.usage as unknown as TokenUsage;
      const cost = costUsd(opts.model, usage, new Date());

      // stop_reason is checked BEFORE content is read. A refusal has an empty
      // content array and a truncation has a half-written one; indexing content[0]
      // first is how those become a confusing TypeError instead of a clear log line.
      if (response.stop_reason === 'refusal') {
        const runId = await logRun(opts, 'error', { usage, cost, durationMs },
          'Model refused the request.', null);
        throw new LlmError('Model refused the request.', 'refusal', runId);
      }
      if (response.stop_reason === 'max_tokens') {
        const runId = await logRun(opts, 'error', { usage, cost, durationMs },
          'Output hit max_tokens and is truncated.', null);
        throw new LlmError(
          `Output truncated at max_tokens (${opts.maxTokens ?? DEFAULT_MAX_TOKENS}). Raise maxTokens.`,
          'truncated',
          runId,
        );
      }

      const text = response.content.find((block) => block.type === 'text');
      if (text === undefined || text.type !== 'text') {
        const runId = await logRun(opts, 'error', { usage, cost, durationMs },
          'Response contained no text block.', null);
        throw new LlmError('Response contained no text block.', 'invalid_json', runId);
      }

      let parsed: T;
      try {
        parsed = JSON.parse(text.text) as T;
      } catch {
        // output_config.format should make this impossible. If it happens, the
        // request shape is wrong — worth an alert rather than a silent retry.
        const runId = await logRun(opts, 'error', { usage, cost, durationMs },
          'Structured output was not valid JSON.', null);
        throw new LlmError('Structured output was not valid JSON.', 'schema_mismatch', runId);
      }

      await logRun(opts, 'ok', { usage, cost, durationMs }, null, parsed);
      return parsed;
    } catch (error) {
      if (error instanceof LlmError) {
        // Refusals and cap stops are final. Everything else gets one retry.
        if (error.kind === 'refusal' || error.kind === 'cost_cap') throw error;
        lastError = error;
      } else {
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        await logRun(opts, 'error', { usage: null, cost: 0, durationMs }, message, null);
        lastError = new LlmError(message, 'api_error');
      }

      if (attempt === 2) break;
    }
  }

  await fileAlertTask(opts, lastError);
  throw lastError ?? new LlmError('Model call failed.', 'api_error');
}

// ---------------------------------------------------------------------------
// Observability — the reason agent_runs exists
// ---------------------------------------------------------------------------

async function logRun(
  opts: CallOpts,
  status: 'ok' | 'error',
  metrics: { usage: TokenUsage | null; cost: number; durationMs: number },
  error: string | null,
  output: unknown,
): Promise<string | undefined> {
  try {
    const supabase = createServiceClient();
    const { data } = await supabase
      .from('agent_runs')
      .insert({
        agent: opts.agent,
        trigger: opts.trigger,
        input: { system_blocks: opts.system.length, user_chars: opts.user.length,
                 contact_id: opts.contactId ?? null },
        output: (output ?? null) as never,
        status,
        error,
        model: opts.model,
        input_tokens: metrics.usage?.input_tokens ?? null,
        output_tokens: metrics.usage?.output_tokens ?? null,
        cost_usd: metrics.cost,
        duration_ms: metrics.durationMs,
      })
      .select('id')
      .maybeSingle();
    return data?.id;
  } catch {
    // Logging must never be the thing that breaks a run. The call itself already
    // succeeded or failed on its own terms; losing the row is the lesser harm.
    return undefined;
  }
}

/** SPEC §8: a run that errors twice surfaces as something the operator sees. */
async function fileAlertTask(opts: CallOpts, error: LlmError | null): Promise<void> {
  try {
    const supabase = createServiceClient();
    await supabase.from('tasks').insert({
      agent: opts.agent,
      type: 'alert',
      contact_id: opts.contactId ?? null,
      title: `${opts.agent} failed after a retry`,
      reasoning: error?.message ?? 'Unknown failure.',
      status: 'pending',
      autonomy_level: 1,
    });
  } catch {
    // Nothing left to escalate to.
  }
}
