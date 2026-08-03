/**
 * Reading the `settings` and `brain` tables, plus the one `agent_runs` row the
 * nav needs. Everything /brain and the app shell display, and nothing they
 * write.
 *
 * **No `'use server'` here, and that is the point of the split** — the same
 * arrangement as ./contacts.ts and ./contact-actions.ts. A file-level
 * `'use server'` publishes every export as a POST endpoint with an action id
 * anyone reading the client bundle can call. "Give me every operational setting"
 * does not need to be one; these are only ever awaited during a Server Component
 * render. The writes live next door in ./settings-actions.ts.
 *
 * Rules this module holds to:
 *
 * - **Every export re-checks the operator.** Anon key only, under RLS. Routing
 *   is not authorisation.
 * - **Nothing is logged.** Not a brain value, not a setting, not in an error
 *   path. A brain key holds the owner's prices and his voice.
 * - **Core's `getSettings()` is deliberately not used.** It takes @agency/core's
 *   `Db`, which is `SupabaseClient<Database>` from @supabase/supabase-js, and
 *   this app's client comes from @supabase/ssr. In a pnpm workspace those two
 *   can resolve to different copies of the same package, and the assignment then
 *   fails to compile in a way that is miserable to debug. The web reads and
 *   writes `settings` itself. The shapes it accepts must stay in step with
 *   `parseSetting` in packages/core/src/settings.ts — the same "duplicated on
 *   purpose, keep them in step" note already sits on `normalizeCadenceTag`.
 * - **There is one read of this table in apps/web, and it is here.** Step 6
 *   briefly had two: this one for /brain's form, and a second in ./tasks.ts for
 *   the Today page's guardrail preview, each with its own coercion rules. Two
 *   screens quietly disagreeing about what the stored send window means is not a
 *   cosmetic bug — one of them tells the operator when their message will leave.
 *   The coercion is in ./settings-validation.ts, where it is tested; the query
 *   is `readSettingsWith` below, which takes a client so a page render that
 *   needs settings and tasks pays for `requireOperator()` once.
 *
 * ## What happens when a stored value is the wrong shape
 *
 * `settings.value` is `jsonb`, so nothing at rest is typed. Both write paths in
 * this app validate, so a malformed row can only arrive from the Supabase
 * dashboard or a psql session — but when it does, core's `getSetting()` throws,
 * which means the worker's cron jobs throw at the top and **nothing is
 * sending**.
 *
 * Two different answers, because the two reads are used for different things:
 *
 * - The /brain panel and the Today page **fall back to the seeded default and
 *   name the key** in `unreadable`, so the page still opens and saving from
 *   /brain repairs the row. Throwing here would send the operator to Next's
 *   generic error page — which in production carries no message at all — from
 *   the one screen that could have fixed the problem.
 * - `readKillSwitch()` **answers `true`** for a malformed value or a failed
 *   read. Both of those mean the send path is refusing or crashing, so "Sends
 *   paused" is the true statement and the nav must make it.
 */

import { BRAIN_KEYS, SETTING_DEFAULTS, SETTING_KEYS } from '@agency/core';
import type { AgentRunStatus, BrainKey } from '@agency/core';

import { daysBetween, formatDay, pastLabel, yearOf } from './day';
import { coerceOperationalSettings } from './settings-validation';
import type { OperationalRead, OperationalSettings } from './settings-validation';
import { requireOperator, type ServerSupabaseClient } from './supabase/server';
import { dayKeyOf } from './validation';

export type { OperationalRead, OperationalSettings };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The seeded values, in this app's shape. `SETTING_DEFAULTS` is core's map,
 *  keyed by column name; every screen wants it keyed the way it reads. */
const DEFAULTS: OperationalSettings = {
  killSwitch: SETTING_DEFAULTS.kill_switch,
  dailySendCap: SETTING_DEFAULTS.daily_send_cap,
  dailyCostCap: SETTING_DEFAULTS.daily_cost_cap,
  sendWindow: SETTING_DEFAULTS.send_window,
  autonomy: SETTING_DEFAULTS.autonomy,
};

/**
 * The read itself, against a client the caller already holds.
 *
 * Exported because ./tasks.ts needs the same five values during the same render
 * as the task queue, and `requireOperator()` costs a round trip to the auth
 * server that one page should not pay for twice to answer two questions. It
 * takes an already-authenticated client rather than creating one, so there is no
 * path here that reads `settings` without having checked who is asking.
 *
 * `settings` also holds `allowed_email`, written by the RLS migration and not
 * part of `SETTING_KEYS`, so the query names the keys it wants rather than
 * reading the table and hoping.
 */
