# contacts.csv — expected shape

What `scripts/import-contacts.ts` expects, and how to run it. Written before the
real CSV exists: **the column mapping here is a proposal, not a discovery.** When
the actual export arrives, change the `MAPPING` constant at the top of
`scripts/import-contacts.ts` to point at the real headers and update this file.
Nothing else in the script should need touching.

Target table: `contacts` (PLAN.md §4).

---

## How these scripts resolve

`scripts/` is deliberately **not** a pnpm workspace package — it is two operator
scripts, not a deployable. What makes them runnable is the root `package.json`,
which declares what they import:

| Package | Where | Why |
|---|---|---|
| `@agency/core` | root `dependencies`, as `workspace:*` | The service-role Supabase client and the schema types. A root workspace dependency is what links it into the root `node_modules`. |
| `csv-parse` | root `devDependencies`, `^5` | CSV parsing. The import uses the sync API: `import { parse } from 'csv-parse/sync'`. |
| `tsx` | root `devDependencies`, `^4` | Runs the TypeScript directly, same as the worker. Only `apps/worker` had it before, and that bin is not on the root path. |
| `@types/node` | root `devDependencies`, `^22` | `node:fs`, `node:path`, `process`. |

Typechecking: `scripts/tsconfig.json` extends `tsconfig.base.json`, and the root
`pnpm typecheck` runs `tsc -p scripts --noEmit` after the workspace pass —
`pnpm -r` never reaches a non-workspace directory on its own.

## Assumptions

Both scripts import the Supabase **service-role** client from the shared package:

```ts
import { createServiceClient } from '@agency/core';
```

The service role key bypasses RLS, which is what an operator script run from a
laptop needs. If `packages/core` ends up exporting that client under a different
name (`serviceClient`, `db`, …), change that single import line in
`scripts/import-contacts.ts` and `scripts/seed-brain.ts`. Nothing else in either
file touches the client construction.

The import script also takes its row shape from `@agency/core` — `ContactInsert`,
`Language`, `Source`, `Stage` — rather than redeclaring it. A column the migration
does not have, or a `stage` value the CHECK constraint would reject, fails
`pnpm typecheck` instead of failing against real data.

Environment (PLAN.md §8) — `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` must be set. Nothing loads `.env` implicitly; the
root `pnpm seed` / `pnpm import:contacts` scripts pass
`--env-file-if-exists=.env` (repo root) for you.

---

## Columns

Header matching is forgiving. Case, surrounding whitespace, a BOM, and spaces
vs. underscores vs. hyphens are all normalised away, so `Value Estimate`,
`value-estimate` and `VALUE_ESTIMATE` all match `value_estimate`. Columns in the
CSV that are not in `MAPPING` are ignored. Headers in `MAPPING` that are not in
the CSV are reported at the start of the run and left blank.

### Required

| Header | Rule |
|---|---|
| `email` | Must be present and syntactically valid. The v1 loop is email follow-up and dedupe is on email, so a row without one cannot be actioned — it is rejected rather than silently imported. |
| `name` **or** `business` | At least one. There has to be something to address the contact as. |

### Optional

| Header | Column | Accepted values / behaviour |
|---|---|---|
| `phone` | `phone` | Free text, stored as written. |
| `language` | `language` | `el` \| `en`. Also accepts `gr`, `greek`, `ελληνικά`, `eng`, `english`, `uk`, `us`. **Blank defaults to `el`.** An unrecognised value (e.g. `fr`) is rejected rather than defaulted — silently making a French contact Greek would corrupt every draft written for them. |
| `city` | `city` | Free text. Also used to derive `timezone` in multi-zone countries. |
| `country` | `country` | ISO 3166-1 alpha-2 (`GR`, `DE`, `US`). Common English and Greek country names are accepted (`Greece`, `Ελλάδα`, `United Kingdom`, `USA`). **Blank defaults to `GR`.** Anything unrecognised is rejected. |
| `timezone` | `timezone` | Explicit IANA zone, e.g. `Europe/Berlin`. Rarely needed — see *Timezone* below. Rejected if not a real zone. |
| `source` | `source` | One of `nfc_card`, `referral`, `inbound`, `outbound`, `walk_in`. Blank is allowed and stored as null. Anything else is rejected. Spaces and hyphens are normalised, so `NFC Card` works. |
| `stage` | `stage` | One of `new`, `contacted`, `replied`, `quoted`, `won`, `lost`, `dormant`. **Blank defaults to `new`.** Anything else is rejected. |
| `value_estimate` | `value_estimate` | A number. `€1.200,50`, `1,200.50` and `1200.5` all parse — whichever separator appears last is read as the decimal point. Currency symbols are stripped. |
| `notes` | `notes` | Free text. Quote it if it contains commas or newlines. |
| `last_touch_at` | `last_touch_at` | Date. See *Dates* below. |
| `next_touch_at` | `next_touch_at` | Date. Leave blank for contacts the owner has not scheduled; step 2 sets it by hand, step 5 by cadence. |
| `touch_count` | `touch_count` | Non-negative integer. Blank is `0`. |
| `do_not_contact` | `do_not_contact` | `yes`/`no`, `true`/`false`, `1`/`0`, `y`/`n`, `ναι`/`όχι`. Blank is `false`. Anything else is rejected — this flag is permanent and must never be set by accident. |

