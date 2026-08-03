/**
 * Tests for the inbound vocabulary — the parts of it that are decisions rather
 * than lists, plus the one list that has no compiler holding it honest.
 *
 * That list is `INBOUND_CLASSES`. Everywhere else in this app a vocabulary is
 * pinned by the type system: `CONTACT_STAGES` carries `satisfies readonly
 * Stage[]` against a union in @agency/core that mirrors a CHECK constraint, so a
 * runtime assertion about it would only restate something `tsc` already refuses
 * to let be false. The inbound classes have no such union — they live in
 * apps/worker, which apps/web cannot import — so the assertion below transcribes
 * SPEC §5's own line and compares against it. That is what turns "the two copies
 * drifted" from a silent wrong caption into a failing test.
 *
 * The rest of the file is about the two states this screen has to keep apart and
 * the caps that stop customer text reaching a place it should not.
 *
 * No network, no database, no key. `./inbox.ts` is deliberately not imported: it
 * reaches `next/headers` through `requireOperator`, which cannot be loaded under
 * `node --test`, which is exactly why everything worth testing lives here.
 *
 * Run: `pnpm --filter @agency/web test`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIDENCE_LABELS,
  CONFIDENCE_TONE,
  DEFAULT_INBOX_DAYS,
  INBOUND_CLASSES,
  INBOUND_CLASS_LABELS,
  INBOUND_CLASS_OUTCOME,
  classOutcome,
  INBOUND_CLASS_TONE,
  INBOX_CLASS_FILTER_OPTIONS,
  MAX_INBOX_DAYS,
  MAX_SNIPPET_CHARS,
  SILENT_CLASSES,
  draftState,
  inboxHref,
  isSilentClass,
  outcomeLine,
  readInboundMeta,
  toInboxClassFilter,
  toInboxDays,
  toSnippet,
} from './inbox-vocab';

// ---------------------------------------------------------------------------
// The nine classes, against the spec
// ---------------------------------------------------------------------------

/** SPEC §5, transcribed: "one of: new_lead | interested | question | objection |
 *  not_interested | scheduling | invoice | spam | not_business". */
const SPEC_CLASSES = [
  'new_lead',
  'interested',
  'question',
  'objection',
  'not_interested',
  'scheduling',
  'invoice',
  'spam',
  'not_business',
];

test('the class list is SPEC §5s list, in order', () => {
  // Order matters as well as membership: it is the order of the filter dropdown,
  // and it is the order the worker's JSON-schema enum is written in.
  assert.deepEqual([...INBOUND_CLASSES], SPEC_CLASSES);
});

test('every class has a label, a chip tone and an outcome', () => {
  // The failure this catches: the worker gains a tenth class, somebody adds it
  // to INBOUND_CLASSES here so the filter works, and forgets the caption — so
  // the page renders a chip with no text and says nothing about what happened.
  for (const cls of INBOUND_CLASSES) {
    assert.equal(typeof INBOUND_CLASS_LABELS[cls], 'string');
    assert.notEqual(INBOUND_CLASS_LABELS[cls], '');
    assert.notEqual(INBOUND_CLASS_TONE[cls], undefined);
    assert.ok(INBOUND_CLASS_OUTCOME[cls].segments.length > 0);
    assert.ok(INBOUND_CLASS_OUTCOME[cls].detail.length > 20);
  }
});

test('no chip uses the accent colour', () => {
  // DESIGN.md §2: accent means "you can interact with this", never a category.
  // A class chip that borrowed it would say the row is clickable, which it is
  // not, and would compete with the two links that are.
  for (const cls of INBOUND_CLASSES) {
    assert.ok(
      !INBOUND_CLASS_TONE[cls].includes('accent'),
      `${cls} uses accent as a data colour`,
    );
  }
});

// ---------------------------------------------------------------------------
// The routing table, restated
// ---------------------------------------------------------------------------

test('the silent classes are exactly the three that produce no task', () => {
  // SPEC §5: not_interested closes the contact, spam and not_business are
  // logged only. These three are the entire reason this page reads
  // `interactions` and not `tasks`.
  assert.deepEqual([...SILENT_CLASSES], ['not_interested', 'spam', 'not_business']);
});

test('each silent class says out loud that nothing was drafted and nobody was told', () => {
  for (const cls of SILENT_CLASSES) {
    const line = outcomeLine(cls);
    assert.match(line, /No reply drafted/);
    assert.match(line, /not notified/i);
  }
});

test('not_interested says what it did to the contact, because nothing else does', () => {
  const outcome = INBOUND_CLASS_OUTCOME.not_interested;
  assert.match(outcome.segments.join(' '), /lost/);
  assert.match(outcome.segments.join(' '), /do-not-contact/);
  // And the detail has to tell the operator how to undo it: this row is the only
  // place in the app that records the contact was closed.
  assert.match(outcome.detail, /Pipeline/);
});

