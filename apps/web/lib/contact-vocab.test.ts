/**
 * Tests for the vocabulary module — specifically for the part of it that is a
 * decision rather than a list.
 *
 * The lists themselves are already checked by the compiler: every one of them
 * carries `satisfies readonly Stage[]` (or `Source`, or `Language`) against the
 * unions in @agency/core, which are the CHECK constraints in the migration. A
 * runtime test that `CONTACT_STAGES` contains `'quoted'` would assert something
 * `tsc` has already refused to let be false.
 *
 * `contactLine` is different. It decides what the operator reads when the row
 * does not say — and it had been written out three times before it moved here,
 * once per screen, which is the state a rule is in right before two copies stop
 * agreeing.
 *
 * No network, no database, no key.
 *
 * Run: `pnpm --filter @agency/web test`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blankToNull, contactLine } from './contact-vocab';

test('blankToNull treats whitespace and absence the same', () => {
  assert.equal(blankToNull(null), null);
  assert.equal(blankToNull(undefined), null);
  assert.equal(blankToNull(''), null);
  assert.equal(blankToNull('   \t'), null);
  assert.equal(blankToNull('  Μαρία  '), 'Μαρία');
});

test('contactLine puts the name first and the business under it', () => {
  assert.deepEqual(contactLine('Μαρία', 'Kafeneio'), {
    primary: 'Μαρία',
    secondary: 'Kafeneio',
  });
});

test('contactLine promotes the business when there is no name', () => {
  // And does not then repeat it on the second line, which would read as a
  // rendering bug rather than as data.
  assert.deepEqual(contactLine(null, 'Kafeneio'), { primary: 'Kafeneio', secondary: null });
  assert.deepEqual(contactLine('   ', 'Kafeneio'), { primary: 'Kafeneio', secondary: null });
});

test('contactLine always returns something a person can click', () => {
  // A task card's contact line is also its accessible name, and a /pipeline cell
  // with nothing in it is a row that cannot be reached from the keyboard.
  assert.deepEqual(contactLine(null, null), { primary: 'Unnamed contact', secondary: null });
  assert.deepEqual(contactLine('  ', '  '), { primary: 'Unnamed contact', secondary: null });
});