Not importable: `id`, `created_at` are set by the database.

### Dates

Accepted: ISO 8601 (`2026-07-15T09:30:00Z`), `YYYY-MM-DD`, and `DD/MM/YYYY`.

**Slashed dates are read day-first** (European convention — the operator is in
Greece), so `03/07/2026` is 3 July, not 3 March. If the source export is
US-formatted, convert it to `YYYY-MM-DD` before importing.

A bare date becomes midnight UTC. That is before the 08:00 Europe/Athens
follow-up run, so a contact dated today is picked up the same morning.

### Timezone

`contacts.timezone` is **derived, not usually supplied** (PLAN.md §7.1). Order of
precedence:

1. An explicit `timezone` column, if present and a valid IANA zone.
2. A `city` match, for countries spanning several zones (`Denver` →
   `America/Denver`, `Perth` → `Australia/Perth`).
3. The `country` code (`DE` → `Europe/Berlin`). Multi-zone countries fall back
   to their commercial centre: `US` → `America/New_York`, `CA` →
   `America/Toronto`, `AU` → `Australia/Sydney`, `BR` → `America/Sao_Paulo`,
   `RU` → `Europe/Moscow`.
4. **Default `Europe/Athens`.**

The country and city tables in the script are deliberately short. Extend
`COUNTRY_TIMEZONES` / `CITY_TIMEZONES` when a contact from somewhere new turns
up — or just put the zone in the CSV.

This only matters for contacts abroad. It exists so a follow-up does not arrive
at 03:00 local and read as a machine.

---

## Example

```csv
name,business,email,phone,language,city,country,source,stage,value_estimate,notes,next_touch_at,do_not_contact
Γιώργος Παπαδόπουλος,Ταβέρνα Ο Γιώργος,g.papadopoulos@example.gr,+30 210 1234567,el,Αθήνα,GR,nfc_card,new,1500,"Πήρε κάρτα NFC στο event, θέλει και site με κρατήσεις",2026-08-14,no
Maria Schmidt,Nordlicht Studio,maria@nordlicht.example,+49 30 9876543,en,Berlin,DE,referral,quoted,4200,"Quoted for the shop rebuild, waiting on her partner",2026-08-05,no
Nikos Alexiou,,nikos.alexiou@example.com,,,Θεσσαλονίκη,,walk_in,contacted,,Ρώτησε για app ιδέα - όχι site,,no
```

Row 3 shows the defaults doing their job: blank `language` → `el`, blank
`country` → `GR`, blank `business` is fine because `name` is present, blank
`next_touch_at` means unscheduled.

---

## Running it

Dry run first. It is the default, so there is nothing to remember:

```bash
pnpm import:contacts ./contacts.csv
```

That prints every contact it would insert, a numbered list of duplicates it
would skip, and a numbered list of rejected rows with the reason for each. It
writes nothing. `--dry-run` is accepted and does the same thing, if being
explicit is worth the keystrokes.

Read the reject list, fix the CSV, dry run again. When the output is right:

```bash
pnpm import:contacts ./contacts.csv --commit
```

### Behaviour worth knowing

- **Deduplication** is on `email`, lowercased and trimmed, in two directions:
  against rows already in the database, and against earlier rows in the same
  file. Both are reported as skips, with the row number of the first occurrence.
- **A bad row never aborts the run.** Every row is validated, the valid ones are
  imported, and the rest are listed with reasons.
- **Re-running is safe.** Contacts already imported are skipped as duplicates, so
  a corrected file can be re-imported without creating doubles.
- **Row numbers** in the output count data rows, not file lines — row 1 is the
  first row under the header.
- **Exit code** is 1 if anything was rejected or an insert failed, 0 on a clean
  run. Useful if this ever gets wrapped in something.
- In a **dry run**, an unreachable database is not fatal — step 1 often runs
  before the migration is applied. Dedupe falls back to within-file only and
  says so. `--commit` refuses to run without a working connection.

---

## The other script

`scripts/seed-brain.ts` follows the same discipline: dry run by default,
`--commit` to write. It upserts the eight `brain` keys, so the owner can edit
the `BRAIN` constant and re-run as the content improves. It is the **only**
seeder for `brain` — `supabase/seed.sql` seeds `settings` and nothing else.

```bash
pnpm seed            # show what would change
pnpm seed --commit   # write it
```

One guard: a key still holding the shipped placeholder text will not overwrite
different content already in the database — re-running a seed script should not
destroy the owner's real words. `--force` overrides it. Once a key has been
written for real, set its `placeholder: false` in the constant and it updates
normally.
