/**
 * Everything this app decides about `settings`, on the way in and on the way
 * out. Pure: no database, no clock, no `next/headers`, so the whole of it is
 * covered by ./settings-validation.test.ts.
 *
 * Two halves that have to agree with each other:
 *
 * - `coerceOperationalSettings` is the **read** path. Five jsonb rows, none of
 *   them typed at rest, into the values /brain renders and the Today page hands
 *   to `evaluateSend`.
 * - `parseSettingsForm` is the **write** path. What the operations form posts,
 *   into the values ./settings-actions.ts upserts.
 *
 * They were written separately during step 6 — /brain's read lived in
 * ./settings.ts and Today's in ./task-view.ts — and they had already drifted:
 * one accepted a fractional `start_hour` and the other did not. Two screens
 * disagreeing about what the stored send window means is not a cosmetic bug,
 * because one of them is what the operator reads on a card that says when their
 * message will leave. There is one read now, and it is the stricter of the two.
 *
 * **This duplicates `parseSetting` in packages/core/src/settings.ts on purpose,
 * and the two must stay in step.** The honest fix would be to call core's
 * `setSetting(db, key, value)` and have one validator — but that function takes
 * core's `Db`, which is `SupabaseClient<Database>` from @supabase/supabase-js,
 * and this app's client comes from @supabase/ssr. In a pnpm workspace those two
 * can resolve to different copies of the same package, and the assignment then
 * fails to compile with an error about two structurally identical types. The web
 * writes its own upserts and validates them here. The same "duplicated, keep
 * them in step" note already sits on `normalizeCadenceTag` and `zonedTimeToUtc`.
 *
 * Two rules here are deliberately **stricter** than core's:
 *
 * 1. `send_window.days` must contain at least one day. Core's validator accepts
 *    `[]`, which makes `nextSendSlot()` search fourteen days, find nothing and
 *    throw — so an empty array does not "send everything immediately", it blocks
 *    every approval on the Today page with an error the operator cannot act on
 *    from where they are standing. Rejecting it on the write path is the cheap
 *    half of the fix; core rejecting it on the read path is recorded as an
 *    integration follow-up.
 * 2. `autonomy` accepts 0 and 1 only. Core's type allows 2 and 3 because the
 *    ladder in SPEC §7 has four rungs, but v1's hard rule is that nothing leaves
 *    the system to a third party above level 1. The ladder is built and shown on
 *    the page; the promotion is not enabled, and this is where that is enforced.
 *    A stored 2 or 3 — which can only arrive from a hand-edited row — makes the
 *    form unsavable until the row is fixed. That is the correct outcome for a
 *    value v1 forbids, and the error text says which key is wrong.
 *
 * **This module imports types only, so it is safe in a client bundle** — the
 * same property lib/contact-vocab.ts has, and for the same reason: the /brain
 * editors need `MAX_BRAIN_CHARS` to show a character count, and a value import
 * from @agency/core would drag the barrel, and with it the Supabase client
 * factories, into the browser. That is why `BRAIN_KEY_SET` below is written out
 * instead of imported, with a compile-time check that it still matches
 * `BRAIN_KEYS`.
 *
 * Errors come back all at once, keyed by form field name, for the reason
 * `parseContactForm` gives: fixing a form one field per round trip is what makes
 * people stop using it.
 */

import type {
  AutonomyLevel,
  AutonomySetting,
  BrainKey,
  SendWindowSetting,
  SettingKey,
  TaskType,
} from '@agency/core';

// ---------------------------------------------------------------------------
// The shape both halves agree on
// ---------------------------------------------------------------------------

/**
 * The five operational settings, as this app holds them.
 *
 * Declared here rather than in ./settings.ts, which is where it started, so that
 * this module has no import from a server-only file at all — not even an erased
 * one. components/brain/brain-entry.tsx value-imports `MAX_BRAIN_CHARS` from
 * here, so this file ends up in the browser bundle; a `import type` from
 * ./settings.ts is erased today and would be an invisible tripwire the first
 * time somebody turned it into a value import.
 */
