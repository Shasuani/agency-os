/**
 * The follow-up agent — SPEC §4, PLAN §6 step 5.
 *
 * Runs daily at 08:00 Europe/Athens. For every contact whose `next_touch_at`
 * has come round: load them, their recent interactions and the whole brain, ask
 * Sonnet whether there is anything genuine to say, and either file a pending
 * task or push the date out. It sends nothing. Gmail is step 6.
 *
 * This file is the orchestration only. Everything decidable without a database
 * or a model — the due predicate, the per-stage touch count, the date maths, the
 * validation of the model's answer — is in `./followup-select.ts` and is unit
 * tested there. Everything about *how the model is asked* is in
 * `./followup-prompt.ts`.
 *
 * ---------------------------------------------------------------------------
 * The five decisions in here that SPEC §4 does not make
 * ---------------------------------------------------------------------------
 *
 * **1. The selection query does not exclude `won`.** SPEC §4 step 1 says
 * "stage not in ('won','lost')", but three of the six rows of SPEC §4's own
 * cadence table — NFC card +14, project delivered +30, active client +30 — are
 * all `won` contacts. Implementing the query literally means the retainer
 * cadence never runs, nothing errors, and clients silently stop hearing from
 * anyone. PLAN §6 step 5 constraint 1 and the header of `cadence.ts` both call
 * this out. The query is `do_not_contact = false and stage <> 'lost'`.
 *
 * **2. A contact who gets a draft also gets their date pushed out.** SPEC §4
 * only mentions pushing the date on the *skip* branch. Leaving it alone on the
 * draft branch means a task sitting unapproved for three days generates a
 * second, third and fourth identical draft — the queue fills with duplicates of
 * the one thing the operator has not got round to. The cadence interval is
 * applied either way. Note that the *sequence step* still does not advance:
 * `touchCount` is derived from `interactions`, and nothing is written to
 * `interactions` until step 6 actually sends, so a rejected draft costs the
 * contact nothing.
 *
 * **3. Cadence decides the schedule; the model only advises.** The model
 * returns `suggested_next_touch_days` on every call. It is honoured on the skip
 * branch, bounded (`planPushOut`), because there the model is the only thing
 * that knows why it declined. On the draft branch the cadence table wins:
 * `cadence.ts` is specified, deterministic and unit tested, and letting a
 * per-call suggestion override it would make the tested module decorative. The
 * suggestion is recorded on the run either way.
 *
 * **4. A cadence result of `dormant` costs no model call.** The contact has
 * exhausted their sequence; SPEC §4's table says the next state is dormant, and
 * `cadence.ts` reasons that a fourth chase stops reading as diligence. Marking
 * them dormant with a 90-day heartbeat is the whole of the correct behaviour,
 * and asking Sonnet to write a fifth chase first would be paying for a message
 * the rules already say not to send.
 *
 * **5. `last_touch_at` is not updated.** Nothing was touched. Drafting is not
 * contact. Step 6 writes it when a message actually leaves.
 *
 * `DRY_RUN` is deliberately not consulted anywhere in this file. Dry-run stubs
 * the Gmail send (PLAN §7), and the whole point of it is that the agent still
 * runs and still produces real drafts to read. This step has no send path.
 *
 * ---------------------------------------------------------------------------
 * Style examples (PLAN §6 step 9) — two queries a run, and never fatal
 * ---------------------------------------------------------------------------
 *
 * The operator's past edits are read **once per language per run** into a small
 * map, not once per contact. There are two languages, so a run costs at most two
 * extra queries however many contacts it has; per contact it would be forty, all
 * returning the same forty rows.
 *
 * The load is wrapped in its own try/catch and an empty result is cached on
 * failure, for two separate reasons. First, a style hint is a nicety and a
 * contact's follow-up is not: a failed query here must cost nobody their draft,
 * so the run continues without examples rather than counting a contact as
 * `failed`. Second, caching the failure means one log line per language per run
 * instead of one per contact — an outage that logs forty times is an outage that
 * hides whatever else happened that morning.
 */

