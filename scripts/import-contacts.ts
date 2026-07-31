/**
 * import-contacts.ts — Agency OS, step 1 (foundation).
 *
 * Imports the existing contact list from a CSV into the `contacts` table.
 *
 *   Dry run (default, writes nothing):
 *     pnpm import:contacts ./contacts.csv
 *
 *   Actually write:
 *     pnpm import:contacts ./contacts.csv --commit
 *
 * (Both wrap `tsx --env-file-if-exists=.env scripts/import-contacts.ts`, run from
 * the repo root. NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.)
 *
 * This is a one-shot operation against real business data, so it is dry-run by
 * default and requires an explicit --commit to insert anything.
 *
 * Column mapping lives in the MAPPING constant below — that is the one place to
 * edit when the real CSV arrives. Full documentation of the expected file:
 * scripts/CONTACTS_CSV.md
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';

// The service client (service role key) bypasses RLS, which is what an operator
// script needs. NOTE: this is the one line to change if packages/core exports
// the service client under a different name — see CONTACTS_CSV.md § Assumptions.
import { createServiceClient } from '@agency/core';
// The insert shape and the accepted vocabularies come from the shared schema
// types, so a column the migration does not have — or a stage the CHECK
// constraint would reject — fails `pnpm typecheck` instead of failing at 3am
// against real data.
import type { ContactInsert, Language, Source, Stage } from '@agency/core';

// ---------------------------------------------------------------------------
// MAPPING — edit this and nothing else when the real CSV arrives.
//
// Key   = column in the `contacts` table (PLAN.md §4).
// Value = header in the CSV file.
//
// Header matching is forgiving: case, surrounding whitespace, spaces vs
// underscores vs hyphens, and a BOM are all normalised away before comparison,
// so "Value Estimate", "value-estimate" and "VALUE_ESTIMATE" all match
// 'value_estimate'. Set a value to null to ignore that column entirely.
// ---------------------------------------------------------------------------

const MAPPING = {
  name: 'name',
  business: 'business',
  email: 'email',
  phone: 'phone',
  language: 'language',
  city: 'city',
  country: 'country',
  // Optional explicit override. Left blank, timezone is derived from
  // country/city and defaults to Europe/Athens (PLAN.md §7.1).
  timezone: 'timezone',
  source: 'source',
  stage: 'stage',
  value_estimate: 'value_estimate',
  notes: 'notes',
  last_touch_at: 'last_touch_at',
  next_touch_at: 'next_touch_at',
  touch_count: 'touch_count',
  do_not_contact: 'do_not_contact',
} as const satisfies Record<string, string | null>;

type ContactColumn = keyof typeof MAPPING;

// ---------------------------------------------------------------------------
// Accepted values (PLAN.md §4)
// ---------------------------------------------------------------------------

const SOURCES = [
  'nfc_card',
  'referral',
  'inbound',
  'outbound',
  'walk_in',
] as const satisfies readonly Source[];

const STAGES = [
  'new',
  'contacted',
  'replied',
  'quoted',
  'won',
  'lost',
  'dormant',
] as const satisfies readonly Stage[];

const DEFAULT_TIMEZONE = 'Europe/Athens';
const DEFAULT_LANGUAGE: Language = 'el';
const DEFAULT_COUNTRY = 'GR';
const DEFAULT_STAGE: Stage = 'new';

/** Free-text language values we accept, normalised to 'el' | 'en'. */
const LANGUAGE_ALIASES: Record<string, Language> = {
  el: 'el',
  gr: 'el',
  ell: 'el',
  gre: 'el',
  greek: 'el',
  hellenic: 'el',
  ελληνικα: 'el',
  ελληνικά: 'el',
  en: 'en',
  eng: 'en',
  english: 'en',
  gb: 'en',
  uk: 'en',
  us: 'en',
  αγγλικα: 'en',
  αγγλικά: 'en',
};

