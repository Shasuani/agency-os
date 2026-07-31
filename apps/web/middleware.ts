/**
 * The single-user auth gate (PLAN.md §1: "Supabase magic link, single allowed
 * email in ALLOWED_EMAIL, checked in Next.js middleware").
 *
 * The matcher below is an allow-list of *exclusions*, not of protected routes:
 * everything is gated except Next's own build output, so a new page added later
 * is protected by default rather than by remembering to add it here. /login and
 * /auth/* are public — that decision lives in lib/supabase/middleware.ts next to
 * the rest of the gate logic, so there is one place to read to know who can
 * reach what.
 *
 * The exclusions are **path prefixes only**, deliberately. The usual boilerplate
 * for this matcher ends with `.*\.(?:svg|png|…)$`, which anchors on the whole
 * path rather than on an asset directory — and `/pipeline/abc.png` matches the
 * `/pipeline/[id]` dynamic route, so that alternative silently un-gates a real
 * page. The header above would then be a lie, and the next dynamic route whose
 * author trusts it ships unauthenticated.
 *
 * `_next/static` and `_next/image` are excluded by prefix because they are
 * requested constantly and hold no data. Everything else, including anything
 * added to /public, is gated — the fonts are self-hosted by next/font under
 * `_next/static`, so /public is empty and there is nothing to let through. If a
 * genuinely public asset is ever needed, put it under `/public/assets/` and add
 * `assets/` to the prefix list here, so the exclusion still cannot collide with
 * a route segment.
 *
 * Checked against: `/`, `/pipeline`, `/pipeline/new`, `/pipeline/abc.png`,
 * `/pipeline/x.svg` — all five run the middleware.
 */

import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: ['/((?!_next/static/|_next/image/|favicon\\.ico$).*)'],
};
