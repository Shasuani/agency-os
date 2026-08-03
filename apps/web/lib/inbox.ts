/**
 * Reading the inbound record for `/inbox`.
 *
 * **This reads `interactions`, not `tasks`, and that is the decision the whole
 * screen rests on.** The obvious design has Today and `/inbox` as two views of
 * the same queue, and it is wrong: three of the nine inbound classes
 * (`not_interested`, `spam`, `not_business`) create no task, so a queue-shaped
 * `/inbox` would be silent about exactly the messages nobody was consulted
 * about. An `interactions` row is written for every inbound message regardless
 * of class — it is written *before* classification, because it is the
 * duplicate-suppression claim — so `interactions` is the only table that knows
 * something arrived at all. SPEC §5: the silent handling of `not_interested`
 * matters as much as the loud handling of hot leads. This module is what makes
 * it inspectable.
 *
 * **No `'use server'`, deliberately** — the same split ./tasks.ts and
 * ./task-actions.ts make, and it matters more here than anywhere. A file-level
 * `'use server'` turns every export into a POST endpoint with a stable action id
 * that anybody who reads the client bundle can call. For a write that is the
 * bargain. For "hand me every email this business has received" it is a gift.
 * These functions are only ever awaited during a Server Component render, where
 * no directive is needed. There are no writes on this page in v1, so there is no
 * companion actions file.
 *
 * Rules held to, in the order they would be missed:
 *
 * - **Every export re-checks the operator** through `requireOperator()`, anon key
 *   only, under RLS. The middleware gates routing; routing is not authorisation.
 * - **A full message body never leaves this module.** `InboundRow` has no `body`
 *   field — `toSnippet` caps it here and the row carries one flattened line. A
 *   component cannot render a whole inbound email by reaching for one more
 *   property, because the property does not exist. The bodies are still read out
 *   of Postgres, which is unavoidable (PostgREST cannot `substring` in a select),
 *   but they stop at this function.
 * - **Nothing is logged.** Not a name, not an address, not a subject, not the
 *   classifier's `reason` — that last one is the subtle one, because it is
 *   generated English that quotes the message it describes. There is no
 *   `console.*` call in this file and there must not be one.
 * - **Every read is bounded.** A window (`days`, capped at 90) and a row ceiling,
 *   so a page render can never become a scan of the whole table.
 *
 * Two smaller decisions worth stating:
 *
 * 1. **The class filter is a `jsonb` path filter — `meta->>class`.** The class
 *    lives in `meta`, not in a column, because the agent claims the row before it
 *    knows the class and a column would mean a migration this step does not need.
 *    All three filters used here (`eq`, `in`, `is null`) are the same PostgREST
 *    construction against the same expression, so they either all work or all
 *    fail together — the summary counts add no failure mode the page did not
 *    already have. The matching index is the one the migration adds on
 *    `(direction, occurred_at desc)`; the class filter itself is a filter on a
 *    small windowed set, not a scan driver.
 * 2. **The draft's fate is a second query, by id.** `interactions.meta.task_id`
 *    is a JSON value and PostgREST cannot join through it, so the task statuses
 *    are fetched by primary key for the rows on screen — `id, status` only, no
 *    bodies, one round trip, at most one hundred ids. It is worth the query: the
 *    honest row does not say "a draft was made", it says whether that draft is
 *    still waiting on Today, was sent, or was rejected. Without it every silent
 *    class and every loud one would end in the same shrug.
 */

import type { Stage, TaskStatus } from '@agency/core';

import {
  readInboundMeta,
  toSnippet,
  type InboundMeta,
  type InboxQuery,
  SILENT_CLASSES,
} from './inbox-vocab';
import { requireOperator } from './supabase/server';
import { readDryRunSends } from './tasks';
import { isUuid } from './validation';

/**
 * How many rows one render will read. The mailbox this runs against is one
 * person's; a hundred is a ceiling against a bad import or a runaway agent,
 * not a page size the operator is expected to hit.
 */
export const MAX_INBOX_ROWS = 100;

const MS_PER_DAY = 86_400_000;

/**
 * Written out rather than `select('*')`, so a column added by a later migration
 * does not quietly start shipping. `body` is read and then dropped by
 * `toRow` — see the header.
 */
const INTERACTION_COLUMNS = 'id, contact_id, subject, body, occurred_at, meta';

/**
 * The embedded contact. `interactions.contact_id` has a foreign key to
 * `contacts`, so PostgREST returns a single object rather than an array. Four
 * columns: enough to name the contact and link to them, and notably not `email`
 * or `notes`, which a list of what arrived has no business carrying.
 */
const INTERACTION_CONTACT_COLUMNS = 'contacts(id, name, business, stage)';

export type InboundContact = {
  id: string;
  name: string | null;
  business: string | null;
  stage: Stage | null;
};

export type InboundRow = {
  id: string;
  /** `interactions.occurred_at`. Formatted by the page, in the operator's zone. */
  occurredAt: string | null;
  subject: string | null;
  /** One flattened, capped line. There is deliberately no full body here. */
  snippet: string;
  snippetTruncated: boolean;
  meta: InboundMeta;
  contact: InboundContact | null;
  /**
   * `tasks.status` for `meta.task_id`. Null means either no draft was made
   * (the three silent classes) or the task row is gone; the page tells those
   * apart by looking at `meta.taskId`.
   */
  draftStatus: TaskStatus | null;
  /**
   * True when that reply's send happened with `DRY_RUN` on. Only ever true
   * alongside `draftStatus: 'sent'`, and the reason the row does not say
   * "Reply sent" over a reply nobody received — see `draftState`.
   */
  draftDryRun: boolean;
};

