'use client';

/**
 * The four operational settings that are not the kill switch: the daily send
 * cap, the daily cost cap, the send window, and the autonomy ladder.
 *
 * These are controls, not preferences. Each one is read by the worker on the
 * send path, so the screen's job is to make the consequence of a value visible
 * next to the field that sets it — the deliverability ramp beside the send cap,
 * the recipient's-local-time rule beside the window, SPEC §7's hard rule beside
 * the ladder. A number typed without its consequence in view is how a new
 * domain ends up sending forty a day in week one and living in spam afterwards.
 *
 * Four decisions:
 *
 * 1. **The inputs are controlled**, for the reason contact-form.tsx documents:
 *    React resets an uncontrolled `<form action>` once the action settles, so a
 *    rejected save would wipe everything just typed. Holding the values here
 *    means a failed save costs nothing but the fix.
 *
 * 2. **The server owns validation.** There is no mirrored rule set here to fall
 *    out of step with `parseSettingsForm`. Errors come back keyed by control
 *    name and land next to their field.
 *
 * 3. **Autonomy is display-only in v1 and says so on screen.** SPEC §7 builds the
 *    ladder and locks it at level 1; nothing leaves the system to a third party
 *    above level 1. The stored levels ride along in hidden fields so a save is a
 *    faithful round trip rather than a silent reset — and if a level above 1 ever
 *    reaches the database by hand, the server refuses the whole form and names
 *    the key, which is the correct outcome for a value v1 forbids.
 *
 * 4. **The promotion prompt is a sentence, not a button.** SPEC §7 and PLAN §7
 *    both ask for it after twenty unedited approvals of a task type, and both
 *    say the promotion itself stays disabled in v1. So it reports the streak and
 *    says what would be on offer, and there is nothing to click: a button that
 *    did nothing would be worse than the sentence, and one that worked would
 *    break the hard rule. The count comes from ./autonomy.ts, which is tested.
 */

import { useState, useTransition, type ReactNode } from 'react';

import { Button, cx } from '@/components/ui/button';
import { Field, fieldId } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Panel } from '@/components/ui/panel';
import { Select } from '@/components/ui/select';
import { readyForPromotion } from '@/lib/autonomy';
import { saveOperationalSettings } from '@/lib/settings-actions';
import type { SettingsErrors, SettingsField } from '@/lib/settings-validation';


/** PLAN §7.1. Four manual edits over a month, which is why it is a table on the
 *  screen rather than an automation nobody would trust. */
const RAMP: readonly { week: string; cap: number }[] = [
  { week: '1', cap: 10 },
  { week: '2', cap: 20 },
  { week: '3', cap: 30 },
  { week: '4+', cap: 40 },
];

/**
 * `settings.send_window.days` uses JS `Date#getDay()` numbering, 0 = Sunday.
 * Displayed Monday-first because that is how a working week reads; the values
 * are untouched, so what is stored is exactly what core and seed.sql document.
 */
const WEEKDAYS: readonly { value: number; label: string; full: string }[] = [
  { value: 1, label: 'Mon', full: 'Monday' },
  { value: 2, label: 'Tue', full: 'Tuesday' },
  { value: 3, label: 'Wed', full: 'Wednesday' },
  { value: 4, label: 'Thu', full: 'Thursday' },
  { value: 5, label: 'Fri', full: 'Friday' },
  { value: 6, label: 'Sat', full: 'Saturday' },
  { value: 0, label: 'Sun', full: 'Sunday' },
];

const HOUR_OPTIONS = Array.from({ length: 25 }, (_, hour) => ({
  value: String(hour),
  label: hour === 24 ? '24:00 (end of day)' : `${String(hour).padStart(2, '0')}:00`,
}));

/** SPEC §7. Levels 2 and 3 are drawn and unreachable — the ladder is the point,
 *  and hiding the rungs above the lock would hide what the lock is for. */
const LADDER: readonly { level: number; text: string }[] = [
  { level: 0, text: 'Ask before drafting' },
  { level: 1, text: 'Draft, wait for approval' },
  { level: 2, text: 'Send, then notify' },
  { level: 3, text: 'Do silently, log only' },
];

const TASK_TYPES: readonly { type: string; label: string; field: SettingsField }[] = [
  { type: 'draft_email', label: 'Draft email', field: 'autonomy_draft_email' },
  { type: 'reminder', label: 'Reminder', field: 'autonomy_reminder' },
  { type: 'alert', label: 'Alert', field: 'autonomy_alert' },
];

export type OperationsFormValues = {
  killSwitch: boolean;
  dailySendCap: string;
  dailyCostCap: string;
  sendWindowDays: number[];
  sendWindowStartHour: string;
  sendWindowEndHour: string;
  autonomy: Record<string, number>;
};

export type OperationsFormProps = {
  values: OperationsFormValues;
  /** Task type → consecutive sends that went out exactly as drafted. Counted on
   *  the server by ./lib/autonomy.ts. */
  unEditedStreaks: Readonly<Record<string, number>>;
  /** Setting keys whose stored value was the wrong shape and is being shown as
   *  the seeded default. Named so saving is understood as a repair. */
  unreadable: readonly string[];
  /** The operator's timezone, for the sentence about whose clock the window is
   *  in. Formatted on the server; this component never asks for one. */
  fallbackTimeZone: string;
};

