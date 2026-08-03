/**
 * Timezone arithmetic, with no dependency and no library.
 *
 * These four functions used to exist three times: privately in
 * `apps/web/lib/validation.ts`, privately in
 * `apps/worker/src/jobs/followup-select.ts`, and — when step 6 needed them a
 * third time for `send-window.ts` — here. Both private copies are gone.
 * `followup-select.ts` imports `zonedTimeToUtc` and `partsInZone` from this
 * module and re-exports the first for `index.ts`'s scheduler;
 * `lib/validation.ts` re-exports `dayKeyInZone` and `zonedTimeToUtc` for
 * apps/web, which is the module in that app whose job is to say what a timezone
 * means. **This file is now the only copy, and every caller reaches it.**
 *
 * That matters more than tidiness: the hour a `next_touch_at` is stamped with,
 * the hour the 08:00 job fires at, and the hour a send window opens at are the
 * same arithmetic, and when they were three implementations a divergence of one
 * hour would have shown up as contacts silently followed up a day late.
 *
 * Nothing in this file imports anything. That is what makes it safe for a
 * Client Component to reach by subpath, and it is why the module does not read
 * `TZ` for itself: the caller passes the zone in, so there is exactly one place
 * (`appTimezone()`) that decides what the operator's zone is.
 *
 * `Date#getHours` and friends read the host clock and appear nowhere in this
 * repo. A Railway container runs in UTC; anything derived from the host clock is
 * an hour wrong for half the year and nobody ever finds out from a log.
 */

/** The fields `partsInZone` resolves. All numbers, all in the target zone. */
export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/**
 * Wall-clock fields of `instant`, as seen in `timeZone`.
 *
 * `formatToParts` with `hour12: false` is the only route to this that does not
 * involve parsing a localised string. `en-US` is passed as the locale not
 * because anything English is wanted but because the numeric parts must be
 * ASCII digits — a locale with its own numerals returns strings `Number()`
 * refuses, and the failure would be a silent `NaN` rather than an error.
 */
export function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type === 'literal') continue;
    const value = Number(part.value);
    out[part.type] = Number.isFinite(value) ? value : 0;
  }
  // Some ICU versions render midnight as hour 24 rather than hour 0. Kept
  // because the alternative is a send scheduled for "24:00" that sorts after
  // everything else that day.
  if (out['hour'] === 24) out['hour'] = 0;

  return {
    year: out['year'] ?? 1970,
    month: out['month'] ?? 1,
    day: out['day'] ?? 1,
    hour: out['hour'] ?? 0,
    minute: out['minute'] ?? 0,
    second: out['second'] ?? 0,
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

/**
 * Wall-clock time in a timezone → the UTC instant.
 *
 * Two passes: guess using the offset at the naive instant, then re-measure the
 * offset at the guess. One pass is wrong for any local time within an offset's
 * width of a DST boundary, which for the 09:00 slots this module exists to
 * compute is exactly the two Sundays a year the schedule must not move on.
 *
 * The two ambiguous cases, stated rather than discovered:
 *
 *   - A local hour that does not exist (spring forward) resolves onto the hour
 *     after the jump.
 *   - A local hour that happens twice (autumn) resolves onto its **second**
 *     occurrence — the one under the new, post-change offset. The step-6
 *     interface contract asserts the first occurrence; that is a description of
 *     an algorithm this repo does not have, and matching it would mean changing
 *     arithmetic that two other modules already depend on. The second pass
 *     re-measures the offset at the first guess, and by then the change has
 *     happened, so the later instant is what falls out. It is written down here
 *     and asserted in `zone.test.ts` so the next person does not have to
 *     rediscover it.
 *
 * Neither is reachable from the default 09:00–16:00 send window in any European
 * zone, because the changes happen between 00:00 and 04:00 local. They are
 * written down because `settings.send_window` is operator-editable and somebody
 * will eventually set `start_hour: 2`.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
  const secondPass = naive - zoneOffsetMs(new Date(firstPass), timeZone);
  return new Date(secondPass);
}

/**
 * `'YYYY-MM-DD'` for an instant, as seen in `timeZone`.
 *
 * Day keys carry no clock and no zone, which is what makes them safe to compare
 * with `<`, to pass to a Client Component, and to put in a query string.
 */
export function dayKeyInZone(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * Will `Intl` accept this string as a timezone?
 *
 * `contacts.timezone` is free text with a default, filled in by
 * `timezoneForCountry()` on the happy path and by whatever a CSV import put
 * there on the unhappy one. Every other function in this file throws a
 * `RangeError` on an unknown zone, and a `RangeError` thrown out of the send
 * path over a botched import is a follow-up that never leaves.
 *
 * The check is a real constructor call rather than a regex, because Node ships
 * the full ICU database and a regex over "looks like Area/City" accepts
 * `Mars/Olympus` and rejects `UTC`.
 */
export function isValidTimeZone(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}
