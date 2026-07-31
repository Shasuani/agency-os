/**
 * seed-brain.ts — Agency OS, step 1 (foundation).
 *
 * Upserts the `brain` keys (PLAN.md §4). Re-runnable: edit the BRAIN constant
 * below and run it again, and the changed keys are updated in place.
 *
 *   Dry run (default, writes nothing):
 *     pnpm seed
 *
 *   Actually write:
 *     pnpm seed --commit
 *
 * (Both wrap `tsx --env-file-if-exists=.env scripts/seed-brain.ts`, run from the
 * repo root. NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.)
 *
 * This is the ONLY seeder for `brain`. supabase/seed.sql deliberately seeds only
 * `settings` — two seeders competing over the same eight keys means one silently
 * loses, and the loser is whichever one the owner actually edited.
 *
 * This is the highest-leverage text in the system — the follow-up agent drafts
 * entirely from it (PLAN.md §9.2). The placeholders below are scaffolding, and
 * step 1 is not done until every one of them has been replaced with the owner's
 * own words. Two things the discussion settled, worth keeping in view while
 * writing them:
 *
 *   - Scope is broader than websites: apps, e-commerce, NFC cards. If `services`
 *     says "web development", the agent will pitch a website to someone who came
 *     about an app.
 *   - If there are distinct segments (a taverna wanting bookings vs. someone
 *     with an app idea), name them. The register for those two is completely
 *     different and the agent will otherwise flatten both into one voice.
 *
 * Safety: a key whose text below is still the shipped placeholder will never
 * overwrite a different value already in the database. That would mean throwing
 * away real content by re-running a seed script. Pass --force to override.
 */

// NOTE: this is the one line to change if packages/core exports the service
// client under a different name — see CONTACTS_CSV.md § Assumptions.
import { createServiceClient } from '@agency/core';
import type { BrainKey } from '@agency/core';

type BrainEntry = {
  /** True while the text is the scaffolding shipped with the repo. Set to false
   *  once it is the owner's real content — that is what makes the key writable
   *  over an existing different value. */
  placeholder: boolean;
  value: string;
};

// ---------------------------------------------------------------------------
// BRAIN — edit these, then re-run. Keys are fixed by PLAN.md §4 and typed against
// BRAIN_KEYS in @agency/core: adding, renaming or dropping one fails `pnpm
// typecheck` until the plan and the shared type agree.
// ---------------------------------------------------------------------------

