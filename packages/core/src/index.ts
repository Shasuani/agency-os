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

/**
 * Note on `./cadence`: this barrel value-imports `./db`, which constructs the
 * service-role Supabase client factory. A Client Component must therefore never
 * import cadence constants from `@agency/core` — package.json exposes the
 * subpath `@agency/core/cadence`, which is a leaf module with no Supabase
 * import, for exactly that case.
 */
