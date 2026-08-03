/**
 * Typed access to the `settings` table (PLAN.md §4).
 *
 * `settings` holds operational flags — kill switch, autonomy levels, volume
 * ramp, spend ceiling, send window. It is deliberately NOT `brain`: `brain` is
 * business facts fed to the LLM, and operational flags must never leak into a
 * prompt.
 *
 * Five keys are typed here, and adding a sixth to `SettingsMap` means editing
 * PLAN.md first:
 *
 *   kill_switch     false
 *   autonomy        {"draft_email": 1, "reminder": 1, "alert": 1}
 *   daily_send_cap  10          -- ramps 10 -> 20 -> 30 -> 40, PLAN.md §7.1
 *   daily_cost_cap  2.00        -- USD
 *   send_window     {"days": [2,3,4], "start_hour": 9, "end_hour": 16}
 *
 * ---------------------------------------------------------------------------
 * Two rows in this table are NOT in `SettingsMap`, on purpose
 * ---------------------------------------------------------------------------
 *
 * The header used to claim "exactly five keys exist". That has not been true
 * since the RLS migration, and it is now wrong twice:
 *
 *   allowed_email   inserted by 20260731140000_rls_operator_only.sql. It is
 *                   read by `public.is_operator()` — in SQL, by the database,
 *                   as the authorisation predicate on every table. No
 *                   TypeScript reads it, and nothing in this file should be
 *                   able to write it: a `setSetting('allowed_email', …)` call
 *                   is a way to hand the whole database to another address.
 *
 *   gmail_watch     step 8's Gmail cursor — `{ history_id, expiration,
 *                   updated_at }`, read and written only by `readGmailWatch` /
 *                   `writeGmailWatch` in `gmail-read.ts`. It is per-deploy
 *                   position in a mailbox, not an operational flag the operator
 *                   would ever set in `/brain`, and putting it on the same
 *                   screen as the kill switch would invite exactly one hand-edit
 *                   too many.
 *
 * Both are reached through their own accessors rather than `getSetting`, and
 * that is not a workaround — `SettingKey` is a closed union and `parseSetting`
 * throws in its `default` branch precisely so an unknown key cannot be read as
 * though it were typed. Adding either of these to the union would trade that
 * guarantee for nothing: neither has a `SETTING_DEFAULTS` entry that would make
 * sense, and the absence of a cursor row means something specific (bootstrap
 * from the current history id) that a default would quietly paper over.
 *
 * The rule, stated once: `settings` is the table; `SettingsMap` is the subset of
 * it that is operator-facing configuration. They were the same set for one step
 * and are not any more.
 */

import type { Db } from './db';
import type { AutonomyLevel, Json, TaskType } from './types';

/** Autonomy level per task type. Locked at 1 for v1 (SPEC §7). */
export type AutonomySetting = Record<TaskType, AutonomyLevel>;

/**
 * Tue–Thu 09:00–16:00 by default, in the *recipient's* timezone.
 * `days` are JS `Date#getDay()` numbers: 0 = Sunday … 6 = Saturday, so
 * [2,3,4] is Tuesday, Wednesday, Thursday.
 * `start_hour` inclusive, `end_hour` exclusive.
 */
export type SendWindowSetting = {
  days: number[];
  start_hour: number;
  end_hour: number;
};

/** The complete set of settings keys and their value shapes. */
export type SettingsMap = {
  kill_switch: boolean;
  autonomy: AutonomySetting;
  daily_send_cap: number;
  daily_cost_cap: number;
  send_window: SendWindowSetting;
};

export type SettingKey = keyof SettingsMap;

export const SETTING_KEYS = [
  'kill_switch',
  'autonomy',
  'daily_send_cap',
  'daily_cost_cap',
  'send_window',
] as const satisfies readonly SettingKey[];

/**
 * Mirrors the seed values in the migration. Used only when a row is genuinely
 * absent (fresh database, key not seeded yet) — a read error still throws.
 */
export const SETTING_DEFAULTS: SettingsMap = {
  kill_switch: false,
  autonomy: { draft_email: 1, reminder: 1, alert: 1 },
  daily_send_cap: 10,
  daily_cost_cap: 2.0,
  send_window: { days: [2, 3, 4], start_hour: 9, end_hour: 16 },
};

// ---------------------------------------------------------------------------
// Validation — jsonb is untyped at rest, so every read is checked
// ---------------------------------------------------------------------------

