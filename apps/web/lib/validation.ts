/**
 * Contact input validation.
 *
 * Two jobs:
 *
 * 1. **Mirror the database.** `contacts.language`, `.source` and `.stage` each
 *    carry a CHECK constraint in supabase/migrations/20260731120000_init.sql.
 *    Everything Postgres rejects is rejected here first, so the operator gets
 *    "Pick a stage from the list" instead of
 *    `new row for relation "contacts" violates check constraint`. The
 *    vocabularies themselves live in ./contact-vocab — that module is
 *    type-only-importing and therefore safe in a Client Component, which this
 *    one is not (see below). It is re-exported at the bottom so server callers
 *    have one import to reach for.
 *
 * 2. **Enforce the rules the database cannot express.** Email format, a
 *    follow-up date that is not already in the past, and money typed by a human
 *    who thinks in Greek number formatting.
 *
 * **Server-side only.** This module value-imports `appTimezone` from
 * @agency/core, whose barrel re-exports the Supabase client factories. A Client
 * Component may `import type` from here — types are erased — but must never
 * value-import it. The dropdown vocabularies it needs are in ./contact-vocab,
 * and the pure day maths is in ./day.
 */

import { appTimezone } from '@agency/core';
import type { ContactInsert, Language, Source, Stage } from '@agency/core';
import { dayKeyInZone, zonedTimeToUtc } from '@agency/core/zone';

import {
  CONTACT_LANGUAGES,
  CONTACT_SOURCES,
  CONTACT_STAGES,
  MAX_TAGS,
  isLanguage,
  isSource,
  isStage,
  parseTags,
} from './contact-vocab';
import type { StageFilter } from './contact-vocab';

// ---------------------------------------------------------------------------
// Query vocabulary for /pipeline — filter, search, sort
// ---------------------------------------------------------------------------

export const CONTACT_SORTS = ['next_touch', 'recent', 'name', 'stage', 'value'] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];

export const SORT_LABELS: Record<ContactSort, string> = {
  next_touch: 'Next touch',
  recent: 'Recently added',
  name: 'Name',
  stage: 'Stage',
  value: 'Value',
};

export const DEFAULT_SORT: ContactSort = 'next_touch';

export const SORT_OPTIONS: readonly { value: string; label: string }[] = CONTACT_SORTS.map(
  (sort) => ({ value: sort, label: SORT_LABELS[sort] }),
);

/** How many rows a single /pipeline render will read. A hard ceiling so the page
 *  cannot degrade into an unbounded table scan as the pipeline grows. */
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_LIST_LIMIT = 200;

export function toContactSort(value: unknown): ContactSort {
  return typeof value === 'string' && (CONTACT_SORTS as readonly string[]).includes(value)
    ? (value as ContactSort)
    : DEFAULT_SORT;
}

/**
 * Sanitise a search term for PostgREST.
 *
 * The search hits four columns via `.or('name.ilike.*,business.ilike.*,…')`, and
 * that filter string is parsed by PostgREST — a comma or a parenthesis in the
 * user's input would end the current condition and start a new one, which is
 * filter injection in the same shape as SQL injection. Those characters are
 * removed rather than escaped: nobody searches their pipeline for `)`.
 */
