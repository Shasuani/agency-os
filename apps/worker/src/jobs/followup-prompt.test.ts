/**
 * Unit tests for `followup-prompt.ts` — SPEC §4's prompting rules and PLAN §2's
 * caching rule.
 *
 * The rules under test, reproduced so a failure can be read without opening
 * another file:
 *
 *   SPEC §4  System prompt is assembled from brain, not hardcoded.
 *   SPEC §4  Write in the contact's language. Greek contacts get Greek, formal
 *            register (πληθυντικός ευγενείας) unless prior interactions show
 *            otherwise.
 *   SPEC §4  Short. Under 120 words. No corporate filler.
 *   SPEC §4  One clear ask per message.
 *   SPEC §4  Never invent facts, prices, or timelines not present in brain or
 *            interactions.
 *   SPEC §4  If there is nothing genuine to say, return should_contact: false.
 *   PLAN §2  The brain block is identical for every contact in a run, so it must
 *            carry cache:true and come FIRST, with per-contact content after it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE AND ARE NOT
 * ---------------------------------------------------------------------------
 *
 * A prompt cannot be unit-tested for quality. What can be tested is that the
 * facts the model needs are present, that the facts it must not have are
 * absent, and that the mechanical properties the cost model depends on hold.
 * So the assertions below are of three kinds:
 *
 *   1. **Structural** — block order, the cache flag, and the byte-for-byte
 *      identity of the cached block across contacts. This is the one that costs
 *      money when it breaks, and it breaks silently: a prompt with the brain in
 *      the wrong block still produces good drafts, it just produces them at
 *      three times the price with a cache-hit rate of zero.
 *
 *   2. **Presence and absence** — the contact's tags reach the prompt; a
 *      missing brain key never becomes the string "undefined"; an empty brain
 *      produces an explicit prohibition rather than a silence.
 *
 *   3. **Routing** — which language and register instruction is emitted, given
 *      the record and the history. Tested through `buildFollowupPrompt` rather
 *      than against an exported detector, because "the prompt says write in
 *      Greek" is the actual contract and an internal helper's return value is
 *      not.
 *
 * ---------------------------------------------------------------------------
 * THE "undefined" TEST IS THE POINT, NOT A NICETY
 * ---------------------------------------------------------------------------
 *
 * Almost every column on `contacts` is nullable and the brain table is empty
 * today, so a template that interpolates a field without checking is not an
 * unlikely mistake, it is the default outcome. "Pricing: undefined" in a prompt
 * does not fail anything — it teaches the model that a value exists and that it
 * is unknown, which is one short step from a model that fills it in. The last
 * describe block runs the whole matrix of degenerate inputs and scans every
 * string that would be sent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFollowupPrompt, isWithinWordLimit, WORD_LIMIT } from './followup-prompt.js';
import type { FollowupPrompt, FollowupPromptInput } from './followup-prompt.js';
import type { Contact, Interaction } from '@agency/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fully-populated Greek contact: the shape the app is designed around. */
function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Μαρία Παπαδοπούλου',
    business: 'Καφέ Νέα',
    email: 'maria@example.gr',
    phone: '+30 2310 000000',
    language: 'el',
    city: 'Θεσσαλονίκη',
    country: 'GR',
    timezone: 'Europe/Athens',
    source: 'referral',
    stage: 'quoted',
    value_estimate: 1500,
    notes: null,
    last_touch_at: '2026-06-01T09:00:00.000Z',
    next_touch_at: '2026-07-31T05:00:00.000Z',
    touch_count: 2,
    do_not_contact: false,
    stage_changed_at: '2026-01-01T00:00:00.000Z',
    tags: ['ecommerce'],
    created_at: '2026-01-05T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * The contact PostgREST actually hands back when nothing has been filled in:
 * every nullable column null, no tags, no history. This is the row that turns a
 * naive template into a prompt full of "undefined".
 */
function emptyContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: '00000000-0000-0000-0000-0000000000ff',
    name: null,
    business: null,
    email: null,
    phone: null,
    language: null,
    city: null,
    country: null,
    timezone: null,
    source: null,
    stage: null,
    value_estimate: null,
    notes: null,
    last_touch_at: null,
    next_touch_at: null,
    touch_count: null,
    do_not_contact: null,
    tags: [],
    stage_changed_at: null,
    created_at: null,
    ...overrides,
  };
}