/**
 * Inbound email in the window, newest first.
 *
 * Newest first because this is a record and a record is read from the top: the
 * question the operator brings to it is "what happened while I was not looking",
 * which is answered by the most recent rows and never by the oldest.
 */
export async function listInbound(
  query: InboxQuery,
  now: Date = new Date(),
  limit: number = MAX_INBOX_ROWS,
): Promise<InboundRow[]> {
  const { supabase } = await requireOperator();
  const since = windowStart(query.days, now);

  const base = supabase
    .from('interactions')
    .select(`${INTERACTION_COLUMNS}, ${INTERACTION_CONTACT_COLUMNS}`)
    .eq('direction', 'in')
    .eq('channel', 'email')
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), MAX_INBOX_ROWS));

  // The class filter, applied on the `jsonb` path. See the header, note 1.
  const filtered =
    query.classFilter === 'all'
      ? base
      : query.classFilter === 'unclassified'
        ? base.is('meta->>class', null)
        : base.eq('meta->>class', query.classFilter);

  const { data, error } = await filtered;
  if (error !== null) throw new Error(`Failed to read the inbox: ${error.message}`);

  const rows = (data ?? []).map(toRow);
  return attachDraftStatus(supabase, rows);
}

/**
 * The three numbers in the page header.
 *
 * They are counted across the window, unfiltered by class, so the header keeps
 * saying what actually arrived while the list below it is narrowed — a summary
 * that moved with the filter would only ever restate the list, which the list is
 * already doing.
 *
 * `head: true` on all three: no row crosses the wire to produce a digit, the
 * rule ./tasks.ts states for the Today tiles.
 */
export type InboxSummary = {
  days: number;
  /** Inbound email in the window. */
  total: number;
  /** Of those, decided without a task and without a notification. */
  silent: number;
  /** Claimed and never classified — a worker that stopped mid-message. */
  unclassified: number;
};

export async function getInboxSummary(
  days: number,
  now: Date = new Date(),
): Promise<InboxSummary> {
  const { supabase } = await requireOperator();
  const since = windowStart(days, now);

  const base = () =>
    supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'in')
      .eq('channel', 'email')
      .gte('occurred_at', since);

  const [total, silent, unclassified] = await Promise.all([
    base(),
    base().in('meta->>class', [...SILENT_CLASSES]),
    base().is('meta->>class', null),
  ]);

  for (const result of [total, silent, unclassified]) {
    if (result.error !== null) throw new Error(`Failed to count the inbox: ${result.error.message}`);
  }

  return {
    days,
    total: total.count ?? 0,
    silent: silent.count ?? 0,
    unclassified: unclassified.count ?? 0,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Fill in what became of each drafted reply.
 *
 * One query for the whole page, keyed by primary key, `id` and `status` only.
 * Rows whose `task_id` no longer resolves keep `draftStatus: null` — the task was
 * deleted, which is not a state this app creates but is a state a hand-run SQL
 * statement can, and inventing a status for it would be the page guessing.
 *
 * The ids are checked against `isUuid` before they reach the query, and that is
 * not belt-and-braces: `meta` is `jsonb`, so `task_id` can hold any string at
 * all, and PostgREST answers `in.(not-a-uuid)` with a 400. One malformed value
 * on one row would take the whole page down and show the operator nothing —
 * which is the opposite of what a record is for.
 */
async function attachDraftStatus(
  supabase: Awaited<ReturnType<typeof requireOperator>>['supabase'],
  rows: InboundRow[],
): Promise<InboundRow[]> {
  const ids = [...new Set(rows.map((row) => row.meta.taskId).filter(isUuid))];
  if (ids.length === 0) return rows;

  const { data, error } = await supabase.from('tasks').select('id, status').in('id', ids);
  if (error !== null) throw new Error(`Failed to read the drafted replies: ${error.message}`);

  const statuses = new Map<string, TaskStatus | null>();
  for (const task of data ?? []) statuses.set(task.id, task.status);

  // Which of the sent ones actually left the machine. `readDryRunSends` lives in
  // ./tasks.ts and is shared with Today's handled list on purpose: the two
  // screens must not be able to disagree about what "sent" means, and a second
  // copy of this query is exactly how they would come to.
  const sentIds = ids.filter((id) => statuses.get(id) === 'sent');
  const dryRuns = await readDryRunSends(supabase, sentIds);

  return rows.map((row) =>
    row.meta.taskId === null
      ? row
      : {
          ...row,
          draftStatus: statuses.get(row.meta.taskId) ?? null,
          draftDryRun: dryRuns.has(row.meta.taskId),
        },
  );
}

/** The start of the window, as an instant. A whole number of 24-hour days back
 *  from now — not a calendar boundary, because "the last 14 days" is a rolling
 *  window and a calendar one would silently shorten to 13 days every spring. */
function windowStart(days: number, now: Date): string {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

type RawRow = {
  id: string;
  contact_id: string | null;
  subject: string | null;
  body: string | null;
  occurred_at: string | null;
  meta: unknown;
  contacts: InboundContact | null;
};

/** The one place a body is allowed to exist, and the place it stops. */
function toRow(raw: unknown): InboundRow {
  const row = raw as RawRow;
  const snippet = toSnippet(row.body);

  return {
    id: row.id,
    occurredAt: row.occurred_at,
    subject: row.subject,
    snippet: snippet.text,
    snippetTruncated: snippet.truncated,
    meta: readInboundMeta(row.meta),
    contact: row.contacts ?? null,
    draftStatus: null,
    draftDryRun: false,
  };
}
