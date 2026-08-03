/**
 * Both settings paths, tested against the tables they mirror.
 *
 * These are the rules that decide whether the worker can send at all, and every
 * one of them is invisible in a typecheck: `daily_send_cap` is a number either
 * way, `send_window.days` is an array either way, and an autonomy level of 2 is
 * a perfectly good `AutonomyLevel`. The three that would be worst in production:
 *
 *   - an empty `days` array saved, after which `nextSendSlot()` throws and every
 *     approval on the Today page fails with an error about a setting
 *   - an autonomy level above 1 saved, which is the one hard rule SPEC §7 makes
 *   - a brain value round-tripping through the browser and coming back changed,
 *     which would make every key look edited and quietly rewrite the text the
 *     drafting agent reads
 *
 * The read path — `coerceOperationalSettings`, at the bottom — is the same
 * concern from the other side, and it is here rather than in its own file
 * because the two halves have to agree. The cases that matter are the ones where
 * a row exists and is the wrong shape: core's `getSetting()` throws on exactly
 * those, which means the worker's cron jobs throw at the top and nothing sends,
 * so a screen that quietly renders the seeded default instead of naming the key
 * is a screen lying about a dead worker.
 *
 * No database, no network, no key. Every function under test is pure by
 * construction, which is why they are in their own module.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_BRAIN_CHARS,
  MAX_DAILY_COST_CAP,
  MAX_DAILY_SEND_CAP,
  coerceOperationalSettings,
  parseBrainKey,
  parseBrainValue,
  parseSettingsForm,
  type OperationalSettings,
} from './settings-validation';

/** The form as the page posts it when nothing has been touched: the seeded
 *  defaults from PLAN §4. Every test starts here and changes one thing. */
function form(overrides: Record<string, string | string[]> = {}): FormData {
  const base: Record<string, string | string[]> = {
    daily_send_cap: '10',
    daily_cost_cap: '2.00',
    send_window_days: ['2', '3', '4'],
    send_window_start_hour: '9',
    send_window_end_hour: '16',
    autonomy_draft_email: '1',
    autonomy_reminder: '1',
    autonomy_alert: '1',
    kill_switch: 'false',
    ...overrides,
  };

  const data = new FormData();
  for (const [key, value] of Object.entries(base)) {
    if (Array.isArray(value)) for (const entry of value) data.append(key, entry);
    else data.set(key, value);
  }
  return data;
}

describe('parseSettingsForm — the seeded defaults', () => {
  it('accepts them unchanged and returns the shape settings.value stores', () => {
    const result = parseSettingsForm(form());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(result.value, {
      killSwitch: false,
      dailySendCap: 10,
      dailyCostCap: 2,
      sendWindow: { days: [2, 3, 4], start_hour: 9, end_hour: 16 },
      autonomy: { draft_email: 1, reminder: 1, alert: 1 },
    });
  });
});