/** Country names we accept in place of an ISO-3166-1 alpha-2 code. */
const COUNTRY_ALIASES: Record<string, string> = {
  greece: 'GR',
  hellas: 'GR',
  ελλαδα: 'GR',
  ελλάδα: 'GR',
  cyprus: 'CY',
  κυπρος: 'CY',
  κύπρος: 'CY',
  'united kingdom': 'GB',
  uk: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'great britain': 'GB',
  ireland: 'IE',
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  america: 'US',
  canada: 'CA',
  germany: 'DE',
  deutschland: 'DE',
  france: 'FR',
  italy: 'IT',
  italia: 'IT',
  spain: 'ES',
  españa: 'ES',
  portugal: 'PT',
  netherlands: 'NL',
  holland: 'NL',
  belgium: 'BE',
  austria: 'AT',
  switzerland: 'CH',
  sweden: 'SE',
  norway: 'NO',
  denmark: 'DK',
  finland: 'FI',
  poland: 'PL',
  czechia: 'CZ',
  'czech republic': 'CZ',
  romania: 'RO',
  bulgaria: 'BG',
  serbia: 'RS',
  croatia: 'HR',
  hungary: 'HU',
  slovenia: 'SI',
  slovakia: 'SK',
  albania: 'AL',
  'north macedonia': 'MK',
  malta: 'MT',
  luxembourg: 'LU',
  turkey: 'TR',
  türkiye: 'TR',
  israel: 'IL',
  uae: 'AE',
  'united arab emirates': 'AE',
  'saudi arabia': 'SA',
  egypt: 'EG',
  'south africa': 'ZA',
  india: 'IN',
  singapore: 'SG',
  'hong kong': 'HK',
  japan: 'JP',
  china: 'CN',
  australia: 'AU',
  'new zealand': 'NZ',
  brazil: 'BR',
};

/**
 * Country → IANA timezone. For countries spanning several zones this is the
 * commercial-centre default; a city match (CITY_TIMEZONES) wins over it, and an
 * explicit `timezone` CSV column wins over both.
 */
const COUNTRY_TIMEZONES: Record<string, string> = {
  GR: 'Europe/Athens',
  CY: 'Asia/Nicosia',
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels',
  AT: 'Europe/Vienna',
  CH: 'Europe/Zurich',
  SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen',
  FI: 'Europe/Helsinki',
  PL: 'Europe/Warsaw',
  CZ: 'Europe/Prague',
  RO: 'Europe/Bucharest',
  BG: 'Europe/Sofia',
  RS: 'Europe/Belgrade',
  HR: 'Europe/Zagreb',
  HU: 'Europe/Budapest',
  SI: 'Europe/Ljubljana',
  SK: 'Europe/Bratislava',
  AL: 'Europe/Tirane',
  MK: 'Europe/Skopje',
  ME: 'Europe/Podgorica',
  MT: 'Europe/Malta',
  LU: 'Europe/Luxembourg',
  LT: 'Europe/Vilnius',
  LV: 'Europe/Riga',
  EE: 'Europe/Tallinn',
  UA: 'Europe/Kyiv',
  TR: 'Europe/Istanbul',
  IL: 'Asia/Jerusalem',
  AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  EG: 'Africa/Cairo',
  ZA: 'Africa/Johannesburg',
  IN: 'Asia/Kolkata',
  SG: 'Asia/Singapore',
  HK: 'Asia/Hong_Kong',
  JP: 'Asia/Tokyo',
  CN: 'Asia/Shanghai',
  NZ: 'Pacific/Auckland',
  RU: 'Europe/Moscow',
  US: 'America/New_York',
  CA: 'America/Toronto',
  AU: 'Australia/Sydney',
  BR: 'America/Sao_Paulo',
};

/** City → IANA timezone, only for countries that span several zones. */
const CITY_TIMEZONES: Record<string, string> = {
  'new york': 'America/New_York',
  brooklyn: 'America/New_York',
  boston: 'America/New_York',
  philadelphia: 'America/New_York',
  washington: 'America/New_York',
  atlanta: 'America/New_York',
  miami: 'America/New_York',
  orlando: 'America/New_York',
  detroit: 'America/Detroit',
  chicago: 'America/Chicago',
  dallas: 'America/Chicago',
  houston: 'America/Chicago',
  austin: 'America/Chicago',
  minneapolis: 'America/Chicago',
  denver: 'America/Denver',
  'salt lake city': 'America/Denver',
  phoenix: 'America/Phoenix',
  'los angeles': 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  'san diego': 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  portland: 'America/Los_Angeles',
  toronto: 'America/Toronto',
  ottawa: 'America/Toronto',
  montreal: 'America/Toronto',
  calgary: 'America/Edmonton',
  edmonton: 'America/Edmonton',
  vancouver: 'America/Vancouver',
  sydney: 'Australia/Sydney',
  canberra: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne',
  brisbane: 'Australia/Brisbane',
  adelaide: 'Australia/Adelaide',
  perth: 'Australia/Perth',
};

// ---------------------------------------------------------------------------
// The row shape we insert. Deliberately a subset of `contacts` — id, created_at
// and the agent-owned counters are left to the database and to the agents.
// ---------------------------------------------------------------------------

