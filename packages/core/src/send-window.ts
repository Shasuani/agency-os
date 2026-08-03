/**
 * When an approved message is actually allowed to leave (PLAN §7.1).
 *
 * Approving a task does not send it. Approval computes an absolute instant and
 * writes it to `tasks.send_after`; the worker's 60-second poller sends whatever
 * is due. This module is the arithmetic in the middle: **the next slot inside
 * the recipient's local business hours, plus 2–15 minutes of jitter.**
 *
 * The point is not open rates. PLAN §7.1 is explicit that the send-time
 * literature is bulk-marketing data and contradicts itself. The point is that
 * these drafts read as the operator rather than as a machine, and **a message
 * arriving at 03:00 local reads as a machine** no matter how well it is
 * written. For Greek contacts — most of them — the answer is almost always "in
 * the next few minutes", because the operator works the same hours they do. The
 * whole feature exists for the contact in New York.
 *
 * The jitter is the second half of the same idea. Three approvals in one sitting
 * that all leave at 14:00:00 are three messages timestamped to the second, which
 * is a thing no human does.
 *
 * ---------------------------------------------------------------------------
 * Enforced once, at approval, and never re-checked
 * ---------------------------------------------------------------------------
 *
 * `send_after` is an absolute instant. The poller sends whatever is due and
 * nobody re-evaluates business hours at send time. A second check, with its own
 * fresh jitter, would reject a task that is one minute inside the window at the
 * moment the poller looks at it — and because the poller does not rewrite
 * `send_after`, that task would be re-rejected every sixty seconds forever. One
 * decision, written down, is the whole design.
 *
 * A consequence worth stating: a clock change between approval and send moves
 * nothing, because the stored value is an instant and not a wall-clock time.
 *
 * ---------------------------------------------------------------------------
 * Five decisions inside the loop
 * ---------------------------------------------------------------------------
 *
 * **Jitter is added after the window start, and a jittered instant that would
 * land past `end_hour` rolls to the next window day.** At 15:58 on a Wednesday
 * with a 16:00 close the slot becomes Thursday 09:0x, not Wednesday 16:13. A
 * rule with a fifteen-minute leak past the boundary is a rule nobody can test
 * and nobody can explain to the person who received the message.
 *
 * **An invalid `contacts.timezone` falls back to the operator's zone and
 * sends.** It does not refuse. The column defaults to `Europe/Athens` and is
 * derived from `country` on contact creation, so a value `Intl` rejects means a
 * botched import, not a contact who should be denied their follow-up.
 * `timeZoneFallback: true` comes back on the result so the caller can log the
 * flag against a contact id — the flag and the id, never the offending string,
 * which is customer data.
 *
 * **A window that yields no slot inside `MAX_WINDOW_SEARCH_DAYS` throws.**
 * `settings.ts`'s validator accepts `days: []` today. Without this guard that
 * setting is either an infinite loop or, worse, a silent "send now" at 03:00.
 * `SendWindowError` fails closed and the approve action turns it into a sentence
 * the operator can act on: their send window has no days in it. The fix is a
 * settings edit, not a code change.
 *
 * **With the seeded default `[2,3,4]` — Tuesday to Thursday — approving on a
 * Monday schedules for Tuesday 09:0x.** That is the specified behaviour and it
 * is not a bug to be "fixed" by widening the default. PLAN §7.1's "almost always
 * in the next few minutes" is only true Tuesday to Thursday; the card shows the
 * scheduled time, so it is never a surprise.
 *
 * **DST is `zone.ts`'s problem and it is documented there.** The short version:
 * a local hour that does not exist resolves onto the hour after the jump, and a
 * local hour that happens twice resolves onto its second occurrence. Neither is
 * reachable from a 09:00–16:00 window in a European zone. Both become reachable
 * the moment an operator edits `send_window` to open at 02:00 or 03:00.
 *
 * **The weekday comes from `Date.UTC(...).getUTCDay()` on the local calendar
 * date**, not from an `Intl` weekday string. `settings.send_window.days` is
 * documented in `settings.ts` and seeded in `seed.sql` as JS `Date#getDay()`
 * numbers (0 = Sunday), and matching that numbering by arithmetic rather than by
 * parsing a localised day name keeps the result locale-independent.
 */

import { randomInt } from 'node:crypto';

import type { SendWindowSetting } from './settings';
import { isValidTimeZone, partsInZone, zonedTimeToUtc } from './zone';

/** PLAN §7.1: "plus 2–15 minutes of jitter". Inclusive at both ends. */
export const MIN_JITTER_MINUTES = 2;
export const MAX_JITTER_MINUTES = 15;

