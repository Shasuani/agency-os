/**
 * The inbound vocabulary: the nine classes the inbox agent can decide, what each
 * one is called on screen, and — the part this module exists for — **what the
 * system did about it**.
 *
 * Read the tone of `/inbox` off this file. Today is a queue: it lists the things
 * that still need a person. `/inbox` is the record, and the record has to include
 * the decisions nobody was asked about. Three of the nine classes
 * (`not_interested`, `spam`, `not_business`) produce no task at all, so Today has
 * no evidence they ever arrived — a rejection that quietly closed a contact and a
 * message that was binned as spam leave no trace anywhere else in the app. SPEC
 * §5 puts it plainly: the silent handling matters as much as the loud handling. A
 * silent decision nobody can inspect is indistinguishable from a bug, so every
 * class here carries a sentence saying what happened, and the three silent ones
 * say out loud that no reply was drafted and no notification was sent.
 *
 * **The nine strings are a second copy, and that is a considered loss.** The
 * first copy is `INBOUND_CLASSES` in `apps/worker/src/jobs/inbox-classify.ts`,
 * which is also the enum in the classifier's JSON schema. apps/web has no
 * dependency on apps/worker and must not acquire one: the worker's module
 * value-imports the LLM wrapper, and this file is imported by a Client Component,
 * so the list would drag the Anthropic SDK into the browser bundle. The other
 * home would be `packages/core`, which is owned by the integration agent in this
 * build step. So the list is transcribed from SPEC §5, and `inbox-vocab.test.ts`
 * pins it against SPEC §5's own line, in order. The failure that guards against:
 * the worker starts emitting a tenth class, this file does not know it, and every
 * message of that class renders as "unclassified" — the page would then lie about
 * a message that was in fact classified, in exactly the situation (a half-rolled
 * deploy) where the operator most needs to be told something is off. That is also
 * why `readInboundMeta` distinguishes *unknown* from *absent*; see below.
 *
 * **`INBOUND_CLASS_OUTCOME` is a second copy of the routing table** in the same
 * way, and it is prose rather than behaviour: nothing in apps/web routes
 * anything, so a drift here produces a wrong caption, not a wrong action. It is
 * still worth having, because the chip on its own says `spam` and the operator's
 * question is never "what was it called", it is "what did you do with it, and can
 * I still get it back". The precise version of each rule (notably the
 * never-demote guard on the stage change) is in `detail`, which becomes the
 * `title` and the screen-reader text; `segments` is the short form on the row.
 *
 * **No colour that is not a data channel.** DESIGN.md §2: accent means "you can
 * interact with this", never a category, so no class chip uses it. The two hot
 * classes get `positive`, `not_interested` gets a hollow `danger` (the same
 * treatment `lost` has on a stage badge, because it is the same event), `spam`
 * and `not_business` get faint hairlines, and everything routine stays neutral.
 * Unclassified gets `warning` — it is an anomaly, not a category.
 *
 * **Why the pure helpers live here rather than in ./inbox.ts.** ./inbox.ts
 * imports `requireOperator`, which imports `next/headers`, which cannot be loaded
 * by `node --test`. Anything that decides something and therefore has to be
 * tested — the meta reader, the snippet cap, the two query parsers — sits on this
 * side of the split, which is also the client-safe side. Same arrangement
 * ./task-view.ts and ./tasks.ts already have.
 *
 * Type-only imports from `@agency/core`, which TypeScript erases. **Do not add a
 * value import from that barrel to this file**: it re-exports the service-role
 * Supabase client factory and this module reaches a browser bundle.
 */

import type { Stage, TaskStatus } from '@agency/core';

// ---------------------------------------------------------------------------
// The nine classes
// ---------------------------------------------------------------------------

/**
 * SPEC §5, in the spec's own order. Mirrored by `INBOUND_CLASSES` in
 * apps/worker/src/jobs/inbox-classify.ts and by that agent's JSON schema enum.
 */
export const INBOUND_CLASSES = [
  'new_lead',
  'interested',
  'question',
  'objection',
  'not_interested',
  'scheduling',
  'invoice',
  'spam',
  'not_business',
] as const;

export type InboundClass = (typeof INBOUND_CLASSES)[number];

export function isInboundClass(value: unknown): value is InboundClass {
  return typeof value === 'string' && (INBOUND_CLASSES as readonly string[]).includes(value);
}

export const INBOUND_CLASS_LABELS: Record<InboundClass, string> = {
  new_lead: 'New lead',
  interested: 'Interested',
  question: 'Question',
  objection: 'Objection',
  not_interested: 'Not interested',
  scheduling: 'Scheduling',
  invoice: 'Invoice',
  spam: 'Spam',
  not_business: 'Not business',
};