type ContactRow = ContactInsert & {
  // Narrower than the table allows: a row without an email cannot be actioned by
  // the v1 loop and is rejected before it gets here.
  email: string;
  language: Language;
  country: string;
  timezone: string;
  source: Source | null;
  stage: Stage;
  touch_count: number;
  do_not_contact: boolean;
};

type Reject = { row: number; email: string; reasons: string[] };
type Skip = { row: number; email: string; reason: string };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const normaliseHeader = (h: string): string =>
  h
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/^_+|_+$/g, '');

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Deliberately permissive — this rejects obvious junk, not exotic addresses. */
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

function parseBoolean(raw: string): boolean | null {
  const v = raw.toLowerCase();
  if (v === '') return false;
  if (['true', 'yes', 'y', '1', 'ναι', 'x'].includes(v)) return true;
  if (['false', 'no', 'n', '0', 'οχι', 'όχι'].includes(v)) return false;
  return null;
}

/**
 * Parses money-ish strings. Handles both "1.200,50" (European) and "1,200.50"
 * (Anglo) by treating whichever separator appears last as the decimal point.
 */
function parseNumber(raw: string): number | null {
  let v = raw.replace(/[€$£\s ]/g, '');
  if (v === '') return null;
  const lastComma = v.lastIndexOf(',');
  const lastDot = v.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    v = lastComma > lastDot ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // "1,200" reads as thousands; "1200,5" reads as a decimal comma.
    v = /^\d{1,3}(,\d{3})+$/.test(v) ? v.replace(/,/g, '') : v.replace(',', '.');
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Accepts ISO 8601, YYYY-MM-DD, and DD/MM/YYYY. Slashes are read DAY-FIRST
 * (European convention — the operator is in Greece). A bare date becomes
 * midnight UTC, which is before the 08:00 Europe/Athens follow-up run, so a
 * contact dated "today" is picked up that same morning.
 */
function parseTimestamp(raw: string): string | null {
  if (raw === '') return null;
  let v = raw;
  const slashed = v.match(/^(\d{1,2})[/](\d{1,2})[/](\d{4})$/);
  if (slashed) {
    // The regex guarantees all three groups, but the compiler does not know
    // that under noUncheckedIndexedAccess.
    const d = slashed[1] ?? '';
    const m = slashed[2] ?? '';
    const y = slashed[3] ?? '';
    v = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v = `${v}T00:00:00Z`;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** PLAN.md §7.1 — timezone is derived from country/city, defaulting to Athens. */
function deriveTimezone(country: string, city: string, explicit: string): string {
  if (explicit && isValidTimezone(explicit)) return explicit;
  const byCity = CITY_TIMEZONES[city.toLowerCase()];
  if (byCity) return byCity;
  return COUNTRY_TIMEZONES[country] ?? DEFAULT_TIMEZONE;
}

function normaliseCountry(raw: string): string | null {
  if (raw === '') return DEFAULT_COUNTRY;
  const lower = raw.toLowerCase();
  const alias = COUNTRY_ALIASES[lower];
  if (alias) return alias;
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return null;
}

// ---------------------------------------------------------------------------
// Row → ContactRow
// ---------------------------------------------------------------------------

function get(row: Record<string, unknown>, column: ContactColumn): string {
  const header = MAPPING[column] as string | null;
  if (!header) return '';
  return clean(row[normaliseHeader(header)]);
}

function buildContact(row: Record<string, unknown>): { contact: ContactRow } | { reasons: string[] } {
  const reasons: string[] = [];

  const name = get(row, 'name');
  const business = get(row, 'business');
  const email = get(row, 'email').toLowerCase();

  if (!email) {
    reasons.push('missing email — the v1 loop is email follow-up, a contact without one cannot be actioned');
  } else if (!EMAIL_RE.test(email)) {
    reasons.push(`malformed email "${email}"`);
  }
  if (!name && !business) reasons.push('missing both name and business — nothing to address the contact as');

  const rawLanguage = get(row, 'language').toLowerCase();
  let language: Language = DEFAULT_LANGUAGE;
  if (rawLanguage) {
    const mapped = LANGUAGE_ALIASES[rawLanguage];
    if (!mapped) {
      reasons.push(`unrecognised language "${rawLanguage}" — expected el or en (blank defaults to el)`);
    } else {
      language = mapped;
    }
  }

  const rawCountry = get(row, 'country');
  const country = normaliseCountry(rawCountry);
  if (country === null) reasons.push(`unrecognised country "${rawCountry}" — use an ISO alpha-2 code such as GR`);

  const rawSource = get(row, 'source').toLowerCase().replace(/[\s-]+/g, '_');
  let source: Source | null = null;
  if (rawSource) {
    if (SOURCES.includes(rawSource as Source)) {
      source = rawSource as Source;
    } else {
      reasons.push(`unrecognised source "${rawSource}" — expected one of ${SOURCES.join(', ')}`);
    }
  }

  const rawStage = get(row, 'stage').toLowerCase().replace(/[\s-]+/g, '_');
  let stage: Stage = DEFAULT_STAGE;
  if (rawStage) {
    if (STAGES.includes(rawStage as Stage)) {
      stage = rawStage as Stage;
    } else {
      reasons.push(`unrecognised stage "${rawStage}" — expected one of ${STAGES.join(', ')}`);
    }
  }

  const rawValue = get(row, 'value_estimate');
  const valueEstimate = rawValue ? parseNumber(rawValue) : null;
  if (rawValue && valueEstimate === null) reasons.push(`value_estimate "${rawValue}" is not a number`);

  const rawTouchCount = get(row, 'touch_count');
  const touchCount = rawTouchCount ? Number(rawTouchCount) : 0;
  if (!Number.isInteger(touchCount) || touchCount < 0) {
    reasons.push(`touch_count "${rawTouchCount}" is not a non-negative integer`);
  }

  const rawLastTouch = get(row, 'last_touch_at');
  const lastTouchAt = parseTimestamp(rawLastTouch);
  if (rawLastTouch && lastTouchAt === null) reasons.push(`last_touch_at "${rawLastTouch}" is not a date`);

  const rawNextTouch = get(row, 'next_touch_at');
  const nextTouchAt = parseTimestamp(rawNextTouch);
  if (rawNextTouch && nextTouchAt === null) reasons.push(`next_touch_at "${rawNextTouch}" is not a date`);

  const rawDnc = get(row, 'do_not_contact');
  const doNotContact = parseBoolean(rawDnc);
  if (doNotContact === null) reasons.push(`do_not_contact "${rawDnc}" is not a yes/no value`);

  const rawTimezone = get(row, 'timezone');
  if (rawTimezone && !isValidTimezone(rawTimezone)) {
    reasons.push(`timezone "${rawTimezone}" is not a valid IANA zone`);
  }

  if (reasons.length > 0) return { reasons };

  const city = get(row, 'city');
  return {
    contact: {
      name: name || null,
      business: business || null,
      email,
      phone: get(row, 'phone') || null,
      language,
      city: city || null,
      country: country as string,
      timezone: deriveTimezone(country as string, city, rawTimezone),
      source,
      stage,
      value_estimate: valueEstimate,
      notes: get(row, 'notes') || null,
      last_touch_at: lastTouchAt,
      next_touch_at: nextTouchAt,
      touch_count: touchCount,
      do_not_contact: doNotContact as boolean,
    },
  };
}

// ---------------------------------------------------------------------------
// CSV loading
// ---------------------------------------------------------------------------

function loadRows(path: string): Record<string, unknown>[] {
  const raw = readFileSync(path, 'utf8');
  const seen = new Map<string, number>();
  return parse(raw, {
    bom: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
    columns: (header: string[]) =>
      header.map((h) => {
        const key = normaliseHeader(h);
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        // csv-parse rejects duplicate column names; suffix instead of crashing.
        return count === 1 ? key : `${key}__${count}`;
      }),
  }) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Existing emails, for cross-run deduplication
// ---------------------------------------------------------------------------

async function fetchExistingEmails(db: ReturnType<typeof createServiceClient>): Promise<Set<string>> {
  const existing = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from('contacts')
      .select('email')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const email = clean((row as { email: string | null }).email).toLowerCase();
      if (email) existing.add(email);
    }
    if (!data || data.length < pageSize) break;
  }
  return existing;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commit = argv.includes('--commit');
  const dryRunFlag = argv.includes('--dry-run');
  const path = argv.find((a) => !a.startsWith('--'));

  if (!path) {
    console.error('usage: pnpm import:contacts <path-to.csv> [--dry-run | --commit]');
    console.error('       dry run is the default; --commit is required to write anything');
    process.exit(2);
  }
  if (commit && dryRunFlag) {
    console.error('pass either --dry-run or --commit, not both');
    process.exit(2);
  }

  const absolute = resolve(process.cwd(), path);
  console.log(`${commit ? 'COMMIT' : 'DRY RUN'} — ${absolute}`);
  if (!commit) console.log('nothing will be written; re-run with --commit to insert\n');
  else console.log('');

  let rows: Record<string, unknown>[];
  try {
    rows = loadRows(absolute);
  } catch (err) {
    console.error(`could not read CSV: ${(err as Error).message}`);
    process.exit(1);
  }

  // Warn about mapped headers that the file does not actually contain — the
  // most likely cause of a silently empty import.
  const present = new Set(Object.keys(rows[0] ?? {}));
  const missing = (Object.entries(MAPPING) as [ContactColumn, string | null][])
    .filter(([, header]) => header && !present.has(normaliseHeader(header)))
    .map(([column, header]) => `${column} <- "${header}"`);
  if (missing.length > 0) {
    console.log(`headers in MAPPING not found in the CSV (those columns will be blank):\n  ${missing.join('\n  ')}\n`);
  }

  // Existing emails. In a dry run a database that is not reachable yet is not
  // fatal — step 1 often runs before the migration is applied.
  let db: ReturnType<typeof createServiceClient> | null = null;
  let existingEmails = new Set<string>();
  try {
    db = createServiceClient();
    existingEmails = await fetchExistingEmails(db);
    console.log(`${existingEmails.size} contact(s) already in the database\n`);
  } catch (err) {
    if (commit) {
      console.error(`could not reach the contacts table: ${(err as Error).message}`);
      process.exit(1);
    }
    console.log(`could not reach the contacts table (${(err as Error).message})`);
    console.log('continuing — duplicates are only checked within the file\n');
  }

  const toInsert: ContactRow[] = [];
  const rejects: Reject[] = [];
  const skips: Skip[] = [];
  const seenInFile = new Map<string, number>();

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const built = buildContact(row);
    if ('reasons' in built) {
      rejects.push({ row: rowNumber, email: clean(row[normaliseHeader(MAPPING.email)]), reasons: built.reasons });
      return;
    }
    const { contact } = built;
    const firstSeen = seenInFile.get(contact.email);
    if (firstSeen !== undefined) {
      skips.push({ row: rowNumber, email: contact.email, reason: `duplicate of row ${firstSeen} in this file` });
      return;
    }
    seenInFile.set(contact.email, rowNumber);
    if (existingEmails.has(contact.email)) {
      skips.push({ row: rowNumber, email: contact.email, reason: 'already in the database' });
      return;
    }
    toInsert.push(contact);
  });

  if (toInsert.length > 0) {
    console.log(`${commit ? 'inserting' : 'would insert'} ${toInsert.length} contact(s):`);
    for (const c of toInsert) {
      const who = [c.name, c.business].filter(Boolean).join(' / ') || '(no name)';
      const parts = [
        c.email,
        who,
        c.language,
        c.timezone,
        c.source ?? 'source:-',
        c.stage,
        c.next_touch_at ? `next:${c.next_touch_at.slice(0, 10)}` : 'next:-',
      ];
      if (c.do_not_contact) parts.push('DO-NOT-CONTACT');
      console.log(`  ${parts.join('  |  ')}`);
    }
    console.log('');
  }

  if (skips.length > 0) {
    console.log(`skipped ${skips.length} duplicate(s):`);
    skips.forEach((s, i) => console.log(`  ${i + 1}. row ${s.row} — ${s.email || '(no email)'} — ${s.reason}`));
    console.log('');
  }

  if (rejects.length > 0) {
    console.log(`rejected ${rejects.length} row(s) — fix these in the CSV and re-run:`);
    rejects.forEach((r, i) => {
      console.log(`  ${i + 1}. row ${r.row} — ${r.email || '(no email)'}`);
      for (const reason of r.reasons) console.log(`       ${reason}`);
    });
    console.log('');
  }

  let inserted = 0;
  let insertFailed = false;

  if (commit && toInsert.length > 0 && db) {
    const batchSize = 100;
    for (let i = 0; i < toInsert.length; i += batchSize) {
      const batch = toInsert.slice(i, i + batchSize);
      const { data, error } = await db.from('contacts').insert(batch).select('id');
      if (error) {
        insertFailed = true;
        console.error(`insert failed for rows ${i + 1}–${i + batch.length}: ${error.message}`);
        continue;
      }
      inserted += data?.length ?? batch.length;
    }
  }

  console.log('summary');
  console.log(`  ${commit ? 'inserted' : 'would insert'}: ${commit ? inserted : toInsert.length}`);
  console.log(`  skipped (duplicates): ${skips.length}`);
  console.log(`  rejected (invalid):   ${rejects.length}`);
  console.log(`  rows read:            ${rows.length}`);

  if (insertFailed || rejects.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