export type OperationalSettings = {
  killSwitch: boolean;
  dailySendCap: number;
  dailyCostCap: number;
  sendWindow: SendWindowSetting;
  autonomy: AutonomySetting;
};

/**
 * The same values, plus the keys whose stored row could not be read.
 *
 * A key with **no row** is a fresh database and takes its default in silence —
 * the seed simply has not run. A key with a row in the wrong shape takes the
 * default *loudly*, because core's `getSetting()` throws on exactly that value,
 * which means every cron job in the worker throws at the top and nothing is
 * sending. A screen that quietly renders the default while the worker is dead is
 * the specific silence this app exists to refuse.
 */
export type OperationalRead = OperationalSettings & {
  unreadable: readonly SettingKey[];
};

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * Error keys are the names of the controls on the page, plus `form` for anything
 * that is not about one field. The form renders `errors[field]` next to its
 * input, exactly as the contact form does.
 */
export const SETTINGS_FIELDS = [
  'daily_send_cap',
  'daily_cost_cap',
  'send_window_days',
  'send_window_start_hour',
  'send_window_end_hour',
  'autonomy_draft_email',
  'autonomy_reminder',
  'autonomy_alert',
  'kill_switch',
  'brain',
  'form',
] as const;

export type SettingsField = (typeof SETTINGS_FIELDS)[number];
export type SettingsErrors = Partial<Record<SettingsField, string>>;

export type SettingsFormResult =
  | { ok: true; value: OperationalSettings }
  | { ok: false; errors: SettingsErrors };

/**
 * What every Server Action in ./settings-actions.ts returns.
 *
 * It is declared here rather than there because a `'use server'` module is
 * required to export nothing but async functions. A type export is erased before
 * that check and works today, but the rule is about the file's public surface
 * and this type is about validation anyway — it belongs next to the errors it
 * carries.
 */
export type SettingsActionResult = { ok: true } | { ok: false; errors: SettingsErrors };

/** PLAN §7.1's ramp tops out at 40/day; the ceiling here is well above that so
 *  the field is a guard against a typo, not a policy. 0 is legal and means
 *  "pause sending without touching the kill switch". */
export const MIN_DAILY_SEND_CAP = 0;
export const MAX_DAILY_SEND_CAP = 200;

/** USD. The seeded value is 2.00; a hundred dollars a day on a single-operator
 *  pipeline is already a runaway loop, so nothing above it is a real setting. */
export const MIN_DAILY_COST_CAP = 0;
export const MAX_DAILY_COST_CAP = 100;

/** Hours are 0–24 with start < end, matching core. 24 is a valid `end_hour`
 *  (exclusive) and not a valid `start_hour`, which `start < end` already says. */
export const MIN_HOUR = 0;
export const MAX_HOUR = 24;

/** The whole prose of one brain key. Longer than any of the seeded files by an
 *  order of magnitude; a value past this is a paste accident. */
export const MAX_BRAIN_CHARS = 20_000;

/** v1's ceiling, restated here because this file is where it is enforced. */
export const V1_MAX_AUTONOMY: AutonomyLevel = 1;

const AUTONOMY_FIELD: Record<TaskType, SettingsField> = {
  draft_email: 'autonomy_draft_email',
  reminder: 'autonomy_reminder',
  alert: 'autonomy_alert',
};

const TASK_TYPES: readonly TaskType[] = ['draft_email', 'reminder', 'alert'];

