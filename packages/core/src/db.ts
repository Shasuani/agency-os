/**
 * Supabase client factories.
 *
 * There are exactly two, and the difference is the whole security model:
 *
 *   createBrowserClient()  anon key.          RLS APPLIES.    apps/web.
 *   createServiceClient()  service role key.  RLS BYPASSED.   apps/worker ONLY.
 *
 * RLS is enabled on every table with the single policy `auth.uid() is not null`
 * (PLAN.md §4). The anon client therefore sees nothing until the operator is
 * signed in via magic link; the service client sees and writes everything, with
 * no user attached to the request.
 *
 * The service role key must never reach a browser bundle. It is not prefixed
 * `NEXT_PUBLIC_`, so Next.js will not inline it — and `createServiceClient()`
 * throws loudly if it is called anywhere the key is absent, which is what would
 * happen if someone imported it into a client component.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { supabaseBrowserEnv, supabaseServiceEnv } from './env';
import type { Database } from './types';

/** Every client in this repo is typed against the schema. */
export type Db = SupabaseClient<Database>;

/**
 * Anon-key client. RLS APPLIES — this client can only read and write what the
 * signed-in operator is allowed to. Use in apps/web (browser and route handlers
 * acting on behalf of the user).
 *
 * Not memoised: Next.js request lifecycles make a shared singleton a footgun,
 * and constructing a client is cheap.
 */
export function createBrowserClient(): Db {
  const { url, anonKey } = supabaseBrowserEnv();
  return createClient<Database>(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

/**
 * Service-role client. RLS IS BYPASSED — this client can read and write every
 * row in the database with no user context. apps/worker ONLY. Never import this
 * from apps/web, and never from anything that ends up in a browser bundle.
 *
 * Throws with an explicit message if SUPABASE_SERVICE_ROLE_KEY is not present,
 * rather than quietly falling back to the anon key.
 */
export function createServiceClient(): Db {
  // Checked via globalThis rather than a bare `window` so this file needs no DOM lib
  // — core is server-side by default and should not pull browser types in wholesale.
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
    throw new Error(
      'createServiceClient() was called in a browser context. The Supabase service role key ' +
        'bypasses RLS and must never leave the worker. Use createBrowserClient() instead.',
    );
  }

  // Throws MissingEnvError naming SUPABASE_SERVICE_ROLE_KEY when it is absent.
  const { url, serviceRoleKey } = supabaseServiceEnv();

  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
