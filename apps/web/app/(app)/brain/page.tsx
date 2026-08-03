import type { Metadata } from 'next';

import { appTimezone, optionalEnv } from '@agency/core';

import { BrainEntry } from '@/components/brain/brain-entry';
import { KillSwitch } from '@/components/brain/kill-switch';
import { OperationsForm } from '@/components/brain/operations-form';
import { PushToggle } from '@/components/brain/push-toggle';
import { unEditedStreaks } from '@/lib/autonomy';
import { formatStampLabel, readBrain, readOperationalSettings } from '@/lib/settings';
import { listRecentSends } from '@/lib/tasks';
import { dayKeyInZone } from '@/lib/validation';

/**
 * /brain — the two things that decide what the agents do.
 *
 * **Operations first, business facts second.** They are not the same kind of
 * thing and PLAN §1 keeps them in different tables for that reason: `settings`
 * holds operational flags that must never leak into a prompt, `brain` holds
 * business facts that are fed to the model verbatim. Putting operations on top
 * is also the practical order — the kill switch is the reason anybody opens this
 * page in a hurry.
 *
 * Nothing here is a preferences screen. Every control is read by the worker on
 * the send path: the kill switch at the top of every cron job and every send,
 * the send cap and the window at approval and at send time, the cost cap before
 * every model call. So each one is rendered next to the consequence of its value
 * rather than next to a tooltip.
 *
 * **The brain keys are seeded from `brain/*.md` on disk, and `pnpm seed --commit`
 * overwrites whatever is typed here.** That is stated on the page, once, above
 * the eight editors. An editor that silently loses an afternoon's work on the
 * next seed is a trap, and the only honest fix short of removing one of the two
 * paths is to say plainly which one wins.
 *
 * The notification switch (step 7) sits at the bottom of Operations rather than
 * on a screen of its own. It is the third thing on this page that changes what
 * the worker does with its output, and it is a per-browser control — the state
 * it reports is the state of the machine the operator is looking at, not a row
 * anybody could read from somewhere else. `VAPID_PUBLIC_KEY` is read here, on
 * the server, and handed down as a prop; it is a public key, so a prop is
 * exactly as exposed as a `NEXT_PUBLIC_` variable and does not need a second
 * name in PLAN §8. When it is unset the toggle says so rather than offering a
 * button that cannot work.
 *
 * Every date is formatted here, on the server, in the operator's timezone
 * (PLAN §7.1) and reaches the Client Components as a finished string — the same
 * arrangement /pipeline uses. The editors never see a clock, so there is nothing
 * for server and client to disagree about.
 */

export const metadata: Metadata = {
  title: 'Brain',
};

/** Never cached, never prerendered. The kill switch's whole value is that the
 *  screen agrees with the database about whether anything can send; a cached
 *  copy of this page would be a copy of that answer. */
export const dynamic = 'force-dynamic';

export default async function BrainPage() {
  const [settings, brain, recentSends] = await Promise.all([
    readOperationalSettings(),
    readBrain(),
    listRecentSends(),
  ]);

  // SPEC §7's promotion prompt. Counted here, on the server, from the pairs the
  // approve action stored; the form renders a sentence and offers no button,
  // because v1 does not promote anything.
  const streaks = unEditedStreaks(recentSends);

  const timeZone = appTimezone();
  const today = dayKeyInZone(new Date(), timeZone);

  // Undefined on a deploy that has not set it — including every local checkout
  // until it is added to the root .env. The toggle renders that honestly.
  const vapidPublicKey = optionalEnv('VAPID_PUBLIC_KEY') ?? null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl">Brain</h1>
          <p className="text-xs text-faint">
            What the agents know, and what they are allowed to do with it.
          </p>
        </div>
      </header>

      <section aria-labelledby="operations-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="operations-heading" className="text-lg">
            Operations
          </h2>
          <p className="text-xs text-faint">
            Read by the worker on every run and every send. Kept out of the brain so an
            operational flag can never reach a prompt.
          </p>
        </div>

        <KillSwitch on={settings.killSwitch} />

        <OperationsForm
          values={{
            killSwitch: settings.killSwitch,
            dailySendCap: String(settings.dailySendCap),
            // Trailing zeros are noise on a field the operator types into; the
            // stored value keeps whatever precision it had.
            dailyCostCap: String(settings.dailyCostCap),
            sendWindowDays: settings.sendWindow.days,
            sendWindowStartHour: String(settings.sendWindow.start_hour),
            sendWindowEndHour: String(settings.sendWindow.end_hour),
            autonomy: settings.autonomy,
          }}
          unEditedStreaks={streaks}
          unreadable={settings.unreadable}
          fallbackTimeZone={timeZone}
        />

        <PushToggle vapidPublicKey={vapidPublicKey} />
      </section>

      <section aria-labelledby="brain-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="brain-heading" className="text-lg">
            Brain
          </h2>
          <p className="text-xs text-faint">
            Eight keys. The follow-up agent reads all of them before writing a word.
          </p>
        </div>

        {/* Said once, here, rather than eight times on eight editors — and said
            plainly, because the trap is real: the files on disk are the source
            of truth for the seeder, and it does not merge. */}
        <div className="rounded-lg border border-line bg-sunken px-4 py-3">
          <p className="max-w-prose text-base text-ink">
            These eight keys live in <code className="font-mono text-sm">brain/*.md</code> in the
            repository, and <code className="font-mono text-sm">pnpm seed --commit</code>{' '}
            overwrites every one of them from those files. Editing here changes the database now;
            the next seed will undo it unless the file is changed too.
          </p>
          <p className="mt-1 max-w-prose text-sm text-muted">
            Use this for a correction you need in the next draft. Put the real version in the file.
          </p>
          <p className="mt-1 max-w-prose text-sm text-muted">
            Leaving a key empty is a decision, not an omission: the agent then says nothing about
            that subject rather than inventing a claim to someone who will read it. Nothing here
            will ask you to fill one in.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {brain.map((entry) => (
            <BrainEntry
              key={entry.key}
              entryKey={entry.key}
              value={entry.value}
              updatedLabel={formatStampLabel(entry.updatedAt, today, timeZone)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
