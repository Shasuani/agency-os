import Link from 'next/link';

import { buttonClass } from '@/components/ui/button';

/**
 * `/` — Today.
 *
 * A placeholder, and it says so rather than pretending. The real screen is
 * build step 6: metric tiles, task cards, approve / edit / skip, and the
 * j/k/e/Enter loop that has to complete in ninety seconds. Nothing here should
 * grow past this page; step 2's one real screen is /pipeline.
 *
 * It renders a `<div>`, not a `<main>` — `app/(app)/layout.tsx` owns the one
 * `<main id="content">` in the tree.
 */
export default function TodayPage() {
  return (
    <div className="max-w-2xl">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl">Today</h1>
        <p className="text-xs text-faint">Nothing runs yet — no agent has been built.</p>
      </header>

      <section className="mt-5 rounded-lg border border-line bg-raised px-5 py-4">
        <h2 className="label-caps text-muted">What this becomes</h2>
        <p className="mt-2 text-base text-ink">
          Three metric tiles, then the pending task cards the follow-up agent files each morning,
          then a collapsed list of what was handled without you.
        </p>
        <p className="mt-1 text-sm text-muted">
          Build step 6. It needs the cadence functions (step 3), the LLM wrapper (step 4) and the
          follow-up agent (step 5) in front of it.
        </p>
      </section>

      <p className="mt-5 text-muted">
        Until then the pipeline is the screen that does the work: it is sorted by follow-up date,
        so whoever is overdue is at the top.
      </p>

      <div className="mt-4">
        <Link href="/pipeline" className={buttonClass({ variant: 'primary' })}>
          Open the pipeline
        </Link>
      </div>
    </div>
  );
}
