/**
 * Session refresh + the single-user auth gate, in one place.
 *
 * This module is imported by `apps/web/middleware.ts` and therefore runs in the
 * Edge runtime. Two consequences, both deliberate:
 *
 * 1. **Nothing here imports @agency/core.** Not even for env access. That
 *    package's barrel re-exports `./db`, which imports @supabase/supabase-js and
 *    exports `createServiceClient` — so a single value import from it drags the
 *    whole service-role factory into the Edge bundle that runs on every request.
 *    apps/web operates under RLS with the anon key, full stop (PLAN.md §4), and
 *    the cheapest way to keep that true is for this file to have no path to the
 *    service client at all.
 * 2. Every variable is read as a **static** `process.env.X` expression. Next.js
 *    inlines statically-referenced `process.env.X` into the Edge bundle; a
 *    computed `process.env[name]` lookup — which is what @agency/core's
 *    `authEnv()` does for non-`NEXT_PUBLIC_` variables — is not guaranteed to
 *    survive that bundling and would silently read `undefined` here. The names
 *    are exactly PLAN.md §8; only the way they are read differs. Server-side
 *    code outside the Edge runtime uses `authEnv()` / `supabaseBrowserEnv()`
 *    normally (see lib/supabase/server.ts).
 *
 * The gate fails **closed**. Anything that is not "a live Supabase session whose
 * email equals ALLOWED_EMAIL" is redirected to /login, including a perfectly
 * valid Supabase session belonging to somebody else — that session is signed out
 * on the spot rather than left hanging around in the browser.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Static reads — see note 2 above. Mirrors `supabaseBrowserEnv()` from
 * @agency/core, including the "fail loudly, naming the variable" contract, and
 * exists only because that module cannot be imported from the Edge runtime.
 */
function edgeSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (url === undefined || url === '' || anonKey === undefined || anonKey === '') {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (needed by the auth gate). ' +
        'Set them in .env / the deployment environment — see PLAN.md §8.',
    );
  }

  return { url, anonKey };
}

/**
 * Path prefixes reachable without a session. Everything else is gated.
 * `/auth` covers the magic-link callback and sign-out route handlers.
 */
const PUBLIC_PREFIXES = ['/login', '/auth'] as const;

/** Where an authenticated operator lands: the only real screen in step 2. */
export const HOME_PATH = '/pipeline';

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Trim + case-fold. Returns null for anything that isn't a usable address. */
export function normaliseEmail(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * The whole authorisation model: exactly one address gets in.
 *
 * Compared case-insensitively after trimming, and nothing cleverer than that —
 * no Gmail dot-folding, no plus-address stripping. A near-miss is a no.
 */
export function matchesAllowedEmail(
  email: string | null | undefined,
  allowedEmail: string | null | undefined,
): boolean {
  const a = normaliseEmail(email);
  const b = normaliseEmail(allowedEmail);
  return a !== null && b !== null && a === b;
}

/**
 * Only ever redirect to a path on this origin. An open redirect here would let
 * a magic link deposit the operator's freshly-minted session on someone else's
 * page, so anything that isn't a single-slash-prefixed relative path is dropped.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

function redirectToLogin(
  request: NextRequest,
  carrier: NextResponse,
  options: { error?: string; next?: string } = {},
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (options.error !== undefined) url.searchParams.set('error', options.error);
  const next = safeNextPath(options.next);
  if (next !== null && next !== '/' && next !== HOME_PATH) url.searchParams.set('next', next);

  const response = NextResponse.redirect(url);
  // Carry over whatever Supabase wrote (refreshed or cleared auth cookies);
  // dropping them here is how you get an infinite redirect loop.
  for (const cookie of carrier.cookies.getAll()) response.cookies.set(cookie);
  return response;
}

/**
 * Refreshes the Supabase session cookie and enforces the gate.
 *
 * Returns either the pass-through response (with refreshed cookies) or a
 * redirect to /login. The caller — middleware.ts — just returns it.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request });

  const { url, anonKey } = edgeSupabaseEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // Nothing between the client construction and getUser(): this call is what
  // refreshes an expired token, and any early return above it logs the operator
  // out at random. getUser() (not getSession()) because it revalidates the JWT
  // with the auth server instead of trusting the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  // Static, not computed — see the header note.
  const allowedEmail = process.env.ALLOWED_EMAIL;
  const isOperator = matchesAllowedEmail(user?.email, allowedEmail);

  if (isPublicPath(pathname)) {
    // Already signed in and staring at the login form: go to the app.
    if (isOperator && pathname === '/login') {
      const url = request.nextUrl.clone();
      url.pathname = safeNextPath(request.nextUrl.searchParams.get('next')) ?? HOME_PATH;
      url.search = '';
      const response = NextResponse.redirect(url);
      for (const cookie of supabaseResponse.cookies.getAll()) response.cookies.set(cookie);
      return response;
    }
    return supabaseResponse;
  }

  if (isOperator) return supabaseResponse;

  // Misconfigured deploy: no ALLOWED_EMAIL means nobody is authorised. Say so
  // instead of pretending the session expired — and do NOT sign the user out,
  // since the fix is an environment variable, not a new magic link.
  if (normaliseEmail(allowedEmail) === null) {
    return redirectToLogin(request, supabaseResponse, { error: 'misconfigured' });
  }

  if (user !== null) {
    // A valid Supabase session belonging to somebody else. Terminate it rather
    // than bouncing them to /login with the cookie still in place.
    await supabase.auth.signOut();
    return redirectToLogin(request, supabaseResponse, { error: 'not_allowed' });
  }

  return redirectToLogin(request, supabaseResponse, {
    next: `${pathname}${request.nextUrl.search}`,
  });
}