export function normaliseSearch(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .trim()
    .replace(/[,()"'\\*]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 100)
    .trim();
  return cleaned === '' ? null : cleaned;
}

/** Everything /pipeline needs to run one query. */
export type ContactQuery = {
  stage?: StageFilter;
  /** Exact tag match (already normalized). '' or undefined means no filter. */
  tag?: string | null;
  search?: string | null;
  sort?: ContactSort;
  limit?: number;
};

// ---------------------------------------------------------------------------
// Errors and results
// ---------------------------------------------------------------------------

/**
 * Error keys are form field names, plus `form` for anything that isn't about one
 * field. The UI renders `errors[field]` next to its input.
 */
export const CONTACT_FIELDS = [
  'name',
  'business',
  'email',
  'phone',
  'language',
  'city',
  'country',
  'source',
  'stage',
  'value_estimate',
  'notes',
  'next_touch_at',
  'tags',
  'do_not_contact',
  'form',
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];
export type FieldErrors = Partial<Record<ContactField, string>>;

/**
 * What every Server Action in lib/contact-actions.ts returns. Actions do not
 * throw on bad input — a thrown error in a Server Action reaches the user as a
 * generic "an error occurred", which is useless when what actually happened is
 * "that date is in the past".
 */
export type ActionResult = { ok: true; id: string } | { ok: false; errors: FieldErrors };

export function fail(errors: FieldErrors): { ok: false; errors: FieldErrors } {
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/**
 * A date-only follow-up ("chase them on the 12th") is stored as 08:00 in the
 * operator's timezone: the hour the follow-up agent runs (SPEC §4), so a date
 * picked in the UI is due on that morning's run and not a day later.
 *
 * Still declared twice — the other copy is `FOLLOWUP_HOUR` in
 * `apps/worker/src/jobs/followup-select.ts`, and the two must stay the same 8 or
 * half the pipeline silently slips a day. Now that `@agency/core` exists as a
 * home for it, converging the constant is a cadence change with the follow-up
 * selector's tests behind it, and is recorded as such rather than smuggled into
 * an integration pass.
 */
export const FOLLOWUP_HOUR = 8;

/**
 * The timezone arithmetic itself now lives once, in `@agency/core/zone`.
 *
 * It used to be a private copy here and another in the worker's follow-up
 * selector, each with a header saying the other existed and had to be kept in
 * step. Step 6 needed it a third time — the send window, from both apps — so the
 * shared module was written and the two copies were deleted into it. The
 * functions are step for step what was here: the same two-pass offset
 * resolution, the same hour-24 correction, the same `'YYYY-MM-DD'` output.
 *
 * They are re-exported rather than left for callers to import directly because
 * every screen in this app already reaches for `dayKeyInZone` from here, and
 * because this is the module whose job is to say what a timezone means in
 * apps/web. `@agency/core/zone` is a leaf with no imports at all, so nothing
 * about routing it through this (server-only) module makes it heavier.
 */
export { dayKeyInZone, zonedTimeToUtc } from '@agency/core/zone';

/**
 * A stored `timestamptz` → the calendar day it falls on in the operator's zone,
 * or null when the column is empty or holds something unparseable.
 *
 * Every screen wants exactly this and three of them had written it out privately
 * — `/pipeline`'s `toDayKey`, Today's `dayOf`, and the nav's run stamp. The null
 * cases are the reason it is worth one function: `new Date(null!)` is an invalid
 * Date, `dayKeyInZone` on an invalid Date returns `'NaN-NaN-NaN'`, and that
 * string sorts and compares perfectly happily against a real day key. A screen
 * would render "3 days overdue" about nothing at all.
 */
export function dayKeyOf(iso: string | null, timeZone: string): string | null {
  if (iso === null) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  return dayKeyInZone(instant, timeZone);
}

/**
 * Is this timestamp on a calendar day before today, in the operator's timezone?
 *
 * Calendar days, not instants, on purpose: picking "today" at 14:00 for a
 * follow-up whose stored time is 08:00 is a perfectly sensible thing to do and
 * must not be rejected as "in the past".
 */
export function isPastDay(iso: string, timeZone: string = appTimezone()): boolean {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return false;
  return dayKeyInZone(instant, timeZone) < dayKeyInZone(new Date(), timeZone);
}

/**
 * `contacts.timezone` (PLAN.md §7.1): derived from country at creation,
 * defaulting to Europe/Athens. It exists so the send window in step 6 means
 * local business hours for contacts abroad — a message landing at 03:00 reads as
 * a machine, which is the one thing these drafts must not do.
 *
 * Countries that span several zones map to their largest-population zone. That
 * is a deliberate approximation for a pipeline that is almost entirely Greek;
 * per-contact correction can come later if it ever matters.
 */
const TIMEZONE_BY_COUNTRY: Record<string, string> = {
  GR: 'Europe/Athens',
  CY: 'Asia/Nicosia',
  BG: 'Europe/Sofia',
  RO: 'Europe/Bucharest',
  DE: 'Europe/Berlin',
  AT: 'Europe/Vienna',
  CH: 'Europe/Zurich',
  FR: 'Europe/Paris',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels',
  DK: 'Europe/Copenhagen',
  SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',
  FI: 'Europe/Helsinki',
  PL: 'Europe/Warsaw',
  CZ: 'Europe/Prague',
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  AE: 'Asia/Dubai',
  US: 'America/New_York',
  CA: 'America/Toronto',
  AU: 'Australia/Sydney',
};

export function timezoneForCountry(country: string | null): string {
  if (country === null) return appTimezone();
  return TIMEZONE_BY_COUNTRY[country.trim().toUpperCase()] ?? appTimezone();
}

// ---------------------------------------------------------------------------
// Field parsers
// ---------------------------------------------------------------------------

function text(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}

function optionalText(formData: FormData, key: string, maxLength: number): string | null {
  const value = text(formData, key);
  if (value === '') return null;
  return value.slice(0, maxLength);
}

function checkbox(formData: FormData, key: string): boolean {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return false;
  const value = raw.toLowerCase();
  return value === 'on' || value === 'true' || value === '1' || value === 'yes';
}

/**
 * Deliberately not RFC 5322. A permissive-but-sane shape check: one @, a dot in
 * the domain, no whitespace or the delimiters that break header parsing. The
 * real validation is that a magic link, or a reply, arrives.
 */
export function isValidEmail(value: string): boolean {
  if (value.length > 254) return false;
  return /^[^\s@,;:<>"'\\()[\]]+@[^\s@,;:<>"'\\()[\].]+(\.[^\s@,;:<>"'\\()[\].]+)+$/.test(value);
}

export function isValidPhone(value: string): boolean {
  if (!/^\+?[\d\s().-]{6,24}$/.test(value)) return false;
  return (value.match(/\d/g) ?? []).length >= 6;
}

/**
 * Accepts what an `<input type="date">`, an `<input type="datetime-local">`, or
 * a full ISO timestamp will send, and returns a UTC ISO string.
 *
 * Date-only and datetime-local values carry no offset, so they are read as wall
 * time in the operator's timezone — the alternative, treating them as UTC, puts
 * every summer follow-up three hours off.
 */
export function parseDateInput(
  raw: string,
  timeZone: string = appTimezone(),
): { ok: true; iso: string | null } | { ok: false; message: string } {
  const value = raw.trim();
  if (value === '') return { ok: true, iso: null };

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const localDateTime = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  const match = dateOnly ?? localDateTime;

  if (match !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = dateOnly !== null ? FOLLOWUP_HOUR : Number(match[4]);
    const minute = dateOnly !== null ? 0 : Number(match[5]);

    // `Date.UTC` happily rolls 2026-02-31 over into March. Reject it instead.
    const roundTrip = new Date(Date.UTC(year, month - 1, day));
    if (
      roundTrip.getUTCFullYear() !== year ||
      roundTrip.getUTCMonth() !== month - 1 ||
      roundTrip.getUTCDate() !== day ||
      hour > 23 ||
      minute > 59
    ) {
      return { ok: false, message: 'That is not a real date.' };
    }

    return { ok: true, iso: zonedTimeToUtc(year, month, day, hour, minute, timeZone).toISOString() };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, message: 'Use a date like 2026-08-14.' };
  }
  return { ok: true, iso: parsed.toISOString() };
}

/**
 * Money, typed by a human who thinks in Greek number formatting.
 *
 * `1.500,50` and `1,500.50` and `1500.5` all have to mean the same thing, so the
 * separators are resolved rather than assumed:
 *   - both separators present → the last one is the decimal point
 *   - one separator, appearing more than once → all of them are thousands marks
 *   - one separator followed by exactly three digits → a thousands mark
 *     (`1,500` is fifteen hundred, not one and a half)
 *   - anything else → a decimal point
 */
function normaliseNumericInput(raw: string): string {
  let value = raw.trim().replace(/[€\s ]/g, '');
  const lastDot = value.lastIndexOf('.');
  const lastComma = value.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    value = value.split(thousands).join('');
    return decimal === ',' ? value.replace(',', '.') : value;
  }

  const separator = lastDot !== -1 ? '.' : lastComma !== -1 ? ',' : null;
  if (separator === null) return value;

  const parts = value.split(separator);
  const tail = parts[parts.length - 1] ?? '';
  if (parts.length > 2 || (parts.length === 2 && tail.length === 3 && parts[0] !== '')) {
    return parts.join('');
  }
  return parts.join('.');
}