test('the six non-silent classes all say a reply was drafted', () => {
  for (const cls of INBOUND_CLASSES) {
    if (isSilentClass(cls)) continue;
    assert.match(outcomeLine(cls), /^Reply drafted/, cls);
  }
});

test('only new_lead and interested claim an immediate notification', () => {
  const immediate = INBOUND_CLASSES.filter((cls) =>
    outcomeLine(cls).includes('notified straight away'),
  );
  assert.deepEqual(immediate, ['new_lead', 'interested']);
});

test('new_lead and invoice do not claim a stage change', () => {
  // Both are deliberate: a new lead was created as `new` by the sender match and
  // nobody wrote to them, and an invoice question comes from a client, for whom
  // `replied` would be a demotion.
  assert.ok(!outcomeLine('new_lead').includes('Stage'));
  assert.ok(!outcomeLine('invoice').includes('Stage'));
});

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

test('only low confidence is given a hue', () => {
  // A permanent green beside every ordinary row trains the eye to stop reading
  // the column, which is the failure that would make it useless on the one row
  // that needs it — the same argument the nav's kill-switch indicator makes.
  assert.equal(CONFIDENCE_TONE.low, 'text-warning');
  assert.equal(CONFIDENCE_TONE.medium, 'text-faint');
  assert.equal(CONFIDENCE_TONE.high, 'text-faint');
  assert.equal(CONFIDENCE_LABELS.low, 'low confidence');
});

// ---------------------------------------------------------------------------
// interactions.meta
// ---------------------------------------------------------------------------

test('meta that is not an object reads as entirely absent', () => {
  // `meta` is jsonb and will happily hold any of these. A page that throws on
  // one bad row shows nothing for the other ninety-nine.
  for (const value of [null, undefined, 'spam', 42, true, ['spam'], []]) {
    const meta = readInboundMeta(value);
    assert.equal(meta.class, null);
    assert.equal(meta.unknownClass, null);
    assert.equal(meta.confidence, null);
    assert.equal(meta.reason, null);
    assert.equal(meta.taskId, null);
  }
});

test('the claim-insert shape reads as claimed but unclassified', () => {
  // This is the row the inbox agent writes BEFORE it classifies — the row is the
  // duplicate-suppression lock. A worker that died between the two writes leaves
  // exactly this behind, and it is the only way that state is ever visible.
  const meta = readInboundMeta({
    gmail_message_id: '18f2c',
    gmail_thread_id: '18f2b',
    rfc_message_id: '<CA+@mail.gmail.com>',
    class: null,
    confidence: null,
    reason: null,
    task_id: null,
    classified_at: null,
  });

  assert.equal(meta.class, null);
  assert.equal(meta.unknownClass, null);
  assert.equal(meta.taskId, null);
  assert.equal(meta.gmailThreadId, '18f2b');
});

test('a classified row reads back every field', () => {
  const meta = readInboundMeta({
    gmail_message_id: '18f2c',
    gmail_thread_id: '18f2b',
    class: 'objection',
    confidence: 'low',
    reason: 'They said the quote was over budget.',
    task_id: '0f9d1a2b-0000-4000-8000-000000000000',
    classified_at: '2026-08-03T09:14:00.000Z',
  });

  assert.equal(meta.class, 'objection');
  assert.equal(meta.confidence, 'low');
  assert.equal(meta.reason, 'They said the quote was over budget.');
  assert.equal(meta.taskId, '0f9d1a2b-0000-4000-8000-000000000000');
});

test('a class this build does not know is kept apart from no class at all', () => {
  // The two look identical on screen if they are folded together, and they mean
  // opposite things: one is a worker that stopped mid-message, the other is a
  // worker running ahead of the web app. Hiding a deploy skew behind something
  // that looks like a crash sends the operator after the wrong problem.
  const drifted = readInboundMeta({ class: 'needs_quote', confidence: 'high' });
  assert.equal(drifted.class, null);
  assert.equal(drifted.unknownClass, 'needs_quote');

  const stopped = readInboundMeta({ class: null });
  assert.equal(stopped.class, null);
  assert.equal(stopped.unknownClass, null);
});

test('an unknown class is capped before it is rendered', () => {
  // It ends up inside a chip. A thousand-character string in `meta` must not
  // become a thousand-character chip.
  const meta = readInboundMeta({ class: 'x'.repeat(500) });
  assert.equal(meta.unknownClass?.length, 40);
});