import { appTimezone, createServiceClient, getSetting, isKillSwitchOn } from '@agency/core';
import type { Contact, Db, Interaction, Language, Stage, TaskInsert } from '@agency/core';
import { findSuppressionTag, nextTouch } from '@agency/core/cadence';
import type { CadenceResult } from '@agency/core/cadence';
import { LlmError, call } from '@agency/core/llm';
import type { Trigger } from '@agency/core/llm';

import { buildFollowupPrompt, promptLanguage } from './followup-prompt.js';
import {
  INTERACTION_HISTORY_LIMIT,
  MAX_CONTACTS_PER_RUN,
  PROMPT_INTERACTION_LIMIT,
  SELECTION_GRACE_MS,
  cacheBreakpointIssue,
  deriveStageTouchCount,
  draftLengthNote,
  parseDraft,
  planNextTouch,
  planPushOut,
  screenContact,
} from './followup-select.js';
import { loadStyleExamples } from './style-examples.js';
import type { StyleExample } from './style-examples.js';

const AGENT = 'followup';

/**
 * What the caller logs, and what step 7 turns into "4 follow-ups ready".
 *
 * `considered + …` holds: every selected contact lands in exactly one of
 * `drafted`, `skipped` or `failed`, including the ones left untouched when a run
 * halts early on the cost cap.
 */
export type FollowupSummary = {
  considered: number;
  drafted: number;
  skipped: number;
  failed: number;
};

export type RunFollowupOptions = {
  /** Injectable for tests. Defaults to the service-role client. */
  db?: Db;
  /** Injectable for tests. Defaults to the moment the run starts. */
  now?: Date;
  /** `agent_runs.trigger`. The cron passes 'cron'; a manual re-run passes 'manual'. */
  trigger?: Trigger;
  /** The operator's timezone. Cadence dates are written at 08:00 in this zone. */
  timeZone?: string;
};

