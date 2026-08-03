import type { Metadata } from 'next';

import { appTimezone } from '@agency/core';
import type { TaskType } from '@agency/core';
import { evaluateSend } from '@agency/core/guardrails';
import type { SendGuardFacts } from '@agency/core/guardrails';
import { partsInZone } from '@agency/core/zone';

import { HandledList, type HandledRow } from '@/components/today/handled-list';
import { MetricTile } from '@/components/today/metric-tile';
import { TaskList } from '@/components/today/task-list';
import { TodayEmptyState } from '@/components/today/empty-state';
import { LANGUAGE_LABELS, blankToNull, contactLine } from '@/lib/contact-vocab';
import { daysBetween, formatDay, pastLabel, yearOf } from '@/lib/day';
import {
  getSendContext,
  getTodayCounts,
  listHandledToday,
  listPendingTasks,
  type HandledTask,
  type SendContext,
  type TaskWithContact,
} from '@/lib/tasks';
import { agentLabel, clock, sendBlockNotice, type TaskCardData } from '@/lib/task-view';
import { dayKeyInZone, dayKeyOf } from '@/lib/validation';

/**
 * `/` — Today. The screen the whole app is for.
 *
 * One person opens this every morning and has to be finished with it in ninety
 * seconds without touching the mouse (PLAN §6 step 6). Everything below is
 * arranged around that.
 *
 * **Three tiles, not four.** SPEC §6 asks for needs you, open leads, unpaid and
 * done today. There is no "unpaid" tile because there is no source for the
 * number: invoicing is out of v1 and `/money` is a stub. A hand-entered figure
 * goes stale in a week and then lies every morning, and a tile that lies is
 * worse than a tile that is missing.
 *
 * **This is a Server Component and it renders a `<div>`.** `app/(app)/layout.tsx`
 * owns the one `<main id="content">` in the tree; a second one is invalid HTML
 * and breaks the landmark navigation the skip link exists for (DESIGN.md §8).
 * The keyboard loop lives entirely in one Client Component, `<TaskList>`, which
 * is the only interactive thing on the page.
 *
 * **Every date, number and refusal reason is resolved here**, on the server, in
 * the operator's timezone, and reaches the card as a finished string — exactly
 * as /pipeline does it. The card never sees a clock, so there is nothing for
 * server and client to disagree about, and a laptop in another airport cannot
 * change what "filed at 08:02" means.
 *
 * **The guardrails are previewed, not enforced, here.** Each card is run through
 * the *pure* `evaluateSend` against counts read once for the whole screen, with
 * the task's status set to `approved` as a hypothesis — the question the card
 * answers is "if I approve this, will it go?", and asking it about a task that
 * is still `pending` would refuse every card with `task_not_approved`, which is
 * true and useless. The I/O half, `assertSendAllowed`, belongs to the send path
 * and is not imported by this app. Nothing on this page can authorise a send;
 * the worker re-reads every row and refuses on its own account. The point is
 * only that the operator finds out about an opt-out *before* pressing approve,
 * rather than from a worker log sixty seconds later.
 */

export const metadata: Metadata = {
  title: 'Today',
};

/** Never cached, never prerendered: every row on this page is customer data read
 *  under RLS as the signed-in operator, and a static copy would be a copy of the
 *  morning's drafts sitting in a build artefact. */
export const dynamic = 'force-dynamic';