export function parseValueEstimate(
  raw: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const value = normaliseNumericInput(raw);
  if (value === '') return { ok: true, value: null };

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return { ok: false, message: 'Use a number, e.g. 1500.' };
  if (parsed < 0) return { ok: false, message: 'A value cannot be negative.' };
  if (parsed > 100_000_000) return { ok: false, message: 'That value looks like a typo.' };

  return { ok: true, value: Math.round(parsed * 100) / 100 };
}

// ---------------------------------------------------------------------------
// The whole form
// ---------------------------------------------------------------------------

/**
 * A validated contact, shaped exactly like the columns it will be written to.
 * Every field is present — this is a full-form write, not a patch.
 *
 * Four fields are narrower than the schema's, because validation always supplies
 * them: `language`, `stage`, `timezone` and `do_not_contact` are never null
 * coming out of `parseContactForm`, even though the columns allow it.
 */
export type ContactInput = {
  name: string | null;
  business: string | null;
  email: string | null;
  phone: string | null;
  language: Language;
  city: string | null;
  country: string | null;
  timezone: string;
  source: Source | null;
  stage: Stage;
  value_estimate: number | null;
  notes: string | null;
  next_touch_at: string | null;
  do_not_contact: boolean;
  /** Normalized, de-duplicated. Column is NOT NULL, so this is never null. */
  tags: string[];
};

