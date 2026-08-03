/**
 * @agency/core — shared package for apps/web and apps/worker.
 *
 * Consumed as TypeScript source (never built to dist): Next.js reads it via
 * `transpilePackages: ['@agency/core']`, the worker runs it under tsx.
 *
 * Later steps add to this package, not to the apps:
 *   cadence.ts                          step 3
 *   llm.ts                              step 4
 *   zone.ts, send-window.ts,
 *   guardrails.ts, gmail.ts             step 6
 *   gmail-read.ts, gmail-mime.ts        step 8
 *
 * Roughly half of those are reachable only by subpath. The notes below say which
 * and why; the short version is that this barrel value-imports `./db`, so
 * anything re-exported here is something a Client Component or a Server Action
 * can reach by autocomplete.
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

/**
 * Step 6 adds four modules and puts none of them here. Each has its own subpath
 * in package.json, and each is off the barrel for its own reason:
 *
 *   @agency/core/gmail        opens sockets. It holds the OAuth exchange and the
 *                             `users.messages.send` call, caches an access token
 *                             at module scope, and is the only code in the repo
 *                             that can put a message in a stranger's inbox. That
 *                             is not something a Server Component should acquire
 *                             by importing `appTimezone` from the same specifier.
 *
 *   @agency/core/guardrails   is the send path. `assertSendAllowed` is the one
 *                             gate in front of `sendEmail`, and the pair should
 *                             be reached by writing the subpath on purpose. It is
 *                             also the module a future "send now" button would
 *                             misuse first; making it slightly awkward to find is
 *                             the point.
 *
 *   @agency/core/send-window  and
 *   @agency/core/zone         are pure leaves with no imports at all. They are
 *                             off the barrel for the opposite reason to the two
 *                             above: `zone.ts` is safe in a browser bundle, and
 *                             re-exporting it here would mean a Client Component
 *                             reaching timezone arithmetic through a specifier
 *                             that drags `@supabase/supabase-js` in behind it.
 *                             The subpath is what keeps that import honest.
 *
 * The same rule decides all four, and it is the rule `llm.ts` established: what
 * this file exports is what the whole repo can reach without thinking about it,
 * so it holds types, settings, env access and pure arithmetic — and nothing that
 * talks to a third party.
 */

/**
 * Step 8 adds one more subpath and, again, nothing here:
 *
 *   @agency/core/gmail-read   opens sockets, like `gmail` — and holds something
 *                             worse. It is the module that has a customer's
 *                             inbound email in memory: not a name and an address
 *                             but whatever they chose to write to a business in
 *                             confidence. Either reason alone would keep it off
 *                             the barrel; together they make it the module this
 *                             rule was written for. `apps/web` imports this file
 *                             for `appTimezone`, so re-exporting `gmail-read`
 *                             would put the inbound mail path in the Next.js
 *                             server bundle and make reading the operator's mail
 *                             reachable from a Server Action by autocomplete.
 *
 * `gmail-mime.ts` has no subpath at all, which is a stronger statement than
 * being off the barrel. It is the pure parsing leaf `gmail-read.ts` sits on —
 * MIME walking, charset decoding, quoted-reply stripping — and it is reached
 * only through `gmail-read`'s re-exports. Giving it its own specifier would
 * invite a caller to parse a message body somewhere that has no business
 * holding one, and there is no caller that needs the parser without the reader.
 *
 * The step-6 note above says the barrel holds nothing that talks to a third
 * party. Step 8 adds the other half of the same rule: it holds nothing that
 * holds a customer's words either.
 */