/**
 * The three that produce no task. Everything this page is for is downstream of
 * this list: these are the messages Today cannot show, because there is nothing
 * pending to show.
 */
export const SILENT_CLASSES = ['not_interested', 'spam', 'not_business'] as const;

export function isSilentClass(value: InboundClass): boolean {
  return (SILENT_CLASSES as readonly string[]).includes(value);
}

/**
 * Chip treatment. Hollow or filled as well as hued, so the three that matter
 * stay one glance apart in greyscale and under red/green colour blindness —
 * the same rule `<StageBadge>` follows for `won` against `lost`.
 */
export const INBOUND_CLASS_TONE: Record<InboundClass, string> = {
  new_lead: 'border-positive bg-positive text-positive-fg',
  interested: 'border-positive/40 bg-positive-subtle text-positive',
  question: 'border-transparent bg-sunken text-muted',
  objection: 'border-transparent bg-sunken text-muted',
  scheduling: 'border-transparent bg-sunken text-muted',
  invoice: 'border-transparent bg-sunken text-muted',
  not_interested: 'border-danger/55 text-danger',
  spam: 'border-line text-faint',
  not_business: 'border-line text-faint',
};

/** What the row says when `meta.class` was never written — see `readInboundMeta`. */
export const UNCLASSIFIED_LABEL = 'Unclassified';
export const UNCLASSIFIED_TONE = 'border-warning/55 border-dashed text-warning';

// ---------------------------------------------------------------------------
// What the system did
// ---------------------------------------------------------------------------

export type ClassOutcome = {
  /** Rendered joined by ` · ` under the message. Short by design. */
  readonly segments: readonly string[];
  /** The precise version, including the guards the short form drops. Becomes
   *  the `title` and the screen-reader text. */
  readonly detail: string;
};

/**
 * The routing table of PLAN §6 step 8 / SPEC §5, restated for a person.
 *
 * The stage line is worded "if they were still new or contacted" because the
 * promotion is guarded against demotion: a `quoted` lead who asks a question is
 * not knocked back to `replied`, which would restart the quoted cadence from the
 * beginning. Saying "moved to replied" flatly would be wrong for most of the
 * pipeline, and a caption that is wrong for the interesting rows is worse than
 * no caption.
 */
export const INBOUND_CLASS_OUTCOME: Record<InboundClass, ClassOutcome> = {
  new_lead: {
    segments: ['Reply drafted', 'You were notified straight away'],
    detail:
      'A reply was drafted and filed on Today for approval, and a push notification went out immediately. The stage was left alone: they were created as new by the sender match, and replied would claim they answered something we sent.',
  },
  interested: {
    segments: ['Reply drafted', 'Stage advanced', 'You were notified straight away'],
    detail:
      'A reply was drafted and filed on Today for approval, and a push notification went out immediately. The stage moved to replied if they were still new or contacted, and was left alone otherwise so a quoted lead is never demoted.',
  },
  question: {
    segments: ['Reply drafted', 'Stage advanced', 'Held for the daily digest'],
    detail:
      'A reply was drafted and filed on Today for approval. No immediate notification — it is counted in the next morning digest. The stage moved to replied if they were still new or contacted, and was left alone otherwise.',
  },
  objection: {
    segments: ['Reply drafted', 'Stage advanced', 'Held for the daily digest'],
    detail:
      'A reply was drafted and filed on Today for approval. No immediate notification — it is counted in the next morning digest. The stage moved to replied if they were still new or contacted, and was left alone otherwise.',
  },
  scheduling: {
    segments: ['Reply drafted', 'Stage advanced', 'Held for the daily digest'],
    detail:
      'A reply was drafted and filed on Today for approval. No immediate notification — it is counted in the next morning digest. The stage moved to replied if they were still new or contacted, and was left alone otherwise.',
  },
  invoice: {
    segments: ['Reply drafted', 'Held for the daily digest'],
    detail:
      'A reply was drafted and filed on Today for approval. No immediate notification — it is counted in the next morning digest. The stage was left alone: an invoice question comes from a client, and replied would be a demotion.',
  },
  not_interested: {
    segments: ['No reply drafted', 'Closed as lost, do-not-contact set', 'You were not notified'],
    detail:
      'Nothing was drafted and nothing was sent to you. The contact was moved to lost and marked do-not-contact, which is permanent and is checked again at send time. If this is wrong, clear it on the contact in Pipeline — no other screen records that this happened.',
  },
  spam: {
    segments: ['No reply drafted', 'Logged only', 'You were not notified'],
    detail:
      'Logged and nothing else: no reply, no task, no notification, no change to the contact. This row is the only trace it arrived.',
  },
  not_business: {
    segments: ['No reply drafted', 'Logged only', 'You were not notified'],
    detail:
      'Logged and nothing else: no reply, no task, no notification, no change to the contact. This row is the only trace it arrived.',
  },
};