test('blank strings and wrong types in meta read as absent', () => {
  const meta = readInboundMeta({
    class: '   ',
    confidence: 'certain',
    reason: '   ',
    task_id: 12345,
    gmail_thread_id: null,
  });

  assert.equal(meta.class, null);
  assert.equal(meta.unknownClass, null);
  assert.equal(meta.confidence, null);
  assert.equal(meta.reason, null);
  assert.equal(meta.taskId, null);
  assert.equal(meta.gmailThreadId, null);
});

// ---------------------------------------------------------------------------
// What became of the draft
// ---------------------------------------------------------------------------

test('the silent classes and the unclassified row have no draft line', () => {
  for (const cls of SILENT_CLASSES) {
    assert.equal(draftState(cls, null, null), null);
  }
  assert.equal(draftState(null, null, null), null);
});

test('a drafting class with no task is a warning, not a shrug', () => {
  // Classified, then no draft filed: a Sonnet call that failed, a word-limit
  // rejection, a worker that died between the two writes. Today has no card
  // because no task exists, so without this the row would read "Reply drafted"
  // over a reply that does not exist.
  const state = draftState('question', null, null);
  assert.equal(state?.label, 'No draft was filed');
  assert.equal(state?.tone, 'text-warning');
  assert.equal(state?.actionable, false);
});

test('only a pending draft is actionable', () => {
  assert.equal(draftState('question', 't1', 'pending')?.actionable, true);
  for (const status of ['approved', 'sent', 'rejected', 'skipped'] as const) {
    assert.equal(draftState('question', 't1', status)?.actionable, false, status);
  }
});

test('a task id that no longer resolves says so rather than guessing', () => {
  const state = draftState('invoice', 't1', null);
  assert.equal(state?.label, 'Draft no longer on file');
  assert.equal(state?.actionable, false);
});

test('a reply sent under DRY_RUN does not claim it was sent', () => {
  // The most misleading sentence this screen could print. /inbox is the record
  // of a conversation, so a row saying we answered is a row the operator will
  // not answer again.
  const real = draftState('question', 't1', 'sent', false);
  const dry = draftState('question', 't1', 'sent', true);

  assert.equal(real?.label, 'Reply sent');
  assert.equal(real?.tone, 'text-positive');

  assert.notEqual(dry?.label, real?.label);
  assert.match(dry?.label ?? '', /not sent/);
  assert.notEqual(dry?.tone, 'text-positive');
  assert.equal(dry?.actionable, false);
});

test('the dry-run flag changes nothing for any other status', () => {
  for (const status of ['pending', 'approved', 'rejected', 'skipped', null] as const) {
    assert.deepEqual(
      draftState('question', 't1', status, true),
      draftState('question', 't1', status, false),
      String(status),
    );
  }
});

test('omitting the dry-run flag reads as a real send', () => {
  // The parameter defaults, so every existing call site keeps its meaning. If
  // that default ever flipped, the whole screen would start claiming nothing
  // had been sent.
  assert.deepEqual(draftState('question', 't1', 'sent'), draftState('question', 't1', 'sent', false));
});

// ---------------------------------------------------------------------------
// The snippet cap
// ---------------------------------------------------------------------------

test('a snippet is one line', () => {
  const { text } = toSnippet('Γεια σας,\n\n  Θα ήθελα μια προσφορά.\r\n\r\nΜαρία');
  assert.equal(text, 'Γεια σας, Θα ήθελα μια προσφορά. Μαρία');
});

test('a body that is not a string produces an empty snippet, not a crash', () => {
  for (const value of [null, undefined, 42, {}, []]) {
    assert.deepEqual(toSnippet(value), { text: '', truncated: false });
  }
});

test('a long body is cut at a word boundary and marked truncated', () => {
  const body = `${'word '.repeat(200)}end`;
  const { text, truncated } = toSnippet(body);

  assert.equal(truncated, true);
  assert.ok(text.length <= MAX_SNIPPET_CHARS + 1, 'the ellipsis is the only overflow allowed');
  assert.ok(text.endsWith('…'));
  // Cut between words, not through one.
  assert.ok(!text.includes('wor…'));
});

test('a single unbroken token is cut where it falls rather than vanishing', () => {
  // An empty preview would be worse: the operator would not know there was a
  // body at all.
  const { text, truncated } = toSnippet('x'.repeat(500));
  assert.equal(truncated, true);
  assert.equal(text.length, MAX_SNIPPET_CHARS + 1);
});

test('a body exactly at the cap is not truncated', () => {
  const body = 'a'.repeat(MAX_SNIPPET_CHARS);
  assert.deepEqual(toSnippet(body), { text: body, truncated: false });
});

