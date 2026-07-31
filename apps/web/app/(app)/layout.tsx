import type { ReactNode } from 'react';

import { Nav } from '@/components/nav';

/**
 * The application shell: skip link, nav, and the one `<main>` on the page.
 *
 * Everything inside this route group is a screen the operator reaches while
 * signed in. `/login` sits outside it (in `app/login/`) and therefore gets the
 * document and nothing else — no nav full of links that would bounce a
 * signed-out visitor straight back to the form they are already looking at.
 *
 * There is exactly one `<main id="content">` in the tree, here. Pages render a
 * `<div>`; a second `<main>` nested inside this one is invalid HTML and breaks
 * landmark navigation, which is the whole reason a screen reader has landmarks.
 * The skip link lives with the region it targets so the two cannot separate.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* Keyboard-first: the first tab stop skips the nav entirely. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-1.5 focus:text-accent-fg"
      >
        Skip to content
      </a>

      <Nav />

      <main id="content" className="mx-auto w-full max-w-shell flex-1 px-6 py-6">
        {children}
      </main>
    </div>
  );
}
