/**
 * Reading the `tasks` queue, and the counts the Today screen is built from.
 *
 * **No `'use server'` here, and that is the point of the split** — the same one
 * ./contacts.ts and ./contact-actions.ts already make. A file-level
 * `'use server'` turns every export into a POST endpoint with a stable action
 * id that anyone who reads the client bundle can call. For a write that is the
 * deal you are making. For "hand me the whole task queue, drafts included" it
 * would be a gift. These functions are only ever awaited during a Server
 * Component render, where no directive is needed. The writes live next door in
 * ./task-actions.ts, which does carry the directive.
 *
 * Rules this module holds to:
 *
 * - **Every export re-checks the operator.** Anon key only, under RLS, via
 *   `requireOperator()`. The middleware gates routing; routing is not
 *   authorisation.
 * - **Counts are counts.** All four tiles and the guardrail context use
 *   `{ count: 'exact', head: true }`, so no row crosses the wire to produce a
 *   number. A page that ships fifty drafts to the browser to render the digit
 *   `50` is a page that leaks fifty drafts.
 * - **Nothing about a contact or a draft is ever logged.** Not a name, not an
 *   address, not a subject line, not in an error path. A contact id is not
 *   customer data; everything else on these rows is.
 *
 * Three decisions the step 6 contract left to this file:
 *
 * 1. **The send guardrails are previewed here, in aggregate.** The card has to
 *    say "this contact has opted out" *before* the operator approves, rather
 *    than letting the send queue discover it sixty seconds later in a log nobody
 *    is reading. `evaluateSend` is pure and takes its facts as data, so the page
 *    calls it with counts read once for the whole screen — one 24h count and one
 *    pass over the last 48 hours of outbound ids — instead of the per-task pair
 *    of queries the worker runs. `assertSendAllowed`, the I/O half, is the send
 *    path's and is not imported here.
 * 2. **`settings` is read by this app rather than through core's `getSettings`,
 *    and it is read in exactly one place.** Core's function takes core's `Db`
 *    type and this app's client comes from `@supabase/ssr`; in a pnpm workspace
 *    those can resolve to different copies of `@supabase/supabase-js` and the
 *    assignment fails to compile in a way that is miserable to debug. So the web
 *    reads the table — through `readSettingsWith` in ./settings.ts, which this
 *    module calls with the client it already has so the render pays for
 *    `requireOperator()` once. The shape checks are in ./settings-validation.ts,
 *    where they are tested and where the /brain form's validation also lives.
 * 3. **`startOfToday` is resolved in the operator's timezone, never `getHours`.**
 *    "Done today" means the day the operator is having, not the day UTC is
 *    having — otherwise the list empties three hours early every summer.
 */

import { appTimezone } from '@agency/core';
import type { Contact, Task } from '@agency/core';

import { PROMOTION_LOOKBACK, type ApprovalRecord } from './autonomy';
import { readSettingsWith } from './settings';
import type { OperationalRead } from './settings-validation';
import { requireOperator } from './supabase/server';
import { dayKeyInZone, zonedTimeToUtc } from './validation';

/** Rolling window for the daily cap (PLAN §7: "last 24h", not "since midnight"). */
const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** SPEC §8: max 1 message per contact per 48h. */
const CONTACT_COOLDOWN_MS = 48 * 60 * 60 * 1000;

/** Stages a contact can be in and still be worth chasing. `won`, `lost` and
 *  `dormant` are not open leads — one is a client, one is over, one is parked. */
const OPEN_STAGES = ['new', 'contacted', 'replied', 'quoted'] as const;

/** Statuses that mean a task is finished, whoever finished it. */
const RESOLVED_STATUSES = ['sent', 'rejected', 'skipped'] as const;

/** How many cards one render will read. The morning batch is a handful; this is
 *  a ceiling so a runaway agent cannot turn the page into a table scan. */
export const MAX_TASK_CARDS = 50;

/** How many rows of "handled today" are worth showing. It is a collapsed list. */
export const MAX_HANDLED_ROWS = 50;