/**
 * How far ahead a slot is looked for before the window is called broken.
 *
 * Any non-empty `days` yields a slot within seven days, so fourteen is not a
 * tuning parameter — it is the bound that turns "no valid window" from an
 * infinite loop into an error with a name.
 */
export const MAX_WINDOW_SEARCH_DAYS = 14;

/**
 * Minutes of jitter.
 *
 * Injected rather than read from `Math.random` inside the loop so that a test
 * can assert an exact instant. A test that can only assert "somewhere in a
 * fifteen-minute range" cannot tell a correct DST calculation from an incorrect
 * one, which is most of what this module needs proving.
 */
export type JitterSource = () => number;

const MS_PER_MINUTE = 60_000;

/**
 * Uniform integer in [2, 15].
 *
 * `randomInt` rather than `Math.random` for the reason the rest of this repo
 * reaches for `node:crypto`: it is already there, it is unbiased over the range
 * without anyone having to think about modulo, and the `max` argument is
 * exclusive so the `+ 1` is deliberate. The choice is not security-relevant —
 * predicting the jitter buys an attacker nothing — it is about not writing a
 * biased range by hand.
 *
 * The `node:crypto` import is why this module is reachable by subpath and not
 * from a Client Component. Its only web consumer is a Server Action.
 */
export const defaultJitter: JitterSource = () =>
  randomInt(MIN_JITTER_MINUTES, MAX_JITTER_MINUTES + 1);

/**
 * No slot inside `MAX_WINDOW_SEARCH_DAYS`.
 *
 * In practice this means `days` is empty. It fails closed — nothing is
 * scheduled, and the operator is told why — rather than falling back to "send
 * now", which would put a message in somebody's inbox at three in the morning
 * because of a settings edit.
 */
export class SendWindowError extends Error {
  override readonly name = 'SendWindowError';
  readonly window: SendWindowSetting;
  readonly timeZone: string;

  constructor(window: SendWindowSetting, timeZone: string) {
    super(
      `No send slot found within ${MAX_WINDOW_SEARCH_DAYS} days for window ` +
        `days=[${window.days.join(',')}] ${window.start_hour}:00-${window.end_hour}:00 in ${timeZone}. ` +
        `Check settings.send_window in /brain — a window with no days selected can never schedule anything.`,
    );
    this.window = window;
    this.timeZone = timeZone;
  }
}

/** Every day of the week, in the `Date#getDay()` numbering `days` uses. */
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * The window an approved task actually belongs in.
 *
 * ---------------------------------------------------------------------------
 * Why an inbox reply is not scheduled like a follow-up
 * ---------------------------------------------------------------------------
 *
 * `settings.send_window` exists for outbound prospecting. PLAN §7.1 introduces
 * it for the follow-up agent and the seeded value is Tuesday to Thursday,
 * 09:00–16:00, which is a sensible cadence for messages *we* decided to start.
 *
 * Step 8 inherited it without a decision being recorded, and the consequence is
 * not subtle. A customer writes in at 17:10 on a Thursday. The webhook fires,
 * the reply is drafted, the operator gets the push, opens Today on Friday
 * morning and approves — and `nextSendSlot` walks forward to the next day in
 * `[2,3,4]` and schedules the answer for the following **Tuesday**. Five days
 * after they asked a question. The card does say so, which makes it visible
 * rather than silent, but visible is not the same as right: an unanswered
 * customer is the exact failure this system exists to prevent, and it would be
 * this system causing it.
 *
 * So a reply keeps the *hours* and drops the *days*. The hours are the part
 * that is about the recipient — PLAN §7.1's real argument is that a message
 * arriving at 03:00 reads as a machine — and they still apply. The days are the
 * part that is about our outreach rhythm, and answering a question is not
 * outreach.
 *
 * Keyed on `tasks.agent`, which is free text: anything that is not `inbox` gets
 * the configured window. That is the safe direction — an unknown agent is
 * treated as outbound and waits.
 */
export function windowForAgent(agent: string | null, window: SendWindowSetting): SendWindowSetting {
  if (agent !== 'inbox') return window;
  return { ...window, days: [...EVERY_DAY] };
}

export type SendSlotInput = {
  /** Usually the approval instant. */
  from: Date;
  /** `contacts.timezone`, raw and possibly rubbish. */
  timeZone: string | null;
  /** Used when `timeZone` is absent or `Intl` rejects it. Pass `appTimezone()`. */
  fallbackTimeZone: string;
  window: SendWindowSetting;
  jitter?: JitterSource;
};