function interaction(overrides: Partial<Interaction> = {}): Interaction {
  return {
    id: '00000000-0000-0000-0000-00000000000a',
    contact_id: '00000000-0000-0000-0000-000000000001',
    direction: 'out',
    channel: 'email',
    subject: null,
    body: null,
    occurred_at: '2026-06-01T09:00:00.000Z',
    meta: null,
    ...overrides,
  };
}

const FULL_BRAIN: Record<string, string> = {
  services: 'Websites, e-shops and NFC business cards.',
  pricing: 'Brochure site from €900. E-shop from €2,400. NFC card €25.',
  tone_of_voice_en: 'Direct, warm, no jargon.',
  tone_of_voice_el: 'Άμεσος, ζεστός, χωρίς ορολογία.',
  case_studies: 'Rebuilt the Kalamaki bakery e-shop; orders up 40%.',
  positioning: 'One person, not an agency. You talk to the person building it.',
  availability: 'Two project slots open in September.',
  retainer_offer: '€150/month for hosting, updates and small changes.',
};

function build(overrides: Partial<FollowupPromptInput> = {}): FollowupPrompt {
  return buildFollowupPrompt({
    brain: FULL_BRAIN,
    contact: contact(),
    interactions: [],
    ...overrides,
  });
}

/** Every string that would actually be sent to the model. */
function allText(prompt: FollowupPrompt): string {
  return [...prompt.system.map((block) => block.text), prompt.user].join('\n');
}

function cachedBlock(prompt: FollowupPrompt): string {
  const first = prompt.system[0];
  assert.ok(first !== undefined, 'expected at least one system block');
  return first.text;
}

function perContactBlocks(prompt: FollowupPrompt): string {
  return prompt.system.slice(1).map((block) => block.text).join('\n');
}

// ---------------------------------------------------------------------------
// 1. Block order and the cache flag — PLAN §2
// ---------------------------------------------------------------------------

describe('system block order and the cache flag (PLAN §2)', () => {
  it('puts the brain first and marks only that block cacheable', () => {
    const prompt = build();

    assert.ok(prompt.system.length >= 2, 'expected a cached block plus per-contact content');
    assert.equal(prompt.system[0]?.cache, true);

    for (const [index, block] of prompt.system.slice(1).entries()) {
      assert.notEqual(
        block.cache,
        true,
        `system[${index + 1}] is cached; per-contact content must never be`,
      );
    }
  });

  it('puts every brain value in the cached block and nowhere else', () => {
    const prompt = build();
    const cached = cachedBlock(prompt);
    const rest = `${perContactBlocks(prompt)}\n${prompt.user}`;

    for (const value of Object.values(FULL_BRAIN)) {
      assert.ok(cached.includes(value), `brain value missing from the cached block: ${value}`);
      assert.ok(
        !rest.includes(value),
        `brain value duplicated outside the cached block: ${value}`,
      );
    }
  });

  it('produces a byte-identical cached block for two different contacts', () => {
    // The whole cost argument rests on this one assertion. If anything
    // per-contact leaks into system[0], every contact writes a new cache entry
    // and reads none, and the only symptom is the bill.
    const first = build({
      contact: contact({ name: 'Μαρία', business: 'Καφέ Νέα', tags: ['ecommerce'] }),
      interactions: [interaction({ direction: 'in', body: 'Καλησπέρα σας.' })],
    });

    const second = build({
      contact: contact({
        id: '00000000-0000-0000-0000-000000000002',
        name: 'John Smith',
        business: 'Smith Roofing',
        language: 'en',
        city: 'Larnaca',
        stage: 'won',
        tags: ['nfc-card', 'delivered'],
        value_estimate: 25,
        touch_count: 9,
      }),
      interactions: [],
    });

    assert.equal(cachedBlock(first), cachedBlock(second));
  });

  it('keeps the contact out of the cached block', () => {
    const prompt = build({
      contact: contact({ name: 'Μαρία Παπαδοπούλου', business: 'Καφέ Νέα', tags: ['ecommerce'] }),
    });
    const cached = cachedBlock(prompt);

    for (const leak of ['Μαρία Παπαδοπούλου', 'Καφέ Νέα', 'Θεσσαλονίκη', 'ecommerce']) {
      assert.ok(!cached.includes(leak), `per-contact value leaked into the cached block: ${leak}`);
    }
  });

  it('renders brain keys in a fixed order regardless of object key order', () => {
    // The caller builds this object from a query. Postgres promises nothing
    // about row order, and insertion order would make the cache prefix depend
    // on the planner.
    const forwards: Record<string, string> = {};
    for (const key of Object.keys(FULL_BRAIN)) forwards[key] = FULL_BRAIN[key] as string;

    const backwards: Record<string, string> = {};
    for (const key of Object.keys(FULL_BRAIN).reverse()) backwards[key] = FULL_BRAIN[key] as string;

    assert.equal(cachedBlock(build({ brain: forwards })), cachedBlock(build({ brain: backwards })));
  });

  it('places unknown brain keys deterministically too', () => {
    const a = build({ brain: { zeta: 'Z', alpha: 'A', services: 'S' } });
    const b = build({ brain: { services: 'S', alpha: 'A', zeta: 'Z' } });

    const cached = cachedBlock(a);
    assert.equal(cached, cachedBlock(b));
    assert.ok(cached.indexOf('### alpha') < cached.indexOf('### zeta'));
    // Seeded keys come before free-form ones.
    assert.ok(cached.indexOf('### services') < cached.indexOf('### alpha'));
  });
});

