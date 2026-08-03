/**
 * Tests for `send-window.ts` — PLAN §7.1, "the next slot inside the recipient's
 * local business hours, plus 2–15 minutes of jitter".
 *
 * Jitter is injected as a constant seven minutes throughout, which is the point
 * of `JitterSource` existing: every expectation below is an exact instant. A
 * suite that could only assert "somewhere in the next fifteen minutes" would
 * pass just as happily against a version that got the timezone an hour wrong,
 * and getting the timezone an hour wrong is the entire failure mode this module
 * is here to prevent.
 *
 * Reference facts, so a failure is readable without a calendar:
 *
 *   2026-08-03  Monday      Athens UTC+3 (EEST)   New York UTC-4 (EDT)
 *   2026-08-04  Tuesday     — a window day under the default [2,3,4]
 *   2026-08-05  Wednesday   — a window day
 *   2026-08-06  Thursday    — a window day
 *   2026-08-07  Friday      — not a window day
 *   2026-03-29  Sunday      Athens moves UTC+2 -> UTC+3
 *   2026-10-25  Sunday      Athens moves UTC+3 -> UTC+2
 *
 * The default window is the one seeded in the migration: Tuesday to Thursday,
 * 09:00 to 16:00, in the *recipient's* zone.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SendWindowSetting } from './settings';
import {
  MAX_JITTER_MINUTES,
  MIN_JITTER_MINUTES,
  SendWindowError,
  clampJitterMinutes,
  nextSendSlot,
  windowForAgent,
} from './send-window';
import { partsInZone } from './zone';

/** `settings.send_window`'s seeded default. Tue/Wed/Thu, 09:00–16:00. */
const DEFAULT_WINDOW: SendWindowSetting = { days: [2, 3, 4], start_hour: 9, end_hour: 16 };

/** Seven minutes, every time. See the header. */
const SEVEN = () => 7;

const ATHENS = 'Europe/Athens';
const NEW_YORK = 'America/New_York';

function slot(from: string, timeZone: string | null, window: SendWindowSetting = DEFAULT_WINDOW) {
  return nextSendSlot({
    from: new Date(from),
    timeZone,
    fallbackTimeZone: ATHENS,
    window,
    jitter: SEVEN,
  });
}

describe('inside the window — the Greek case, which is most sends', () => {
  it('a Tuesday 10:00 Athens approval leaves seven minutes later', () => {
    // 2026-08-04T07:00:00Z is Tuesday 10:00 Athens (UTC+3), comfortably inside
    // 09:00-16:00. PLAN §7.1: "almost always in the next few minutes".
    const result = slot('2026-08-04T07:00:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-08-04T07:07:00.000Z');
    assert.equal(result.immediate, true);
    assert.equal(result.jitterMinutes, 7);
    assert.equal(result.timeZone, ATHENS);
    assert.equal(result.timeZoneFallback, false);
    assert.equal(result.reason, 'Sends in about 7 minutes.');
  });

  it('an approval one minute after the window opens is still immediate', () => {
    // 06:01Z is 09:01 Athens.
    const result = slot('2026-08-04T06:01:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-08-04T06:08:00.000Z');
    assert.equal(result.immediate, true);
  });

  it('an approval exactly at the opening hour waits for the window, not for itself', () => {
    // `from > start` is strict, so 09:00:00 on the dot anchors on the window
    // start rather than on the approval. The two instants are identical here, so
    // the only visible difference is `immediate` and the sentence on the card —
    // and "Sends today from 09:00" is the honest one at 09:00:00.
    const result = slot('2026-08-04T06:00:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-08-04T06:07:00.000Z');
    assert.equal(result.immediate, false);
    assert.equal(result.reason, 'Sends today from 09:00.');
  });
});

