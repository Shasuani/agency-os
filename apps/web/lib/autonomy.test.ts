/**
 * Tests for the autonomy promotion prompt (SPEC §7).
 *
 * The prompt is the visible half of the one rule v1 will not bend: nothing
 * leaves this system to a third party above level 1. It cannot promote anything
 * — no code path raises a level — so the mistake available here is the quieter
 * one: telling the operator that twenty drafts went out untouched when they did
 * not. That sentence is an argument for trusting the machine more, and it has to
 * be earned exactly.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROMOTION_LOOKBACK,
  PROMOTION_THRESHOLD,
  readyForPromotion,
  unEditedStreaks,
  type ApprovalRecord,
} from './autonomy';

const DRAFT = 'Καλημέρα,\n\nΜια σύντομη υπενθύμιση.';

function unedited(type = 'draft_email'): ApprovalRecord {
  return { type, draftBody: DRAFT, finalBody: DRAFT };
}

function edited(type = 'draft_email'): ApprovalRecord {
  return { type, draftBody: DRAFT, finalBody: `${DRAFT} Και κάτι ακόμη.` };
}

test('SPEC §7 fixes the threshold at twenty', () => {
  assert.equal(PROMOTION_THRESHOLD, 20);
});

test('counts consecutive unedited sends of a type', () => {
  const rows = [unedited(), unedited(), unedited()];
  assert.deepEqual(unEditedStreaks(rows), { draft_email: 3 });
});

test('an edit resets the streak, and only the rows newer than it count', () => {
  // The operator rewriting a draft is them saying the machine got it wrong. A
  // running total would call nineteen rewrites and twenty clean ones evidence
  // of trust.
  const rows = [unedited(), unedited(), edited(), unedited(), unedited(), unedited()];
  assert.deepEqual(unEditedStreaks(rows), { draft_email: 2 });
});

test('keeps types apart, and one type’s edit does not break another’s streak', () => {
  const rows = [unedited('draft_email'), edited('reminder'), unedited('draft_email')];
  assert.deepEqual(unEditedStreaks(rows), { draft_email: 2 });
});

test('a row with no final_body is not counted as unedited', () => {
  // `approveTask` always writes `final_body`, copying the draft through byte for
  // byte when nothing changed. A null one came from somewhere else and says
  // nothing about whether the operator agreed with the draft.
  const rows: ApprovalRecord[] = [
    { type: 'draft_email', draftBody: DRAFT, finalBody: null },
    unedited(),
  ];
  assert.deepEqual(unEditedStreaks(rows), {});
});

test('ignores a row with no type rather than inventing a bucket for it', () => {
  const rows: ApprovalRecord[] = [
    { type: null, draftBody: DRAFT, finalBody: DRAFT },
    unedited(),
  ];
  assert.deepEqual(unEditedStreaks(rows), { draft_email: 1 });
});

test('whitespace-only differences are not edits', () => {
  // The same normalisation the approve action applies. Without it a textarea
  // returning CRLF on Windows would break the streak on every single approval
  // and the prompt would never appear at all.
  const rows: ApprovalRecord[] = [
    { type: 'draft_email', draftBody: 'Καλημέρα,\n\nΝαι.', finalBody: 'Καλημέρα,\r\n\r\nΝαι.  ' },
  ];
  assert.deepEqual(unEditedStreaks(rows), { draft_email: 1 });
});

test('the prompt appears at twenty and not at nineteen', () => {
  assert.equal(readyForPromotion(PROMOTION_THRESHOLD - 1), false);
  assert.equal(readyForPromotion(PROMOTION_THRESHOLD), true);
  assert.equal(readyForPromotion(PROMOTION_THRESHOLD + 40), true);
});

test('an empty history offers nothing', () => {
  assert.deepEqual(unEditedStreaks([]), {});
  assert.equal(readyForPromotion(0), false);
});

test('the lookback is wide enough to reach the threshold', () => {
  // A ceiling below the threshold would make the prompt unreachable, which is a
  // silent way to not build a feature.
  assert.ok(PROMOTION_LOOKBACK > PROMOTION_THRESHOLD);
});