// ---------------------------------------------------------------------------
// 2. The brain — empty, partial, full
// ---------------------------------------------------------------------------

describe('the brain block', () => {
  it('renders each present key under its own heading', () => {
    const cached = cachedBlock(build());

    for (const [key, value] of Object.entries(FULL_BRAIN)) {
      assert.ok(cached.includes(`### ${key}`), `missing heading for ${key}`);
      assert.ok(cached.includes(value), `missing value for ${key}`);
    }
    assert.ok(!cached.includes('Not recorded:'), 'nothing is missing, so nothing should be listed');
  });

  it('states the empty brain as a prohibition and points at should_contact: false', () => {
    // The brain table is empty today, so this is the live case, not an edge
    // case. The failure it guards against is a prompt that says nothing about
    // its own ignorance and gets an invented offer back.
    const cached = cachedBlock(build({ brain: {} }));

    assert.ok(cached.includes('The business-facts store is empty.'));
    assert.ok(cached.includes('should_contact: false'));
    assert.ok(
      cached.includes('not an invitation to improvise'),
      'the empty brain must forbid improvisation explicitly',
    );
    assert.ok(!cached.includes('###'), 'no key sections when there are no keys');
  });

  it('names the keys that are missing so absence is an instruction', () => {
    const cached = cachedBlock(build({ brain: { services: 'Websites and e-shops.' } }));

    assert.ok(cached.includes('### services'));
    assert.ok(!cached.includes('### pricing'), 'a missing key must not get a heading');

    assert.ok(cached.includes('Not recorded:'));
    for (const key of ['pricing', 'availability', 'case_studies', 'retainer_offer']) {
      assert.ok(cached.includes(key), `missing key not named: ${key}`);
    }
    assert.ok(cached.includes('say nothing about it'));
  });

  it('skips empty, whitespace and non-string brain values', () => {
    const prompt = build({
      brain: {
        services: 'Websites.',
        pricing: '',
        availability: '   ',
        // The brain column is `text not null`, but the value arrives through
        // PostgREST and JSON, and a partial projection is a null away.
        positioning: null as unknown as string,
        case_studies: undefined as unknown as string,
      },
    });
    const cached = cachedBlock(prompt);

    assert.ok(cached.includes('### services'));
    assert.ok(!cached.includes('### pricing'));
    assert.ok(!cached.includes('### positioning'));
    assert.ok(!cached.toLowerCase().includes('undefined'));
    assert.ok(cached.includes('Not recorded:'));
  });

  it('keeps the drafting rules in the cached block, whatever the brain says', () => {
    // "Assembled from brain" governs business facts. The rules are SPEC §4
    // itself and must survive an empty brain, or the empty-brain run has no
    // instructions at all.
    for (const brain of [FULL_BRAIN, {}]) {
      const cached = cachedBlock(build({ brain }));
      assert.ok(cached.includes(`Under ${WORD_LIMIT} words`), 'the word limit must be stated');
      assert.ok(cached.includes('one ask'), 'the one-ask rule must be stated');
      assert.ok(cached.includes('I hope this email finds you well'), 'filler must be named');
      assert.ok(cached.includes('Never invent'), 'the no-invention rule must be stated');
      assert.ok(cached.includes('should_contact: false'));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Language and register — SPEC §4
// ---------------------------------------------------------------------------

describe('language and register (SPEC §4)', () => {
  it('writes Greek in the formal register for a Greek contact with no history', () => {
    const text = perContactBlocks(build({ contact: contact({ language: 'el' }) }));

    assert.ok(text.includes('Write this message in Greek'));
    assert.ok(text.includes('πληθυντικός ευγενείας'), 'the formal register must be named in Greek');
    assert.ok(text.includes('in the formal register'));
  });

  it('writes English for an English contact', () => {
    const text = perContactBlocks(build({ contact: contact({ language: 'en' }) }));

    assert.ok(text.includes('Write this message in English'));
    assert.ok(!text.includes('πληθυντικός'), 'no Greek register instruction on an English message');
  });

  it("prefers the contact's own messages over the language column", () => {
    // A CSV import defaults every row to 'el'. Someone who has only ever
    // written in English must not be answered in Greek because of a default.
    const text = perContactBlocks(
      build({
        contact: contact({ language: 'el' }),
        interactions: [
          interaction({
            direction: 'in',
            subject: 'Website quote',
            body: 'Hi, could you send me a quote for a new website? Thanks.',
          }),
        ],
      }),
    );

    assert.ok(text.includes('Write this message in English'));
    assert.ok(text.includes("Chosen from this contact's own messages"));
  });

  it('answers in Greek when the record says English but the contact writes Greek', () => {
    const text = perContactBlocks(
      build({
        contact: contact({ language: 'en' }),
        interactions: [
          interaction({ direction: 'in', body: 'Καλησπέρα, θα ήθελα μια προσφορά για το site.' }),
        ],
      }),
    );

    assert.ok(text.includes('Write this message in Greek'));
  });

  it('ignores the language of outbound messages when choosing a language', () => {
    // What the owner writes is his habit, not evidence about them.
    const text = perContactBlocks(
      build({
        contact: contact({ language: 'en' }),
        interactions: [
          interaction({ direction: 'out', body: 'Καλησπέρα σας, στέλνω την προσφορά.' }),
        ],
      }),
    );

    assert.ok(text.includes('Write this message in English'));
    assert.ok(text.includes('has never written to you'));
  });

  it('falls back to the record when the contact has written nothing legible', () => {
    const text = perContactBlocks(
      build({
        contact: contact({ language: 'en' }),
        interactions: [interaction({ direction: 'in', body: '+30 6900 000000 — 15/09 ;)' })],
      }),
    );

    assert.ok(text.includes('Write this message in English'));
    assert.ok(text.includes('has written nothing that identifies a language'));
  });

  it('stays informal when the thread is already informal', () => {
    // "unless prior interactions show otherwise" — this is the "otherwise".
    const text = perContactBlocks(
      build({
        contact: contact({ language: 'el' }),
        interactions: [
          interaction({ direction: 'in', body: 'Γεια σου Κώστα, το site σου το είδα, μπράβο!' }),
          interaction({ direction: 'out', body: 'Ευχαριστώ! Θα σου στείλω λεπτομέρειες.' }),
        ],
      }),
    );

    assert.ok(text.includes('Write this message in Greek'));
    assert.ok(text.includes('stay in that register'));
    assert.ok(!text.includes('in the formal register'));
  });

  it('stays formal when the thread uses πληθυντικός ευγενείας', () => {
    const text = perContactBlocks(
      build({
        contact: contact({ language: 'el' }),
        interactions: [
          interaction({ direction: 'in', body: 'Καλησπέρα σας, θα ήθελα να σας ρωτήσω κάτι.' }),
        ],
      }),
    );

    assert.ok(text.includes('in the formal register'));
    assert.ok(!text.includes('stay in that register'));
  });

  it('defaults to Greek and says so when nothing identifies a language', () => {
    const text = perContactBlocks(
      build({ brain: {}, contact: emptyContact(), interactions: [] }),
    );

    assert.ok(text.includes('Write this message in Greek'));
    assert.ok(text.includes('Neither the history nor the contact record'));
    assert.ok(text.includes('follow the history'), 'the model must be free to override the guess');
  });
});

// ---------------------------------------------------------------------------
// 4. Tags — PLAN §4.1
// ---------------------------------------------------------------------------

describe('tags (PLAN §4.1)', () => {
  it('puts the tags in the prompt and says they must change the message', () => {
    const text = perContactBlocks(build({ contact: contact({ tags: ['ecommerce', 'redesign'] }) }));

    assert.ok(text.includes('ecommerce'));
    assert.ok(text.includes('redesign'));
    assert.ok(text.includes('what this contact needed or bought'));
  });

  it('gives an ecommerce contact a materially different prompt from an nfc-card one', () => {
    const shop = build({ contact: contact({ tags: ['ecommerce'] }) });
    const card = build({ contact: contact({ tags: ['nfc-card'] }) });

    assert.notEqual(perContactBlocks(shop), perContactBlocks(card));
    assert.ok(perContactBlocks(shop).includes('Tags: ecommerce'));
    assert.ok(perContactBlocks(card).includes('Tags: nfc-card'));
  });

  it('says plainly that there are no tags rather than rendering an empty list', () => {
    const text = perContactBlocks(build({ contact: contact({ tags: [] }) }));

    assert.ok(text.includes('has no tags'));
    assert.ok(!text.includes('Tags:'));
    assert.ok(text.includes('Do not guess'));
  });

  it('survives a tags column that arrives null from a partial projection', () => {
    const text = perContactBlocks(
      build({ contact: contact({ tags: null as unknown as string[] }) }),
    );

    assert.ok(text.includes('has no tags'));
    assert.ok(!text.toLowerCase().includes('undefined'));
  });
});

// ---------------------------------------------------------------------------
// 5. The contact record and the history
// ---------------------------------------------------------------------------

describe('the contact dossier', () => {
  it('renders the fields that shape a draft', () => {
    const { user } = build({ contact: contact({ notes: 'Prefers WhatsApp.' }) });

    assert.ok(user.includes('Μαρία Παπαδοπούλου'));
    assert.ok(user.includes('Καφέ Νέα'));
    assert.ok(user.includes('Stage: quoted'));
    assert.ok(user.includes('Prefers WhatsApp.'));
    assert.ok(user.includes('2026-06-01'), 'last_touch_at should be rendered as a date');
  });

  it('keeps the email address and phone number out of the prompt', () => {
    // Nothing in a draft needs them, and everything in a prompt is copied into
    // agent_runs.input and a third party's logs.
    const { user } = build();

    assert.ok(!user.includes('maria@example.gr'));
    assert.ok(!user.includes('+30 2310 000000'));
  });

  it('marks the notes and the value estimate as private so they are not quoted back', () => {
    const { user } = build({
      contact: contact({ notes: 'Haggled hard last time.', value_estimate: 1500 }),
    });

    assert.ok(user.includes('never to be quoted back'));
    assert.ok(
      user.includes('never to be mentioned to them'),
      "the owner's deal-size estimate must be marked internal",
    );
    assert.ok(!user.includes('€'), 'the schema records no currency, so the prompt must not invent one');
  });

  it('says there is no history when there is none', () => {
    const { user } = build({ interactions: [] });

    assert.ok(user.includes('There is no recorded conversation with this person at all'));
    assert.ok(!user.toLowerCase().includes('undefined'));
  });

  it('renders the history oldest first even when the query returns it newest first', () => {
    // `.order('occurred_at', { ascending: false }).limit(10)` is the natural
    // query. Rendered in that order, the model answers the oldest message.
    const { user } = build({
      interactions: [
        interaction({ id: 'b', occurred_at: '2026-06-01T09:00:00.000Z', body: 'SECOND MESSAGE' }),
        interaction({ id: 'a', occurred_at: '2026-01-05T09:00:00.000Z', body: 'FIRST MESSAGE' }),
      ],
    });

    assert.ok(user.indexOf('FIRST MESSAGE') < user.indexOf('SECOND MESSAGE'));
  });

  it('renders at most the last ten exchanges', () => {
    const many = Array.from({ length: 14 }, (_, index) =>
      interaction({
        id: `i${index}`,
        occurred_at: `2026-01-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
        body: `MESSAGE ${index}`,
      }),
    );

    const { user } = build({ interactions: many });

    assert.ok(!user.includes('MESSAGE 0'), 'the oldest exchanges should be dropped');
    assert.ok(!user.includes('MESSAGE 3'));
    assert.ok(user.includes('MESSAGE 4'), 'the tenth-most-recent should survive');
    assert.ok(user.includes('MESSAGE 13'), 'the newest must always survive');
    assert.ok(user.includes('The last 10 exchanges'));
  });

  it('labels direction in plain words', () => {
    const { user } = build({
      interactions: [
        interaction({ id: 'in', direction: 'in', body: 'THEIR WORDS' }),
        interaction({ id: 'out', direction: 'out', body: 'MY WORDS' }),
        interaction({ id: 'unknown', direction: null, body: 'ORPHAN' }),
      ],
    });

    assert.ok(user.includes('them → you'));
    assert.ok(user.includes('you → them'));
    assert.ok(user.includes('direction not recorded'));
  });

  it('truncates a pasted wall of text rather than paying for it', () => {
    const { user } = build({
      interactions: [interaction({ body: `${'x'.repeat(5000)} TAIL` })],
    });

    assert.ok(user.includes('[truncated]'));
    assert.ok(!user.includes('TAIL'));
    assert.ok(user.length < 6000, 'the truncated prompt should not carry the whole wall');
  });

  it('says the contact is due today without claiming to know today', () => {
    const { user } = build();

    assert.ok(user.includes('due today or is overdue'));
    assert.ok(user.includes('not itself a reason to write'));
  });
});

// ---------------------------------------------------------------------------
// 6. The schema — SPEC §4, exactly
// ---------------------------------------------------------------------------

describe('the JSON schema (SPEC §4)', () => {
  it('has exactly the six specified fields, all required', () => {
    const { schema } = build();
    const expected = [
      'should_contact',
      'reason',
      'subject',
      'body',
      'suggested_next_touch_days',
      'confidence',
    ];

    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(properties).sort(), [...expected].sort());
    assert.deepEqual([...(schema['required'] as string[])].sort(), [...expected].sort());
    assert.equal(schema['additionalProperties'], false);
    assert.equal(schema['type'], 'object');
  });

  it('types each field the way SPEC §4 shows it', () => {
    const properties = build().schema['properties'] as Record<string, Record<string, unknown>>;

    assert.equal(properties['should_contact']?.['type'], 'boolean');
    assert.equal(properties['reason']?.['type'], 'string');
    assert.equal(properties['subject']?.['type'], 'string');
    assert.equal(properties['body']?.['type'], 'string');
    assert.equal(properties['suggested_next_touch_days']?.['type'], 'integer');
    assert.deepEqual(properties['confidence']?.['enum'], ['low', 'medium', 'high']);
  });

  it('uses no constraint the structured-output API rejects', () => {
    // PLAN §2: minLength / maxLength / minimum / maximum / minItems are not
    // supported. A schema carrying one 400s the whole run at 08:00.
    const serialised = JSON.stringify(build().schema);

    for (const banned of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'pattern']) {
      assert.ok(!serialised.includes(banned), `unsupported schema keyword present: ${banned}`);
    }
  });

  it('returns the same frozen schema every time so the 24h schema cache hits', () => {
    const first = build().schema;
    const second = build({ contact: emptyContact() }).schema;

    assert.equal(first, second);
    assert.ok(Object.isFrozen(first));
  });
});

// ---------------------------------------------------------------------------
// 7. isWithinWordLimit — the half of the 120-word rule the schema cannot do
// ---------------------------------------------------------------------------

describe('isWithinWordLimit', () => {
  const words = (count: number): string => Array.from({ length: count }, () => 'word').join(' ');

  it('defaults to the SPEC §4 limit of 120 words', () => {
    assert.equal(WORD_LIMIT, 120);
    assert.equal(isWithinWordLimit(words(120)), true);
    assert.equal(isWithinWordLimit(words(121)), false);
  });

  it('counts words, not characters', () => {
    assert.equal(isWithinWordLimit('x'.repeat(10_000)), true);
  });

  it('treats any run of whitespace as one separator', () => {
    assert.equal(isWithinWordLimit('one   two\n\nthree\tfour', 4), true);
    assert.equal(isWithinWordLimit('one   two\n\nthree\tfour', 3), false);
  });

  it('counts Greek words the same way', () => {
    assert.equal(isWithinWordLimit('Καλησπέρα σας, στέλνω την προσφορά.', 5), true);
    assert.equal(isWithinWordLimit('Καλησπέρα σας, στέλνω την προσφορά.', 4), false);
  });

  it('accepts an empty body — zero words is within any limit', () => {
    // should_contact: false legitimately returns an empty body. "Is it empty" is
    // a different question with a different right answer.
    assert.equal(isWithinWordLimit(''), true);
    assert.equal(isWithinWordLimit('   \n  '), true);
  });

  it('rejects anything that is not a string', () => {
    // A malformed response must not slip through the one check that exists.
    assert.equal(isWithinWordLimit(undefined), false);
    assert.equal(isWithinWordLimit(null), false);
    assert.equal(isWithinWordLimit(42), false);
    assert.equal(isWithinWordLimit({ body: 'hello' }), false);
  });

  it('honours an explicit limit', () => {
    assert.equal(isWithinWordLimit(words(10), 10), true);
    assert.equal(isWithinWordLimit(words(11), 10), false);
    assert.equal(isWithinWordLimit(words(1), 0), false);
  });
});

// ---------------------------------------------------------------------------
// 8. No prompt ever contains "undefined"
// ---------------------------------------------------------------------------

describe('no prompt ever renders a missing value', () => {
  const cases: readonly (readonly [string, FollowupPromptInput])[] = [
    ['empty brain, empty contact, no history', { brain: {}, contact: emptyContact(), interactions: [] }],
    ['full brain, empty contact', { brain: FULL_BRAIN, contact: emptyContact(), interactions: [] }],
    [
      'partial brain, full contact',
      { brain: { services: 'Websites.' }, contact: contact(), interactions: [] },
    ],
    [
      'interactions with nothing in them',
      {
        brain: {},
        contact: emptyContact(),
        interactions: [
          interaction({ subject: null, body: null, channel: null, direction: null, occurred_at: null }),
          interaction({ id: 'two', subject: '   ', body: '   ', occurred_at: 'not a date' }),
        ],
      },
    ],
    [
      'everything populated',
      {
        brain: FULL_BRAIN,
        contact: contact({ notes: 'Knows the owner from school.' }),
        interactions: [
          interaction({ direction: 'in', subject: 'Προσφορά', body: 'Καλησπέρα σας.' }),
          interaction({ direction: 'out', subject: 'Re: Προσφορά', body: 'Στέλνω την προσφορά.' }),
        ],
      },
    ],
  ];

  for (const [name, input] of cases) {
    it(`${name}: no "undefined", no "null", no "[object Object]"`, () => {
      const text = allText(buildFollowupPrompt(input)).toLowerCase();

      assert.ok(!text.includes('undefined'), 'a missing value reached the prompt as "undefined"');
      assert.ok(!text.includes('[object object]'), 'an object was stringified into the prompt');
      assert.ok(!text.includes(': null'), 'a null column reached the prompt as "null"');
      assert.ok(!text.includes('nan'), 'a bad number reached the prompt as NaN');
    });
  }

  it('still produces a coherent, complete prompt from nothing at all', () => {
    // The degenerate case must still be usable: an empty brain and an empty
    // contact is what a first real run looks like today.
    const prompt = buildFollowupPrompt({ brain: {}, contact: emptyContact(), interactions: [] });

    assert.equal(prompt.system[0]?.cache, true);
    assert.ok(cachedBlock(prompt).includes('should_contact: false'));
    assert.ok(perContactBlocks(prompt).includes('Write this message in Greek'));
    assert.ok(prompt.user.includes('Almost nothing is recorded about this contact.'));
    assert.ok(prompt.user.includes('Now decide'));
  });
});