const BRAIN: Record<BrainKey, BrainEntry> = {
  services: {
    placeholder: true,
    value: `TODO — what the business actually builds, in the owner's own words.

Scope is wider than "web development", and this text is what stops the agent
pitching a website to someone who came about an app. Name everything actually
sold: websites; custom apps (web and mobile); e-commerce stores and online
payments; NFC business cards and the profile pages behind them; getting an
existing business online and selling; building someone's idea into a working
product; ongoing maintenance and retainers.

If there are distinct segments — a taverna that wants bookings vs. someone with
an app idea — name them explicitly. The register for those two is completely
different and the agent will otherwise flatten both into one voice.`,
  },
  pricing: {
    placeholder: true,
    value: `TODO — real numbers, before step 5.

Typical price ranges or starting points per service (websites, apps, e-commerce,
NFC cards, retainers), what is included, deposit terms, and anything quoted per
project rather than fixed. The agent is instructed never to invent a price: if it
is not written here it will not be offered, and the draft will say so instead of
guessing.`,
  },
  positioning: {
    placeholder: true,
    value: `TODO — the through-line, not a service list.

Helping people get online and make money from it, or get an idea built. Websites,
apps, e-commerce and NFC cards are the means, not the pitch.

Say who this is for (small and local businesses in Greece, people with an idea and
no technical co-founder, shops that sell offline and not yet online), what makes it
different from an agency or a freelancer marketplace, and what the owner will not
take on. Solo operator in Greece, works in English and Greek.`,
  },
  tone_of_voice_el: {
    placeholder: true,
    value: `TODO — πώς γράφει ο ιδιοκτήτης στα ελληνικά.

Default: formal register, πληθυντικός ευγενείας, εκτός αν η προηγούμενη
επικοινωνία με τη συγκεκριμένη επαφή δείχνει αλλιώς. Σύντομα, χωρίς εταιρική
φλυαρία, ένα ξεκάθαρο αίτημα ανά μήνυμα, κάτω από 120 λέξεις.

Βάλε 2-3 πραγματικά email που έχει στείλει, ως παραδείγματα — τα δείγματα προς
μίμηση δουλεύουν πολύ καλύτερα από τα επίθετα.`,
  },
  tone_of_voice_en: {
    placeholder: true,
    value: `TODO — how the owner writes in English.

Direct, short, no corporate filler, no "I hope this email finds you well". First
person. One clear ask per message. Under 120 words.

Paste two or three real emails he has actually sent as examples — imitated samples
beat adjectives.`,
  },
  case_studies: {
    placeholder: true,
    value: `TODO — two to five real pieces of work.

Who the client was (or the type of business), what was built, and the outcome in
concrete terms: more bookings, first online sales, an idea shipped. These are the
only proof points the agent may cite. It is instructed never to invent a result,
so an empty entry here means the drafts carry no evidence at all.`,
  },
  availability: {
    placeholder: true,
    value: `TODO — current capacity. Keep this one current.

Whether new projects are being taken, roughly when the next slot opens, and typical
lead time to start. The agent uses this to decide whether a follow-up should push
for a call now or check back later, so a stale entry makes it promise time that does
not exist. This is the fact that goes stale fastest and it goes into real messages.`,
  },
  retainer_offer: {
    placeholder: true,
    value: `TODO — the ongoing offer for won clients, on the +30 day cadence.

What maintenance, hosting, updates, content or support is included, at what monthly
price, and the minimum term. This is what the agent proposes on check-ins with
clients whose project has been delivered.`,
  },
};

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commit = argv.includes('--commit');
  const dryRunFlag = argv.includes('--dry-run');
  const force = argv.includes('--force');

  if (commit && dryRunFlag) {
    console.error('pass either --dry-run or --commit, not both');
    process.exit(2);
  }

  console.log(commit ? 'COMMIT' : 'DRY RUN');
  if (!commit) console.log('nothing will be written; re-run with --commit to upsert\n');
  else console.log('');

  const db = createServiceClient();

  const { data, error } = await db.from('brain').select('key, value');
  if (error) {
    console.error(`could not read the brain table: ${error.message}`);
    process.exit(1);
  }
  const existing = new Map((data ?? []).map((r): [string, string] => [r.key, r.value]));

  const toWrite: { key: string; value: string }[] = [];
  const unchanged: string[] = [];
  const protectedKeys: string[] = [];
  const placeholders: string[] = [];

  for (const [key, entry] of Object.entries(BRAIN)) {
    if (entry.placeholder) placeholders.push(key);
    const current = existing.get(key);

    if (current === entry.value) {
      unchanged.push(key);
      continue;
    }
    if (current !== undefined && entry.placeholder && !force) {
      protectedKeys.push(key);
      continue;
    }
    toWrite.push({ key, value: entry.value });
    const label = current === undefined ? 'new' : 'update';
    console.log(`  ${commit ? 'writing' : 'would write'} ${key} (${label})`);
  }

  if (toWrite.length > 0) console.log('');

  if (protectedKeys.length > 0) {
    console.log('left alone — the database has different content and the text here is still a placeholder:');
    protectedKeys.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));
    console.log('  pass --force to overwrite anyway\n');
  }

  let written = 0;
  let writeFailed = false;

  if (commit && toWrite.length > 0) {
    const now = new Date().toISOString();
    const { data: result, error: upsertError } = await db
      .from('brain')
      .upsert(
        toWrite.map((row) => ({ ...row, updated_at: now })),
        { onConflict: 'key' },
      )
      .select('key');
    if (upsertError) {
      writeFailed = true;
      console.error(`upsert failed: ${upsertError.message}`);
    } else {
      written = result?.length ?? toWrite.length;
    }
  }

  console.log('summary');
  console.log(`  ${commit ? 'written' : 'would write'}: ${commit ? written : toWrite.length}`);
  console.log(`  unchanged:      ${unchanged.length}`);
  console.log(`  protected:      ${protectedKeys.length}`);
  console.log(`  keys total:     ${Object.keys(BRAIN).length}`);

  if (placeholders.length > 0) {
    console.log(`\n${placeholders.length} key(s) still hold placeholder text: ${placeholders.join(', ')}`);
    console.log('step 1 is not done, and the follow-up agent (step 5) must not run, until these are real.');
  }

  if (writeFailed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
