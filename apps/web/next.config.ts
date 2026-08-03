import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NextConfig } from 'next';

/**
 * The ONLY variables apps/web is allowed to see.
 *
 * This is the point of the allow-list, and it is a security control rather than
 * tidiness: the root `.env` also holds `SUPABASE_SERVICE_ROLE_KEY`,
 * `ANTHROPIC_API_KEY`, `GMAIL_REFRESH_TOKEN` and `VAPID_PRIVATE_KEY`. Copying
 * the whole file onto `process.env` would put every one of them inside the web
 * server process — and `createServiceClient()` from @agency/core would then
 * return a working, RLS-bypassing client to any server file that imported it.
 * The comment in lib/supabase/server.ts says that must never happen; this is
 * what makes it true rather than aspirational. With the key absent,
 * `createServiceClient()` throws `MissingEnvError` instead.
 *
 * Names are exactly PLAN.md §8. Adding one here means apps/web genuinely needs
 * it in the browser or in a Server Component — say why in the same commit.
 *
 * Mirror this in production: never set `SUPABASE_SERVICE_ROLE_KEY` (or any of
 * the other four) on the Vercel project. They belong to the Railway worker.
 *
 * `VAPID_PUBLIC_KEY` is the fifth name and the only one that is deliberately
 * shared with the worker, because it is a public key: the browser needs it to
 * create a push subscription (step 7), and a value that ships to every visitor
 * of /brain cannot be leaked by being in this process. It is read server-side by
 * app/(app)/brain/page.tsx and passed to the toggle as a prop rather than being
 * renamed `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, which would be a second name for the
 * same secret-free value plus a new entry in `ENV_VARS` and a new static read in
 * env.ts. Without this line the key is `undefined` in local development and the
 * toggle renders its "not configured" state forever.
 *
 * `VAPID_PRIVATE_KEY` is the other half of that pair and is **not** here, and
 * must never be set on the Vercel project. It signs the pushes; the worker is
 * the only thing that sends them.
 */
const WEB_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'ALLOWED_EMAIL',
  'TZ',
  'VAPID_PUBLIC_KEY',
]);

/**
 * Next.js reads `.env` from its own project directory (apps/web), not from the
 * monorepo root — it does not walk up. The operator keeps one `.env` at the repo
 * root (README setup step 3), so without this the whole `NEXT_PUBLIC_SUPABASE_*`
 * group is `undefined` in the web app and `supabaseBrowserEnv()` throws.
 *
 * This runs in Node before Next compiles anything, so `NEXT_PUBLIC_*` values
 * placed on `process.env` here are still inlined into the client bundle.
 *
 * Real platform variables always win: a key already present in `process.env`
 * (Vercel, Railway, the shell) is never overwritten by the file.
 */
function loadRootEnv(): void {
  // `next dev` / `next build` run with cwd = apps/web.
  const path = resolve(process.cwd(), '../../.env');
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (key === '' || !WEB_ENV_ALLOWLIST.has(key)) continue;
    if (process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value.charAt(0);
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: strip a trailing ` # comment`, the same way dotenv does.
      value = value.replace(/\s+#.*$/, '').trim();
    }

    process.env[key] = value;
  }
}

loadRootEnv();

/**
 * @agency/core is consumed as TypeScript source (its package.json points
 * "main"/"types" at ./src/index.ts), so Next has to transpile it itself.
 */
const nextConfig: NextConfig = {
  transpilePackages: ['@agency/core'],

  /**
   * Pin the monorepo root. Next infers it by walking up for a lockfile, and an
   * unrelated `package-lock.json` further up the tree (e.g. in the home
   * directory) wins over our `pnpm-lock.yaml` — Next then traces file
   * dependencies from the wrong root, which warns locally and can ship the
   * wrong set of files in a standalone build.
   */
  outputFileTracingRoot: resolve(process.cwd(), '../..'),
};

export default nextConfig;
