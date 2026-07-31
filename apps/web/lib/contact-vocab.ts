/**
 * The contact vocabularies — the single source of truth for every stage, source
 * and language string in apps/web.
 *
 * **These ARE the CHECK constraints.** `contacts.language`, `.source` and
 * `.stage` each carry one in supabase/migrations/20260731120000_init.sql, and
 * every list below is that constraint, in the same order, typed with
 * `satisfies readonly Stage[]` against the unions in @agency/core. Adding a
 * value the migration does not have will not compile; adding one to the
 * migration and not here will not appear in a dropdown. That is the point.
 *
 * **Why this is its own module rather than part of lib/validation.ts.** The
 * dropdowns need these lists, and the dropdowns are Client Components.
 * lib/validation.ts value-imports `appTimezone` from @agency/core, whose barrel
 * re-exports the Supabase client factories — including the service-role one — so
 * it must never end up in a browser bundle. This file imports types from that
 * barrel, which TypeScript erases, and its one value import is from the
 * `@agency/core/cadence` subpath — a leaf module of pure functions and string
 * constants with no Supabase import at all. Both are safe in a browser bundle;
 * importing a value from `@agency/core` itself here would not be.
 *
 * It previously existed twice: once here (as `CONTACT_STAGES`) and once in
 * components/ui/stage-badge.tsx (as `STAGES`), with two copies of
 * `STAGE_LABELS`. They happened to agree. The next stage added would have made
 * the dropdown and the validator disagree about what is legal, silently, because
 * only one copy carried the `satisfies` constraint.
 */

import { DELIVERED_TAG, NFC_CARD_TAG } from '@agency/core/cadence';
import type { Language, Source, Stage } from '@agency/core';

/** contacts_stage_check. Order is the pipeline's own order, which is the order
 *  a dropdown should show. */
export const CONTACT_STAGES = [
  'new',
  'contacted',
  'replied',
  'quoted',
  'won',
  'lost',
  'dormant',
] as const satisfies readonly Stage[];

/** contacts_source_check. */
export const CONTACT_SOURCES = [
  'nfc_card',
  'referral',
  'inbound',
  'outbound',
  'walk_in',
] as const satisfies readonly Source[];

/** contacts_language_check. Default 'el' — this is a Greek business. */
export const CONTACT_LANGUAGES = ['el', 'en'] as const satisfies readonly Language[];

export const STAGE_LABELS: Record<Stage, string> = {
  new: 'New',
  contacted: 'Contacted',
  replied: 'Replied',
  quoted: 'Quoted',
  won: 'Won',
  lost: 'Lost',
  dormant: 'Dormant',
};

export const SOURCE_LABELS: Record<Source, string> = {
  nfc_card: 'NFC card',
  referral: 'Referral',
  inbound: 'Inbound',
  outbound: 'Outbound',
  walk_in: 'Walk-in',
};

export const LANGUAGE_LABELS: Record<Language, string> = {
  el: 'Greek',
  en: 'English',
};

// ---------------------------------------------------------------------------
// Tags — what the contact needs or bought
// ---------------------------------------------------------------------------

/**
 * Deliberately NOT a CHECK constraint, unlike everything above it.
 *
 * `contacts.tags` is `text[]` with no constraint, because the work this business
 * does is not a closed set — the next thing sold will not be in this list, and
 * a dropdown that cannot express it is worse than a free-text field. These are
 * suggestions offered in the UI so spelling stays consistent enough for the
 * filter to be useful; anything can be typed.
 *
 * Distinct from `source`, which is easy to conflate: `source` is how the contact
 * arrived (nfc_card, referral, walk_in), `tags` is what they need or bought.
 * Someone can arrive via an NFC card and want an e-commerce site — those are two
 * different facts and PLAN §4's cadence table treats them differently.
 *
 * Read by the follow-up agent at step 5: a contact tagged `ecommerce` gets a
 * materially different draft from one tagged `nfc-card`.
 *
 * **Two of these are load-bearing, not merely suggestions.** `nfc-card` and
 * `delivered` are the two rows of SPEC §4's cadence table that have no stage of
 * their own, so packages/core/src/cadence.ts keys off them: a `won` contact
 * tagged `nfc-card` is scheduled at +14 with an upsell reason, one tagged
 * `delivered` at +30 with a referral-and-testimonial reason, and an untagged
 * `won` contact at +30 as a plain retainer check-in. They are imported from
 * `@agency/core/cadence` rather than retyped so the chip an operator clicks and
 * the string the cadence matches cannot drift apart.
 */
export const SUGGESTED_TAGS = [
  'website',
  'web-app',
  'mobile-app',
  'ecommerce',
  NFC_CARD_TAG,
  'seo',
  'redesign',
  'hosting',
  'maintenance',
  'branding',
  DELIVERED_TAG,
] as const;

/** Max tags per contact. A guard against a paste accident, not a design limit. */
export const MAX_TAGS = 20;
/** Max characters per tag. */
export const MAX_TAG_LENGTH = 32;

/**
 * Lowercase, trim, collapse whitespace and underscores to single hyphens.
 *
 * The filter matches tags exactly, so `Web App`, `web app` and `web_app` must
 * not become three different tags. Applied on every write path — the form, the
 * CSV import, and the Server Action — so there is no route into the column that
 * skips it.
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LENGTH);
}

/**
 * Parse a comma-separated tag string into a normalized, de-duplicated list.
 * Order is preserved (first occurrence wins) so the operator's own ordering
 * survives a round-trip.
 */
export function parseTags(input: string | null | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(',')) {
    const tag = normalizeTag(part);
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Render a tag list back into the comma-separated form the input expects. */
export function formatTags(tags: readonly string[] | null | undefined): string {
  return (tags ?? []).join(', ');
}

/** The tag filter on /pipeline, where '' means no filter. */
export function toTagFilter(value: unknown): string {
  return typeof value === 'string' ? normalizeTag(value) : '';
}

// ---------------------------------------------------------------------------
// Guards. Server-side validation mirrors the CHECK constraints through these.
// ---------------------------------------------------------------------------

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (CONTACT_STAGES as readonly string[]).includes(value);
}

export function isSource(value: unknown): value is Source {
  return typeof value === 'string' && (CONTACT_SOURCES as readonly string[]).includes(value);
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (CONTACT_LANGUAGES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Ready-made `<Select options={…} />` lists. Plain data, built once.
// ---------------------------------------------------------------------------

export type VocabOption = { value: string; label: string };

export const STAGE_OPTIONS: readonly VocabOption[] = CONTACT_STAGES.map((stage) => ({
  value: stage,
  label: STAGE_LABELS[stage],
}));

export const SOURCE_OPTIONS: readonly VocabOption[] = CONTACT_SOURCES.map((source) => ({
  value: source,
  label: SOURCE_LABELS[source],
}));

export const LANGUAGE_OPTIONS: readonly VocabOption[] = CONTACT_LANGUAGES.map((language) => ({
  value: language,
  label: LANGUAGE_LABELS[language],
}));

/** The stage filter on /pipeline, where 'all' means no filter. */
export type StageFilter = Stage | 'all';

export const STAGE_FILTER_OPTIONS: readonly VocabOption[] = [
  { value: 'all', label: 'All stages' },
  ...STAGE_OPTIONS,
];

export function toStageFilter(value: unknown): StageFilter {
  return isStage(value) ? value : 'all';
}