/**
 * Written out rather than `select('*')`, so a column added by a later migration
 * does not quietly start shipping to the browser.
 */
const TASK_COLUMNS =
  'id, agent, type, contact_id, title, reasoning, draft_subject, draft_body, final_body, status, autonomy_level, send_after, created_at, resolved_at';

/**
 * The embedded contact. `tasks.contact_id` has a foreign key to `contacts`, so
 * PostgREST returns this as a single object rather than an array. Only the
 * columns the card and the guardrail preview need — notably not `notes`, which
 * can be long and has no business in a queue render.
 */
const TASK_CONTACT_COLUMNS =
  'contacts(id, name, business, email, language, stage, timezone, tags, last_touch_at, next_touch_at, do_not_contact)';

export type TaskWithContact = Task & {
  contacts: Pick<
    Contact,
    | 'id'
    | 'name'
    | 'business'
    | 'email'
    | 'language'
    | 'stage'
    | 'timezone'
    | 'tags'
    | 'last_touch_at'
    | 'next_touch_at'
    | 'do_not_contact'
  > | null;
};

// ---------------------------------------------------------------------------
// The tiles
// ---------------------------------------------------------------------------

export type TodayCounts = {
  /** `tasks.status = 'pending'`. The number in the "needs you" tile. */
  needsYou: number;
  /** Approved and waiting for the poller. The sub-line under the first tile. */
  queued: number;
  /** Contacts in a live stage who have not opted out. */
  openLeads: number;
  /** Tasks resolved since local midnight. */
  doneToday: number;
};

/**
 * Three tiles, not four (PLAN §6 step 6). The spec's fourth tile is "unpaid",
 * and invoicing is out of scope for v1, so the number has no source. A
 * hand-entered figure goes stale in a week and then lies every morning. `queued`
 * is not a tile either — it is the sub-line under "needs you", because it
 * answers "and what did I already deal with?" rather than being work of its own.
 */
export async function getTodayCounts(now: Date = new Date()): Promise<TodayCounts> {
  const { supabase } = await requireOperator();
  const startOfToday = startOfTodayIso(now);

  const [needsYou, queued, openLeads, doneToday] = await Promise.all([
    supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .in('stage', [...OPEN_STAGES])
      // Written as an `or` against NULL for the reason lib/contacts.ts and the
      // follow-up selector both document: `.eq('do_not_contact', false)` drops
      // every row where the column is NULL, and a filter that silently loses
      // warm leads is the exact failure this app exists to prevent.
      .or('do_not_contact.is.null,do_not_contact.is.false'),
    supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .in('status', [...RESOLVED_STATUSES])
      .gte('resolved_at', startOfToday),
  ]);

  for (const result of [needsYou, queued, openLeads, doneToday]) {
    if (result.error !== null) throw new Error(`Failed to count today: ${result.error.message}`);
  }

  return {
    needsYou: needsYou.count ?? 0,
    queued: queued.count ?? 0,
    openLeads: openLeads.count ?? 0,
    doneToday: doneToday.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------

/**
 * The pending queue, newest first.
 *
 * Newest first because the morning batch arrives together and the operator
 * reads down it; oldest-first would put yesterday's leftovers at the top of a
 * screen whose whole promise is that the top of it is what matters now. Served
 * by `tasks_status_created_at_idx`.
 */
export async function listPendingTasks(limit: number = MAX_TASK_CARDS): Promise<TaskWithContact[]> {
  const { supabase } = await requireOperator();

  const { data, error } = await supabase
    .from('tasks')
    .select(`${TASK_COLUMNS}, ${TASK_CONTACT_COLUMNS}`)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), MAX_TASK_CARDS));

  if (error !== null) throw new Error(`Failed to load the task queue: ${error.message}`);

  return (data ?? []) as unknown as TaskWithContact[];
}

/**
 * What was resolved since local midnight, newest first — the collapsed list at
 * the bottom of the screen.
 *
 * `resolved_at` carries no index, and deliberately so: at v1 volumes this is a
 * sequential scan of tens of rows. Add the index when the table has thousands.
 */
