/**
 * Magic-link landing. The one route that turns a link into a session.
 *
 * Supabase sends the operator to /auth/v1/verify, which redirects here with
 * either `?code=` (PKCE — what signInWithOtp from the login page produces) or
 * `?token_hash=&type=` (the older email template). Both are handled; anything
 * else, including an expired link, goes back to /login with a readable reason.
 *
 * The email check is repeated here even though the middleware also enforces it.
 * This is the moment a session cookie is created, and the cheapest place to
 * refuse to create one for the wrong person is before it exists.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { authEnv } from '@agency/core';

import { HOME_PATH, matchesAllowedEmail, safeNextPath } from '@/lib/supabase/middleware';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/** Email OTP types Supabase can send to a single-user app. */
const OTP_TYPES = ['magiclink', 'email', 'signup', 'invite', 'recovery', 'email_change'] as const;
type OtpType = (typeof OTP_TYPES)[number];

function isOtpType(value: string | null): value is OtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value);
}

function redirectTo(request: NextRequest, pathname: string, search = ''): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = search;
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const next = safeNextPath(params.get('next')) ?? HOME_PATH;

  // Supabase reports a dead link as ?error=access_denied&error_code=otp_expired.
  if (params.get('error') !== null) return redirectTo(request, '/login', '?error=link_invalid');

  const code = params.get('code');
  const tokenHash = params.get('token_hash');
  const type = params.get('type');

  const supabase = await createSupabaseServerClient();

  if (code !== null) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error !== null) return redirectTo(request, '/login', '?error=link_invalid');
  } else if (tokenHash !== null && isOtpType(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error !== null) return redirectTo(request, '/login', '?error=link_invalid');
  } else {
    return redirectTo(request, '/login', '?error=link_invalid');
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { allowedEmail } = authEnv();
  if (!matchesAllowedEmail(user?.email, allowedEmail)) {
    // A valid Supabase session for somebody who is not the operator. Destroy it
    // here rather than letting the middleware bounce it on the next request.
    await supabase.auth.signOut();
    return redirectTo(request, '/login', '?error=not_allowed');
  }

  return redirectTo(request, next);
}