describe('outside the window', () => {
  it('an early-morning approval waits for the window to open the same day', () => {
    // 2026-08-04T04:00:00Z is Tuesday 07:00 Athens. The window opens at 09:00,
    // which is 06:00Z; plus seven minutes.
    const result = slot('2026-08-04T04:00:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-08-04T06:07:00.000Z');
    assert.equal(result.immediate, false);
    assert.equal(result.reason, 'Sends today from 09:00.');
  });

  it('an evening approval on a window day rolls to the next window day', () => {
    // Tuesday 20:00 Athens (17:00Z) is past the 16:00 close, so Wednesday.
    const result = slot('2026-08-04T17:00:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-08-05T06:07:00.000Z');
    assert.equal(result.reason, 'Sends Wednesday from 09:00.');
  });

  it('a Friday 17:00 approval lands on the following Tuesday', () => {
    // This is the one the operator will notice. 2026-08-07T14:00:00Z is Friday
    // 17:00 Athens; the default window is Tue-Thu, so the next slot is Tuesday
    // the 11th at 09:07 Athens = 06:07Z. Four days of waiting, and it is the
    // specified behaviour rather than a bug — see the module header.
    const result = slot('2026-08-07T14:00:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-08-11T06:07:00.000Z');
    assert.equal(result.immediate, false);
    assert.equal(result.reason, 'Sends Tuesday from 09:00.');
  });

  it('a Monday approval waits for Tuesday under the seeded default', () => {
    // Stated explicitly because it is the behaviour most likely to be reported
    // as a bug and "fixed" by widening the default window. 2026-08-03 is Monday.
    const result = slot('2026-08-03T09:00:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-08-04T06:07:00.000Z');
    assert.equal(result.reason, 'Sends Tuesday from 09:00.');
  });
});

describe('the jitter must not leak past the close', () => {
  it('15:58 on a Wednesday becomes Thursday 09:07, not Wednesday 16:05', () => {
    // 2026-08-05T12:58:00Z is Wednesday 15:58 Athens. Seven minutes of jitter
    // would put it at 16:05 local, past the 16:00 close. The window is only
    // meaningful if nothing lands outside it, so the slot rolls forward.
    const result = slot('2026-08-05T12:58:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-08-06T06:07:00.000Z');
    assert.equal(result.immediate, false);
    assert.equal(result.reason, 'Sends Thursday from 09:00.');
  });

  it('a slot landing exactly on the close is rejected, since end_hour is exclusive', () => {
    // 12:53Z is 15:53 Athens; +7 is exactly 16:00, which `settings.ts` documents
    // as exclusive. One second earlier would be fine, so this is the boundary.
    const result = slot('2026-08-05T12:53:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-08-06T06:07:00.000Z');
  });

  it('one minute earlier still goes out the same afternoon', () => {
    // 12:52Z + 7 = 12:59Z = 15:59 Athens, inside the window by one minute.
    const result = slot('2026-08-05T12:52:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-08-05T12:59:00.000Z');
    assert.equal(result.immediate, true);
  });
});

describe('the recipient s timezone is the one that counts', () => {
  it('a New York contact gets 09:00 in New York, not 09:00 in Athens', () => {
    // The reason this feature exists (PLAN §7.1: "a message arriving at 03:00
    // local reads as a machine"). The operator approves at 10:00 Athens on a
    // Tuesday, which is 03:00 in New York. The message waits six hours.
    const result = slot('2026-08-04T07:00:00Z', NEW_YORK);
    assert.equal(result.sendAfter.toISOString(), '2026-08-04T13:07:00.000Z');
    assert.equal(result.timeZone, NEW_YORK);
    assert.equal(result.immediate, false);

    // Stated as the local wall clock as well, because the ISO string above is
    // only obviously correct to someone holding the offset in their head.
    const local = partsInZone(result.sendAfter, NEW_YORK);
    assert.equal(local.hour, 9);
    assert.equal(local.minute, 7);
  });

  it('the same instant and the same window give a different answer per contact', () => {
    // Same approval, two contacts. If these two ever agree, the timezone is
    // being ignored somewhere.
    const athens = slot('2026-08-04T07:00:00Z', ATHENS);
    const newYork = slot('2026-08-04T07:00:00Z', NEW_YORK);
    assert.notEqual(athens.sendAfter.toISOString(), newYork.sendAfter.toISOString());
    assert.equal(athens.immediate, true);
    assert.equal(newYork.immediate, false);
  });

  it('a late-evening New York approval uses the New York calendar day', () => {
    // 2026-08-05T02:00:00Z is Tuesday 05:00 in Athens but still Tuesday 22:00 in
    // New York. The window there closed four hours ago, so the slot is
    // Wednesday 09:07 New York = 13:07Z. Taking the calendar day from the
    // wrong zone would put it on Tuesday and send it into the past.
    const result = slot('2026-08-05T02:00:00Z', NEW_YORK);
    assert.equal(result.sendAfter.toISOString(), '2026-08-05T13:07:00.000Z');
    assert.equal(result.reason, 'Sends Wednesday from 09:00.');
  });
});