// ---------------------------------------------------------------------------
// The read path — stored jsonb into typed values
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/**
 * Rows of `settings` into the five values, with the unreadable ones named.
 *
 * Deliberately **stricter than core's `parseSetting`** in two places, and the
 * difference is worth stating because the two files carry a "keep them in step"
 * note about each other:
 *
 * - Hours and weekdays must be integers. Core checks the range and not the
 *   shape, so `start_hour: 9.5` survives it and reaches `zonedTimeToUtc`, which
 *   turns a half-hour into a `Date.UTC` argument and produces a send time nobody
 *   asked for. There is no such thing as a fractional business hour here.
 * - The send cap must be a non-negative integer. Half an email is not a cap.
 *
 * Being stricter on the read is safe in the direction that matters: a value this
 * rejects is a value core will also refuse to parse or will parse into something
 * unusable, so naming it in `unreadable` tells the operator about a row that was
 * going to break the worker anyway.
 *
 * **`send_window.days: []` is accepted and is not malformed.** It is a legal but
 * unusable value: it means no day is a sending day, `nextSendSlot` searches
 * fourteen days, finds nothing and throws `SendWindowError`, and the approve
 * action reports that in words the operator can act on. Coercing it back to the
 * default here would send messages on days somebody deliberately cleared, which
 * is a worse failure than a refused approval. The write path in
 * `parseSettingsForm` refuses to *create* the state; the read path does not
 * pretend it is absent.
 *
 * `defaults` is a parameter rather than an import so this module stays free of
 * value imports and therefore safe in a client bundle. `SETTING_DEFAULTS` is a
 * value in @agency/core, whose barrel constructs the service-role client.
 */
