import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NextConfig } from 'next';

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
    if (key === '' || process.env[key] !== undefined) continue;

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
};

export default nextConfig;