export async function readSettingsWith(
  supabase: ServerSupabaseClient,
): Promise<OperationalRead> {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', [...SETTING_KEYS]);

  // A read failure is not survivable for either screen that calls this: every
  // control on /brain and every card on Today would be a lie about what the
  // worker will do. The message is Postgres', and it names no value.
  if (error !== null) throw new Error(`Failed to read settings: ${error.message}`);

  return coerceOperationalSettings(data ?? [], DEFAULTS);
}

/** The /brain panel's read. One round trip for all five keys. */
export async function readOperationalSettings(): Promise<OperationalRead> {
  const { supabase } = await requireOperator();
  return readSettingsWith(supabase);
}

/**
 * Just the flag, for the nav indicator. One row, primary key.
 *
 * Answers `true` when the row is malformed or the read fails — see the header.
 * Both of those states mean the worker is not sending, and an indicator that
 * says "normal" while nothing leaves is the failure this app keeps arguing
 * against.
 */
export async function readKillSwitch(): Promise<boolean> {
  const { supabase } = await requireOperator();

  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'kill_switch')
    .maybeSingle();

  if (error !== null) return true;
  if (data === null) return SETTING_DEFAULTS.kill_switch;
  return typeof data.value === 'boolean' ? data.value : true;
}

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------

export type BrainRow = {
  key: BrainKey;
  /** '' for a key with no row, and for a key deliberately left empty. */
  value: string;
  updatedAt: string | null;
};

/**
 * All eight keys, in `BRAIN_KEYS` order, whether or not a row exists.
 *
 * Order comes from @agency/core so the page cannot drift from the seeder, and a
 * key with no row renders as an empty editor rather than disappearing — a
 * missing key and an empty key look the same to the follow-up agent (it stays
 * quiet on that subject), so they should look the same here.
 *
 * Rows whose key is not one of the eight are ignored. Nothing writes them today;
 * if something ever does, the agents will not read it either.
 */
export async function readBrain(): Promise<BrainRow[]> {
  const { supabase } = await requireOperator();

  const { data, error } = await supabase.from('brain').select('key, value, updated_at');

  if (error !== null) throw new Error(`Failed to read the brain: ${error.message}`);

  const rows = new Map((data ?? []).map((row) => [row.key, row]));

  return BRAIN_KEYS.map((key) => {
    const row = rows.get(key);
    return {
      key,
      value: typeof row?.value === 'string' ? row.value : '',
      updatedAt: row?.updated_at ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Last run — the nav's other step-6 addition (DESIGN.md §6, <Nav>)
// ---------------------------------------------------------------------------

/**
 * The most recent `agent_runs` row.
 *
 * `agent_runs` is written by the LLM wrapper, one row per model call, so this is
 * "when an agent last did something that cost money" and not "when the cron last
 * ticked". Those differ on a morning where nothing was due: the run happened and
 * wrote no row. The nav therefore labels it "last agent run" rather than "last
 * run", because a date three days old is a normal state and must not read as a
 * stalled worker.
 *
 * Raw values, formatted by the layout. Same arrangement as /pipeline: dates
 * become strings on the server, in the operator's timezone, so the Client
 * Component never sees a clock and no hydration mismatch is possible.
 *
 * **Never throws.** This is chrome on every signed-in screen; a failed
 * decorative query must not be able to take down /pipeline. It returns null and
 * the indicator renders nothing.
 */
export type LastRun = {
  agent: string | null;
  status: AgentRunStatus | null;
  /** ISO timestamp, straight from the column. */
  at: string | null;
};

/**
 * `'30 Jul · 3 days ago'` for a stored timestamp, or null when there isn't one.
 *
 * Absolute date first with the relative phrase as a hint beside it, per
 * DESIGN.md §7: "3 days ago" on its own stops meaning anything the moment you
 * come back to the screen a week later.
 *
 * It lives here rather than in ./day.ts because that module is shared and is not
 * step 6's to edit while several agents are working in parallel — and because
 * `day.ts` is deliberately free of anything that knows what a timezone is, while
 * this takes a `timeZone` to resolve the instant first. Promoting it is worth
 * doing once the step lands; both callers of it are server-side.
 */
export function formatStampLabel(
  iso: string | null,
  today: string,
  timeZone: string,
): string | null {
  const day = dayKeyOf(iso, timeZone);
  if (day === null) return null;

  const offset = daysBetween(today, day);
  const absolute = formatDay(day, yearOf(today));

  return offset === null ? absolute : `${absolute} · ${pastLabel(offset)}`;
}

export async function readLastRun(): Promise<LastRun | null> {
  try {
    const { supabase } = await requireOperator();

    const { data, error } = await supabase
      .from('agent_runs')
      .select('agent, status, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error !== null || data === null) return null;

    return { agent: data.agent, status: data.status, at: data.created_at };
  } catch {
    return null;
  }
}
