/**
 * Selection-logic tests — the half of the follow-up agent that decides WHO gets
 * contacted and WHEN, without touching a database or a model.
 *
 * The prompt tests cover what gets written. These cover the two mistakes that
 * would be worst in production and are both invisible in a typecheck:
 *
 *   - a `won` contact never being selected, which silently kills three of the
 *     six rows of SPEC §4's cadence table including the entire retainer cadence
 *   - a lifetime `touch_count` reaching `nextTouch()`, which marks a
 *     freshly-quoted contact dormant the day after you quote them
 *
 * Both are PLAN §6 step 5 constraints inherited from step 3.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Contact, Interaction } from '@agency/core';

import {
  FOLLOWUP_HOUR,
  MAX_PUSH_OUT_DAYS,
  MIN_PUSH_OUT_DAYS,
  atFollowupHour,
  clampPushOutDays,
  deriveStageTouchCount,
  hasEmailAddress,
  planNextTouchAfterSend,
} from './followup-select';

const TZ = 'Europe/Athens';

function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Maria',
    business: 'Taverna Ilios',
    email: 'maria@example.gr',
    phone: null,
    language: 'el',
    city: 'Athens',
    country: 'GR',
    timezone: TZ,
    source: 'nfc_card',
    stage: 'new',
    value_estimate: null,
    notes: null,
    last_touch_at: null,
    next_touch_at: null,
    touch_count: 0,
    do_not_contact: false,
    tags: [],
    stage_changed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Contact;
}

function interaction(over: Partial<Interaction> = {}): Interaction {
  return {
    id: crypto.randomUUID(),
    contact_id: '00000000-0000-0000-0000-000000000001',
    direction: 'out',
    channel: 'email',
    subject: null,
    body: null,
    occurred_at: '2026-06-01T09:00:00.000Z',
    meta: null,
    ...over,
  } as Interaction;
}

describe('constraint 2 — touch count is per-stage, never the lifetime counter', () => {
  it('a lead chased 5 times then quoted does NOT arrive as touchCount 5', () => {
    // The bug this exists to prevent: 5 would fall off the end of the 3-step
    // quoted sequence and mark them dormant the day after they were quoted.
    // They were quoted on 1 June — after all five of those chases.
    const c = contact({ stage: 'quoted', touch_count: 5, stage_changed_at: '2026-06-01T00:00:00.000Z' });
    const history: Interaction[] = [
      interaction({ occurred_at: '2026-05-01T09:00:00.000Z' }),
      interaction({ occurred_at: '2026-05-08T09:00:00.000Z' }),
      interaction({ occurred_at: '2026-05-15T09:00:00.000Z' }),
      interaction({ occurred_at: '2026-05-22T09:00:00.000Z' }),
      interaction({ occurred_at: '2026-05-29T09:00:00.000Z' }),
    ];

    const derived = deriveStageTouchCount({ contact: c, interactions: history });
    assert.notEqual(
      derived.touchCount,
      c.touch_count,
      'derived count must not simply echo contacts.touch_count',
    );
    assert.ok(
      derived.touchCount < 3,
      `expected a fresh quoted contact to be early in its sequence, got ${derived.touchCount}`,
    );
  });

  it('an inbound reply resets the chase count — they answered, so the chase ended', () => {
    const c = contact({ stage: 'replied', touch_count: 9 });
    const history: Interaction[] = [
      interaction({ direction: 'out', occurred_at: '2026-06-01T09:00:00.000Z' }),
      interaction({ direction: 'out', occurred_at: '2026-06-08T09:00:00.000Z' }),
      interaction({ direction: 'in', occurred_at: '2026-06-09T09:00:00.000Z' }),
    ];
    const derived = deriveStageTouchCount({ contact: c, interactions: history });
    assert.equal(derived.touchCount, 0, 'a reply should put them back at the start');
  });

  it('a contact with no history at all starts at 0, not undefined or NaN', () => {
    const derived = deriveStageTouchCount({ contact: contact(), interactions: [] });
    assert.equal(derived.touchCount, 0);
    assert.equal(Number.isInteger(derived.touchCount), true);
  });

  it('never returns a negative count, whatever the history looks like', () => {
    // nextTouch() throws RangeError on a negative — that must be unreachable
    // from real data, or one odd row aborts a contact for no reason.
    const cases: Interaction[][] = [
      [],
      [interaction({ direction: 'in' })],
      [interaction({ direction: 'in' }), interaction({ direction: 'in' })],
    ];
    for (const history of cases) {
      const derived = deriveStageTouchCount({ contact: contact(), interactions: history });
      assert.ok(derived.touchCount >= 0, `got ${derived.touchCount}`);
      assert.equal(Number.isInteger(derived.touchCount), true);
    }
  });

  it('only counts outbound — inbound mail is not a chase', () => {
    const outboundOnly = deriveStageTouchCount({
      contact: contact(),
      interactions: [interaction({ direction: 'out' }), interaction({ direction: 'out' })],
    });
    const mixed = deriveStageTouchCount({
      contact: contact(),
      interactions: [interaction({ direction: 'out' }), interaction({ direction: 'in' })],
    });
    assert.ok(outboundOnly.touchCount > mixed.touchCount);
  });
});

describe('follow-up date maths — Europe/Athens, not the host clock', () => {
  it('lands on the follow-up hour in Athens, not UTC', () => {
    const from = new Date('2026-07-31T12:00:00.000Z');
    const next = atFollowupHour(from, 7, TZ);
    const athensHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        hour: '2-digit',
        hour12: false,
      }).format(next),
    );
    assert.equal(athensHour, FOLLOWUP_HOUR, 'must be 08:00 as read in Athens');
  });

  it('+7 days really is seven days later', () => {
    const from = new Date('2026-07-31T12:00:00.000Z');
    const next = atFollowupHour(from, 7, TZ);
    const days = (next.getTime() - from.getTime()) / 86_400_000;
    assert.ok(days > 6 && days < 8, `expected ~7 days, got ${days.toFixed(2)}`);
  });

  it('survives the DST boundary without drifting an hour', () => {
    // Greece moves clocks on the last Sunday of October.
    const before = new Date('2026-10-20T09:00:00.000Z');
    const next = atFollowupHour(before, 14, TZ);
    const athensHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        hour: '2-digit',
        hour12: false,
      }).format(next),
    );
    assert.equal(athensHour, FOLLOWUP_HOUR, 'still 08:00 local after the clocks change');
  });
});

describe('push-out clamping — the model does not get to pick any number', () => {
  it('clamps an absurdly large suggestion', () => {
    assert.ok(clampPushOutDays(9999, 14) <= MAX_PUSH_OUT_DAYS);
  });

  it('clamps zero and negatives up to the floor', () => {
    assert.ok(clampPushOutDays(0, 14) >= MIN_PUSH_OUT_DAYS);
    assert.ok(clampPushOutDays(-5, 14) >= MIN_PUSH_OUT_DAYS);
  });

  it('falls back when the model returns nothing usable', () => {
    assert.equal(clampPushOutDays(null, 14), 14);
    assert.equal(clampPushOutDays(Number.NaN, 14), 14);
  });

  it('passes a sensible suggestion through untouched', () => {
    assert.equal(clampPushOutDays(21, 14), 21);
  });
});

describe('email presence — a follow-up with nowhere to send', () => {
  it('recognises a usable address', () => {
    assert.equal(hasEmailAddress({ email: 'maria@example.gr' }), true);
  });

  it('treats null, empty and whitespace as no address', () => {
    assert.equal(hasEmailAddress({ email: null }), false);
    assert.equal(hasEmailAddress({ email: '' }), false);
    assert.equal(hasEmailAddress({ email: '   ' }), false);
  });
});

// ---------------------------------------------------------------------------
// Re-anchoring the cadence on the send
// ---------------------------------------------------------------------------

describe('planNextTouchAfterSend — the interval is measured from the message', () => {
  it('advances to the next interval, from the moment the message left', () => {
    // The bug, and it did not need an approval delay to bite. At draft time a
    // `contacted` lead with one outreach on file derives touchCount 0, so
    // `followup.ts` wrote draft + 3. The draft it was filing is the touch that
    // makes them step 1, whose interval is +7. So chase 2 was drafted three days
    // after chase 1, and every interval in SPEC §4's table was served one step
    // early, permanently and silently.
    const sentAt = new Date('2026-08-10T09:00:00.000Z');
    const plan = planNextTouchAfterSend({
      contact: contact({
        stage: 'contacted',
        stage_changed_at: '2026-08-01T00:00:00.000Z',
        next_touch_at: '2026-08-08T05:00:00.000Z',
      }),
      // Including the row just written: the outreach, then this send.
      interactions: [
        interaction({ occurred_at: '2026-08-03T09:00:00.000Z' }),
        interaction({ occurred_at: sentAt.toISOString() }),
      ],
      sentAt,
      timeZone: TZ,
    });

    assert.notEqual(plan, null);
    assert.equal(plan?.days, 7);
    assert.equal(plan?.at.getTime(), atFollowupHour(sentAt, 7, TZ).getTime());
  });

  it('closes the collapse when the approval waited longer than the interval', () => {
    // Approve on Thursday, the seeded [2,3,4] window schedules for Tuesday, and
    // `next_touch_at` was already Sunday. Without re-anchoring the contact is due
    // before the message has even gone out, and the next chase is drafted the
    // morning after the previous one landed.
    const sentAt = new Date('2026-08-18T06:05:00.000Z');
    const plan = planNextTouchAfterSend({
      contact: contact({
        stage: 'contacted',
        stage_changed_at: '2026-08-01T00:00:00.000Z',
        next_touch_at: '2026-08-16T05:00:00.000Z', // already in the past at send time
      }),
      interactions: [
        interaction({ occurred_at: '2026-08-03T09:00:00.000Z' }),
        interaction({ occurred_at: sentAt.toISOString() }),
      ],
      sentAt,
      timeZone: TZ,
    });

    assert.ok(plan !== null);
    assert.ok(plan.at.getTime() > sentAt.getTime());
  });

  it('never pulls a date in', () => {
    // A send can land days after the draft, and the stored date may have been
    // pushed further out in the meantime — by `inbox.ts` because the contact
    // wrote back, or by the operator. Pulling in is how a live conversation gets
    // a cold nudge on top of it.
    const sentAt = new Date('2026-08-10T09:00:00.000Z');
    const plan = planNextTouchAfterSend({
      contact: contact({
        stage: 'contacted',
        stage_changed_at: '2026-08-01T00:00:00.000Z',
        next_touch_at: '2026-12-01T05:00:00.000Z',
      }),
      interactions: [
        interaction({ occurred_at: '2026-08-03T09:00:00.000Z' }),
        interaction({ occurred_at: sentAt.toISOString() }),
      ],
      sentAt,
      timeZone: TZ,
    });

    assert.equal(plan, null);
  });

  it('leaves a stage decision to the follow-up agent', () => {
    // Four unanswered touches is `dormant`, and dormant is a stage change with an
    // alert and a `contacts.stage` write behind it. The send queue owns none of
    // that, so it returns null, the existing date stands, and the morning run
    // makes the same decision it would have made anyway.
    const sentAt = new Date('2026-08-10T09:00:00.000Z');
    const outbound = ['2026-08-01', '2026-08-03', '2026-08-06', '2026-08-10'].map((day) =>
      interaction({ occurred_at: `${day}T09:00:00.000Z` }),
    );

    const plan = planNextTouchAfterSend({
      contact: contact({
        stage: 'contacted',
        stage_changed_at: '2026-07-30T00:00:00.000Z',
        next_touch_at: '2026-08-12T05:00:00.000Z',
      }),
      interactions: outbound,
      sentAt,
      timeZone: TZ,
    });

    assert.equal(plan, null);
  });

  it('does nothing for a contact with no stage', () => {
    // `screenContact` files an alert for that row. The send queue is not the
    // place to have an opinion about it.
    const sentAt = new Date('2026-08-10T09:00:00.000Z');
    const plan = planNextTouchAfterSend({
      contact: contact({ stage: null, next_touch_at: null }),
      interactions: [interaction({ occurred_at: sentAt.toISOString() })],
      sentAt,
      timeZone: TZ,
    });

    assert.equal(plan, null);
  });

  it('schedules from a null next_touch_at rather than refusing', () => {
    // A contact whose date was cleared and who is then sent to by hand still
    // needs a next touch; "no date" is not "further out than the new one".
    const sentAt = new Date('2026-08-10T09:00:00.000Z');
    const plan = planNextTouchAfterSend({
      contact: contact({
        stage: 'contacted',
        stage_changed_at: '2026-08-01T00:00:00.000Z',
        next_touch_at: null,
      }),
      interactions: [interaction({ occurred_at: sentAt.toISOString() })],
      sentAt,
      timeZone: TZ,
    });

    assert.equal(plan?.days, 3);
  });
});