export function OperationsForm({
  values,
  unEditedStreaks,
  unreadable,
  fallbackTimeZone,
}: OperationsFormProps) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<SettingsErrors | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<OperationsFormValues>(values);

  function set<K extends keyof OperationsFormValues>(key: K, value: OperationsFormValues[K]): void {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleDay(day: number): void {
    setSaved(false);
    setForm((current) => ({
      ...current,
      sendWindowDays: current.sendWindowDays.includes(day)
        ? current.sendWindowDays.filter((d) => d !== day)
        : [...current.sendWindowDays, day].sort((a, b) => a - b),
    }));
  }

  function onSubmit(formData: FormData): void {
    setErrors(undefined);
    startTransition(async () => {
      const result = await saveOperationalSettings(formData);
      if (result.ok) {
        setSaved(true);
        return;
      }
      setErrors(result.errors);
    });
  }

  return (
    <form
      action={onSubmit}
      noValidate
      aria-busy={pending || undefined}
      onKeyDown={(event) => {
        // ⌘/Ctrl+Enter saves from anywhere, the same shortcut as the contact
        // form. Plain Enter in a text input already submits.
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
      className={cx('flex flex-col gap-4 transition-opacity', pending && 'opacity-70')}
    >
      {/* The kill switch has its own action and its own panel above. It rides
          along as a hidden field only so the parsed form is a truthful snapshot
          of all five settings; nothing here writes it. */}
      <input type="hidden" name="kill_switch" value={form.killSwitch ? 'on' : 'false'} />

      {errors?.form !== undefined ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-base text-danger"
        >
          {errors.form}
        </p>
      ) : null}

      {unreadable.length > 0 ? (
        <p className="rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-base text-warning">
          The stored value for {unreadable.join(', ')} could not be read and is shown as the
          seeded default. The worker treats an unreadable setting as a hard error, so nothing
          sends until this is saved.
        </p>
      ) : null}

      <Panel level={3} title="Volume" note="PLAN §7.1 — the deliverability ramp">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex flex-col gap-3">
            <Field
              name="daily_send_cap"
              label="Daily send cap"
              error={errors?.daily_send_cap}
              hint="Emails in any rolling 24 hours, counted at send time. 0 pauses sending without touching the kill switch."
            >
              <Input
                numeric
                inputMode="numeric"
                value={form.dailySendCap}
                autoComplete="off"
                className="max-w-32"
                onChange={(event) => set('dailySendCap', event.target.value)}
              />
            </Field>

            <p className="max-w-prose text-xs text-muted">
              A new domain sending forty a day from day one lands in spam and stays there. Bump
              this by hand once a week — four edits over a month. Before the first live send, SPF,
              DKIM and DMARC have to be verified on the domain, or the ramp accomplishes nothing.
            </p>

            <Field
              name="daily_cost_cap"
              label="Daily cost cap"
              action="USD"
              error={errors?.daily_cost_cap}
              hint="Checked before every model call. Over it, the agents halt and file an alert instead of spending."
            >
              <Input
                numeric
                inputMode="decimal"
                value={form.dailyCostCap}
                autoComplete="off"
                className="max-w-32"
                onChange={(event) => set('dailyCostCap', event.target.value)}
              />
            </Field>
          </div>

          <table className="h-fit self-start border-collapse text-sm">
            <caption className="label-caps pb-1 text-left text-muted">Ramp</caption>
            <thead>
              <tr>
                <th className="label-caps border-b border-line px-3 py-1 text-left text-muted">
                  Week
                </th>
                <th className="label-caps border-b border-line px-3 py-1 text-right text-muted">
                  Cap/day
                </th>
              </tr>
            </thead>
            <tbody>
              {RAMP.map((row) => {
                const current = String(row.cap) === form.dailySendCap.trim();
                return (
                  <tr key={row.week}>
                    <td
                      className={cx(
                        'numeric border-b border-line px-3 py-1',
                        current ? 'text-ink' : 'text-muted',
                      )}
                    >
                      {row.week}
                    </td>
                    <td
                      className={cx(
                        'numeric border-b border-line px-3 py-1 text-right',
                        current ? 'font-medium text-ink' : 'text-muted',
                      )}
                    >
                      {row.cap}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel level={3} title="Send window" note={`Recipient's local time, ${fallbackTimeZone} when unknown`}>
        <fieldset className="flex flex-col gap-1">
          <legend className="label-caps text-muted">Days</legend>
          <div
            role="group"
            aria-describedby={`${fieldId('send_window_days')}-hint`}
            className="flex flex-wrap gap-1.5 pt-1"
          >
            {WEEKDAYS.map((day) => {
              const checked = form.sendWindowDays.includes(day.value);
              const id = `${fieldId('send_window_days')}-${day.value}`;
              return (
                <span key={day.value} className="inline-flex">
                  <input
                    id={id}
                    type="checkbox"
                    name="send_window_days"
                    value={String(day.value)}
                    checked={checked}
                    onChange={() => toggleDay(day.value)}
                    className="peer sr-only"
                  />
                  <label
                    htmlFor={id}
                    title={day.full}
                    className={cx(
                      'inline-flex h-[var(--control-h-sm)] cursor-pointer items-center rounded-md border px-2.5 text-sm transition-colors select-none',
                      'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-accent',
                      checked
                        ? 'border-line-strong bg-sunken font-medium text-ink'
                        : 'border-line text-faint hover:text-muted',
                    )}
                  >
                    {day.label}
                  </label>
                </span>
              );
            })}
          </div>

          {errors?.send_window_days !== undefined ? (
            <p role="alert" className="text-xs text-danger">
              {errors.send_window_days}
            </p>
          ) : (
            <p id={`${fieldId('send_window_days')}-hint`} className="text-xs text-faint">
              Tue–Thu by default. With none selected nothing can be scheduled at all, so at least
              one is required.
            </p>
          )}
        </fieldset>

        <div className="mt-3 grid max-w-md gap-3 sm:grid-cols-2">
          <Field name="send_window_start_hour" label="From" error={errors?.send_window_start_hour}>
            <Select
              value={form.sendWindowStartHour}
              options={HOUR_OPTIONS}
              onChange={(event) => set('sendWindowStartHour', event.target.value)}
            />
          </Field>

          <Field
            name="send_window_end_hour"
            label="Until"
            error={errors?.send_window_end_hour}
            hint="Exclusive"
          >
            <Select
              value={form.sendWindowEndHour}
              options={HOUR_OPTIONS}
              onChange={(event) => set('sendWindowEndHour', event.target.value)}
            />
          </Field>
        </div>

        <p className="mt-3 max-w-prose text-xs text-muted">
          Approving a draft schedules it for the next slot inside these hours in the recipient's
          own timezone, plus two to fifteen minutes of jitter. For Greek contacts that is almost
          always the next few minutes on a window day — and on a Monday, with the default Tue–Thu,
          it is Tuesday morning. The card tells you which before you approve. The point is not
          open rates: a message arriving at 03:00 local reads as a machine.
        </p>
      </Panel>

      <Panel level={3} title="Autonomy" note="SPEC §7 — built, shown, locked at level 1">
        <p className="max-w-prose text-base text-ink">
          Every task type has a level. v1's hard rule is that nothing leaves the system to a third
          party above level 1, so the ladder is built and displayed and the promotion is not
          enabled. These are read-only here on purpose; the value is stored and the send path
          reads it.
        </p>

        <ol className="mt-3 max-w-md space-y-0.5">
          {LADDER.map((rung) => {
            const reachable = rung.level <= 1;
            return (
              <li
                key={rung.level}
                className={cx(
                  'flex items-baseline gap-2 text-sm',
                  reachable ? 'text-ink' : 'text-faint',
                )}
              >
                <span className="numeric w-4 text-right">{rung.level}</span>
                <span>{rung.text}</span>
                {!reachable ? <span className="text-xs text-faint">— not available in v1</span> : null}
              </li>
            );
          })}
        </ol>

        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1">
          {TASK_TYPES.map((task) => {
            const level = form.autonomy[task.type] ?? 1;
            const error = errors?.[task.field];
            const streak = unEditedStreaks[task.type] ?? 0;
            return (
              <div key={task.type} className="flex items-baseline gap-2">
                <input type="hidden" name={task.field} value={String(level)} />
                <dt className="label-caps text-muted">{task.label}</dt>
                <dd className="numeric text-sm text-ink">Level {level}</dd>
                {streak > 0 ? (
                  <span className="text-xs text-faint">
                    {streak} in a row unedited
                  </span>
                ) : null}
                {error !== undefined ? (
                  <span role="alert" className="text-xs text-danger">
                    {error}
                  </span>
                ) : null}
              </div>
            );
          })}
        </dl>

        {TASK_TYPES.filter((task) => readyForPromotion(unEditedStreaks[task.type] ?? 0)).map(
          (task) => (
            <p
              key={task.type}
              className="mt-3 max-w-prose rounded-md border border-accent/25 bg-accent-subtle px-3 py-2 text-base text-ink"
            >
              <span className="font-display font-medium">{task.label} has earned level 2.</span>{' '}
              The last {unEditedStreaks[task.type]} went out exactly as drafted. Level 2 is send,
              then notify — you would stop approving these and start reading them afterwards. It
              is not available in v1 and there is nothing here to click: SPEC §7&apos;s hard rule
              is that nothing leaves this system to a third party without you.
            </p>
          ),
        )}
      </Panel>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-baseline gap-1 text-2xs text-faint">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> save
        </p>

        <div className="flex items-center gap-3">
          <SaveNote saved={saved} pending={pending} />
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function SaveNote({ saved, pending }: { saved: boolean; pending: boolean }): ReactNode {
  if (pending || !saved) return null;
  // Not a toast, not an animation: a line of text that goes away the moment
  // anything is edited again.
  return (
    <span role="status" className="text-xs text-muted">
      Saved. The worker picks this up on its next tick.
    </span>
  );
}