// ---------------------------------------------------------------------------
// The query, which is the whole state of the page
// ---------------------------------------------------------------------------

test('the class filter falls back to all for anything it does not recognise', () => {
  assert.equal(toInboxClassFilter('spam'), 'spam');
  assert.equal(toInboxClassFilter('unclassified'), 'unclassified');
  assert.equal(toInboxClassFilter(undefined), 'all');
  assert.equal(toInboxClassFilter(''), 'all');
  assert.equal(toInboxClassFilter(['spam']), 'all');
  assert.equal(toInboxClassFilter(7), 'all');
  // Plausible but wrong: the label, not the value.
  assert.equal(toInboxClassFilter('New lead'), 'all');
});

test('the filter dropdown offers every class plus the two non-class states', () => {
  assert.equal(INBOX_CLASS_FILTER_OPTIONS.length, INBOUND_CLASSES.length + 2);
  assert.equal(INBOX_CLASS_FILTER_OPTIONS[0]?.value, 'all');
  assert.equal(INBOX_CLASS_FILTER_OPTIONS.at(-1)?.value, 'unclassified');
});

test('the window is clamped rather than trusted', () => {
  assert.equal(toInboxDays('30'), 30);
  assert.equal(toInboxDays(undefined), DEFAULT_INBOX_DAYS);
  assert.equal(toInboxDays('0'), DEFAULT_INBOX_DAYS, 'a zero window is not "no window"');
  assert.equal(toInboxDays('-5'), DEFAULT_INBOX_DAYS);
  assert.equal(toInboxDays('abc'), DEFAULT_INBOX_DAYS);
  assert.equal(toInboxDays('7.5'), DEFAULT_INBOX_DAYS);
  assert.equal(toInboxDays(30), DEFAULT_INBOX_DAYS, 'only strings arrive from a URL');
  // The ceiling is what stops a hand-edited param turning a page render into a
  // scan of the whole table.
  assert.equal(toInboxDays('100000'), MAX_INBOX_DAYS);
});

test('the canonical href omits the defaults', () => {
  // So /inbox and /inbox?class=all&days=14 are one address rather than two links
  // to the same screen.
  assert.equal(inboxHref({}), '/inbox');
  assert.equal(inboxHref({ classFilter: 'all', days: DEFAULT_INBOX_DAYS }), '/inbox');
  assert.equal(inboxHref({ classFilter: 'spam', days: DEFAULT_INBOX_DAYS }), '/inbox?class=spam');
  assert.equal(inboxHref({ classFilter: 'all', days: 90 }), '/inbox?days=90');
  assert.equal(inboxHref({ classFilter: 'unclassified', days: 7 }), '/inbox?class=unclassified&days=7');
});


// ---------------------------------------------------------------------------
// The row must not contradict itself
// ---------------------------------------------------------------------------

test('classOutcome does not claim a reply that was never drafted', () => {
  // The worker's rule is `route.draftReply && !match.optedOut`, and the
  // suppression is deliberate: a contact marked do-not-contact who writes in is
  // still logged and still classified, but never drafted at. Keyed on the class
  // alone, the row rendered `Reply drafted · Stage advanced · Held for the daily
  // digest` next to `No draft was filed` — on one line, on the page whose whole
  // purpose is being the record you can disagree with.
  const suppressed = classOutcome('question', false);
  assert.equal(suppressed.segments[0], 'No reply drafted');
  assert.ok(!suppressed.segments.join(' ').includes('Reply drafted'));
  // The rest of the row is still true: the stage did move, and it is still
  // counted in the digest.
  assert.deepEqual(suppressed.segments.slice(1), INBOUND_CLASS_OUTCOME.question.segments.slice(1));
});

test('classOutcome is unchanged when a reply really was drafted', () => {
  for (const cls of INBOUND_CLASSES) {
    assert.deepEqual(classOutcome(cls, true), INBOUND_CLASS_OUTCOME[cls]);
  }
});

test('classOutcome leaves the silent classes alone', () => {
  // They never draft, so `drafted: false` is their ordinary state and their copy
  // already says so. Rewriting it would produce "No reply drafted · No reply
  // drafted".
  for (const cls of ['not_interested', 'spam', 'not_business'] as const) {
    assert.deepEqual(classOutcome(cls, false), INBOUND_CLASS_OUTCOME[cls]);
  }
});

test('the suppressed detail explains itself without asserting why', () => {
  // A failed `tasks` insert produces the same state as an opt-out, and the row
  // cannot tell them apart. It names the likely reason and admits the other.
  const detail = classOutcome('interested', false).detail;
  assert.ok(detail.includes('do-not-contact'));
  assert.ok(detail.includes('failed task insert') || detail.includes('failed task'));
});
