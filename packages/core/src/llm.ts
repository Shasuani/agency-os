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
import { costUsd, isModel, type Model, type TokenUsage } from './pricing';

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
 * Sum today's spend from `agent_runs` and compare against `settings.daily_cost_cap`.
 *
 * Checked BEFORE the call rather than after: the failure this guards against is
 * a retry loop, and a loop that checks afterwards has already spent the money.
 */
async function assertUnderCostCap(): Promise<void> {
  const supabase = createServiceClient();

  const { data: setting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_cost_cap')
    .maybeSingle();

  const cap = typeof setting?.value === 'number' ? setting.value : null;
  if (cap === null) return; // unset means no ceiling; the seed sets one

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  const { data: runs } = await supabase
    .from('agent_runs')
    .select('cost_usd')
    .gte('created_at', since.toISOString());

  const spent = (runs ?? []).reduce(
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
