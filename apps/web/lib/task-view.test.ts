/**
 * Tests for the pure half of the Today screen.
 *
 * No network, no database, no key. Every function here is a string or a shape
 * check, which is exactly why they were pulled out of the page and the Server
 * Action in the first place — the body comparison step 9 reads is not testable
 * while it lives inside a component render.
 *
 * The settings shapes this file used to cover moved to ./settings-validation.ts
 * at integration, along with the second copy of them that /brain had grown; the
 * contact-naming rule moved to ./contact-vocab.ts, where /pipeline and the
 * contact page reach it too. Both are tested beside their new homes.
 *
 * Run: `pnpm --filter @agency/web test`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BODY_CHARS,
  SEND_BLOCK_COPY,
  agentLabel,
  blocksApproval,
  bodyChanged,
  DRY_RUN_LABEL,
  TASK_STATUS_LABELS,
  clock,
  countLabel,
  dryRunNote,
  normalizeBody,
  sendBlockNotice,
  sendOutcome,
  validateBody,
} from './task-view';

// ---------------------------------------------------------------------------
// The body comparison step 9 depends on
// ---------------------------------------------------------------------------

test('normalizeBody folds CRLF and trailing whitespace, and nothing else', () => {
  assert.equal(normalizeBody('Γεια σας,\r\n\r\nΤι λέτε;'), 'Γεια σας,\n\nΤι λέτε;');
  assert.equal(normalizeBody('one\ntwo\n\n\n'), 'one\ntwo');
  assert.equal(normalizeBody('trailing spaces   \nand tabs\t\t'), 'trailing spaces\nand tabs');
  // Interior blank lines are the operator's paragraphs. They stay.
  assert.equal(normalizeBody('a\n\n\nb'), 'a\n\n\nb');
  assert.equal(normalizeBody('  leading kept'), '  leading kept');
});

test('bodyChanged ignores line endings and trailing newlines', () => {
  const draft = 'Γεια σας,\n\nΘα ήθελα να επανέλθω.';
  assert.equal(bodyChanged(draft, draft), false);
  assert.equal(bodyChanged(draft, draft.replace(/\n/g, '\r\n')), false);
  assert.equal(bodyChanged(draft, `${draft}\n`), false);
  assert.equal(bodyChanged(draft, `${draft} `), false);
});

test('bodyChanged sees a real edit, including one character', () => {
  const draft = 'Θα ήθελα να επανέλθω.';
  assert.equal(bodyChanged(draft, 'Θα ήθελα να επανέλθω!'), true);
  assert.equal(bodyChanged(draft, `${draft}\n\nΚώστας`), true);
  // A null draft against anything is an edit; a null draft against nothing is
  // not reachable through validateBody, which refuses an empty body first.
  assert.equal(bodyChanged(null, 'anything'), true);
  assert.equal(bodyChanged(null, ''), false);
});

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

test('validateBody refuses an empty or whitespace-only message', () => {
  for (const input of ['', '   ', '\n\n', '\r\n \t']) {
    const result = validateBody(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /empty message cannot be sent/);
  }
});

test('validateBody refuses a non-string and an over-long message', () => {
  assert.equal(validateBody(undefined).ok, false);
  assert.equal(validateBody(42).ok, false);

  const tooLong = 'α'.repeat(MAX_BODY_CHARS + 1);
  const result = validateBody(tooLong);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Something upstream is wrong/);
});

test('validateBody returns the normalized body, not the raw one', () => {
  const result = validateBody('Γεια σας,\r\n\r\nΚώστας\n\n');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, 'Γεια σας,\n\nΚώστας');
});

// ---------------------------------------------------------------------------
// Guardrail copy
// ---------------------------------------------------------------------------

/** The thirteen reasons in the step 6 contract, §1, plus `already_sent` — the
 *  guard added when the per-contact cooldown turned out to be a 48-hour delay on
 *  a duplicate rather than a bar to one. Written out rather than derived, so
 *  removing one from `SendRefusalReason` fails here loudly instead of quietly
 *  dropping a card's explanation. */
const REASONS = [
  'kill_switch',
  'task_not_found',
  'task_wrong_type',
  'task_not_approved',
  'already_sent',
  'no_contact',
  'contact_missing',
  'do_not_contact',
  'suppression_tag',
  'no_email_address',
  'empty_body',
  'autonomy_off',
  'daily_cap',
  'contact_cooldown',
] as const;