describe('daylight saving', () => {
  it('crossing the March change forward still lands on local 09:07', () => {
    // Approved Friday 27 March 2026 at 17:00 Athens (UTC+2, so 15:00Z). The next
    // window day is Tuesday the 31st, by which point Athens is UTC+3. Naive
    // millisecond arithmetic on the approval instant would land at 10:07 local.
    const result = slot('2026-03-27T15:00:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-03-31T06:07:00.000Z');
    const local = partsInZone(result.sendAfter, ATHENS);
    assert.equal(local.hour, 9);
    assert.equal(local.minute, 7);
  });

  it('crossing the October change back still lands on local 09:07', () => {
    // Approved Friday 23 October 2026 at 17:00 Athens (UTC+3, so 14:00Z). The
    // next window day is Tuesday the 27th, by which point Athens is UTC+2.
    const result = slot('2026-10-23T14:00:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2026-10-27T07:07:00.000Z');
    const local = partsInZone(result.sendAfter, ATHENS);
    assert.equal(local.hour, 9);
    assert.equal(local.minute, 7);
  });

  it('the Tuesday before and the Tuesday after are an hour apart in UTC', () => {
    // The same local slot, two different instants. This is the assertion that
    // fails if anyone replaces zonedTimeToUtc with a fixed offset.
    const before = slot('2026-03-24T04:00:00Z', ATHENS);
    const after = slot('2026-03-31T04:00:00Z', ATHENS);
    assert.equal(before.sendAfter.toISOString(), '2026-03-24T07:07:00.000Z');
    assert.equal(after.sendAfter.toISOString(), '2026-03-31T06:07:00.000Z');
  });

  it('a New York contact and an Athens contact change clocks on different dates', () => {
    // The US moves on 8 March 2026 and the EU on 29 March. For three weeks the
    // gap between the two zones is six hours instead of the usual seven, and
    // any code carrying a hard-coded offset is wrong for exactly those weeks.
    // 2026-03-17 is a Tuesday.
    const result = slot('2026-03-17T05:00:00Z', NEW_YORK);
    const local = partsInZone(result.sendAfter, NEW_YORK);
    assert.equal(local.hour, 9);
    assert.equal(local.minute, 7);
    assert.equal(result.sendAfter.toISOString(), '2026-03-17T13:07:00.000Z');
  });
});

describe('an unusable contacts.timezone falls back rather than refusing', () => {
  it('a string Intl rejects uses the operator timezone and flags it', () => {
    // A botched import is not a reason to deny somebody their follow-up. The
    // flag comes back so the caller can log it against a contact id — never the
    // offending string, which arrived with customer data.
    const result = slot('2026-08-04T07:00:00Z', 'Mars/Olympus');
    assert.equal(result.timeZone, ATHENS);
    assert.equal(result.timeZoneFallback, true);
    assert.equal(result.sendAfter.toISOString(), '2026-08-04T07:07:00.000Z');
  });

  it('null and empty behave the same way, and do not throw', () => {
    for (const value of [null, '', '   ']) {
      const result = slot('2026-08-04T07:00:00Z', value);
      assert.equal(result.timeZone, ATHENS);
      assert.equal(result.timeZoneFallback, true);
      assert.equal(result.sendAfter.toISOString(), '2026-08-04T07:07:00.000Z');
    }
  });

  it('a valid zone with stray whitespace is used, not thrown away', () => {
    const result = slot('2026-08-04T07:00:00Z', '  Europe/Athens  ');
    assert.equal(result.timeZone, ATHENS);
    assert.equal(result.timeZoneFallback, false);
  });
});

