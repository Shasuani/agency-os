/**
 * What each brain key is for, in the operator's words.
 *
 * Pure data, no imports, safe in a client bundle — the same arrangement as
 * lib/contact-vocab.ts and for the same reason: the Client Components on /brain
 * must not value-import anything that reaches @agency/core, whose barrel
 * constructs the Supabase client factories.
 *
 * **The list of keys is not here.** Order and membership come from `BRAIN_KEYS`
 * in @agency/core, read server-side by `readBrain()`, so this file cannot drift
 * from the seeder into showing a key nothing writes or hiding one it does. This
 * is a label lookup keyed by string, with a fallback, and nothing else.
 *
 * The blurbs are written for someone deciding what to type, not for someone
 * cataloguing a schema. Each says what the drafting agent will do with the text,
 * because that is the only thing that makes the difference between a useful entry
 * and marketing copy — see brain/README.md, which is the longer version of the
 * same advice and lives next to the files themselves.
 */

export type BrainKeyMeta = {
  label: string;
  /** One line: what the agent does with this text. */
  blurb: string;
  /** Shown in an empty editor. Never auto-filled — an empty key is a real state. */
  placeholder: string;
};

const FALLBACK: BrainKeyMeta = {
  label: 'Unknown key',
  blurb: 'Not one of the eight keys the agents read.',
  placeholder: '',
};

const META: Record<string, BrainKeyMeta> = {
  services: {
    label: 'Services',
    blurb: 'What you actually sell. The agent will not offer anything that is not in here.',
    placeholder: 'Websites, e-commerce, NFC cards…',
  },
  pricing: {
    label: 'Pricing',
    blurb:
      'Numbers the agent is allowed to state in writing. If a figure is approximate, say so here or leave it out.',
    placeholder: 'Simple site from €800. Anything bigger is quoted…',
  },
  positioning: {
    label: 'Positioning',
    blurb: 'Who you are for and what makes you the obvious choice. Shapes what a follow-up leads with.',
    placeholder: 'Small businesses in Greece that need a site that works…',
  },
  tone_of_voice_el: {
    label: 'Tone of voice — Greek',
    blurb:
      'The sound of you, in Greek. The highest-leverage text in the project: paste in two or three emails you have actually sent.',
    placeholder: 'Γεια σου Μαρία, …',
  },
  tone_of_voice_en: {
    label: 'Tone of voice — English',
    blurb: 'The same, in English. Used for every contact whose language is set to English.',
    placeholder: 'Hi Maria, …',
  },
  case_studies: {
    label: 'Case studies',
    blurb:
      'Work you would happily name out loud. An invented case study is a lie you have to defend in a real conversation.',
    placeholder: 'A taverna in Chania — menu site, went live in a week…',
  },
  availability: {
    label: 'Availability',
    blurb: 'When you could actually start. Stops a follow-up promising a slot you do not have.',
    placeholder: 'Taking on two projects for September…',
  },
  retainer_offer: {
    label: 'Retainer offer',
    blurb: 'The ongoing arrangement, if you offer one. Referenced in the retainer check-in cadence.',
    placeholder: 'Monthly upkeep, small changes included…',
  },
};

export function brainMeta(key: string): BrainKeyMeta {
  return META[key] ?? { ...FALLBACK, label: key };
}
