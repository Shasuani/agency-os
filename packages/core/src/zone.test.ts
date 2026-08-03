/**
 * Tests for `zone.ts` — the timezone arithmetic every scheduled instant in this
 * system is built out of.
 *
 * The reason this file exists at all: the bugs it guards against are all
 * invisible. A one-hour error in `zonedTimeToUtc` does not throw, does not fail
 * a typecheck, and does not look wrong in a database — it just means a message
 * arrives at 08:00 instead of 09:00, or a follow-up scheduled for "tomorrow"
 * misses tomorrow's 08:00 run by sixty minutes and lands a day late. Twice a
 * year, and only in the two weeks around a clock change.
 *
 * Every expected instant below is stated with the offset that produces it, so a
 * failure can be read without a timezone database open in another window:
 *
 *   Europe/Athens   UTC+2 (EET) in winter, UTC+3 (EEST) in summer.
 *                   2026: forward 29 March, back 25 October.
 *   America/New_York UTC-5 (EST) in winter, UTC-4 (EDT) in summer.
 *
 * Nothing here reads the host clock or `TZ`. Every zone is passed explicitly,
 * which is the property that makes the suite give the same answer on a laptop
 * in Athens and in a UTC container on Railway.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dayKeyInZone, isValidTimeZone, partsInZone, zonedTimeToUtc } from './zone';

describe('partsInZone', () => {
  it('reads the local wall clock, not the host clock', () => {
    // 2026-08-04T07:00:00Z. Athens is UTC+3 in August.
    const parts = partsInZone(new Date('2026-08-04T07:00:00Z'), 'Europe/Athens');
    assert.deepEqual(parts, { year: 2026, month: 8, day: 4, hour: 10, minute: 0, second: 0 });
  });

  it('the same instant is a different calendar day in New York', () => {
    // 2026-08-04T02:00:00Z is 22:00 on 3 August in New York (UTC-4 in August).
    const parts = partsInZone(new Date('2026-08-04T02:00:00Z'), 'America/New_York');
    assert.deepEqual(parts, { year: 2026, month: 8, day: 3, hour: 22, minute: 0, second: 0 });
  });

  it('midnight is hour 0, never hour 24', () => {
    // Some ICU versions render midnight as 24 on the *previous* day's date. If
    // that ever happens the day would be wrong too, so both are asserted.
    const parts = partsInZone(new Date('2026-08-03T21:00:00Z'), 'Europe/Athens');
    assert.equal(parts.hour, 0);
    assert.equal(parts.day, 4);
  });
});

describe('zonedTimeToUtc', () => {
  it('Athens 09:00 in August is 06:00Z (UTC+3)', () => {
    assert.equal(
      zonedTimeToUtc(2026, 8, 4, 9, 0, 'Europe/Athens').toISOString(),
      '2026-08-04T06:00:00.000Z',
    );
  });

  it('Athens 09:00 in January is 07:00Z (UTC+2)', () => {
    assert.equal(
      zonedTimeToUtc(2026, 1, 13, 9, 0, 'Europe/Athens').toISOString(),
      '2026-01-13T07:00:00.000Z',
    );
  });

  it('New York 09:00 in August is 13:00Z (UTC-4)', () => {
    assert.equal(
      zonedTimeToUtc(2026, 8, 4, 9, 0, 'America/New_York').toISOString(),
      '2026-08-04T13:00:00.000Z',
    );
  });

  it('New York 09:00 in January is 14:00Z (UTC-5)', () => {
    assert.equal(
      zonedTimeToUtc(2026, 1, 13, 9, 0, 'America/New_York').toISOString(),
      '2026-01-13T14:00:00.000Z',
    );
  });

  it('holds the local hour on both sides of the March change', () => {
    // 29 March 2026 is when Athens goes UTC+2 -> UTC+3. The Tuesday before and
    // the Tuesday after must both be local 09:00, at two different instants.
    // If either drifts, every send scheduled that fortnight is an hour out.
    const before = zonedTimeToUtc(2026, 3, 24, 9, 0, 'Europe/Athens');
    const after = zonedTimeToUtc(2026, 3, 31, 9, 0, 'Europe/Athens');
    assert.equal(before.toISOString(), '2026-03-24T07:00:00.000Z');
    assert.equal(after.toISOString(), '2026-03-31T06:00:00.000Z');
    assert.equal(partsInZone(before, 'Europe/Athens').hour, 9);
    assert.equal(partsInZone(after, 'Europe/Athens').hour, 9);
  });

  it('holds the local hour on both sides of the October change', () => {
    // 25 October 2026 is when Athens goes UTC+3 -> UTC+2.
    const before = zonedTimeToUtc(2026, 10, 20, 9, 0, 'Europe/Athens');
    const after = zonedTimeToUtc(2026, 10, 27, 9, 0, 'Europe/Athens');
    assert.equal(before.toISOString(), '2026-10-20T06:00:00.000Z');
    assert.equal(after.toISOString(), '2026-10-27T07:00:00.000Z');
  });

  it('a local hour that does not exist resolves onto the hour after the jump', () => {
    // Athens skips 03:00-03:59 on 29 March 2026 (01:00Z). 03:00 local is not a
    // real time; the documented answer is 04:00 local, which is 01:00Z.
    // Unreachable from the default 09:00-16:00 window, reachable the moment an
    // operator sets start_hour: 3 in /brain.
    const resolved = zonedTimeToUtc(2026, 3, 29, 3, 0, 'Europe/Athens');
    assert.equal(resolved.toISOString(), '2026-03-29T01:00:00.000Z');
    assert.equal(partsInZone(resolved, 'Europe/Athens').hour, 4);
  });

  it('a local hour that happens twice resolves onto its second occurrence', () => {
    // Athens repeats 03:00-03:59 on 25 October 2026: once at 00:30Z (UTC+3),
    // again at 01:30Z (UTC+2). The two-pass algorithm re-measures the offset at
    // its first guess, by which point the change has already happened, so the
    // later instant wins.
    //
    // The step-6 contract claims the first occurrence. It is wrong about this
    // repo's arithmetic, and the arithmetic is the thing two other modules
    // already share, so the documentation moved rather than the code. Pinned
    // here because it is exactly the sort of behaviour a well-meaning
    // "simplification" of zonedTimeToUtc would flip without noticing.
    assert.equal(
      zonedTimeToUtc(2026, 10, 25, 3, 30, 'Europe/Athens').toISOString(),
      '2026-10-25T01:30:00.000Z',
    );
  });

  it('normalises an out-of-range day, so callers can add days blindly', () => {
    // Date.UTC rolls 31 January + 1 into February. Callers rely on this rather
    // than doing calendar arithmetic themselves.
    assert.equal(
      zonedTimeToUtc(2026, 1, 32, 9, 0, 'Europe/Athens').toISOString(),
      '2026-02-01T07:00:00.000Z',
    );
  });
});

describe('dayKeyInZone', () => {
  it('pads month and day so the strings sort correctly', () => {
    assert.equal(dayKeyInZone(new Date('2026-01-05T12:00:00Z'), 'Europe/Athens'), '2026-01-05');
  });

  it('is the local day, not the UTC day', () => {
    // 21:30Z on 3 August is already 4 August in Athens.
    assert.equal(dayKeyInZone(new Date('2026-08-03T21:30:00Z'), 'Europe/Athens'), '2026-08-04');
    assert.equal(dayKeyInZone(new Date('2026-08-03T21:30:00Z'), 'America/New_York'), '2026-08-03');
  });
});

describe('isValidTimeZone', () => {
  it('accepts real zones, including the ones that are not Area/City', () => {
    assert.equal(isValidTimeZone('Europe/Athens'), true);
    assert.equal(isValidTimeZone('America/New_York'), true);
    assert.equal(isValidTimeZone('UTC'), true);
  });

  it('rejects a plausible-looking string a regex would accept', () => {
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
    assert.equal(isValidTimeZone('Europe/Athina'), false);
  });

  it('rejects absent and empty values, which is what a bad import leaves', () => {
    assert.equal(isValidTimeZone(null), false);
    assert.equal(isValidTimeZone(undefined), false);
    assert.equal(isValidTimeZone(''), false);
    assert.equal(isValidTimeZone('   '), false);
  });
});