/**
 * Compile-time tie to the schema. `ContactInput` is written out above rather
 * than derived, because deriving it would lose the four narrowings — but nothing
 * would otherwise stop it drifting from the `contacts` table it is inserted
 * into. These two aliases fail to compile if a field carries a type the column
 * will not take, or if a field is not a column at all.
 *
 * Exported because they are the contract, and because an unused local type is
 * the first thing a future edit deletes.
 */
export type ContactInputIsInsertable = ContactInput extends ContactInsert ? true : never;
export type ContactInputHasNoStrayColumns =
  Exclude<keyof ContactInput, keyof ContactInsert> extends never ? true : never;

const _schemaContract: [ContactInputIsInsertable, ContactInputHasNoStrayColumns] = [true, true];
void _schemaContract;

export type ParseResult = { ok: true; value: ContactInput } | { ok: false; errors: FieldErrors };

export type ParseMode = 'create' | 'update';

/**
 * Validate a contact form.
 *
 * `mode` changes exactly one rule: a past `next_touch_at` is rejected on create,
 * and allowed here on update. Re-saving a contact whose follow-up date slipped
 * by while you were heads-down must not fail because of a field you did not
 * touch — lib/contact-actions.ts re-applies the check on update only when the
 * date has actually changed.
 *
 * **A missing email is not an error.** It used to be, whenever a follow-up date
 * was set, on the reasoning that email is the only outbound channel. But the
 * commonest contact in this pipeline is an NFC card with a name and a phone
 * number, three screens promise that "a name and a follow-up date is enough",
 * and a date on such a contact is still worth having: it brings the row back to
 * the top of /pipeline on the morning it is due, which is a reminder for the
 * operator even when the agent has nothing to send. The form says so next to the
 * date field, and step 5 is where the agent skips a contact it cannot email.
 *
 * Returns every error at once. Fixing a form one field per round trip is the
 * thing that makes people stop entering contacts, and a contact that never gets
 * entered is the failure this whole app exists to prevent.
 */