/**
 * The outcome for one row, taking into account whether a reply was actually
 * filed.
 *
 * `INBOUND_CLASS_OUTCOME` is keyed on the class alone, and the worker's rule is
 * not: `const mayDraft = route.draftReply && !match.optedOut`. That suppression
 * is deliberate and documented — a contact with `do_not_contact = true` who
 * writes in is still logged and still classified, but never drafted at — and it
 * is a live branch in the code, not stale copy.
 *
 * So an opted-out contact writing "when can you start?" was classified
 * `question`, had no task filed, and the row then rendered
 * `Reply drafted · Stage advanced · Held for the daily digest` on one line next
 * to `No draft was filed` on the other. The page whose stated purpose is being
 * the record you can disagree with was contradicting itself inside a single row.
 *
 * `drafted` is `meta.task_id !== null`, the same signal `draftState` reads, so
 * the two halves of the row cannot disagree. It is deliberately not "because
 * they opted out": a `tasks` insert that failed produces the same state, and the
 * caption should say what happened rather than guess why. The detail names the
 * likely reason, where there is room to be careful about it.
 */
export function classOutcome(cls: InboundClass, drafted: boolean): ClassOutcome {
  const base = INBOUND_CLASS_OUTCOME[cls];
  if (drafted || isSilentClass(cls)) return base;

  return {
    segments: ['No reply drafted', ...base.segments.slice(1)],
    detail:
      'No reply was drafted. The usual reason is that this contact is marked do-not-contact: ' +
      'they are still logged and still classified, but nothing is ever written to them. ' +
      'A failed task insert looks the same from here. ' +
      base.detail,
  };
}

/** The one-line form. ` · ` matches the separator the rest of the app uses. */
export function outcomeLine(cls: InboundClass, drafted: boolean = true): string {
  return classOutcome(cls, drafted).segments.join(' · ');
}

// ---------------------------------------------------------------------------
// What became of the drafted reply
// ---------------------------------------------------------------------------

export type DraftState = {
  label: string;
  tone: string;
  /** True only while the draft is still waiting on Today, which is the one
   *  state with somewhere to go. */
  actionable: boolean;
};

/**
 * The end of the row: for the six classes that draft a reply, whether that reply
 * is still waiting, went out, or was thrown away.
 *
 * The state worth the code is the last branch. A class that drafts, with no
 * `task_id` on the interaction, means the message was classified and then the
 * draft never got filed — a Sonnet call that failed, a word-limit rejection, a
 * worker that died between the two writes. Nothing else in the app records that:
 * Today has no card because no task exists, and the row would otherwise read
 * "Reply drafted" over a reply that does not exist. It is `warning` for the same
 * reason an unclassified row is — an anomaly is not a category.
 *
 * `null` means there is nothing to say, which is correct for the three silent
 * classes (their outcome line already says no reply was drafted) and for a row
 * that was never classified.
 *
 * **`dryRun` is why `sent` has two labels.** `DRY_RUN` defaults to true, and
 * under it the send path does everything except open the socket — the task is
 * marked `sent` either way. "Reply sent" on a reply nobody received is the
 * single most misleading sentence this screen could print, and `/inbox` is
 * where it would be believed most: this page is the record of a conversation,
 * so a row claiming we answered is a row the operator will not answer again.
 * The green is withheld rather than swapped for a warning hue, for the reason
 * `CONFIDENCE_TONE` gives — with the flag on by default, a colour that fires on
 * every row is a colour nobody reads. Today's handled list makes the same call
 * through `sendOutcome` in ./task-view.
 */