test('every refusal reason has card copy', () => {
  assert.deepEqual(Object.keys(SEND_BLOCK_COPY).sort(), [...REASONS].sort());

  for (const reason of REASONS) {
    const notice = SEND_BLOCK_COPY[reason];
    assert.ok(notice.label.length > 0, `${reason} has no label`);
    assert.ok(notice.detail.length > 0, `${reason} has no detail`);
    // The detail is also rendered onto an alert task (PLAN §7). No addresses.
    assert.ok(!notice.detail.includes('@'), `${reason} detail must not carry an address`);
  }
});

test('only the two rate reasons leave the approve button usable', () => {
  const usable = REASONS.filter((reason) => !blocksApproval(reason));
  assert.deepEqual(usable, ['daily_cap', 'contact_cooldown']);
});

test('the kill switch blocks approval even though the queue would keep the task', () => {
  assert.equal(blocksApproval('kill_switch'), true);
});

// ---------------------------------------------------------------------------
// Card text
// ---------------------------------------------------------------------------

test('agentLabel names the agents we have and shows the ones we do not', () => {
  assert.equal(agentLabel('followup'), 'Follow-up');
  assert.equal(agentLabel('inbox'), 'Inbox');
  assert.equal(agentLabel('lead-hunter'), 'lead-hunter');
  assert.equal(agentLabel(null), 'System');
  assert.equal(agentLabel('   '), 'System');
});

test('clock pads both fields', () => {
  assert.equal(clock(8, 2), '08:02');
  assert.equal(clock(0, 0), '00:00');
  assert.equal(clock(16, 45), '16:45');
});

test('countLabel pluralises', () => {
  assert.equal(countLabel(0, 'thing', 'things'), '0 things');
  assert.equal(countLabel(1, 'thing', 'things'), '1 thing');
  assert.equal(countLabel(9, 'thing', 'things'), '9 things');
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------
//
// `DRY_RUN` defaults to true, so on the machine this was built on every send is
// one. These four assertions are the whole guarantee that the word "Sent" on
// the Today screen means a customer actually has the email.

test('a dry-run send does not say "Sent"', () => {
  const outcome = sendOutcome('sent', true);
  assert.equal(outcome.label, DRY_RUN_LABEL);
  assert.notEqual(outcome.label, TASK_STATUS_LABELS.sent);
});

test('a dry-run send does not get the green reserved for a real one', () => {
  assert.equal(sendOutcome('sent', false).tone, 'text-positive');
  assert.notEqual(sendOutcome('sent', true).tone, 'text-positive');
});

test('the flag changes nothing for a status that records no send', () => {
  // Nothing writes an interactions row for these, so the flag can only ever
  // arrive false — but a caller that got it wrong must not be able to relabel
  // the operator's own decision.
  for (const status of ['rejected', 'skipped', 'pending', 'approved'] as const) {
    assert.deepEqual(sendOutcome(status, true), sendOutcome(status, false));
    assert.equal(sendOutcome(status, true).label, TASK_STATUS_LABELS[status]);
  }
});

test('dryRunNote says nothing when there is nothing to say', () => {
  assert.equal(dryRunNote(0), '');
  assert.equal(dryRunNote(-1), '');
  assert.equal(dryRunNote(1), '1 was a dry run — nothing left the machine');
  assert.equal(dryRunNote(3), '3 were dry runs — nothing left the machine');
});


// ---------------------------------------------------------------------------
// The one guard notice whose copy depends on a number
// ---------------------------------------------------------------------------

test('sendBlockNotice keeps the ordinary daily-cap copy for a real cap', () => {
  assert.equal(sendBlockNotice('daily_cap', 10), SEND_BLOCK_COPY.daily_cap);
});

test('sendBlockNotice does not tell the operator to wait for a pause they set', () => {
  // `MIN_DAILY_SEND_CAP` is 0 and `settings-validation.ts` documents 0 as
  // pausing sending without touching the kill switch. The guardrail refuses on
  // `sentInLast24h >= dailySendCap`, so `0 >= 0` refuses immediately — and it
  // did so with the "this waits in the queue" copy, for a condition only a
  // settings edit can clear.
  const notice = sendBlockNotice('daily_cap', 0);
  assert.notEqual(notice.detail, SEND_BLOCK_COPY.daily_cap.detail);
  assert.ok(notice.detail.includes('/brain'));
  // Still `wait`: approving works and the draft stays queued, which is what the
  // tone controls.
  assert.equal(notice.tone, 'wait');
});

test('sendBlockNotice leaves every other reason alone', () => {
  for (const reason of ['kill_switch', 'do_not_contact', 'contact_cooldown'] as const) {
    assert.equal(sendBlockNotice(reason, 0), SEND_BLOCK_COPY[reason]);
  }
});