describe('parseSettingsForm — daily_send_cap, the PLAN §7.1 ramp', () => {
  it('accepts every rung of the ramp', () => {
    for (const cap of ['10', '20', '30', '40']) {
      const result = parseSettingsForm(form({ daily_send_cap: cap }));
      assert.equal(result.ok, true, `rung ${cap} rejected`);
      if (result.ok) assert.equal(result.value.dailySendCap, Number(cap));
    }
  });

  it('accepts 0, which pauses sending without touching the kill switch', () => {
    const result = parseSettingsForm(form({ daily_send_cap: '0' }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.dailySendCap, 0);
  });

  it('rejects a negative cap', () => {
    const result = parseSettingsForm(form({ daily_send_cap: '-1' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.daily_send_cap !== undefined);
  });

  it('rejects a cap above the ceiling', () => {
    const result = parseSettingsForm(form({ daily_send_cap: String(MAX_DAILY_SEND_CAP + 1) }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.daily_send_cap !== undefined);
  });

  it('rejects a fraction of an email', () => {
    const result = parseSettingsForm(form({ daily_send_cap: '10.5' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.daily_send_cap !== undefined);
  });

  it('rejects an empty field rather than reading it as 0', () => {
    const result = parseSettingsForm(form({ daily_send_cap: '' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.daily_send_cap !== undefined);
  });
});

describe('parseSettingsForm — daily_cost_cap', () => {
  it('reads a Greek decimal comma as a decimal point', () => {
    const result = parseSettingsForm(form({ daily_cost_cap: '2,50' }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.dailyCostCap, 2.5);
  });

  it('rejects an amount above the ceiling', () => {
    const result = parseSettingsForm(form({ daily_cost_cap: String(MAX_DAILY_COST_CAP + 1) }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.daily_cost_cap !== undefined);
  });

  it('rejects text', () => {
    const result = parseSettingsForm(form({ daily_cost_cap: 'two dollars' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.daily_cost_cap !== undefined);
  });
});

describe('parseSettingsForm — send_window', () => {
  it('refuses an empty day list, which would block every approval', () => {
    const result = parseSettingsForm(form({ send_window_days: [] }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.send_window_days !== undefined);
  });

  it('sorts and de-duplicates the days so two saves produce the same row', () => {
    const result = parseSettingsForm(form({ send_window_days: ['4', '2', '4', '3'] }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.sendWindow.days, [2, 3, 4]);
  });

  it('accepts Sunday as 0 — JS getDay() numbering, the same as seed.sql', () => {
    const result = parseSettingsForm(form({ send_window_days: ['0', '6'] }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.sendWindow.days, [0, 6]);
  });

  it('rejects a day outside 0–6', () => {
    const result = parseSettingsForm(form({ send_window_days: ['7'] }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.send_window_days !== undefined);
  });

  it('rejects a window that ends before it starts', () => {
    const result = parseSettingsForm(
      form({ send_window_start_hour: '16', send_window_end_hour: '9' }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.send_window_end_hour !== undefined);
  });

  it('rejects a zero-length window', () => {
    const result = parseSettingsForm(
      form({ send_window_start_hour: '9', send_window_end_hour: '9' }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.send_window_end_hour !== undefined);
  });

  it('rejects an hour above 24', () => {
    const result = parseSettingsForm(form({ send_window_end_hour: '25' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.send_window_end_hour !== undefined);
  });

  it('accepts a 24-hour window, since end_hour is exclusive', () => {
    const result = parseSettingsForm(
      form({ send_window_start_hour: '0', send_window_end_hour: '24' }),
    );
    assert.equal(result.ok, true);
  });
});

describe('parseSettingsForm — autonomy is locked at 1 for v1', () => {
  it('accepts level 0', () => {
    const result = parseSettingsForm(form({ autonomy_draft_email: '0' }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.autonomy.draft_email, 0);
  });

  it('refuses level 2 by name, per SPEC §7', () => {
    const result = parseSettingsForm(form({ autonomy_draft_email: '2' }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.errors.autonomy_draft_email ?? '', /above level 1/);
    }
  });

  it('refuses level 3 on any task type, not just draft_email', () => {
    for (const field of ['autonomy_draft_email', 'autonomy_reminder', 'autonomy_alert']) {
      const result = parseSettingsForm(form({ [field]: '3' }));
      assert.equal(result.ok, false, `${field} accepted level 3`);
    }
  });

  it('refuses a level off the ladder entirely', () => {
    const result = parseSettingsForm(form({ autonomy_alert: '9' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.autonomy_alert !== undefined);
  });
});

describe('parseSettingsForm — reporting', () => {
  it('returns every bad field at once, not the first one', () => {
    const result = parseSettingsForm(
      form({ daily_send_cap: 'ten', daily_cost_cap: 'free', send_window_days: [] }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(Object.keys(result.errors).length, 3);
    }
  });

  it('carries the kill switch through without deciding anything about it', () => {
    const on = parseSettingsForm(form({ kill_switch: 'on' }));
    assert.equal(on.ok, true);
    if (on.ok) assert.equal(on.value.killSwitch, true);

    const off = parseSettingsForm(form({ kill_switch: 'false' }));
    assert.equal(off.ok, true);
    if (off.ok) assert.equal(off.value.killSwitch, false);
  });
});

describe('parseBrainKey', () => {
  it('accepts all eight seeded keys', () => {
    for (const key of [
      'services',
      'pricing',
      'tone_of_voice_en',
      'tone_of_voice_el',
      'case_studies',
      'positioning',
      'availability',
      'retainer_offer',
    ]) {
      assert.equal(parseBrainKey(key).ok, true, `${key} rejected`);
    }
  });

  it('refuses a key nobody reads', () => {
    assert.equal(parseBrainKey('secret_sauce').ok, false);
  });

  it('refuses a non-string', () => {
    assert.equal(parseBrainKey(null).ok, false);
    assert.equal(parseBrainKey(42).ok, false);
  });
});

describe('parseBrainValue', () => {
  it('accepts an empty value — an empty key is a deliberate state', () => {
    const result = parseBrainValue('');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, '');
  });

  it('keeps internal blank lines and leading whitespace exactly', () => {
    const prose = '  Indented first line\n\nA second paragraph.\n\n\nA third.';
    const result = parseBrainValue(prose);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, prose);
  });

  it('normalises the CRLF a textarea submits, so an untouched key is not an edit', () => {
    const result = parseBrainValue('One line\r\nAnother line');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 'One line\nAnother line');
  });

  it('drops the trailing newline a textarea adds, matching what the seeder writes', () => {
    const result = parseBrainValue('Prices from €800.\n');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 'Prices from €800.');
  });

  it('keeps Greek intact', () => {
    const greek = 'Μιλάω απλά. Δεν υπόσχομαι τίποτα που δεν μπορώ να κάνω.';
    const result = parseBrainValue(greek);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, greek);
  });

  it('accepts a value exactly at the ceiling and refuses one past it', () => {
    assert.equal(parseBrainValue('a'.repeat(MAX_BRAIN_CHARS)).ok, true);
    assert.equal(parseBrainValue('a'.repeat(MAX_BRAIN_CHARS + 1)).ok, false);
  });

  it('refuses a non-string rather than stringifying it', () => {
    assert.equal(parseBrainValue(undefined).ok, false);
    assert.equal(parseBrainValue({ value: 'x' }).ok, false);
  });
});

// ---------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------

/** Mirrors `SETTING_DEFAULTS` in packages/core/src/settings.ts, which is what
 *  the real caller passes in. Held here as a literal so this test never needs a
 *  value import from @agency/core. */
const DEFAULTS: OperationalSettings = {
  killSwitch: false,
  dailySendCap: 10,
  dailyCostCap: 2,
  sendWindow: { days: [2, 3, 4], start_hour: 9, end_hour: 16 },
  autonomy: { draft_email: 1, reminder: 1, alert: 1 },
};

describe('coerceOperationalSettings', () => {
  it('reads an empty table as the seeded defaults, with nothing unreadable', () => {
    // A key with no row is a fresh database, not a fault. Reporting it would
    // put a red strip on both screens of a repo somebody has just cloned.
    const read = coerceOperationalSettings([], DEFAULTS);
    assert.deepEqual(read.unreadable, []);
    assert.equal(read.killSwitch, false);
    assert.equal(read.dailySendCap, 10);
    assert.deepEqual(read.sendWindow, { days: [2, 3, 4], start_hour: 9, end_hour: 16 });
  });

  it('lets well-formed rows win over the defaults', () => {
    const read = coerceOperationalSettings(
      [
        { key: 'kill_switch', value: true },
        { key: 'daily_send_cap', value: 40 },
        { key: 'daily_cost_cap', value: 0.5 },
        { key: 'send_window', value: { days: [1, 2, 3, 4, 5], start_hour: 8, end_hour: 20 } },
        { key: 'autonomy', value: { draft_email: 0, reminder: 1, alert: 1 } },
      ],
      DEFAULTS,
    );

    assert.deepEqual(read.unreadable, []);
    assert.equal(read.killSwitch, true);
    assert.equal(read.dailySendCap, 40);
    assert.equal(read.dailyCostCap, 0.5);
    assert.equal(read.autonomy.draft_email, 0);
    assert.deepEqual(read.sendWindow, { days: [1, 2, 3, 4, 5], start_hour: 8, end_hour: 20 });
  });

  it('falls back to the default for a malformed row and names the key', () => {
    const read = coerceOperationalSettings(
      [
        { key: 'kill_switch', value: 'true' },
        { key: 'daily_send_cap', value: -1 },
        { key: 'send_window', value: { days: [2], start_hour: 16, end_hour: 9 } },
      ],
      DEFAULTS,
    );

    assert.deepEqual([...read.unreadable].sort(), [
      'daily_send_cap',
      'kill_switch',
      'send_window',
    ]);
    assert.equal(read.killSwitch, false);
    assert.equal(read.dailySendCap, 10);
    assert.deepEqual(read.sendWindow, DEFAULTS.sendWindow);
  });

  it('treats autonomy missing a task type as unreadable, not partially applied', () => {
    // A partial map leaves one type with an undefined level, and `evaluateSend`
    // reads that level to decide whether the task may be sent at all.
    const read = coerceOperationalSettings(
      [{ key: 'autonomy', value: { draft_email: 1, reminder: 1 } }],
      DEFAULTS,
    );
    assert.deepEqual(read.unreadable, ['autonomy']);
    assert.deepEqual(read.autonomy, DEFAULTS.autonomy);
  });

  it('parses an autonomy level above 1 — clamping belongs to the guardrails', () => {
    // The write path refuses to create this; the read path must not pretend a
    // hand-edited row says something it does not.
    const read = coerceOperationalSettings(
      [{ key: 'autonomy', value: { draft_email: 3, reminder: 1, alert: 1 } }],
      DEFAULTS,
    );
    assert.deepEqual(read.unreadable, []);
    assert.equal(read.autonomy.draft_email, 3);
  });

  it('accepts an empty send window as legal-but-unusable, not unreadable', () => {
    // `nextSendSlot` throws on it and the approve action says so in words.
    // Coercing it back to Tue-Thu here would send on days somebody cleared.
    const read = coerceOperationalSettings(
      [{ key: 'send_window', value: { days: [], start_hour: 9, end_hour: 16 } }],
      DEFAULTS,
    );
    assert.deepEqual(read.unreadable, []);
    assert.deepEqual(read.sendWindow.days, []);
  });

  it('reports a fractional or out-of-range weekday', () => {
    for (const days of [[7], [-1], [2.5], ['2']]) {
      const read = coerceOperationalSettings(
        [{ key: 'send_window', value: { days, start_hour: 9, end_hour: 16 } }],
        DEFAULTS,
      );
      assert.deepEqual(read.unreadable, ['send_window'], JSON.stringify(days));
    }
  });

  it('reports a fractional hour, which core would accept and misuse', () => {
    // `start_hour: 9.5` survives core's range check and reaches `zonedTimeToUtc`
    // as a `Date.UTC` argument. There is no such thing as a fractional business
    // hour, and a send time nobody asked for is worse than a named bad row.
    const read = coerceOperationalSettings(
      [{ key: 'send_window', value: { days: [2], start_hour: 9.5, end_hour: 16 } }],
      DEFAULTS,
    );
    assert.deepEqual(read.unreadable, ['send_window']);
  });

  it('accepts a non-integer cost cap, which is money and not a count', () => {
    const read = coerceOperationalSettings([{ key: 'daily_cost_cap', value: 2.75 }], DEFAULTS);
    assert.deepEqual(read.unreadable, []);
    assert.equal(read.dailyCostCap, 2.75);
  });
});