export type SendSlot = {
  /** What goes in `tasks.send_after`. */
  sendAfter: Date;
  /** The zone actually used. */
  timeZone: string;
  /** True when `timeZone` was unusable and `fallbackTimeZone` was substituted. */
  timeZoneFallback: boolean;
  /** `from` was already inside the window; only jitter was added. */
  immediate: boolean;
  jitterMinutes: number;
  /** For the card: "Sends in about 7 minutes." / "Sends Tuesday from 09:00." */
  reason: string;
};

/**
 * JS `Date#getDay()` numbering, written out rather than formatted.
 *
 * `Intl` would return the weekday in whatever locale it was handed, and the
 * card is English. Seven strings are cheaper than a locale decision, and they
 * cannot drift from the numbering `settings.send_window.days` uses.
 */
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * Clamp the injected jitter into the range PLAN §7.1 specifies.
 *
 * A source that returns 0, 900, or `NaN` is a caller bug, and the two honest
 * responses are to throw or to clamp. Clamping wins because the alternative is
 * an approval that fails for a reason the operator cannot act on: the bound that
 * matters is "not outside business hours", and every value in [2, 15] satisfies
 * it. `NaN` clamps to the floor rather than propagating, because `NaN`
 * milliseconds added to an instant produces an Invalid Date that would be
 * written to `send_after` and silently never come due.
 */
export function clampJitterMinutes(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_JITTER_MINUTES;
  return Math.min(MAX_JITTER_MINUTES, Math.max(MIN_JITTER_MINUTES, Math.round(raw)));
}

/**
 * The next instant this message is allowed to leave.
 *
 * Throws `SendWindowError` when the window can never produce one. Every other
 * input — a null timezone, `Mars/Olympus`, an approval at 23:00 on a Saturday —
 * produces a slot.
 */
export function nextSendSlot(input: SendSlotInput): SendSlot {
  const raw = typeof input.timeZone === 'string' ? input.timeZone.trim() : '';
  const usable = isValidTimeZone(raw);
  const timeZone = usable ? raw : input.fallbackTimeZone;
  const timeZoneFallback = !usable;

  const jitterMinutes = clampJitterMinutes((input.jitter ?? defaultJitter)());
  const jitterMs = jitterMinutes * MS_PER_MINUTE;

  const window = input.window;
  const days = new Set(window.days);
  const base = partsInZone(input.from, timeZone);

  for (let offset = 0; offset <= MAX_WINDOW_SEARCH_DAYS; offset += 1) {
    // Date.UTC normalises the rollover — day 30 + 5 becomes the 4th of the next
    // month, across a year boundary included — and gives the weekday in the same
    // 0=Sunday numbering `window.days` uses.
    const date = new Date(Date.UTC(base.year, base.month - 1, base.day + offset));
    if (!days.has(date.getUTCDay())) continue;

    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();

    const start = zonedTimeToUtc(year, month, day, window.start_hour, 0, timeZone);
    const end = zonedTimeToUtc(year, month, day, window.end_hour, 0, timeZone);

    // Only the first day considered can be partly in the past; every later one
    // starts at `start_hour` by definition.
    const insideAlready = offset === 0 && input.from.getTime() > start.getTime();
    const anchor = insideAlready ? input.from.getTime() : start.getTime();
    const candidate = anchor + jitterMs;

    // The roll-forward rule: a jittered instant at or past the close belongs to
    // the next window day, not to the last quarter-hour of this one.
    if (candidate >= end.getTime()) continue;

    const sendAfter = new Date(candidate);
    return {
      sendAfter,
      timeZone,
      timeZoneFallback,
      immediate: insideAlready,
      jitterMinutes,
      reason: describeSlot({
        immediate: insideAlready,
        jitterMinutes,
        startHour: window.start_hour,
        weekday: date.getUTCDay(),
        sameLocalDay: offset === 0,
      }),
    };
  }

  throw new SendWindowError(window, timeZone);
}

/**
 * The sentence on the task card.
 *
 * Written here rather than in the web app because it is derived from numbers the
 * web app would otherwise have to recompute, and a second computation is a
 * second chance to disagree with `send_after`. No customer data reaches it.
 */
export function describeSlot(input: {
  immediate: boolean;
  jitterMinutes: number;
  startHour: number;
  weekday: number;
  sameLocalDay: boolean;
}): string {
  if (input.immediate) {
    const unit = input.jitterMinutes === 1 ? 'minute' : 'minutes';
    return `Sends in about ${input.jitterMinutes} ${unit}.`;
  }
  const hour = String(input.startHour).padStart(2, '0');
  const when = input.sameLocalDay
    ? 'today'
    : (WEEKDAY_NAMES[input.weekday] ?? 'the next working day');
  return `Sends ${when} from ${hour}:00.`;
}
