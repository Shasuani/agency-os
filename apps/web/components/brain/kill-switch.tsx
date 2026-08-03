'use client';

/**
 * The kill switch (PLAN §7): one toggle that pauses every cron job and blocks
 * every send.
 *
 * Three decisions about how it behaves, none of which are cosmetic:
 *
 * 1. **One click in both directions, no confirmation dialog.** The reason to
 *    reach for this control is that something is going wrong right now, and a
 *    confirmation step on an emergency stop is a step taken while the thing you
 *    are trying to stop is still running. Turning it back on is also one click,
 *    because by then the operator has read the panel telling them exactly what
 *    resumes.
 *
 * 2. **Its own action, not a field on the settings form.** A toggle that only
 *    takes effect once the cost cap validates is a toggle that fails at the
 *    moment it matters. `setKillSwitch` writes one row and revalidates the
 *    layout, so the nav indicator changes with it.
 *
 * 3. **When it is on, the panel states what is paused rather than saying
 *    "enabled".** "Kill switch: on" is a fact about a database row. What the
 *    operator needs to know is that this morning's drafts will not be written
 *    and nothing approved will leave, and those two sentences are also the check
 *    on whether they meant to do it.
 *
 * When it is off this is a quiet single line — no green tick, no "all systems
 * normal" panel. Chrome does not celebrate; there are 364 days a year on which
 * this control has nothing to say.
 */

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { setKillSwitch } from '@/lib/settings-actions';


export function KillSwitch({ on }: { on: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>(undefined);

  // Optimism would be wrong here: the whole value of this control is that the
  // screen agrees with the database about whether anything can send. The button
  // stays busy until the action has come back and the page has revalidated.
  function toggle(next: boolean): void {
    setError(undefined);
    startTransition(async () => {
      const result = await setKillSwitch(next);
      if (!result.ok) {
        setError(result.errors.kill_switch ?? 'Could not change the kill switch.');
      }
    });
  }

  if (on) {
    return (
      <Panel level={3} title="Sends paused" tone="warning" note="PLAN §7 — the kill switch is on">
        <p className="text-base text-ink">
          Nothing is going out and nothing is being drafted. This stays true until you turn it
          off.
        </p>
        <ul className="mt-2 space-y-0.5 text-sm text-ink">
          <li>· The morning follow-up run stops before it reads a single contact.</li>
          <li>· The send queue sends nothing. Anything already approved waits, it is not lost.</li>
          <li>· Approving a draft is refused, so you cannot queue up work that silently never leaves.</li>
        </ul>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => toggle(false)} disabled={pending}>
            {pending ? 'Resuming…' : 'Resume sending'}
          </Button>
          <span className="text-xs text-muted">
            Approved tasks whose send time has passed go out on the next tick, within a minute.
          </span>
        </div>

        {error !== undefined ? (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </Panel>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-raised px-4 py-2.5">
      <p className="text-sm text-muted">
        Sending is live. Follow-ups are drafted on the morning run and go out once you approve
        them.
      </p>

      <div className="flex items-center gap-3">
        {error !== undefined ? (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        ) : null}
        <Button variant="secondary" onClick={() => toggle(true)} disabled={pending}>
          {pending ? 'Pausing…' : 'Pause everything'}
        </Button>
      </div>
    </div>
  );
}
