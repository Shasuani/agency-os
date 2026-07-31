'use client';

/**
 * The Supabase client for Client Components.
 *
 * ANON KEY ONLY, and it could not be otherwise: this file is bundled and shipped
 * to the browser, so the only credential it may ever touch is
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY`. RLS is what protects the data (PLAN.md §4).
 *
 * Nothing in step 2 needs it — reads are Server Components and writes are Server
 * Actions (no client-side data fetching, by contract). It exists for the things
 * that genuinely have to run in the browser later: the Web Push subscription
 * flow in step 7, and any realtime subscription. If you are reaching for it to
 * fetch rows, use lib/contacts.ts from a Server Component instead.
 */

import { createBrowserClient } from '@supabase/ssr';

import type { Database } from '@agency/core';

/**
 * Static reads, not `supabaseBrowserEnv()` from @agency/core.
 *
 * Two reasons, and they are the same two everywhere else in this directory:
 * Next only inlines `process.env.X` when it appears as a literal expression, and
 * value-importing the core barrel from a `'use client'` module drags `./db` —
 * and with it the service-role client factory — into the browser bundle. No key
 * would leak (`SUPABASE_SERVICE_ROLE_KEY` is not `NEXT_PUBLIC_`, is read by
 * computed key, and is not even present in the web build's environment; see
 * `WEB_ENV_ALLOWLIST` in next.config.ts), but shipping the factory at all is a
 * standing invitation, and this file exists to be copied from later.
 */
function browserSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (url === undefined || url === '' || anonKey === undefined || anonKey === '') {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (needed by the browser ' +
        'Supabase client). Set them in .env / the deployment environment — see PLAN.md §8.',
    );
  }

  return { url, anonKey };
}

let client: ReturnType<typeof createBrowserClient<Database>> | undefined;

/**
 * Memoised for the lifetime of the tab. In the browser there is exactly one
 * session and one set of auth cookies, and creating a second client means two
 * token-refresh timers racing each other.
 */
export function createSupabaseBrowserClient() {
  if (client === undefined) {
    const { url, anonKey } = browserSupabaseEnv();
    client = createBrowserClient<Database>(url, anonKey);
  }
  return client;
}