export function draftState(
  cls: InboundClass | null,
  taskId: string | null,
  status: TaskStatus | null,
  dryRun: boolean = false,
): DraftState | null {
  if (cls === null || isSilentClass(cls)) return null;

  if (taskId === null) {
    return {
      label: 'No draft was filed',
      tone: 'text-warning',
      actionable: false,
    };
  }

  switch (status) {
    case 'pending':
      return { label: 'Draft waiting on Today', tone: 'text-accent', actionable: true };
    case 'approved':
      return { label: 'Approved, waiting for the send window', tone: 'text-muted', actionable: false };
    case 'sent':
      return dryRun
        ? { label: 'Reply was a dry run — not sent', tone: 'text-muted', actionable: false }
        : { label: 'Reply sent', tone: 'text-positive', actionable: false };
    case 'rejected':
      return { label: 'Draft rejected', tone: 'text-faint', actionable: false };
    case 'skipped':
      return { label: 'Draft skipped', tone: 'text-faint', actionable: false };
    default:
      // A `task_id` that no longer resolves. Not a state this app creates, but
      // one a hand-run delete does, and inventing a status for it would be the
      // page guessing about a message it is supposed to be the record of.
      return { label: 'Draft no longer on file', tone: 'text-faint', actionable: false };
  }
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export function isConfidence(value: unknown): value is Confidence {
  return typeof value === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  low: 'low confidence',
  medium: 'medium confidence',
  high: 'high confidence',
};

/**
 * Only `low` earns a hue.
 *
 * A confident classification is the ordinary case, and a permanent green next to
 * every ordinary row trains the eye to stop reading the column — which is the
 * failure that would make the warning useless on the one row that needs it. The
 * nav's kill-switch indicator makes the same argument for the same reason. A
 * low-confidence guess is the row most likely to be wrong, so it is the row the
 * operator is meant to stop on.
 */
export const CONFIDENCE_TONE: Record<Confidence, string> = {
  low: 'text-warning',
  medium: 'text-faint',
  high: 'text-faint',
};

// ---------------------------------------------------------------------------
// interactions.meta, as written by the inbox agent
// ---------------------------------------------------------------------------

/**
 * The shape of `interactions.meta` for an inbound row. This is a **data
 * contract** with apps/worker's inbox agent, not a shared type: neither side
 * imports the other. The agent writes the claim row before it classifies — the
 * row is the duplicate-suppression lock — so every field except the Gmail ids
 * starts null and is filled in by a later update.
 */
export type InboundMeta = {
  /** Null when the row was written but never classified. */
  class: InboundClass | null;
  /** Set when `meta.class` held a string this build does not know. */
  unknownClass: string | null;
  confidence: Confidence | null;
  /** The classifier's one sentence for the operator. Rendered, never logged. */
  reason: string | null;
  /** The draft task, when the class produced one. */
  taskId: string | null;
  gmailThreadId: string | null;
};

const EMPTY_META: InboundMeta = {
  class: null,
  unknownClass: null,
  confidence: null,
  reason: null,
  taskId: null,
  gmailThreadId: null,
};

/**
 * Read `interactions.meta` defensively.
 *
 * Two absent states are kept apart on purpose, and this is the whole reason the
 * function exists rather than three property reads at the call site:
 *
 * - **`class: null`, `unknownClass: null`** — the row was claimed and never
 *   classified. That is what a worker that died between the insert and the Haiku
 *   call leaves behind, and rendering it honestly is the only way that state is
 *   ever visible to anybody.
 * - **`class: null`, `unknownClass: 'whatever'`** — the row *was* classified,
 *   into something this build has no label for. That is a deploy skew between
 *   the worker and the web app. Folding it into the first state would hide a
 *   version mismatch behind something that looks like a crash, and the operator
 *   would go looking for the wrong problem.
 *
 * Everything else is null-safe against anything, because `meta` is `jsonb` and
 * the column will happily hold a string, a number or an array. A page that
 * throws on one bad row shows nothing for the other ninety-nine.
 */
export function readInboundMeta(meta: unknown): InboundMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return EMPTY_META;

  const record = meta as Record<string, unknown>;
  const rawClass = record['class'];

  return {
    class: isInboundClass(rawClass) ? rawClass : null,
    unknownClass:
      !isInboundClass(rawClass) && typeof rawClass === 'string' && rawClass.trim() !== ''
        ? rawClass.trim().slice(0, 40)
        : null,
    confidence: isConfidence(record['confidence']) ? record['confidence'] : null,
    reason: nonEmptyString(record['reason']),
    taskId: nonEmptyString(record['task_id']),
    gmailThreadId: nonEmptyString(record['gmail_thread_id']),
  };
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// The snippet
// ---------------------------------------------------------------------------

/**
 * How much of an inbound body reaches the page. One line of a list row; nothing
 * on this screen opens a message.
 */
export const MAX_SNIPPET_CHARS = 180;

export type Snippet = { text: string; truncated: boolean };

/**
 * A body → one line, capped.
 *
 * `lib/inbox.ts` applies this before the row leaves the module, and the row type
 * it returns has no `body` field at all — so there is no way for a component to
 * render a full inbound email by reaching for one more property. That is the
 * same argument ./tasks.ts makes about counts, pointed at the most sensitive
 * text this system holds: a page that ships every inbound email to the browser
 * in order to render a list of one-line previews is a page that leaks every
 * inbound email.
 *
 * The cut backs off to the last space inside the window when there is one, so a
 * Greek word is not sliced in half; a single very long token is cut where it
 * falls, because the alternative is an empty preview.
 */
export function toSnippet(body: unknown, max: number = MAX_SNIPPET_CHARS): Snippet {
  if (typeof body !== 'string') return { text: '', truncated: false };

  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return { text: flat, truncated: false };

  const window = flat.slice(0, max);
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > max / 2 ? window.slice(0, lastSpace) : window;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

// ---------------------------------------------------------------------------
// The query, which is the whole state of the page
// ---------------------------------------------------------------------------

export const INBOX_PATH = '/inbox';

/** `'all'` is no filter; `'unclassified'` is `meta->>class is null`, which is a
 *  state and not a class, so it cannot live in `INBOUND_CLASSES`. */
export type InboxClassFilter = InboundClass | 'all' | 'unclassified';

export const INBOX_CLASS_FILTER_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'all', label: 'All classes' },
  ...INBOUND_CLASSES.map((cls) => ({ value: cls, label: INBOUND_CLASS_LABELS[cls] })),
  { value: 'unclassified', label: UNCLASSIFIED_LABEL },
];

