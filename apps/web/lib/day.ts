/**
 * Calendar-day arithmetic and formatting. One copy, used by the list, the
 * contact page and the follow-up field.
 *
 * A "day" here is a `'YYYY-MM-DD'` string that has **already had its timezone
 * resolved** — `dayKeyInZone` in lib/validation.ts is the one place that turns a
 * stored `timestamptz` into one of these, and it does it on the server in the
 * operator's zone (PLAN.md §7.1). Everything below is then pure string and
 * number work: no clock, no locale, no `Intl`, no timezone. That is what lets a
 * Server Component format a date and a Client Component render it without a
 * hydration mismatch, and what keeps a laptop in another airport from changing
 * what "3 days overdue" means.
 *
 * The arithmetic is done in UTC on purpose. These strings carry no offset, so
 * doing it in local time would make a DST boundary between two of them come out
 * as 6.958 days.
 *
 * This module existed three times before, in app/pipeline/page.tsx,
 * app/pipeline/[id]/page.tsx and components/pipeline/next-touch-field.tsx, and
 * the copies had already drifted: one validated `2026-02-31` and one rolled it
 * over into March, and the list said "3 days ago" where the detail page said
 * "3d ago" about the same column. The validating version and the long labels
 * are the ones kept.
 *
 * Pure, dependency-free, and safe to import from a Client Component.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * `'YYYY-MM-DD'` → epoch ms at UTC midnight, or null if it is not a real date.
 *
 * The round-trip check is the reason this is a function and not one line:
 * `Date.UTC(2026, 1, 31)` happily returns 3 March. Every caller wants null
 * there, and the copy in app/pipeline/[id]/page.tsx used to silently return
 * March.
 */
export function dayToUtcMs(day: string): number | null {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const ms = Date.UTC(year, month - 1, date);

  const roundTrip = new Date(ms);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== date
  ) {
    return null;
  }
  return ms;
}

export function utcMsToDay(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** `addDays('2026-08-14', 7)` → `'2026-08-21'`. Null for an unreal date. */
export function addDays(day: string, days: number): string | null {
  const ms = dayToUtcMs(day);
  return ms === null ? null : utcMsToDay(ms + days * MS_PER_DAY);
}

/** Whole days from `from` to `to`. Negative means `to` is in the past. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayToUtcMs(from);
  const b = dayToUtcMs(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/** The year a day falls in, for the "drop the year unless it differs" rule. */
export function yearOf(day: string): number {
  return Number(day.slice(0, 4));
}

/**
 * `'14 Aug'`, or `'14 Aug 2027'` once the year stops being `currentYear`
 * (DESIGN.md §7: dates are absolute and unambiguous). Returns the input
 * unchanged if it is not a real date, so a cell never renders empty.
 */
export function formatDay(day: string, currentYear: number): string {
  const ms = dayToUtcMs(day);
  if (ms === null) return day;

  const date = new Date(ms);
  const month = MONTHS[date.getUTCMonth()] ?? '';
  const year = date.getUTCFullYear();

  return `${date.getUTCDate()} ${month}${year === currentYear ? '' : ` ${year}`}`;
}

/** `'Fri 14 Aug'` — the same, with a weekday. Used where a single date is the
 *  subject of the screen rather than one cell in a column. */
export function formatDayWithWeekday(day: string, currentYear: number): string {
  const ms = dayToUtcMs(day);
  if (ms === null) return day;

  const date = new Date(ms);
  const weekday = WEEKDAYS[date.getUTCDay()] ?? '';
  return `${weekday} ${formatDay(day, currentYear)}`;
}

/**
 * The relative hint beside a **future-leaning** date — `next_touch_at`.
 *
 * Never shown on its own: the absolute date is always next to it, which is what
 * makes "in 5 days" safe (DESIGN.md §7).
 */
export function futureLabel(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return '1 day overdue';
  if (days < 0) {
    const overdue = Math.abs(days);
    return overdue < 60 ? `${overdue} days overdue` : `${Math.round(overdue / 30)} months overdue`;
  }
  return days < 60 ? `in ${days} days` : `in ${Math.round(days / 30)} months`;
}

/** The same, for a **past-leaning** date — `last_touch_at`, `created_at`. */
export function pastLabel(days: number): string {
  if (days === 0) return 'today';
  if (days === -1) return 'yesterday';
  if (days === 1) return 'tomorrow';
  if (days < 0) {
    const ago = Math.abs(days);
    return ago < 60 ? `${ago} days ago` : `${Math.round(ago / 30)} months ago`;
  }
  return days < 60 ? `in ${days} days` : `in ${Math.round(days / 30)} months`;
}

/**
 * DESIGN.md §2, the date rule: past is danger, today or within 48h is warning,
 * anything further out is ordinary metadata. Returned as the tone name so the
 * caller picks the utility — the table paints a rail as well as text.
 */
export type DueTone = 'overdue' | 'due' | 'later';

export function toneFor(days: number): DueTone {
  if (days < 0) return 'overdue';
  if (days <= 2) return 'due';
  return 'later';
}

/** `text-*` utility for a tone. The one mapping, so three screens agree. */
export const DUE_TEXT_TONE: Record<DueTone, string> = {
  overdue: 'text-danger',
  due: 'text-warning',
  later: 'text-muted',
};

/**
 * `'€1,500'` — cents only when there are any, because a column of `.00` is noise
 * in a table read at a glance. Grouped by hand for the same reason the dates
 * are: one deterministic string, whatever the host's ICU data says.
 */
export function formatEuro(value: number): string {
  if (!Number.isFinite(value)) return '—';

  const negative = value < 0;
  const cents = Math.round(Math.abs(value) * 100);
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;

  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimals = fraction === 0 ? '' : `.${String(fraction).padStart(2, '0')}`;

  return `${negative ? '−' : ''}€${grouped}${decimals}`;
}
