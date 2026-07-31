/**
 * Sign in. One address, one method: a Supabase magic link (PLAN.md §1).
 *
 * No password, no client-side JavaScript — a plain form posting to a Server
 * Action. The action runs the PKCE flow server-side: `signInWithOtp` writes the
 * code-verifier cookie here, /auth/callback exchanges the code for a session
 * against it. The verifier therefore never reaches the browser as script state.
 *
 * This page lives outside the `(app)` route group, so it renders inside the
 * document layout and nothing else — no nav. A signed-out visitor has no
 * business being shown six links that all bounce back here. It owns its own
 * `<main>` for the same reason: there is no shell above it to provide one, and
 * every page needs exactly one landmark.
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { authEnv } from '@agency/core';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { matchesAllowedEmail, safeNextPath } from '@/lib/supabase/middleware';
import { isValidEmail } from '@/lib/validation';

export const metadata: Metadata = {
  title: 'Sign in',
};

/**
 * Where the magic link comes back to.
 *
 * PLAN.md §8 defines no site URL, so the origin is derived from the request —
 * but **`x-forwarded-host` is not trusted**. That header is attacker-supplied on
 * any deployment that does not strip it, and it lands verbatim in
 * `emailRedirectTo`, i.e. in the link the operator is about to click. Anyone can
 * reach this action (it is a public route), so submitting the operator's own
 * address with a spoofed `X-Forwarded-Host` would mail them a link whose code
 * arrives on somebody else's origin, ready to be exchanged for their session.
 *
 * `Host` is used instead: Vercel and every sane proxy route by it, so it can
 * only be a hostname the deployment actually answers on. It is still validated
 * to a bare `host[:port]` shape, because a comma-joined list or an embedded path
 * is a sign the value came from somewhere it should not have.
 *
 * Supabase's own Redirect URL allow-list is the second lock, and the one that
 * must be configured with no wildcards — README setup step 2.
 */
async function requestOrigin(): Promise<string> {
  const headerList = await headers();
  const raw = (headerList.get('host') ?? 'localhost:3000').trim();

  const host = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(raw) ? raw : 'localhost:3000';
  const local = host.startsWith('localhost') || host.startsWith('127.0.0.1');

  return `${local ? 'http' : 'https'}://${host}`;
}

async function sendMagicLink(formData: FormData): Promise<void> {
  'use server';

  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const next = safeNextPath(String(formData.get('next') ?? '')) ?? '';

  if (!isValidEmail(email)) redirect('/login?error=invalid_email');

  const { allowedEmail } = authEnv();

  // Not the operator: report the same thing as success and send nothing. Any
  // other behaviour turns this form into an email-sending oracle for whoever
  // finds the URL, and confirms which address owns the account.
  if (!matchesAllowedEmail(email, allowedEmail)) redirect('/login?sent=1');

  const supabase = await createSupabaseServerClient();
  const origin = await requestOrigin();
  const callback = `${origin}/auth/callback${next === '' ? '' : `?next=${encodeURIComponent(next)}`}`;

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: callback,
      // The single operator has to be creatable on first sign-in, and this line
      // is only ever reached for ALLOWED_EMAIL. Turn sign-ups off in the
      // Supabase dashboard once that first sign-in has happened (README step 2).
      shouldCreateUser: true,
    },
  });

  // Never log the address.
  if (error !== null) redirect('/login?error=send_failed');

  redirect('/login?sent=1');
}

/**
 * Password sign-in.
 *
 * Added because magic links are not dependable enough to be the only way in:
 * Supabase's built-in mailer allows ~2 messages an hour on the free tier, and
 * the PKCE link only works in the browser that requested it — so opening it from
 * a phone or a webmail in-app browser silently fails. Locking the operator out
 * of their own tool because an email did not arrive is not an acceptable
 * failure mode for something used every morning.
 *
 * Same guard as the magic-link path: only ALLOWED_EMAIL can sign in, and a
 * wrong address gets the same generic message as a wrong password so the form
 * never confirms which address owns the account.
 */
async function signInWithPassword(formData: FormData): Promise<void> {
  'use server';

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  const next = safeNextPath(String(formData.get('next') ?? '')) ?? '/';

  if (!isValidEmail(email) || password === '') redirect('/login?error=bad_credentials');

  const { allowedEmail } = authEnv();
  if (!matchesAllowedEmail(email, allowedEmail)) redirect('/login?error=bad_credentials');

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error !== null) redirect('/login?error=bad_credentials');

  redirect(next);
}

const MESSAGES: Record<string, string> = {
  invalid_email: 'That is not a valid email address.',
  send_failed: 'The link could not be sent. Try again in a moment.',
  not_allowed: 'That account cannot access this app.',
  link_invalid: 'That link has expired or was already used. Request a new one.',
  bad_credentials: 'Wrong email or password.',
  misconfigured: 'ALLOWED_EMAIL is not set on this deployment. Nobody can sign in until it is.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (key: string): string | null => {
    const value = params[key];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };

  const errorKey = first('error');
  const message = errorKey !== null ? (MESSAGES[errorKey] ?? 'Something went wrong.') : null;
  const sent = first('sent') === '1';
  const signedOut = first('signed_out') === '1';
  const next = safeNextPath(first('next')) ?? '';

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-5 px-6">
      <header>
        <p className="font-display text-sm font-medium tracking-tight text-ink">
          Agency<span className="text-faint">OS</span>
        </p>
        <h1 className="mt-4 text-xl">Sign in</h1>
        <p className="mt-1 text-muted">
          One operator, one address. A link arrives by email — there is no password to forget.
        </p>
      </header>

      {sent ? (
        <p
          role="status"
          className="rounded-md border border-line-strong bg-raised px-3 py-2 text-base text-ink"
        >
          Link sent, if that address is the one. Valid for an hour, usable once.
        </p>
      ) : null}

      {signedOut ? (
        <p role="status" className="text-sm text-muted">
          Signed out.
        </p>
      ) : null}

      {message !== null ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-base text-danger"
        >
          {message}
        </p>
      ) : null}

      {/* Password first: it is the path that always works. The magic link is
          kept because it is genuinely nicer when it works, but it depends on an
          email arriving AND on the link being opened in this same browser, and
          neither is guaranteed. */}
      <form action={signInWithPassword} className="flex flex-col gap-3">
        <input type="hidden" name="next" value={next} />

        <Field name="email" label="Email">
          <Input
            type="email"
            inputMode="email"
            autoComplete="username"
            autoFocus
            required
            spellCheck={false}
          />
        </Field>

        <Field name="password" label="Password">
          <Input type="password" autoComplete="current-password" required />
        </Field>

        <Button type="submit" variant="primary" className="w-full">
          Sign in
        </Button>
      </form>

      <form action={sendMagicLink} className="flex flex-col gap-2 border-t border-line pt-4">
        <input type="hidden" name="next" value={next} />
        <p className="text-xs text-faint">
          Or email a link instead. It only works in the browser that requested it, and the free
          tier allows about two an hour.
        </p>
        <Field name="email" label="Email for the link">
          <Input type="email" inputMode="email" required spellCheck={false} />
        </Field>
        <Button type="submit" variant="ghost" className="w-full">
          Send link
        </Button>
      </form>

      <p className="border-t border-line pt-4 text-xs text-faint">
        Nothing here is public. Every route behind this form is gated on a single address, and the
        contact data behind it is gated again in the database.
      </p>
    </main>
  );
}