export type HandledTask = TaskWithContact & {
  /** True when the send happened with `DRY_RUN` on. See `readDryRunSends`. */
  dryRun: boolean;
};

export async function listHandledToday(
  limit: number = MAX_HANDLED_ROWS,
  now: Date = new Date(),
): Promise<HandledTask[]> {
  const { supabase } = await requireOperator();

  const { data, error } = await supabase
    .from('tasks')
    .select(`${TASK_COLUMNS}, ${TASK_CONTACT_COLUMNS}`)
    .in('status', [...RESOLVED_STATUSES])
    .gte('resolved_at', startOfTodayIso(now))
    .order('resolved_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), MAX_HANDLED_ROWS));

  if (error !== null) throw new Error(`Failed to load what was handled: ${error.message}`);

  const rows = (data ?? []) as unknown as TaskWithContact[];

  // The second query rather than a second `requireOperator()` in the page: the
  // client is already here, the ids are already here, and the page has no
  // business holding a Supabase client to answer one boolean per row.
  const dryRuns = await readDryRunSends(
    supabase,
    rows.filter((row) => row.status === 'sent').map((row) => row.id),
  );

  return rows.map((row) => ({ ...row, dryRun: dryRuns.has(row.id) }));
}

// ---------------------------------------------------------------------------
// Which of those sends actually left the machine
// ---------------------------------------------------------------------------

/**
 * The task ids whose send was a dry run.
 *
 * **Why this is a separate query and not a column on `tasks`.** `DRY_RUN` is a
 * property of the send, not of the task: the task is drafted, approved and
 * resolved identically either way, and it is the send path that either opens a
 * socket or does not. `send-queue.ts` records that fact where it happens, on the
 * outbound `interactions` row it writes for every send — `meta.dry_run`, always
 * present, always a boolean. Copying it onto `tasks` would mean a migration and
 * a second place for the same fact to be wrong.
 *
 * PostgREST cannot join through a JSON value, so this is keyed on `meta->>task_id`
 * for the ids already on screen — the same construction and the same reasoning as
 * `attachDraftStatus` in ./inbox.ts, which is why both pages call this one
 * function rather than each growing a copy.
 *
 * Takes the client instead of calling `requireOperator()` itself: both callers
 * have already established the operator and both are mid-render. It is not an
 * exported entry point in its own right and must not be used as one — the
 * caller's `requireOperator()` is the authorisation, exactly as it is for every
 * other read in this file.
 *
 * A missing row means "no send was recorded", which reads as not-a-dry-run.
 * That is the honest default: a task marked `sent` with no interaction row is a
 * bookkeeping failure `send-queue.ts` already files an alert card about, and
 * claiming it was a dry run would be this page inventing an explanation for it.
 *
 * `meta->>dry_run` is compared as text because that is what `->>` returns.
 * Anything that is not exactly `'true'` — including a legacy row written before
 * the key existed — is not a dry run.
 */
export async function readDryRunSends(
  supabase: Awaited<ReturnType<typeof requireOperator>>['supabase'],
  taskIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(taskIds)].filter((id) => id !== '');
  if (ids.length === 0) return new Set();

  const { data, error } = await supabase
    .from('interactions')
    .select('meta')
    .eq('direction', 'out')
    .in('meta->>task_id', ids)
    .eq('meta->>dry_run', 'true');

  if (error !== null) throw new Error(`Failed to read which sends were dry runs: ${error.message}`);

  const dryRun = new Set<string>();
  for (const row of data ?? []) {
    const meta = row.meta;
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) continue;
    const taskId = (meta as Record<string, unknown>)['task_id'];
    if (typeof taskId === 'string' && taskId !== '') dryRun.add(taskId);
  }
  return dryRun;
}

// ---------------------------------------------------------------------------
// The autonomy promotion prompt
// ---------------------------------------------------------------------------

