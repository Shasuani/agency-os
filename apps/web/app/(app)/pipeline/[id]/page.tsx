/**
 * `/pipeline/[id]` — one contact, editable.
 *
 * The same form as `/pipeline/new`; only the action differs. What this page adds
 * is the other half of a contact record: the four columns the operator does not
 * own. `touch_count`, `last_touch_at`, `created_at` and `timezone` are written
 * by the agents and by the schema, so they are shown as facts beside the form
 * and are not editable anywhere in the app. Hiding them would be worse — "when
 * did I last speak to this person" is exactly the question this screen exists to
 * answer before you decide what to type in the notes.
 *
 * **Every date on this page is formatted here, on the server, in the operator's
 * timezone** (PLAN.md §7.1), through lib/day.ts — the same module the list uses,
 * so the two screens cannot describe the same column differently.
 *
 * A contact that does not exist — or that RLS hides — is a 404, not an empty
 * form. `getContact` returns null for a malformed id too, so a hand-typed URL
 * never reaches PostgREST as a filter value.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { appTimezone } from '@agency/core';

import { formatTags } from '@/lib/contact-vocab';

import {
  ContactForm,
  type ContactFormState,
  type ContactFormValues,
} from '@/components/pipeline/contact-form';
import { buttonClass } from '@/components/ui/button';
import { StageBadge } from '@/components/ui/stage-badge';
import { updateContact } from '@/lib/contact-actions';
import { getContact } from '@/lib/contacts';
import { daysBetween, formatDay, pastLabel, yearOf } from '@/lib/day';
import { requireOperator } from '@/lib/supabase/server';
import {
  LANGUAGE_OPTIONS,
  SOURCE_OPTIONS,
  contactLine,
  dayKeyInZone,
  dayKeyOf,
} from '@/lib/validation';

export const metadata: Metadata = { title: 'Contact' };

const PIPELINE_PATH = '/pipeline';

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOperator();

  const { id } = await params;
  const contact = await getContact(id);
  if (contact === null) notFound();

  const timeZone = appTimezone();
  const today = dayKeyInZone(new Date(), timeZone);

  const values: ContactFormValues = {
    name: contact.name ?? '',
    business: contact.business ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    language: contact.language ?? 'el',
    city: contact.city ?? '',
    country: contact.country ?? '',
    source: contact.source ?? '',
    stage: contact.stage ?? 'new',
    value_estimate: contact.value_estimate === null ? '' : String(contact.value_estimate),
    notes: contact.notes ?? '',
    tags: formatTags(contact.tags),
    // '' rather than null: this is a `<input type="date">` value, and React
    // treats null as uncontrolled.
    next_touch_at: dayKeyOf(contact.next_touch_at, timeZone) ?? '',
    do_not_contact: contact.do_not_contact ?? false,
  };

  async function save(_state: ContactFormState, formData: FormData): Promise<ContactFormState> {
    'use server';

    const result = await updateContact(id, formData);
    if (result.ok) redirect(PIPELINE_PATH);

    return { errors: result.errors };
  }

  // One of name/business is guaranteed by validation, and an older imported row
  // with neither still gets a heading. The rule is in lib/contact-vocab.ts;
  // this page, /pipeline's table and the Today card all had their own copy.
  const { primary: heading, secondary: subheading } = contactLine(
    contact.name,
    contact.business,
  );

  const added = formatStamp(contact.created_at, timeZone, today);
  const lastTouch = formatStamp(contact.last_touch_at, timeZone, today);

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h1 className="text-xl">{heading}</h1>
          {subheading !== null ? <span className="text-md text-muted">{subheading}</span> : null}
          <StageBadge stage={contact.stage} size="md" className="translate-y-px" />
          {contact.do_not_contact === true ? (
            <span className="label-caps text-warning" title="Opted out — nothing is ever sent">
              opted out
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Link href="/pipeline/new" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            New contact
          </Link>
          <Link href={PIPELINE_PATH} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            Back to pipeline
          </Link>
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <ContactForm
          mode="edit"
          action={save}
          values={values}
          today={today}
          sourceOptions={SOURCE_OPTIONS}
          languageOptions={LANGUAGE_OPTIONS}
          cancelHref={PIPELINE_PATH}
        />

        <aside className="rounded-lg border border-line bg-raised lg:sticky lg:top-16">
          <h2 className="label-caps border-b border-line px-4 py-2 text-muted">Recorded</h2>

          <dl className="px-4 py-1">
            <Fact label="Added" value={added?.date ?? '—'} note={added?.relative} />
            <Fact label="Last touch" value={lastTouch?.date ?? 'Never'} note={lastTouch?.relative} />
            <Fact label="Touches" value={String(contact.touch_count ?? 0)} />
            <Fact label="Timezone" value={contact.timezone ?? '—'} numeric={false} />
          </dl>

          <p className="border-t border-line px-4 py-2 text-xs text-faint">
            The system keeps these. Touches are counted by the follow-up agent from step 5;
            the timezone follows the country and decides when a message may leave (PLAN §7.1).
          </p>

          <p className="border-t border-line px-4 py-2 font-mono text-2xs break-all text-faint">
            {contact.id}
          </p>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Fact({
  label,
  value,
  note,
  numeric = true,
}: {
  label: string;
  value: string;
  note?: string;
  numeric?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
      <dt className="label-caps shrink-0 text-faint">{label}</dt>
      <dd className={numeric ? 'numeric text-sm text-ink' : 'text-sm text-ink'}>
        {value}
        {note !== undefined && note !== '' ? (
          <span className="ml-1.5 text-xs text-faint">{note}</span>
        ) : null}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dates. Calendar days in the operator's timezone rather than instants —
// "yesterday" is a day, not 24 hours. The formatting itself is lib/day.ts.
// ---------------------------------------------------------------------------

function formatStamp(
  iso: string | null,
  timeZone: string,
  today: string,
): { date: string; relative: string } | null {
  const day = dayKeyOf(iso, timeZone);
  if (day === null) return null;

  const offset = daysBetween(today, day);

  return {
    date: formatDay(day, yearOf(today)),
    // `pastLabel`, not a local abbreviation: these two columns are the same
    // facts the list shows, and "3 days ago" there with "3d ago" here was the
    // kind of inconsistency that makes an app feel assembled rather than built.
    relative: offset === null ? '' : pastLabel(offset),
  };
}