export function toInboxClassFilter(value: unknown): InboxClassFilter {
  if (value === 'unclassified') return 'unclassified';
  return isInboundClass(value) ? value : 'all';
}

/** SPEC §5 gives no window. Fourteen days is two weeks of mail: long enough that
 *  a Monday shows the fortnight, short enough that the default read stays small. */
export const DEFAULT_INBOX_DAYS = 14;
export const MAX_INBOX_DAYS = 90;
export const INBOX_DAY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

/**
 * Anything that is not a whole number of days in range falls back to the
 * default. A hand-edited `?days=0` must not read as "no window at all" and
 * `?days=100000` must not turn a page render into a full scan of the table.
 */
export function toInboxDays(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return DEFAULT_INBOX_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 1) return DEFAULT_INBOX_DAYS;
  // Clamped rather than rejected: a hand-edited `?days=100000` means "as far
  // back as you go", and answering that with the 14-day default would look like
  // the param was ignored.
  return Math.min(days, MAX_INBOX_DAYS);
}

export type InboxQuery = {
  classFilter: InboxClassFilter;
  days: number;
};

/**
 * The canonical URL for a view. Defaults are omitted, so `/inbox` and
 * `/inbox?class=all&days=14` are the same address rather than two links to the
 * same screen that the nav's active-route check would treat differently.
 */
export function inboxHref(query: Partial<InboxQuery>): string {
  const params = new URLSearchParams();
  const classFilter = query.classFilter ?? 'all';
  const days = query.days ?? DEFAULT_INBOX_DAYS;

  if (classFilter !== 'all') params.set('class', classFilter);
  if (days !== DEFAULT_INBOX_DAYS) params.set('days', String(days));

  const search = params.toString();
  return search === '' ? INBOX_PATH : `${INBOX_PATH}?${search}`;
}

/** The label a filter is described by in the empty state. */
export function classFilterLabel(filter: InboxClassFilter): string | null {
  if (filter === 'all') return null;
  if (filter === 'unclassified') return UNCLASSIFIED_LABEL;
  return INBOUND_CLASS_LABELS[filter];
}

// ---------------------------------------------------------------------------
// Shapes the page hands to the components
// ---------------------------------------------------------------------------

/** Everything already resolved to a string on the server, as this app does
 *  everywhere: the components below never see a clock or a timezone. */
export type InboxChip = {
  label: string;
  /** Border/background/text utilities. Tokens only. */
  tone: string;
  /** Hover and screen-reader text — what the class means. */
  title: string;
};

export type InboxRowView = {
  id: string;
  chip: InboxChip;
  contact: {
    id: string;
    primary: string;
    secondary: string | null;
    stage: Stage | null;
  } | null;
  /** `'14 Aug · 09:14'`, resolved in the operator's timezone on the server. */
  stamp: string;
  /** `'yesterday'` — the hint beside the absolute date, never instead of it. */
  relative: string;
  subject: string | null;
  snippet: string;
  snippetTruncated: boolean;
  /** The classifier's sentence. Rendered here and nowhere else. */
  reason: string | null;
  outcome: ClassOutcome | null;
  confidence: { label: string; tone: string } | null;
  /** What became of the drafted reply, when the class produced one. */
  draft: {
    /** Only set while the task is still waiting on Today. */
    href: string | null;
    label: string;
    tone: string;
  } | null;
};