function log(message: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), agent: AGENT, message, ...extra }));
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runFollowup(options: RunFollowupOptions = {}): Promise<FollowupSummary> {
  const db = options.db ?? createServiceClient();
  const now = options.now ?? new Date();
  const trigger: Trigger = options.trigger ?? 'cron';
  // Resolved per run, not at module scope, so a test can pass a fixed zone
  // without touching process.env.
  const timeZone = options.timeZone ?? appTimezone();

  const summary: FollowupSummary = { considered: 0, drafted: 0, skipped: 0, failed: 0 };

  // Everything before the loop is all-or-nothing: without the brain, the queue
  // or the settings there is no run at all. A failure here is not a contact
  // failure, so it is not counted as one — but SPEC §8 still says it must not
  // vanish, hence the alert. It is rethrown so the caller's retry-once path
  // (PLAN §7) still sees it.
  let contacts: Contact[];
  let brain: Record<string, string>;
  let alreadyQueued: Set<string>;
  let autonomyLevel: number;

  try {
    // SPEC §8 / PLAN §7: checked at the top of every cron job, before anything
    // is read and long before anything is written.
    if (await isKillSwitchOn(db)) {
      log('kill switch is on — no follow-ups considered', { kill_switch: true });
      return summary;
    }

    contacts = await selectDueContacts(db, now);
    summary.considered = contacts.length;

    if (contacts.length === 0) {
      log('nothing due', summary);
      return summary;
    }

    if (contacts.length === MAX_CONTACTS_PER_RUN) {
      // Not an error — the overflow is still due tomorrow, and the query is
      // ordered oldest-first so the most overdue were served. Logged because a
      // run that hits the ceiling two mornings running means something is wrong
      // upstream, and that is invisible otherwise.
      log('hit the per-run contact ceiling', { limit: MAX_CONTACTS_PER_RUN });
    }

    // Loaded once for the whole run. This is what makes prompt caching possible:
    // an identical brain block in every request, first, behind a cache
    // breakpoint (PLAN §2). Re-reading it per contact would be one wasted query
    // each and, if an edit landed mid-run, a cache miss on every contact after
    // it.
    brain = await loadBrain(db);

    // An unresolved draft for the same contact — from either agent, waiting on
    // the operator or waiting on the send window — means an email to them is
    // already in flight. Drafting a second one does not help them and can mail
    // them twice. See `loadContactsWithOpenDraft`.
    alreadyQueued = await loadContactsWithOpenDraft(
      db,
      contacts.map((contact) => contact.id),
    );

    // SPEC §7: the ladder is built and locked at 1 for v1 — nothing leaves the
    // system to a third party above level 1. Read from settings so the ladder
    // is real, then clamped, so raising the setting cannot make this agent send.
    const autonomy = await getSetting(db, 'autonomy');
    autonomyLevel = Math.min(autonomy.draft_email, 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('run failed before any contact was processed', { error: message });
    await fileAlert(db, null, 'Follow-up run failed to start', message, 1);
    throw error;
  }

  let cacheWarned = false;
  let halted: string | null = null;

  // Step 9. Filled lazily, at most one entry per language per run. An empty
  // array is cached on failure on purpose — see the header.
  const styleExamplesByLanguage = new Map<Language, StyleExample[]>();

  const styleExamplesFor = async (language: Language): Promise<StyleExample[]> => {
    const cached = styleExamplesByLanguage.get(language);
    if (cached !== undefined) return cached;

    let examples: StyleExample[] = [];
    try {
      examples = await loadStyleExamples(db, language);
    } catch (error) {
      log('could not load style examples — drafting without them', {
        language,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    styleExamplesByLanguage.set(language, examples);
    return examples;
  };

  for (const [index, contact] of contacts.entries()) {
    if (halted !== null) {
      // Everything left was genuinely skipped this morning, and is still due
      // tomorrow: nothing was written to their row.
      summary.skipped += 1;
      continue;
    }

    // PLAN §6 step 5, constraint 3. `nextTouch` throws a RangeError on corrupt
    // input, PostgREST throws on a network blip, and the model throws on a
    // refusal. Any one of those outside this try/catch aborts the 08:00 run and
    // *everybody* is missed that day. One bad row must cost one contact.
    try {
      const outcome = await processContact({
        db,
        contact,
        now,
        timeZone,
        trigger,
        brain,
        // Loaded for the language the prompt has decided to write in, not for
        // the column. The prompt filters what it is given a third time against
        // the same decision, so keying this on `contacts.language` meant that
        // every contact whose written language differed from their column — the
        // exact case the heuristic exists for — got an empty list and no style
        // examples at all, silently. Deferred into `processContact` because the
        // decision needs the contact's interactions, which are loaded there.
        styleExamplesFor,
        autonomyLevel,
        alreadyQueued: alreadyQueued.has(contact.id),
        onCacheIssue: (issue) => {
          if (cacheWarned) return;
          cacheWarned = true;
          // Not fatal — the run still produces correct drafts, it just pays
          // full input price for the brain on every contact instead of a tenth.
          log('prompt cache breakpoint looks wrong', { issue });
        },
      });

      if (outcome.kind === 'drafted') {
        summary.drafted += 1;
        log('drafted', {
          contact_id: contact.id,
          task_id: outcome.taskId,
          cadence: outcome.cadenceReason,
          confidence: outcome.confidence,
        });
      } else {
        summary.skipped += 1;
        log('skipped', { contact_id: contact.id, reason: outcome.reason });
      }
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      log('contact failed', { contact_id: contact.id, error: message, position: index });

      if (error instanceof LlmError && error.kind === 'cost_cap') {
        // The wrapper throws this before it spends anything and files no alert
        // of its own for it. Every remaining contact would fail identically, so
        // stop rather than burn the rest of the run discovering that.
        halted = 'daily cost cap reached';
        await fileAlert(db, contact.id, 'Follow-up run halted', message, autonomyLevel);
        continue;
      }

      // SPEC §8: an error never disappears silently. The LLM wrapper already
      // files its own alert after its retry, so a second one here would put two
      // cards in the queue for one failure.
      if (!(error instanceof LlmError)) {
        await fileAlert(
          db,
          contact.id,
          `Follow-up failed for ${contactLabel(contact)}`,
          message,
          autonomyLevel,
        );
      }
    }
  }

  // A full run that drafted nothing is the signature of a stuck queue head.
  //
  // The no-email case is filtered at the query now, but it is not the only row
  // that can stay due indefinitely: `screenContact` returns `alert` for a null
  // stage and for an unparseable `next_touch_at`, and both of those deliberately
  // keep their date. Enough of them and the sixty oldest due contacts are all
  // rows the agent cannot act on, the agent quietly stops drafting for everyone
  // else, and the only trace is a log line nobody reads. This is the card that
  // says so. It is filed only when both conditions hold, so an ordinary busy
  // morning — sixty contacts, forty drafts — files nothing.
  if (summary.considered >= MAX_CONTACTS_PER_RUN && summary.drafted === 0 && halted === null) {
    await fileAlert(
      db,
      null,
      'The follow-up run filled up and drafted nothing',
      `All ${MAX_CONTACTS_PER_RUN} contacts the run could look at were skipped, so nobody ` +
        'behind them was reached either. Open /pipeline sorted by follow-up date and fix the ' +
        'rows at the top — usually a missing stage or a follow-up date that will not parse.',
      autonomyLevel,
    );
  }

  // SPEC §4 step 6 is one notification, not one per task — and step 7 owns
  // delivery. Step 5's whole responsibility is the count.
  log(`${summary.drafted} follow-ups ready`, { ...summary, halted });

  return summary;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Contacts due for a touch.
 *
 * Two things about this query that are not obvious and are both quiet failures:
 *
 * **`stage <> 'lost'` is written as an `or` against NULL.** In SQL — and so in
 * PostgREST — `NULL <> 'lost'` is NULL, not true, so a plain `.neq('stage',
 * 'lost')` silently drops every contact whose stage was never set. Same for
 * `.eq('do_not_contact', false)` against a NULL. Both columns are nullable
 * (a `default` does not make a column NOT NULL). A filter that loses warm leads
 * without erroring is the exact failure this application exists to prevent, so
 * NULLs are selected in and screened in code, where `screenContact` can decide
 * whether they are a data problem worth an alert.
 *
 * **The grace window.** `next_touch_at` is written at exactly 08:00 local and
 * the cron fires at exactly 08:00 local; a few seconds of timer drift the wrong
 * way would miss the entire day's queue. See `SELECTION_GRACE_MS`.
 *
 * **Contacts with no email address are excluded here, not screened out later,
 * and that is a correctness fix rather than an optimisation.**
 * `screenContact` deliberately leaves such a contact's `next_touch_at` alone —
 * the date is their reminder on `/pipeline` and pushing it out every morning
 * would take the reminder away. The consequence, which was live until this
 * filter existed, is that the row stays due *forever*, and because the ordering
 * is oldest-first it stays at the head of the ordering forever. Sixty NFC-card
 * contacts entered with a name and a phone number — the commonest contact in
 * this pipeline, per `followup-select.ts` — are enough to fill
 * `MAX_CONTACTS_PER_RUN` permanently. From that morning on the query returns
 * only those sixty, every one is screened out, `drafted` is 0 every day, and
 * the whole agent has stopped with nothing but a ceiling log line to say so.
 *
 * Filtering at the database keeps both properties: the date is still untouched,
 * so `/pipeline` still lifts them to the top on the day they are due, and they
 * never consume one of the sixty slots. `screenContact`'s own no-email branch
 * stays where it is — it is the tested assertion, and this filter is a `like`
 * against a text column, which is not the place to be the only guard.
 */
export async function selectDueContacts(db: Db, now: Date): Promise<Contact[]> {
  const dueBy = new Date(now.getTime() + SELECTION_GRACE_MS).toISOString();

  const { data, error } = await db
    .from('contacts')
    .select('*')
    .or('do_not_contact.is.null,do_not_contact.is.false')
    .or('stage.is.null,stage.neq.lost')
    // The same test `hasEmailAddress` applies, expressed in PostgREST. `not
    // is null` and `like '%@%'` between them reject null, the empty string and
    // a phone number typed into the wrong box.
    .not('email', 'is', null)
    .like('email', '%@%')
    .lte('next_touch_at', dueBy)
    .order('next_touch_at', { ascending: true })
    .limit(MAX_CONTACTS_PER_RUN);

  if (error) throw new Error(`Failed to select due contacts: ${error.message}`);
  return data ?? [];
}

/** SPEC §4 step 2: "the whole brain". */
async function loadBrain(db: Db): Promise<Record<string, string>> {
  const { data, error } = await db.from('brain').select('key, value');
  if (error) throw new Error(`Failed to load brain: ${error.message}`);

  const brain: Record<string, string> = {};
  for (const row of data ?? []) brain[row.key] = row.value;
  return brain;
}

/** SPEC §4 step 2: "the last 10 interactions" — see `INTERACTION_HISTORY_LIMIT`. */
async function loadInteractions(db: Db, contactId: string): Promise<Interaction[]> {
  const { data, error } = await db
    .from('interactions')
    .select('*')
    .eq('contact_id', contactId)
    .order('occurred_at', { ascending: false })
    .limit(INTERACTION_HISTORY_LIMIT);

  if (error) throw new Error(`Failed to load interactions: ${error.message}`);
  return data ?? [];
}

/**
 * Contacts who already have an email in flight, so today's run leaves them be.
 *
 * Two filters that used to be here are gone, and each of them was a way to mail
 * the same person twice in one week.
 *
 * **`status` is `pending` OR `approved`, not `pending` alone.** `approveTask`
 * moves the row to `approved` and writes `send_after`, which the send window
 * can put days out — with the seeded `[2,3,4] / 09:00–16:00`, an approval at
 * 16:30 on a Thursday schedules for the following Tuesday. Meanwhile the draft
 * branch of `processContact` already set `next_touch_at` to draft time plus the
 * cadence interval, which can easily be Sunday. On Monday the contact was due,
 * had no *pending* draft, and got a second one written. Both eventually left;
 * the only thing between them was the 48-hour cooldown, which spaces two
 * emails rather than preventing them.
 *
 * **There is no `agent` filter.** An inbox reply waiting for approval is an
 * email to this contact that has not gone out yet, and drafting a cold nudge on
 * top of it is exactly the "somebody we are mid-conversation with" failure
 * `inbox.ts`'s `pushNextTouch` exists to prevent — which it only mitigates,
 * with a three-day floor, so a reply card left unapproved for four days used to
 * produce precisely that.
 *
 * `sent`, `rejected` and `skipped` are all resolved and none of them holds a
 * contact back: the message either left (and the cooldown and `last_touch_at`
 * take over) or the operator decided against it.
 */
export async function loadContactsWithOpenDraft(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const { data, error } = await db
    .from('tasks')
    .select('contact_id')
    .eq('type', 'draft_email')
    .in('status', ['pending', 'approved'])
    .in('contact_id', ids);

  if (error) throw new Error(`Failed to check the pending queue: ${error.message}`);

  const queued = new Set<string>();
  for (const row of data ?? []) {
    if (row.contact_id !== null) queued.add(row.contact_id);
  }
  return queued;
}

// ---------------------------------------------------------------------------
// One contact
// ---------------------------------------------------------------------------

type ContactOutcome =
  | { kind: 'drafted'; taskId: string | null; cadenceReason: string; confidence: string }
  | { kind: 'skipped'; reason: string };

type ProcessArgs = {
  db: Db;
  contact: Contact;
  now: Date;
  timeZone: string;
  trigger: Trigger;
  brain: Record<string, string>;
  /** Per-language, cached for the run, never fatal. See the header. */
  styleExamplesFor: (language: Language) => Promise<StyleExample[]>;
  autonomyLevel: number;
  alreadyQueued: boolean;
  onCacheIssue: (issue: string) => void;
};

async function processContact(args: ProcessArgs): Promise<ContactOutcome> {
  const { db, contact, now, timeZone } = args;

  // ---- Screen -------------------------------------------------------------
  const screen = screenContact(contact, now);
  if (!screen.due) {
    if (screen.action === 'clear_next_touch') {
      const { error } = await db
        .from('contacts')
        .update({ next_touch_at: null })
        .eq('id', contact.id);
      if (error) throw new Error(`Failed to clear next_touch_at: ${error.message}`);
    }
    if (screen.action === 'alert') {
      await fileAlert(
        db,
        contact.id,
        `Follow-up skipped ${contactLabel(contact)}`,
        `${screen.reason}. Fix the row in /pipeline and the agent will pick them up again.`,
        args.autonomyLevel,
      );
    }
    return { kind: 'skipped', reason: screen.reason };
  }

  if (args.alreadyQueued) {
    // Left due on purpose: the moment the card is resolved — sent, rejected or
    // skipped — the contact is eligible again on the next run.
    return { kind: 'skipped', reason: 'an email to this contact is already in the queue' };
  }

  // `screenContact` has already rejected a null stage; this narrows it for the
  // compiler and turns an impossible state into a caught error rather than a
  // cast.
  const stage: Stage | null = contact.stage;
  if (stage === null) throw new Error('stage was null after screening');

  // ---- Cadence ------------------------------------------------------------
  const interactions = await loadInteractions(db, contact.id);

  // PLAN §6 step 5, constraint 2: derived, never `contacts.touch_count` raw.
  const touch = deriveStageTouchCount({ contact, interactions });

  const cadence: CadenceResult = nextTouch({
    stage,
    touchCount: touch.touchCount,
    source: contact.source,
    tags: contact.tags,
  });

  if (cadence.kind === 'stop') {
    return await applyStop(args, cadence);
  }

  if (cadence.kind === 'dormant') {
    // Decision 4 in the header: no model call. The rules already say what
    // happens next, and it is not another email.
    const plan = planNextTouch(cadence, now, timeZone);
    const { error } = await db
      .from('contacts')
      .update({ stage: 'dormant', next_touch_at: plan.at?.toISOString() ?? null })
      .eq('id', contact.id);
    if (error) throw new Error(`Failed to mark the contact dormant: ${error.message}`);
    return { kind: 'skipped', reason: `${cadence.reason} ${touch.explanation}` };
  }

  // ---- Ask the model ------------------------------------------------------
  // The same slice goes to both calls on purpose: `promptLanguage` reads the
  // contact's own messages, so a different window could decide a different
  // language from the one the prompt then writes in, and the examples would be
  // filtered away again.
  const promptInteractions = interactions.slice(0, PROMPT_INTERACTION_LIMIT);

  const prompt = buildFollowupPrompt({
    brain: args.brain,
    contact,
    interactions: promptInteractions,
    styleExamples: await args.styleExamplesFor(promptLanguage(contact, promptInteractions)),
  });

  const cacheIssue = cacheBreakpointIssue(prompt.system);
  if (cacheIssue !== null) args.onCacheIssue(cacheIssue);

  const raw = await call<unknown>({
    agent: AGENT,
    trigger: args.trigger,
    model: 'claude-sonnet-5',
    system: prompt.system,
    user: prompt.user,
    schema: prompt.schema,
    contactId: contact.id,
  });

  const parsed = parseDraft(raw);
  if (!parsed.ok) {
    // Thrown rather than returned: this is a failure, it belongs in `failed`,
    // and the per-contact catch files the alert. `call()` has already logged the
    // output to `agent_runs`, so the offending JSON is recoverable.
    throw new Error(`Model output unusable: ${parsed.problem}`);
  }
  const draft = parsed.draft;

  // ---- SPEC §4 step 4 — nothing genuine to say ----------------------------
  if (!draft.should_contact) {
    const plan = planPushOut(cadence, draft.suggested_next_touch_days, now, timeZone);
    const { error } = await db
      .from('contacts')
      .update({ next_touch_at: plan.at?.toISOString() ?? null })
      .eq('id', contact.id);
    if (error) throw new Error(`Failed to push next_touch_at out: ${error.message}`);

    // "log it. No task created." — the reason is already on the `agent_runs`
    // row written by `call()`; this line is what makes it greppable in the
    // worker's output on the morning it happened.
    return { kind: 'skipped', reason: `${draft.reason} ${plan.reason}` };
  }

  // ---- SPEC §4 step 5 — a pending task ------------------------------------
  const lengthNote = draftLengthNote(draft.body);
  const reasoning = [draft.reason, cadence.reason, touch.explanation, lengthNote]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ');

  const task: TaskInsert = {
    agent: AGENT,
    type: 'draft_email',
    contact_id: contact.id,
    title: `Follow up: ${contactLabel(contact)}`,
    reasoning,
    draft_subject: draft.subject,
    draft_body: draft.body,
    status: 'pending',
    autonomy_level: args.autonomyLevel,
  };

  const { data: inserted, error: insertError } = await db
    .from('tasks')
    .insert(task)
    .select('id')
    .maybeSingle();
  if (insertError) throw new Error(`Failed to create the task: ${insertError.message}`);

  // Decision 2 in the header: the date moves for a draft as well as a skip, so a
  // card left unapproved does not breed duplicates of itself every morning.
  const plan = planNextTouch(cadence, now, timeZone);
  const { error: dateError } = await db
    .from('contacts')
    .update({ next_touch_at: plan.at?.toISOString() ?? null })
    .eq('id', contact.id);
  if (dateError) throw new Error(`Failed to reschedule next_touch_at: ${dateError.message}`);

  return {
    kind: 'drafted',
    taskId: inserted?.id ?? null,
    cadenceReason: cadence.reason,
    confidence: draft.confidence,
  };
}

/**
 * `nextTouch` returned `stop`: `lost`, a suppression tag, or a stage no rule
 * covers.
 *
 * A suppression tag is promoted to `contacts.do_not_contact`, on the explicit
 * instruction in `cadence.ts`'s `SUPPRESSION_TAGS`. Until it is, the tag means
 * something only inside that one function — every other path in the system (a
 * manual send from `/pipeline`, a CSV export, step 6's send queue) goes on
 * believing the contact can be emailed. `do_not_contact` is permanent and is
 * never cleared by an agent, only set.
 */
async function applyStop(args: ProcessArgs, cadence: CadenceResult): Promise<ContactOutcome> {
  const { db, contact } = args;
  const suppression = findSuppressionTag(contact.tags);

  if (suppression !== null) {
    const { error } = await db
      .from('contacts')
      .update({ do_not_contact: true, next_touch_at: null })
      .eq('id', contact.id);
    if (error) throw new Error(`Failed to record do_not_contact: ${error.message}`);
    log('promoted a suppression tag to do_not_contact', {
      contact_id: contact.id,
      tag: suppression,
    });
    return { kind: 'skipped', reason: cadence.reason };
  }

  const { error } = await db
    .from('contacts')
    .update({ next_touch_at: null })
    .eq('id', contact.id);
  if (error) throw new Error(`Failed to clear next_touch_at: ${error.message}`);

  // `lost` is expected and quiet. Anything else is a stage the rules do not
  // cover, which is a data problem the operator should see rather than a
  // contact that silently stops being scheduled.
  if (contact.stage !== 'lost') {
    await fileAlert(
      db,
      contact.id,
      `Follow-up stopped for ${contactLabel(contact)}`,
      `${cadence.reason} Their follow-up date has been cleared; set one in /pipeline once the row is fixed.`,
      args.autonomyLevel,
    );
  }

  return { kind: 'skipped', reason: cadence.reason };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contactLabel(contact: Pick<Contact, 'name' | 'business' | 'email' | 'id'>): string {
  return contact.name ?? contact.business ?? contact.email ?? contact.id;
}

/**
 * SPEC §8: "If an agent run errors … it never silently swallows the failure."
 *
 * Best-effort by construction. If the database is the thing that is broken, the
 * alert insert fails too, and throwing from the error handler would take down
 * the rest of the run — which is the failure this whole per-contact structure
 * exists to prevent. The console line is the fallback record.
 */
async function fileAlert(
  db: Db,
  contactId: string | null,
  title: string,
  reasoning: string,
  autonomyLevel: number,
): Promise<void> {
  try {
    await db.from('tasks').insert({
      agent: AGENT,
      type: 'alert',
      contact_id: contactId,
      title,
      reasoning,
      status: 'pending',
      autonomy_level: autonomyLevel,
    });
  } catch (error) {
    log('failed to file an alert task', {
      contact_id: contactId,
      title,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
