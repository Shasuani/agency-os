/**
 * Load brain/*.md into the `brain` table.
 *
 *   pnpm seed              # dry run — prints what would be written
 *   pnpm seed --commit     # writes
 *
 * The content lives in `brain/` as plain Markdown rather than inside this file,
 * because it is business copy written by the owner, not code. Editing a .ts file
 * to change how you describe your own services is a needless obstacle in front
 * of the single most important text in the project.
 *
 * Re-runnable: every key is upserted, so the workflow is "edit the file, run it
 * again".
 *
 * This is the ONLY seeder for `brain`. supabase/seed.sql deliberately seeds only
 * `settings` — two seeders competing over the same eight keys means one silently
 * loses, and the loser is whichever one the owner actually edited.
 *
 * **HTML comments are stripped before writing.** The files carry
 * `<!-- fill this in -->` guidance meant for the owner, and none of it should
 * reach a model — an instruction addressed to a human, read by an agent, is
 * exactly how a prompt ends up doing something odd.
 *
 * A key whose file is empty after stripping is written as an empty string, not
 * skipped. That is the honest signal: the follow-up agent treats an empty brain
 * key as "we have nothing true to say about this" and stays quiet, which is the
 * behaviour SPEC §4 asks for.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServiceClient } from '@agency/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAIN_DIR = join(HERE, '..', 'brain');

/** The eight keys SPEC §3 seeds. One file each, `<key>.md`. */
const KEYS = [
  'services',
  'pricing',
  'positioning',
  'tone_of_voice_el',
  'tone_of_voice_en',
  'case_studies',
  'availability',
  'retainer_offer',
] as const;

type BrainKey = (typeof KEYS)[number];

/** Remove `<!-- ... -->` blocks — owner guidance, not content for a model. */
function stripComments(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function read(key: BrainKey): { value: string; missing: boolean } {
  const path = join(BRAIN_DIR, `${key}.md`);
  if (!existsSync(path)) return { value: '', missing: true };
  return { value: stripComments(readFileSync(path, 'utf8')), missing: false };
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');

  console.log(commit ? 'WRITING to the brain table' : 'DRY RUN — nothing will be written');
  console.log(`reading ${BRAIN_DIR}\n`);

  const entries = KEYS.map((key) => ({ key, ...read(key) }));

  let filled = 0;
  for (const entry of entries) {
    const words = entry.value === '' ? 0 : entry.value.split(/\s+/).length;
    if (words > 0) filled += 1;
    const state = entry.missing
      ? 'NO FILE'
      : words === 0
        ? 'empty — agent stays quiet on this'
        : `${words} words`;
    console.log(`  ${entry.key.padEnd(18)} ${state}`);
  }

  console.log(`\n${filled}/${KEYS.length} keys have content.`);

  if (filled === 0) {
    console.log(
      '\nEvery key is empty. That is a valid state — the follow-up agent will decide it\n' +
        'has nothing true to say and skip everyone — but it means no draft is ever written.\n' +
        'Start with brain/tone_of_voice_el.md: paste in two or three emails you have sent.',
    );
  }

  if (!commit) {
    console.log('\nRe-run with --commit to write.');
    return;
  }

  const supabase = createServiceClient();
  for (const entry of entries) {
    const { error } = await supabase
      .from('brain')
      .upsert({ key: entry.key, value: entry.value, updated_at: new Date().toISOString() });
    if (error !== null) {
      console.error(`  failed to write ${entry.key}: ${error.message}`);
      process.exit(1);
    }
  }
  console.log(`\nwrote ${entries.length} keys.`);
}

main().catch((error: unknown) => {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
