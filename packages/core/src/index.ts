/**
 * @agency/core — shared package for apps/web and apps/worker.
 *
 * Consumed as TypeScript source (never built to dist): Next.js reads it via
 * `transpilePackages: ['@agency/core']`, the worker runs it under tsx.
 *
 * Later steps add to this package, not to the apps:
 *   cadence.ts     step 3
 *   llm.ts         step 4
 *   guardrails.ts  step 6
 *   gmail.ts       step 6
 *   prompts/       steps 5 and 8
 */

export * from './types';
export * from './env';
export * from './db';
export * from './settings';
export * from './cadence';
export * from './pricing';

/**
 * `llm.ts` is deliberately NOT re-exported here.
 *
 * It value-imports @anthropic-ai/sdk, and apps/web's Server Components import
 * this barrel for `appTimezone`/`authEnv` — so re-exporting it put the whole
 * Anthropic SDK into the Next.js server bundle for an app that never calls a
 * model. Worse, it made an LLM call reachable from a Server Action by autocomplete.
 *
 * The worker imports it explicitly from the `@agency/core/llm` subpath, the same
 * arrangement as `@agency/core/cadence`. `pricing.ts` stays here: it is pure
 * arithmetic with no SDK import, and the web app may legitimately want to
 * display a cost.
 */

/**
 * Note on `./cadence`: this barrel value-imports `./db`, which constructs the
 * service-role Supabase client factory. A Client Component must therefore never
 * import cadence constants from `@agency/core` — package.json exposes the
 * subpath `@agency/core/cadence`, which is a leaf module with no Supabase
 * import, for exactly that case.
 */