describe('a window that can never produce a slot fails closed', () => {
  it('days: [] throws SendWindowError rather than sending now', () => {
    // `settings.ts`'s validator accepts an empty array today. Without this
    // guard the loop either spins or falls through to "send immediately", which
    // at 03:00 local is the exact outcome the window exists to prevent.
    assert.throws(
      () => slot('2026-08-04T07:00:00Z', ATHENS, { days: [], start_hour: 9, end_hour: 16 }),
      (error: unknown) => {
        assert.ok(error instanceof SendWindowError);
        assert.equal(error.name, 'SendWindowError');
        assert.deepEqual(error.window.days, []);
        assert.equal(error.timeZone, ATHENS);
        // The message has to be readable by the operator, who will see it on the
        // approve button, so it names the setting and the screen.
        assert.match(error.message, /settings\.send_window/);
        return true;
      },
    );
  });

  it('a window whose days exist still schedules, however narrow', () => {
    // days: [6] is Saturday only. Approved on a Tuesday, the slot is four days
    // out; 2026-08-08 is the Saturday.
    const result = slot('2026-08-04T07:00:00Z', ATHENS, {
      days: [6],
      start_hour: 9,
      end_hour: 16,
    });
    assert.equal(result.sendAfter.toISOString(), '2026-08-08T06:07:00.000Z');
    assert.equal(result.reason, 'Sends Saturday from 09:00.');
  });

  it('a one-hour window still schedules inside itself, and rolls when it cannot', () => {
    // `end_hour` is an integer in both validators and `start >= end` is rejected
    // by each of them, so a window narrower than the jitter is not expressible —
    // an earlier version of this case asserted `{start_hour: 9, end_hour: 9}`,
    // which `nextSendSlot` can never be handed and which would pass against any
    // implementation that threw. The reachable version of the same worry is a
    // one-hour window with an approval inside its last seven minutes.
    const inside = slot('2026-08-04T06:30:00Z', ATHENS, {
      days: [2, 3, 4],
      start_hour: 9,
      end_hour: 10,
    });
    assert.equal(inside.sendAfter.toISOString(), '2026-08-04T06:37:00.000Z');

    // 09:58 Athens: seven minutes of jitter lands at 10:05, past the close. It
    // goes on Wednesday morning rather than five minutes late on Tuesday.
    const rolled = slot('2026-08-04T06:58:00Z', ATHENS, {
      days: [2, 3, 4],
      start_hour: 9,
      end_hour: 10,
    });
    assert.equal(rolled.sendAfter.toISOString(), '2026-08-05T06:07:00.000Z');
    assert.equal(rolled.reason, 'Sends Wednesday from 09:00.');
  });

  it('crosses a year boundary without arithmetic drift', () => {
    // `base.day + offset` relies on `Date.UTC` normalising past the end of a
    // month and a year, and the offset changes underneath it: Athens is UTC+3 on
    // 31 December in the fixture's summer-time reasoning but UTC+2 in winter, so
    // 09:07 local is 07:07Z, not 06:07Z. Nothing else in the suite goes near it.
    const result = slot('2026-12-31T16:00:00Z', ATHENS);
    assert.equal(result.sendAfter.toISOString(), '2027-01-05T07:07:00.000Z');
    assert.equal(result.reason, 'Sends Tuesday from 09:00.');
  });
});

describe('clampJitterMinutes', () => {
  it('holds the range PLAN §7.1 specifies', () => {
    assert.equal(clampJitterMinutes(0), MIN_JITTER_MINUTES);
    assert.equal(clampJitterMinutes(-40), MIN_JITTER_MINUTES);
    assert.equal(clampJitterMinutes(900), MAX_JITTER_MINUTES);
    assert.equal(clampJitterMinutes(7), 7);
  });

  it('rounds, so a fractional source cannot produce sub-second scheduling noise', () => {
    assert.equal(clampJitterMinutes(7.6), 8);
    assert.equal(clampJitterMinutes(7.4), 7);
  });

  it('NaN clamps to the floor instead of producing an Invalid Date', () => {
    // NaN milliseconds added to an instant yields an Invalid Date, which would
    // be written to send_after as null-ish rubbish and never come due — a task
    // that silently never sends, which is this repo's defining failure mode.
    assert.equal(clampJitterMinutes(Number.NaN), MIN_JITTER_MINUTES);
    assert.equal(clampJitterMinutes(Number.POSITIVE_INFINITY), MIN_JITTER_MINUTES);
  });

  it('a source outside the range still produces a usable slot', () => {
    const result = nextSendSlot({
      from: new Date('2026-08-04T07:00:00Z'),
      timeZone: ATHENS,
      fallbackTimeZone: ATHENS,
      window: DEFAULT_WINDOW,
      jitter: () => 900,
    });
    assert.equal(result.jitterMinutes, MAX_JITTER_MINUTES);
    assert.equal(result.sendAfter.toISOString(), '2026-08-04T07:15:00.000Z');
  });
});