export class SettingShapeError extends Error {
  constructor(key: SettingKey, value: unknown) {
    super(`settings.${key} has an unexpected shape: ${JSON.stringify(value)}`);
    this.name = 'SettingShapeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function parseSetting<K extends SettingKey>(key: K, value: Json): SettingsMap[K] {
  switch (key) {
    case 'kill_switch': {
      if (typeof value !== 'boolean') throw new SettingShapeError(key, value);
      return value as unknown as SettingsMap[K];
    }
    case 'daily_send_cap':
    case 'daily_cost_cap': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new SettingShapeError(key, value);
      return value as unknown as SettingsMap[K];
    }
    case 'autonomy': {
      if (!isRecord(value)) throw new SettingShapeError(key, value);
      const types: TaskType[] = ['draft_email', 'reminder', 'alert'];
      for (const type of types) {
        if (!isAutonomyLevel(value[type])) throw new SettingShapeError(key, value);
      }
      return value as unknown as SettingsMap[K];
    }
    case 'send_window': {
      if (!isRecord(value)) throw new SettingShapeError(key, value);
      const days = value['days'];
      const start = value['start_hour'];
      const end = value['end_hour'];
      const daysOk = Array.isArray(days) && days.every((d) => typeof d === 'number' && d >= 0 && d <= 6);
      const hoursOk =
        typeof start === 'number' && typeof end === 'number' && start >= 0 && end <= 24 && start < end;
      if (!daysOk || !hoursOk) throw new SettingShapeError(key, value);
      return value as unknown as SettingsMap[K];
    }
    default: {
      throw new SettingShapeError(key, value);
    }
  }
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Read one setting. Falls back to the seeded default if the row does not exist;
 * throws on a query error or a malformed value rather than guessing.
 */
export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingsMap[K]> {
  const { data, error } = await db.from('settings').select('value').eq('key', key).maybeSingle();

  if (error) throw new Error(`Failed to read settings.${key}: ${error.message}`);
  if (!data) return SETTING_DEFAULTS[key];

  return parseSetting(key, data.value);
}

/** Read every setting in one round trip. Missing keys fall back to defaults. */
export async function getSettings(db: Db): Promise<SettingsMap> {
  const { data, error } = await db.from('settings').select('key, value');

  if (error) throw new Error(`Failed to read settings: ${error.message}`);

  const rows = new Map((data ?? []).map((row) => [row.key, row.value]));
  const out = { ...SETTING_DEFAULTS };

  for (const key of SETTING_KEYS) {
    if (!rows.has(key)) continue;
    // Narrowing per key keeps parseSetting's return type honest.
    switch (key) {
      case 'kill_switch':
        out.kill_switch = parseSetting('kill_switch', rows.get(key) as Json);
        break;
      case 'autonomy':
        out.autonomy = parseSetting('autonomy', rows.get(key) as Json);
        break;
      case 'daily_send_cap':
        out.daily_send_cap = parseSetting('daily_send_cap', rows.get(key) as Json);
        break;
      case 'daily_cost_cap':
        out.daily_cost_cap = parseSetting('daily_cost_cap', rows.get(key) as Json);
        break;
      case 'send_window':
        out.send_window = parseSetting('send_window', rows.get(key) as Json);
        break;
    }
  }

  return out;
}

/**
 * Write one setting. Validates the shape before it hits the database, so a bad
 * value never lands in a table the send path trusts. Bumps `updated_at`.
 */
export async function setSetting<K extends SettingKey>(
  db: Db,
  key: K,
  value: SettingsMap[K],
): Promise<SettingsMap[K]> {
  const validated = parseSetting(key, value as unknown as Json);

  const { error } = await db.from('settings').upsert(
    {
      key,
      value: validated as unknown as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' },
  );

  if (error) throw new Error(`Failed to write settings.${key}: ${error.message}`);
  return validated;
}

/**
 * The kill switch (PLAN.md §7). Checked at the top of every cron job and every
 * send. `true` means: pause everything.
 */
export async function isKillSwitchOn(db: Db): Promise<boolean> {
  return getSetting(db, 'kill_switch');
}

/** Autonomy level for a given task type. v1 never acts above level 1. */
export async function getAutonomyLevel(db: Db, type: TaskType): Promise<AutonomyLevel> {
  const autonomy = await getSetting(db, 'autonomy');
  return autonomy[type];
}
