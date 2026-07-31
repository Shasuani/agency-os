/**
 * The Supabase client for React Server Components, Server Actions and Route
 * Handlers.
 *
 * ANON KEY ONLY. apps/web reads and writes under RLS as the signed-in operator
 * (PLAN.md §4). `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and belongs to
 * apps/worker; it must never be imported, referenced, or bundled here — which
 * also means never importing `createServiceClient` from @agency/core in this
 * app.
 *
 * That used to be a comment and nothing else, which is not a control. It is now
 * enforced by `WEB_ENV_ALLOWLIST` in next.config.ts: the root `.env` loader
 * copies four variables onto `process.env` and drops the rest, so the service
 * role key is simply not present in this process and `createServiceClient()`
 * throws `MissingEnvError` rather than returning a working RLS-bypassing
 * client. Keep it that way in production too — never set that variable on the
 * Vercel project.
 *
 * Cookies come from `next/headers`, so this module is Node-runtime only. The
 * Edge middleware has its own client in ./middleware.ts.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { authEnv, supabaseBrowserEnv } from '@agency/core';
import type { Database } from '@agency/core';

import { HOME_PATH, matchesAllowedEmail } from './middleware';

/**
 * A fresh client per request. Not memoised: it closes over this request's
 * cookie jar, and sharing one across requests would hand one operator's session
 * to another — the exact bug RLS cannot save you from.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = supabaseBrowserEnv();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. Harmless: the middleware
          // refreshes the session on every request, so the write that matters
          // has already happened by the time a component renders.
        }
      },
    },
  });
}

/** The client type, derived rather than imported, so this app never needs a direct
 *  dependency on @supabase/supabase-js just to name a type. */
export type ServerSupabaseClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type Operator = {
  supabase: ServerSupabaseClient;
  userId: string;
};

/**
 * Assert the caller is *the* operator, and hand back a client bound to their
 * session.
 *
 * The middleware already gates every route, but Server Actions are POST
 * endpoints that can be invoked directly with a crafted request, so every write
 * re-checks rather than trusting that a page render happened first. Two
 * independent checks, one of which is not routing.
 *
 * Redirects to /login rather than throwing: an expired session should show the
 * login form, not a stack trace.
 */
export async function requireOperator(): Promise<Operator> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error !== null || user === null) redirect('/login');

  const { allowedEmail } = authEnv();
  if (!matchesAllowedEmail(user.email, allowedEmail)) {
    await supabase.auth.signOut();
    redirect('/login?error=not_allowed');
  }

  return { supabase, userId: user.id };
}

export { HOME_PATH };