export function parseContactForm(
  formData: FormData,
  mode: ParseMode,
  timeZone: string = appTimezone(),
): ParseResult {
  const errors: FieldErrors = {};

  const name = optionalText(formData, 'name', 200);
  const business = optionalText(formData, 'business', 200);
  if (name === null && business === null) {
    errors.name = 'Give the contact a name or a business.';
  }

  const emailRaw = text(formData, 'email').toLowerCase();
  let email: string | null = null;
  if (emailRaw !== '') {
    if (!isValidEmail(emailRaw)) errors.email = 'That is not a valid email address.';
    else email = emailRaw;
  }

  const phoneRaw = text(formData, 'phone');
  let phone: string | null = null;
  if (phoneRaw !== '') {
    if (!isValidPhone(phoneRaw)) errors.phone = 'That is not a valid phone number.';
    else phone = phoneRaw.slice(0, 40);
  }

  const languageRaw = text(formData, 'language');
  const language: Language = isLanguage(languageRaw) ? languageRaw : 'el';
  if (languageRaw !== '' && !isLanguage(languageRaw)) {
    errors.language = `Language must be one of: ${CONTACT_LANGUAGES.join(', ')}.`;
  }

  const stageRaw = text(formData, 'stage');
  const stage: Stage = isStage(stageRaw) ? stageRaw : 'new';
  if (stageRaw !== '' && !isStage(stageRaw)) {
    errors.stage = `Stage must be one of: ${CONTACT_STAGES.join(', ')}.`;
  }

  const sourceRaw = text(formData, 'source');
  let source: Source | null = null;
  if (sourceRaw !== '') {
    if (!isSource(sourceRaw)) errors.source = `Source must be one of: ${CONTACT_SOURCES.join(', ')}.`;
    else source = sourceRaw;
  }

  const city = optionalText(formData, 'city', 120);

  const countryRaw = text(formData, 'country').toUpperCase();
  let country: string | null = null;
  if (countryRaw !== '') {
    if (!/^[A-Z]{2}$/.test(countryRaw)) {
      errors.country = 'Use a two-letter country code, e.g. GR.';
    } else {
      country = countryRaw;
    }
  }

  const valueResult = parseValueEstimate(text(formData, 'value_estimate'));
  let value_estimate: number | null = null;
  if (!valueResult.ok) errors.value_estimate = valueResult.message;
  else value_estimate = valueResult.value;

  const notes = optionalText(formData, 'notes', 10_000);

  const dateResult = parseDateInput(text(formData, 'next_touch_at'), timeZone);
  let next_touch_at: string | null = null;
  if (!dateResult.ok) {
    errors.next_touch_at = dateResult.message;
  } else {
    next_touch_at = dateResult.iso;
    if (mode === 'create' && next_touch_at !== null && isPastDay(next_touch_at, timeZone)) {
      errors.next_touch_at = 'That date has already passed. Pick today or later.';
    }
  }

  const do_not_contact = checkbox(formData, 'do_not_contact');

  // Opting a contact out clears their follow-up rather than erroring: a date
  // that can never fire is not an input mistake to correct, it is a leftover.
  // `do_not_contact` is permanent and checked again at send time (PLAN.md §7).
  if (do_not_contact) next_touch_at = null;

  // Tags are free-form, so there is nothing to reject against a vocabulary — but
  // an over-long list is a paste accident rather than intent, and silently
  // truncating it would lose data the operator thinks they saved.
  const tagsRaw = text(formData, 'tags');
  const tags = parseTags(tagsRaw);
  if (tagsRaw.split(',').filter((part) => part.trim() !== '').length > MAX_TAGS) {
    errors.tags = `That is more than ${MAX_TAGS} tags. Keep the ones that describe the work.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name,
      business,
      email,
      phone,
      language,
      city,
      country,
      timezone: timezoneForCountry(country),
      source,
      stage,
      value_estimate,
      notes,
      next_touch_at,
      do_not_contact,
      tags,
    },
  };
}

/** Guard against a malformed id reaching PostgREST as a filter value. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

// ---------------------------------------------------------------------------
// Re-exported from ./contact-vocab so a server module has one import to reach
// for. Client Components must import from ./contact-vocab directly — reaching
// them through this module would pull @agency/core into the browser bundle.
// ---------------------------------------------------------------------------

export {
  CONTACT_LANGUAGES,
  CONTACT_SOURCES,
  CONTACT_STAGES,
  LANGUAGE_LABELS,
  LANGUAGE_OPTIONS,
  SOURCE_LABELS,
  SOURCE_OPTIONS,
  STAGE_FILTER_OPTIONS,
  STAGE_LABELS,
  STAGE_OPTIONS,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  SUGGESTED_TAGS,
  blankToNull,
  contactLine,
  formatTags,
  isLanguage,
  isSource,
  isStage,
  normalizeTag,
  parseTags,
  toStageFilter,
  toTagFilter,
} from './contact-vocab';
export type { StageFilter, VocabOption } from './contact-vocab';
