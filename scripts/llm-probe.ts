/**
 * Step 4 acceptance test (PLAN.md §6): prove a real model call lands in
 * `agent_runs` with correct token counts and a cost within a cent of
 * hand-calculation.
 *
 *   pnpm exec tsx scripts/llm-probe.ts            # calls Haiku, the cheap one
 *   pnpm exec tsx scripts/llm-probe.ts --sonnet   # calls Sonnet
 *   pnpm exec tsx scripts/llm-probe.ts --no-db    # skip the agent_runs check
 *
 * Needs ANTHROPIC_API_KEY. The `--no-db` mode needs nothing else, so the wrapper
 * can be exercised before Supabase exists — which is the situation this project
 * is actually in. Without it, a Supabase project is required for the cost-cap
 * read and the run row.
 *
 * This costs real money: roughly $0.00002 on Haiku. Not zero, but not a rounding
 * error away from zero either.
 */

import { costUsd, type Model } from '@agency/core';

const useSonnet = process.argv.includes('--sonnet');
const skipDb = process.argv.includes('--no-db');
const model: Model = useSonnet ? 'claude-sonnet-5' : 'claude-haiku-4-5';

const SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string', enum: ['el', 'en'] },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
    summary: { type: 'string' },
  },
  required: ['language', 'sentiment', 'summary'],
  additionalProperties: false,
} as const;

type Result = { language: string; sentiment: string; summary: string };

async function main(): Promise<void> {
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ANTHROPIC_API_KEY is not set. Put a real key in .env — see PLAN.md §8.');
    process.exit(1);
  }

  console.log(`model: ${model}`);
  console.log(skipDb ? 'mode:  direct SDK (no agent_runs row)\n' : 'mode:  full wrapper\n');

  if (skipDb) {
    // Exercise the same request shape the wrapper builds, without the database
    // round-trips. Proves the parameter rules and structured output are right.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { requestShapeFor } = await import('@agency/core/llm');
    const client = new Anthropic();

    const started = Date.now();
    const response = await client.messages.create({
      model,
      max_tokens: 300,
      system: [{ type: 'text', text: 'You classify short business messages.' }],
      messages: [
        { role: 'user', content: 'Καλησπέρα, ενδιαφέρομαι για μια νέα ιστοσελίδα. Πόσο κοστίζει;' },
      ],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      ...requestShapeFor(model),
    } as never);
    const durationMs = Date.now() - started;

    report(response, durationMs);
    return;
  }

  const { call } = await import('@agency/core/llm');
  const started = Date.now();
  const result = await call<Result>({
    agent: 'probe',
    trigger: 'manual',
    model,
    system: [{ text: 'You classify short business messages.', cache: false }],
    user: 'Καλησπέρα, ενδιαφέρομαι για μια νέα ιστοσελίδα. Πόσο κοστίζει;',
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 300,
  });
  console.log(`parsed:   ${JSON.stringify(result)}`);
  console.log(`duration: ${Date.now() - started}ms`);
  console.log('\nNow check the row landed:');
  console.log("  select agent, model, input_tokens, output_tokens, cost_usd, duration_ms");
  console.log("  from agent_runs order by created_at desc limit 1;");
}

function report(response: unknown, durationMs: number): void {
  const r = response as {
    stop_reason: string;
    content: Array<{ type: string; text?: string }>;
    usage: Record<string, number>;
  };

  console.log(`stop_reason: ${r.stop_reason}`);
  if (r.stop_reason === 'refusal') {
    console.log('The model refused. Nothing to cost out.');
    return;
  }

  const text = r.content.find((b) => b.type === 'text')?.text ?? '';
  console.log(`output:      ${text}`);
  console.log(`valid JSON:  ${(() => { try { JSON.parse(text); return 'yes'; } catch { return 'NO'; } })()}`);
  console.log(`duration:    ${durationMs}ms`);

  const usage = r.usage;
  console.log('\nusage:');
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v === 'number') console.log(`  ${k.padEnd(30)} ${v}`);
  }

  const at = new Date();
  const cost = costUsd(model, usage as never, at);
  const rate = model === 'claude-haiku-4-5' ? { i: 1, o: 5 } : { i: 2, o: 10 };
  const byHand =
    ((usage['input_tokens'] ?? 0) / 1e6) * rate.i + ((usage['output_tokens'] ?? 0) / 1e6) * rate.o;

  console.log('\ncost:');
  console.log(`  costUsd()        $${cost.toFixed(8)}`);
  console.log(`  by hand          $${byHand.toFixed(8)}   (${usage['input_tokens']}/1e6*$${rate.i} + ${usage['output_tokens']}/1e6*$${rate.o})`);
  const delta = Math.abs(cost - byHand);
  console.log(`  difference       $${delta.toFixed(8)}  ${delta < 0.01 ? '✓ within a cent' : '✗ OVER A CENT'}`);
}

main().catch((error: unknown) => {
  console.error('\nprobe failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
