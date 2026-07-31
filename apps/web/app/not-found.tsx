import Link from 'next/link';

import { buttonClass } from '@/components/ui/button';

/**
 * 404. Reached by a hand-typed URL, a stale bookmark, or `notFound()` from
 * `/pipeline/[id]` when a contact id does not resolve — which is also what an
 * id hidden by RLS looks like, deliberately: "does not exist" and "not yours"
 * must be indistinguishable from outside.
 *
 * It sits at the root rather than inside the (app) group so it renders without
 * the nav, the same as /login: a signed-out visitor guessing at URLs should not
 * be shown a map of the application.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-6">
      <p className="numeric text-3xl text-faint">404</p>
      <div>
        <h1 className="text-lg">Nothing at this address.</h1>
        <p className="mt-1 text-muted">
          The page does not exist, or the contact it points at does not — those look the same from
          here, on purpose.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/pipeline" className={buttonClass({ variant: 'primary' })}>
          Pipeline
        </Link>
        <Link href="/" className={buttonClass({ variant: 'ghost' })}>
          Today
        </Link>
      </div>
    </main>
  );
}