export default async function TodayPage() {
  const now = new Date();
  const timeZone = appTimezone();

  // Four independent reads. Sequentially they would be four round trips deep on
  // a page whose whole promise is that it is already there when you open it.
  const [counts, pending, handled, context] = await Promise.all([
    getTodayCounts(now),
    listPendingTasks(),
    listHandledToday(undefined, now),
    getSendContext(now),
  ]);

  const today = dayKeyInZone(now, timeZone);
  const cards = pending.map((task) => toCard(task, context, now, timeZone, today));
  const handledRows = handled.map((task) => toHandledRow(task, timeZone));

  const { killSwitch, dailySendCap, unreadable } = context.settings;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl">Today</h1>
        <p className="text-xs text-faint">
          Newest first. j/k to move, e to edit, Enter to approve.
        </p>
      </header>

      {killSwitch ? (
        <p
          role="status"
          className="rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-base text-warning"
        >
          <span className="font-display font-medium">Sends are paused.</span> The kill switch is
          on, so nothing can be approved or sent. Turn it off in /brain.
        </p>
      ) : null}

      {unreadable.length > 0 ? (
        <p
          role="status"
          className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-base text-danger"
        >
          <span className="font-display font-medium">Settings could not be read.</span>{' '}
          {unreadable.join(', ')} {unreadable.length === 1 ? 'is' : 'are'} stored in a shape the
          send path does not understand, so the seeded default is in use. Fix it in /brain.
        </p>
      ) : null}

      <section aria-label="Today at a glance" className="grid gap-3 sm:grid-cols-3">
        <MetricTile
          label="Needs you"
          value={counts.needsYou}
          sub={
            counts.queued > 0
              ? `${counts.queued} approved, waiting for the send window`
              : 'Nothing approved is waiting to send'
          }
        />
        <MetricTile
          label="Open leads"
          value={counts.openLeads}
          sub="New, contacted, replied or quoted"
          href="/pipeline"
        />
        <MetricTile
          label="Done today"
          value={counts.doneToday}
          // The tile counts every resolved task; the cap counts sends. Reading
          // "12 · cap 10/day" off one line says the cap has been blown when
          // eleven of the twelve were rejections, so the cap is stated next to
          // the number it actually governs — the rolling 24-hour count the
          // worker checks before each send.
          sub={`Sent, rejected or skipped · ${context.sentInLast24h} of ${dailySendCap} sent in 24h`}
        />
      </section>

      {cards.length === 0 ? (
        <TodayEmptyState doneToday={counts.doneToday} queued={counts.queued} />
      ) : (
        <section aria-label="Tasks that need you">
          <TaskList tasks={cards} />
        </section>
      )}

      <HandledList rows={handledRows} />
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Row mapping. Everything below runs on the server and returns finished strings.
 * ----------------------------------------------------------------------- */

function toCard(
  task: TaskWithContact,
  context: SendContext,
  now: Date,
  timeZone: string,
  today: string,
): TaskCardData {
  const contact = task.contacts;
  const names = contactLine(contact?.name ?? null, contact?.business ?? null);
  const body = task.final_body ?? task.draft_body ?? '';
  const kind = task.type === 'draft_email' ? 'draft_email' : 'note';

  return {
    id: task.id,
    kind,
    agent: agentLabel(task.agent),
    // `title` is written by the agent and is nullable in the schema. The card's
    // heading is also its accessible name, so it cannot be allowed to be blank.
    title: blankToNull(task.title) ?? (kind === 'draft_email' ? 'Follow-up draft' : 'Note'),
    filedAt: clockAt(task.created_at, timeZone),
    contact:
      contact === null || contact === undefined
        ? null
        : {
            id: contact.id,
            primary: names.primary,
            secondary: names.secondary,
            stage: contact.stage,
          },
    context: contextLine(task, today, timeZone),
    reasoning: blankToNull(task.reasoning),
    subject: blankToNull(task.draft_subject),
    body,
    // A note has no recipient and no draft, so there is nothing to guard and
    // `evaluateSend` would only report `task_wrong_type` — true, and not what
    // the operator needs to read on a card whose only button is "Dismiss".
    guard: kind === 'draft_email' ? previewGuard(task, body, context, now) : null,
  };
}

/**
 * Would this go, if it were approved right now?
 *
 * `status: 'approved'` is a hypothesis, not the row: see the file header. Every
 * other fact is real. The counts come from `getSendContext`, which read them
 * once for the whole screen — the worker reads them per task, immediately before
 * each send, and that reading is the one that decides anything.
 */
function previewGuard(
  task: TaskWithContact,
  body: string,
  context: SendContext,
  now: Date,
): TaskCardData['guard'] {
  const contact = task.contacts ?? null;
  const type: TaskType = task.type ?? 'draft_email';

  const facts: SendGuardFacts = {
    now,
    killSwitch: context.settings.killSwitch,
    autonomyLevel: context.settings.autonomy[type],
    dailySendCap: context.settings.dailySendCap,
    task: {
      id: task.id,
      type: task.type,
      status: 'approved',
      contactId: task.contact_id,
      subject: task.draft_subject,
      body,
    },
    // The question this preview answers is "if I approve this, will it go?", and
    // a task the operator has not approved yet has not been sent. The worker
    // asks the database instead, per task, immediately before the Gmail call —
    // that reading is the one that stops a second copy, and this page cannot do
    // anything about it either way.
    alreadySent: false,
    contact:
      contact === null
        ? null
        : {
            id: contact.id,
            email: contact.email,
            doNotContact: contact.do_not_contact,
            tags: contact.tags,
          },
    sentInLast24h: context.sentInLast24h,
    sentToContactInLast48h:
      task.contact_id === null ? 0 : (context.sentToContactInLast48h[task.contact_id] ?? 0),
  };

  const decision = evaluateSend(facts);
  if (decision.allowed) return null;

  // `empty_body` is the one refusal the operator can clear without a reload, by
  // typing. A server-rendered strip cannot know they have, so it would keep the
  // approve button disabled after the draft was written — the card owns that
  // condition live instead, against the body it is holding, and says the same
  // sentence. Every other reason needs a round trip to change.
  if (decision.reason === 'empty_body') return null;

  return sendBlockNotice(decision.reason, facts.dailySendCap);
}

/**
 * The one-line context under the contact's name: what the agent knew when it
 * drafted, in the order the operator asks about it — what language this will be
 * in, when they were last spoken to, and what the conversation was about.
 */
function contextLine(task: TaskWithContact, today: string, timeZone: string): string[] {
  const contact = task.contacts;
  if (contact === null || contact === undefined) return [];

  const parts: string[] = [];

  if (contact.language !== null) parts.push(LANGUAGE_LABELS[contact.language]);

  const lastTouch = dayKeyOf(contact.last_touch_at, timeZone);
  if (lastTouch === null) {
    parts.push('never contacted');
  } else {
    const offset = daysBetween(today, lastTouch);
    // Absolute first, relative as the hint beside it (DESIGN.md §7).
    parts.push(
      offset === null
        ? `last touch ${formatDay(lastTouch, yearOf(today))}`
        : `last touch ${formatDay(lastTouch, yearOf(today))}, ${pastLabel(offset)}`,
    );
  }

  const tags = (contact.tags ?? []).slice(0, 3);
  if (tags.length > 0) parts.push(tags.join(', '));

  return parts;
}

function toHandledRow(task: HandledTask, timeZone: string): HandledRow {
  const contact = task.contacts;
  const names = contactLine(contact?.name ?? null, contact?.business ?? null);

  return {
    id: task.id,
    // Only resolved rows are read, so the status is one of the three; the
    // fallback keeps the type honest rather than asserting it away.
    status: task.status ?? 'skipped',
    dryRun: task.dryRun,
    primary: contact === null || contact === undefined ? '—' : names.primary,
    title: blankToNull(task.title) ?? '',
    at: clockAt(task.resolved_at, timeZone),
  };
}

/* -------------------------------------------------------------------------- */

/**
 * A stored `timestamptz` → `'08:02'` in the operator's zone.
 *
 * `partsInZone` comes from `@agency/core/zone`, which is where step 6 put the
 * timezone arithmetic that already existed twice (lib/validation.ts and the
 * worker's follow-up selector). Never `Date#getHours`: that reads the server's
 * clock, and this app renders on machines whose timezone is nobody's business.
 */
function clockAt(iso: string | null, timeZone: string): string {
  if (iso === null) return '—';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '—';
  const parts = partsInZone(instant, timeZone);
  return clock(parts.hour, parts.minute);
}
