'use server';

/**
 * Sign out.
 *
 * A **Server Action**, not a route handler, and that is the whole point of the
 * file. `/auth/*` is a public prefix (lib/supabase/middleware.ts), so a POST
 * route handler at /auth/signout would be reachable cross-origin: an
 * auto-submitting `<form method="post">` on any page the operator opens is a
 * simple request, needs no preflight, and carries the session cookie under
 * SameSite=Lax. Route Handlers get none of the Origin/Host validation Next
 * applies to Server Actions, so nothing would reject it and the operator would
 * be logged out by a third party at will. Next verifies the Origin header
 * against the request Host for every Server Action invocation, so moving the
 * behaviour here closes that for free rather than by hand-rolling a check.
 *
 * Nothing about the operator is logged, here or in the error path.
 */

import { redirect } from 'next/navigation';

import { createSupabaseServerClient } from './supabase/server';

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // signOut() on a client with no session errors, and there is nothing to
  // report either way — only call it when there is something to end.
  if (user !== null) await supabase.auth.signOut();

  redirect('/login?signed_out=1');
}
