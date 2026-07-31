/**
 * `/pipeline/new` — the step 2 acceptance test, in one screen: "the owner can
 * add a contact met yesterday and set a follow-up date, from the deployed app."
 *
 * So the path is short on purpose. The form opens with the defaults that are
 * true for almost every contact in this pipeline — Greek, in Greece, brand new,
 * met by handing over an NFC card — the cursor is already in the name field, a
 * name alone is enough to save, and the follow-up date is four quick-set buttons
 * away. Nothing asks for confirmation, and nothing else is required: a card with
 * a name and a phone number saves with a date on it.
 *
 * A Server Component that reads no data: the only reason it touches Supabase is
 * `requireOperator`, which asserts the session belongs to ALLOWED_EMAIL. The
 * middleware already gates the route; this is the second, independent check, and
 * `createContact` runs a third of its own because a Server Action is a POST
 * endpoint that can be called without ever rendering this page.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { appTimezone } from '@agency/core';

import {
  ContactForm,
  NEW_CONTACT,
  type ContactFormState,
} from '@/components/pipeline/contact-form';
import { buttonClass } from '@/components/ui/button';
import { createContact } from '@/lib/contact-actions';
import { requireOperator } from '@/lib/supabase/server';
import { LANGUAGE_OPTIONS, SOURCE_OPTIONS, dayKeyInZone } from '@/lib/validation';

export const metadata: Metadata = { title: 'New contact' };

const PIPELINE_PATH = '/pipeline';

export default async function NewContactPage() {
  await requireOperator();

  // "Today" is resolved on the server, in the operator's timezone, so the
  // quick-set buttons mean the same thing from any laptop in any airport.
  const today = dayKeyInZone(new Date(), appTimezone());

  async function save(_state: ContactFormState, formData: FormData): Promise<ContactFormState> {
    'use server';

    const result = await createContact(formData);

    // Straight back to the list — it is sorted by next touch, so a contact
    // saved with a follow-up date lands exactly where the operator will look
    // for it. That is the confirmation; a "saved!" screen would be a step.
    if (result.ok) redirect(PIPELINE_PATH);

    return { errors: result.errors };
  }

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <h1 className="text-xl">New contact</h1>
          <p className="mt-0.5 text-sm text-muted">
            Someone you met. A name and a follow-up date is enough — the rest can wait.
          </p>
        </div>
        <Link href={PIPELINE_PATH} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
          Back to pipeline
        </Link>
      </header>

      <ContactForm
        mode="create"
        action={save}
        values={NEW_CONTACT}
        today={today}
        sourceOptions={SOURCE_OPTIONS}
        languageOptions={LANGUAGE_OPTIONS}
        cancelHref={PIPELINE_PATH}
      />
    </div>
  );
}