/**
 * The last `PROMOTION_LOOKBACK` sends, newest first, for the streak arithmetic
 * in ./autonomy.ts.
 *
 * The two bodies are the only reason this is not a count: whether a draft went
 * out as written is a comparison between two columns, and PostgREST cannot make
 * one. So the rule this file otherwise holds to — counts are counts, no row
 * crosses the wire to produce a number — is broken here on purpose, for one
 * bounded read on a page the operator opens by hand. Nothing is rendered from
 * the bodies; they are compared and discarded.
 */
export async function listRecentSends(): Promise<ApprovalRecord[]> {
  const { supabase } = await requireOperator();

  const { data, error } = await supabase
    .from('tasks')
    .select('type, draft_body, final_body')
    .eq('status', 'sent')
    .order('resolved_at', { ascending: false })
    .limit(PROMOTION_LOOKBACK);

  if (error !== null) throw new Error(`Failed to read recent sends: ${error.message}`);

  return (data ?? []).map((row) => ({
    type: row.type,
    draftBody: row.draft_body,
    finalBody: row.final_body,
  }));
}

// ---------------------------------------------------------------------------
// settings, and the facts the guardrail preview needs
// ---------------------------------------------------------------------------

export type SendContext = {
  settings: OperationalRead;
  /** Outbound emails in the rolling 24h window, against `dailySendCap`. */
  sentInLast24h: number;
  /** contact id → outbound emails to them in the rolling 48h window. */
  sentToContactInLast48h: Readonly<Record<string, number>>;
};

/**
 * Everything `evaluateSend` needs that is not on the task row itself.
 *
 * The worker asks these questions one task at a time, immediately before each
 * send, which is what makes counting rather than locking correct there — it is
 * single-flight and it is the only writer. This is the *preview*: one read for
 * the whole screen, so a queue of thirty cards costs two queries instead of
 * sixty. It can be a few seconds stale, and that is fine, because it decides
 * what a card says and never whether a message leaves. The send path re-reads
 * everything and refuses on its own account; nothing here can authorise a send.
 *
 * The 48h window is read as a list of contact ids rather than a count per
 * contact — one round trip instead of one per card. Ids only: no subject, no
 * body, no address crosses the wire.
 */
export async function getSendContext(now: Date = new Date()): Promise<SendContext> {
  const { supabase } = await requireOperator();

  const since24h = new Date(now.getTime() - DAILY_CAP_WINDOW_MS).toISOString();
  const since48h = new Date(now.getTime() - CONTACT_COOLDOWN_MS).toISOString();

  const [settings, daily, recent] = await Promise.all([
    readSettingsWith(supabase),
    supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'out')
      .eq('channel', 'email')
      .gte('occurred_at', since24h),
    supabase
      .from('interactions')
      .select('contact_id')
      .eq('direction', 'out')
      .eq('channel', 'email')
      .gte('occurred_at', since48h)
      // Two days of sending is bounded by twice the daily cap; the ceiling is
      // here so a bad import cannot turn a page render into an unbounded read.
      .limit(500),
  ]);

  if (daily.error !== null) {
    throw new Error(`Failed to count today's sends: ${daily.error.message}`);
  }
  if (recent.error !== null) {
    throw new Error(`Failed to read recent sends: ${recent.error.message}`);
  }

  const sentToContactInLast48h: Record<string, number> = {};
  for (const row of recent.data ?? []) {
    const id = row.contact_id;
    if (id === null) continue;
    sentToContactInLast48h[id] = (sentToContactInLast48h[id] ?? 0) + 1;
  }

  return { settings, sentInLast24h: daily.count ?? 0, sentToContactInLast48h };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Local midnight, as an instant.
 *
 * `dayKeyInZone` then `zonedTimeToUtc`, both from lib/validation.ts, which is
 * the one module in apps/web that knows what a timezone is. Never
 * `Date#getHours`: that reads the *server's* clock, and this app renders on
 * machines whose timezone is nobody's business.
 */
function startOfTodayIso(now: Date): string {
  const timeZone = appTimezone();
  const day = dayKeyInZone(now, timeZone);
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return zonedTimeToUtc(year, month, date, 0, 0, timeZone).toISOString();
}