export function coerceOperationalSettings(
  rows: readonly { key: string; value: unknown }[],
  defaults: OperationalSettings,
): OperationalRead {
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const unreadable: SettingKey[] = [];

  function pick<T>(key: SettingKey, coerce: (value: unknown) => T | null, fallback: T): T {
    if (!byKey.has(key)) return fallback;
    const coerced = coerce(byKey.get(key));
    if (coerced === null) {
      unreadable.push(key);
      return fallback;
    }
    return coerced;
  }

  const killSwitch = pick(
    'kill_switch',
    (value) => (typeof value === 'boolean' ? value : null),
    defaults.killSwitch,
  );

  const dailySendCap = pick(
    'daily_send_cap',
    (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null),
    defaults.dailySendCap,
  );

  // Money, so not an integer — the seeded value is 2.00 and a cap of 0.50 is a
  // reasonable thing for the operator to want.
  const dailyCostCap = pick(
    'daily_cost_cap',
    (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null),
    defaults.dailyCostCap,
  );

  const sendWindow = pick(
    'send_window',
    (value): SendWindowSetting | null => {
      if (!isRecord(value)) return null;
      const days = value['days'];
      const start = value['start_hour'];
      const end = value['end_hour'];
      const daysOk =
        Array.isArray(days) &&
        days.every(
          (day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6,
        );
      const hoursOk =
        typeof start === 'number' &&
        typeof end === 'number' &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= MIN_HOUR &&
        end <= MAX_HOUR &&
        start < end;
      if (!daysOk || !hoursOk) return null;
      return { days: [...(days as number[])], start_hour: start, end_hour: end };
    },
    defaults.sendWindow,
  );

  // All three task types or none. A partial map would leave one type with an
  // undefined level, and `evaluateSend` reads that level to decide whether a
  // task may be sent at all — an undefined there is a decision nobody made.
  const autonomy = pick(
    'autonomy',
    (value): AutonomySetting | null => {
      if (!isRecord(value)) return null;
      const out = {} as AutonomySetting;
      for (const type of TASK_TYPES) {
        const level = value[type];
        if (!isAutonomyLevel(level)) return null;
        out[type] = level;
      }
      return out;
    },
    defaults.autonomy,
  );

  return { killSwitch, dailySendCap, dailyCostCap, sendWindow, autonomy, unreadable };
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

function text(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * An integer typed by a human. Rejects `'9 '`-with-letters, `'1e3'` and the
 * empty string; accepts a leading `+`/`-` so a negative reads as out of range
 * rather than as gibberish.
 */
function parseInteger(raw: string): number | null {
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * A decimal typed by a human, for the cost cap only.
 *
 * A comma is read as a decimal point because the operator types on a Greek
 * keyboard and `2,50` is what he means by two and a half dollars. This is
 * deliberately not `normaliseNumericInput` from ./validation.ts, which resolves
 * thousands separators as well: this field is capped at 100, so there is no
 * thousands separator to resolve and the ambiguity that function exists for
 * cannot arise.
 */
function parseDecimal(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  if (!/^[+-]?\d*\.?\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** A checkbox that is only ever posted by the page as a hidden field. */
function parseFlag(formData: FormData, key: string): boolean {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return false;
  const value = raw.toLowerCase();
  return value === 'on' || value === 'true' || value === '1' || value === 'yes';
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * Parse the operations form: send cap, cost cap, send window, autonomy.
 *
 * `killSwitch` is carried through from a hidden field so the returned value is a
 * truthful snapshot of all five settings — but **`saveOperationalSettings` never
 * writes it.** The switch has its own one-click action for a reason: pausing
 * every send must not be something that can be lost inside a form save that got
 * rejected because the cost cap had a typo in it.
 */
export function parseSettingsForm(formData: FormData): SettingsFormResult {
  const errors: SettingsErrors = {};

  // -- daily_send_cap -------------------------------------------------------
  const capRaw = text(formData, 'daily_send_cap');
  const cap = parseInteger(capRaw);
  if (cap === null) {
    errors.daily_send_cap = 'Use a whole number of emails, e.g. 10.';
  } else if (cap < MIN_DAILY_SEND_CAP || cap > MAX_DAILY_SEND_CAP) {
    errors.daily_send_cap = `Between ${MIN_DAILY_SEND_CAP} and ${MAX_DAILY_SEND_CAP}. 0 pauses sending without touching the kill switch.`;
  }

  // -- daily_cost_cap -------------------------------------------------------
  const costRaw = text(formData, 'daily_cost_cap');
  const cost = parseDecimal(costRaw);
  if (cost === null) {
    errors.daily_cost_cap = 'Use an amount in dollars, e.g. 2.00.';
  } else if (cost < MIN_DAILY_COST_CAP || cost > MAX_DAILY_COST_CAP) {
    errors.daily_cost_cap = `Between $${MIN_DAILY_COST_CAP} and $${MAX_DAILY_COST_CAP} a day.`;
  }

  // -- send_window.days -----------------------------------------------------
  // JS `Date#getDay()` numbering, 0 = Sunday, the same numbers seed.sql stores
  // and packages/core/src/settings.ts documents. Sorted and de-duplicated so two
  // saves of the same selection produce the same row.
  const dayValues = formData.getAll('send_window_days');
  const days: number[] = [];
  let badDay = false;
  for (const entry of dayValues) {
    const day = typeof entry === 'string' ? parseInteger(entry.trim()) : null;
    if (day === null || day < 0 || day > 6) {
      badDay = true;
      continue;
    }
    if (!days.includes(day)) days.push(day);
  }
  days.sort((a, b) => a - b);

  if (badDay) {
    errors.send_window_days = 'That is not a day of the week.';
  } else if (days.length === 0) {
    errors.send_window_days =
      'Pick at least one day. With none, nothing can ever be scheduled to send.';
  }

  // -- send_window hours ----------------------------------------------------
  const startRaw = text(formData, 'send_window_start_hour');
  const endRaw = text(formData, 'send_window_end_hour');
  const start = parseInteger(startRaw);
  const end = parseInteger(endRaw);

  if (start === null || start < MIN_HOUR || start > MAX_HOUR) {
    errors.send_window_start_hour = 'Use an hour from 0 to 24.';
  }
  if (end === null || end < MIN_HOUR || end > MAX_HOUR) {
    errors.send_window_end_hour = 'Use an hour from 0 to 24.';
  }
  if (
    start !== null &&
    end !== null &&
    errors.send_window_start_hour === undefined &&
    errors.send_window_end_hour === undefined &&
    start >= end
  ) {
    errors.send_window_end_hour = 'The window has to end after it starts.';
  }

  // -- autonomy -------------------------------------------------------------
  const autonomy: Partial<Record<TaskType, AutonomyLevel>> = {};
  for (const type of TASK_TYPES) {
    const field = AUTONOMY_FIELD[type];
    const level = parseInteger(text(formData, field));
    if (level === null || level < 0 || level > 3) {
      errors[field] = 'Pick a level from the ladder.';
      continue;
    }
    if (level > V1_MAX_AUTONOMY) {
      errors[field] = 'SPEC §7: nothing leaves the system above level 1 in v1.';
      continue;
    }
    autonomy[type] = level as AutonomyLevel;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      killSwitch: parseFlag(formData, 'kill_switch'),
      dailySendCap: cap as number,
      dailyCostCap: cost as number,
      sendWindow: { days, start_hour: start as number, end_hour: end as number },
      autonomy: autonomy as AutonomySetting,
    },
  };
}

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------

export type BrainKeyResult = { ok: true; value: BrainKey } | { ok: false; error: string };
export type BrainValueResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * The eight keys, for the membership test only — **not** an ordering. The page
 * gets its order from `BRAIN_KEYS` in @agency/core via `readBrain()`, which is
 * the one list.
 *
 * Written out rather than imported so this module stays free of value imports
 * and therefore safe in a client bundle. The two assertions below are what stop
 * that from becoming drift: `satisfies` rejects a key that is not a `BrainKey`,
 * and `_brainKeysComplete` fails to compile if a key is ever added to
 * @agency/core and not to this list. The same compile-time-tie idiom
 * `ContactInputIsInsertable` uses in ./validation.ts.
 */
export const BRAIN_KEY_SET = [
  'services',
  'pricing',
  'tone_of_voice_en',
  'tone_of_voice_el',
  'case_studies',
  'positioning',
  'availability',
  'retainer_offer',
] as const satisfies readonly BrainKey[];

type MissingBrainKey = Exclude<BrainKey, (typeof BRAIN_KEY_SET)[number]>;
const _brainKeysComplete: [MissingBrainKey] extends [never] ? true : never = true;
void _brainKeysComplete;

/**
 * A key outside the set would create a `brain` row that no agent ever reads and
 * no seeder ever overwrites — invisible dead weight that looks like it is doing
 * something.
 */
export function parseBrainKey(raw: unknown): BrainKeyResult {
  if (typeof raw !== 'string') return { ok: false, error: 'That is not a brain key.' };
  const key = raw.trim();
  if (!(BRAIN_KEY_SET as readonly string[]).includes(key)) {
    return { ok: false, error: 'That is not one of the eight brain keys.' };
  }
  return { ok: true, value: key as BrainKey };
}

/**
 * A brain value is the operator's own prose and the drafting agent reads it
 * literally, so it is stored verbatim: no capitalisation, no wrapping, no
 * Markdown handling, and every internal blank line kept.
 *
 * Two normalisations, both of which would otherwise show up as a false edit:
 *
 * - CRLF becomes LF. A `<textarea>` submits CRLF per the HTML spec; the seeder
 *   writes LF from the file on disk. Without this every key looks changed the
 *   moment it is opened in the browser.
 * - Trailing blank space is dropped. A textarea always ships a trailing newline
 *   and `scripts/seed-brain.ts` ends its value with `.trim()`, so keeping it
 *   would make the seeded value and the typed value differ by a character
 *   nobody typed. Leading whitespace is left alone — an indented first line may
 *   be deliberate.
 *
 * **An empty value is valid and is not an error.** SPEC §4 and brain/README.md
 * both say so: an empty key makes the agent stay quiet on that subject rather
 * than invent a claim to a real customer. Nothing in this app may nag about it
 * or fill it in.
 */
export function parseBrainValue(raw: unknown): BrainValueResult {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'That value could not be read as text.' };
  }

  const value = raw.replace(/\r\n/g, '\n').replace(/[ \t\n]+$/, '');

  if (value.length > MAX_BRAIN_CHARS) {
    return {
      ok: false,
      error: `That is ${value.length.toLocaleString('en-US')} characters. Keep a brain key under ${MAX_BRAIN_CHARS.toLocaleString('en-US')}.`,
    };
  }

  return { ok: true, value };
}