describe('the default jitter source', () => {
  it('stays inside [2, 15] over many draws', () => {
    // Not a randomness test — a range test. `randomInt`'s max is exclusive, so
    // the +1 in the implementation is load-bearing and an off-by-one here would
    // mean the documented range is a lie by one minute at the top.
    let sawMin = false;
    let sawMax = false;
    for (let i = 0; i < 3000; i += 1) {
      const result = nextSendSlot({
        from: new Date('2026-08-04T07:00:00Z'),
        timeZone: ATHENS,
        fallbackTimeZone: ATHENS,
        window: DEFAULT_WINDOW,
      });
      assert.ok(result.jitterMinutes >= MIN_JITTER_MINUTES);
      assert.ok(result.jitterMinutes <= MAX_JITTER_MINUTES);
      assert.equal(Number.isInteger(result.jitterMinutes), true);
      if (result.jitterMinutes === MIN_JITTER_MINUTES) sawMin = true;
      if (result.jitterMinutes === MAX_JITTER_MINUTES) sawMax = true;
    }
    // Both ends are reachable. With 3000 draws over 14 values the chance of
    // missing either end is around 10^-93, so this will not flake.
    assert.equal(sawMin, true);
    assert.equal(sawMax, true);
  });
});

// ---------------------------------------------------------------------------
// The window is not the same for both agents
// ---------------------------------------------------------------------------

describe('windowForAgent', () => {
  const seeded: SendWindowSetting = { days: [2, 3, 4], start_hour: 9, end_hour: 16 };

  it('leaves a follow-up on the configured outreach rhythm', () => {
    assert.deepEqual(windowForAgent('followup', seeded), seeded);
  });

  it('lets a reply go out on any day, keeping the hours', () => {
    const reply = windowForAgent('inbox', seeded);
    assert.deepEqual(reply.days, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(reply.start_hour, 9);
    assert.equal(reply.end_hour, 16);
  });

  it('answers a Thursday-evening question on Friday, not the following Tuesday', () => {
    // The failure, end to end. A customer writes in at 17:10 on a Thursday; the
    // operator approves on Friday morning. With the seeded [2,3,4] window the
    // answer was scheduled for the following Tuesday — five days after they
    // asked, by a system whose entire purpose is that nobody is left waiting.
    const fridayMorning = new Date('2026-08-07T05:00:00.000Z'); // 08:00 Athens, a Friday

    const asOutreach = nextSendSlot({
      from: fridayMorning,
      timeZone: 'Europe/Athens',
      fallbackTimeZone: 'Europe/Athens',
      window: windowForAgent('followup', seeded),
      jitter: () => 5,
    });
    const asReply = nextSendSlot({
      from: fridayMorning,
      timeZone: 'Europe/Athens',
      fallbackTimeZone: 'Europe/Athens',
      window: windowForAgent('inbox', seeded),
      jitter: () => 5,
    });

    assert.equal(asOutreach.sendAfter.toISOString(), '2026-08-11T06:05:00.000Z');
    assert.equal(asReply.sendAfter.toISOString(), '2026-08-07T06:05:00.000Z');
  });

  it('still refuses to send a reply at 03:00', () => {
    // The hours are the half of the rule that is about the recipient. Dropping
    // the days must not drop those with them.
    const lateNight = new Date('2026-08-08T00:10:00.000Z'); // 03:10 Athens, a Saturday
    const slot = nextSendSlot({
      from: lateNight,
      timeZone: 'Europe/Athens',
      fallbackTimeZone: 'Europe/Athens',
      window: windowForAgent('inbox', seeded),
      jitter: () => 5,
    });

    assert.equal(slot.sendAfter.toISOString(), '2026-08-08T06:05:00.000Z');
  });

  it('treats an unrecognised agent as outbound', () => {
    // `tasks.agent` is free text. The safe direction for an unknown value is the
    // one that waits.
    assert.deepEqual(windowForAgent('some-future-agent', seeded), seeded);
    assert.deepEqual(windowForAgent(null, seeded), seeded);
  });
});
