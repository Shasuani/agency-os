'use client';

/**
 * One form, two jobs: `/pipeline/new` and `/pipeline/[id]`.
 *
 * Not two components. Every field, every default, every rule about which
 * combinations are legal is identical on create and on edit — the only thing
 * that differs is where the write goes, and that arrives as the `action` prop.
 * Two copies of this file would drift the moment a column is added.
 *
 * Three decisions worth knowing before editing it:
 *
 * 1. **The inputs are controlled.** Not because the form needs client state to
 *    work — it posts a plain `FormData` to a Server Action — but because React
 *    resets an uncontrolled `<form action={…}>` once the action settles. On a
 *    rejected submit that would wipe everything the operator typed, which is the
 *    single fastest way to make someone stop entering contacts. Holding the
 *    values here means a failed save costs nothing but the fix.
 *
 * 2. **Vocabularies are not retyped here.** They come from `lib/contact-vocab`,
 *    the module that also feeds the server-side validator and therefore mirrors
 *    the CHECK constraints in the migration. That module imports types only, so
 *    it is safe in a client bundle; `lib/validation` itself is not, because it
 *    value-imports `@agency/core`, whose barrel reaches the Supabase service
 *    client. Type-only imports from it are fine — they are erased.
 *
 * 3. **The server owns validation.** There is no mirrored client-side rule set
 *    to fall out of step with `parseContactForm`. Errors come back keyed by
 *    column name and land next to their field, and the first bad field takes
 *    focus so a fix is one keystroke away.
 *
 * Fields the system owns — `touch_count`, `last_touch_at`, `created_at`,
 * `timezone` — are not here. They are the agents' bookkeeping; the contact page
 * shows them read-only beside this form.
 */

import Link from 'next/link';
import {
  useActionState,
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { Button, buttonClass, cx } from '@/components/ui/button';
import { CheckboxField, Field, fieldId } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Select, type SelectOption } from '@/components/ui/select';
import { STAGE_OPTIONS, SUGGESTED_TAGS } from '@/lib/contact-vocab';
import type { ContactField, FieldErrors } from '@/lib/validation';

import { NextTouchField } from './next-touch-field';

/** datalist id for the tag suggestions. */
const TAG_SUGGESTIONS_ID = 'contact-tag-suggestions';

// ---------------------------------------------------------------------------
// Contract with the page
// ---------------------------------------------------------------------------

/**
 * Every editable column, as the string an `<input>` holds. Dates are
 * 'YYYY-MM-DD' as the date reads in the operator's timezone — the conversion to
 * an instant happens once, on the server, in `parseDateInput`.
 */
export type ContactFormValues = {
  name: string;
  business: string;
  email: string;
  phone: string;
  language: string;
  city: string;
  country: string;
  source: string;
  stage: string;
  value_estimate: string;
  notes: string;
  tags: string;
  /** Seed value only: once mounted, `NextTouchField` owns this one. */
  next_touch_at: string;
  do_not_contact: boolean;
};

/** What the Server Action returns. Mirrors `ActionResult` from lib/validation,
 *  minus the success case: a successful save redirects and never comes back. */
export type ContactFormState = { errors?: FieldErrors };

export type ContactFormAction = (
  state: ContactFormState,
  formData: FormData,
) => Promise<ContactFormState>;

/**
 * The starting point for a new contact (PLAN.md §4 column defaults, plus the
 * source the operator actually uses most). Greek, in Greece, brand new, met by
 * handing over an NFC card — so the common case is: type a name, hit +7, save.
 */
export const NEW_CONTACT: ContactFormValues = {
  name: '',
  business: '',
  email: '',
  phone: '',
  language: 'el',
  city: '',
  country: 'GR',
  source: 'nfc_card',
  stage: 'new',
  value_estimate: '',
  notes: '',
  tags: '',
  next_touch_at: '',
  do_not_contact: false,
};

export type ContactFormProps = {
  mode: 'create' | 'edit';
  action: ContactFormAction;
  values: ContactFormValues;
  /** Today, 'YYYY-MM-DD', computed on the server in the operator's timezone.
   *  Never from the browser clock: a laptop abroad must not shift "+7 days". */
  today: string;
  /** `SOURCE_OPTIONS` from lib/contact-vocab, passed in by the page. */
  sourceOptions: readonly SelectOption[];
  /** `LANGUAGE_OPTIONS` from lib/contact-vocab, passed in by the page. */
  languageOptions: readonly SelectOption[];
  /** Where Cancel goes. */
  cancelHref: string;
};

/** Which field to focus after a rejected submit — reading order, not schema
 *  order, so focus lands where the eye already is. `form` is excluded: it has no
 *  control to focus and is rendered at the top as a banner. */
const FOCUS_ORDER = [
  'name',
  'business',
  'email',
  'phone',
  'source',
  'language',
  'city',
  'country',
  'stage',
  'value_estimate',
  'next_touch_at',
  'notes',
  'tags',
  'do_not_contact',
] as const satisfies readonly ContactField[];

const INITIAL_STATE: ContactFormState = {};

export function ContactForm({
  mode,
  action,
  values: initialValues,
  today,
  sourceOptions,
  languageOptions,
  cancelHref,
}: ContactFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [values, setValues] = useState<ContactFormValues>(initialValues);

  /** Already opted out when the page loaded. Permanent (PLAN.md §7): the form
   *  cannot clear it, so it is shown as a fact rather than a control. */
  const lockedOut = mode === 'edit' && initialValues.do_not_contact;
  const [optOutOpen, setOptOutOpen] = useState(false);

  const errors = state.errors;

  function set<K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  // Send focus to the first field the server rejected. Without this, a form
  // this tall can report an error that is off screen.
  useEffect(() => {
    if (errors === undefined) return;
    for (const field of FOCUS_ORDER) {
      if (errors[field] !== undefined) {
        document.getElementById(fieldId(field))?.focus();
        return;
      }
    }
  }, [errors]);

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    // ⌘/Ctrl+Enter saves from anywhere, including the notes textarea. Plain
    // Enter in a text input already submits — that is the browser's own
    // behaviour and it is left alone.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  }

  const optedOut = lockedOut || values.do_not_contact;

  return (
    <form
      action={formAction}
      onKeyDown={onKeyDown}
      noValidate
      aria-busy={pending || undefined}
      className={cx('flex flex-col gap-4 transition-opacity', pending && 'opacity-70')}
    >
      {errors?.form !== undefined ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-base text-danger"
        >
          {errors.form}
        </p>
      ) : null}

      <Panel title="Who">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            name="name"
            label="Name"
            error={errors?.name}
            hint={mode === 'create' ? 'A name or a business is enough to save.' : undefined}
          >
            <Input
              value={values.name}
              autoFocus={mode === 'create'}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set('name', event.target.value)}
            />
          </Field>

          <Field name="business" label="Business" error={errors?.business}>
            <Input
              value={values.business}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set('business', event.target.value)}
            />
          </Field>

          <Field
            name="email"
            label="Email"
            error={errors?.email}
            hint="The only outbound channel. Without one, a follow-up date is a reminder for you."
          >
            <Input
              type="email"
              inputMode="email"
              value={values.email}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set('email', event.target.value)}
            />
          </Field>

          <Field name="phone" label="Phone" error={errors?.phone}>
            <Input
              type="tel"
              inputMode="tel"
              numeric
              value={values.phone}
              autoComplete="off"
              onChange={(event) => set('phone', event.target.value)}
            />
          </Field>
        </div>
      </Panel>

      <Panel title="Where they came from" hint="Country sets the send window">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field name="source" label="Source" error={errors?.source}>
            <Select
              value={values.source}
              options={sourceOptions}
              placeholder="Unrecorded"
              onChange={(event) => set('source', event.target.value)}
            />
          </Field>

          <Field name="language" label="Language" error={errors?.language}>
            <Select
              value={values.language}
              options={languageOptions}
              onChange={(event) => set('language', event.target.value)}
            />
          </Field>

          <Field name="city" label="City" error={errors?.city}>
            <Input
              value={values.city}
              autoComplete="off"
              onChange={(event) => set('city', event.target.value)}
            />
          </Field>

          <Field name="country" label="Country" error={errors?.country} hint="Two letters, e.g. GR">
            <Input
              value={values.country}
              numeric
              maxLength={2}
              autoComplete="off"
              spellCheck={false}
              className="uppercase"
              onChange={(event) => set('country', event.target.value.toUpperCase())}
            />
          </Field>
        </div>
      </Panel>

      <Panel title="Where it stands">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field name="stage" label="Stage" error={errors?.stage}>
            <Select
              value={values.stage}
              options={STAGE_OPTIONS}
              onChange={(event) => set('stage', event.target.value)}
            />
          </Field>

          <Field
            name="value_estimate"
            label="Value estimate"
            action="€"
            error={errors?.value_estimate}
          >
            <Input
              numeric
              inputMode="decimal"
              placeholder="1500"
              value={values.value_estimate}
              autoComplete="off"
              onChange={(event) => set('value_estimate', event.target.value)}
            />
          </Field>
        </div>
      </Panel>

      <Panel title="When to chase them" hint="The agent takes this over in step 5">
        <NextTouchField
          today={today}
          defaultValue={initialValues.next_touch_at}
          error={errors?.next_touch_at}
          disabled={optedOut}
          disabledNote="Opted out — no follow-up will be scheduled, and any existing date is cleared on save."
          // Live, from the email field above: a date on a contact with no
          // address saves fine, but the agent will have nowhere to send it. The
          // note appears and disappears as the address is typed.
          noEmail={values.email.trim() === ''}
        />
      </Panel>

      <Panel title="Context" hint="The follow-up agent reads this from step 5">
        <Field
          name="tags"
          label="Tags"
          error={errors?.tags}
          hint="What they need or bought — comma separated. Separate from Source, which is how they found you."
        >
          <Input
            value={values.tags}
            onChange={(event) => set('tags', event.target.value)}
            placeholder="ecommerce, redesign"
            list={TAG_SUGGESTIONS_ID}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {/* A datalist suggests without constraining: the list keeps spelling
              consistent enough for the filter to work, while anything can still
              be typed. The next thing this business sells is not in this list. */}
          <datalist id={TAG_SUGGESTIONS_ID}>
            {SUGGESTED_TAGS.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </Field>

        <Field
          name="notes"
          label="Notes"
          error={errors?.notes}
          hint="What they asked for, what you promised, anything a follow-up should not get wrong."
        >
          <Textarea
            rows={6}
            value={values.notes}
            onChange={(event) => set('notes', event.target.value)}
          />
        </Field>
      </Panel>

      <OptOut
        locked={lockedOut}
        checked={values.do_not_contact}
        open={optOutOpen}
        error={errors?.do_not_contact}
        onOpen={() => setOptOutOpen(true)}
        onCancel={() => {
          setOptOutOpen(false);
          set('do_not_contact', false);
        }}
        onChange={(checked) => set('do_not_contact', checked)}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="flex items-baseline gap-1 text-2xs text-faint">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> save
        </p>

        <div className="flex items-center gap-2">
          <Link href={cancelHref} className={buttonClass({ variant: 'ghost' })}>
            Cancel
          </Link>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : mode === 'create' ? 'Add contact' : 'Save changes'}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-raised">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2">
        <h2 className="label-caps text-muted">{title}</h2>
        {hint !== undefined ? <span className="text-xs text-faint">{hint}</span> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * `do_not_contact`.
 *
 * PLAN.md §7 makes this permanent and checks it immediately before every Gmail
 * call. Re-contacting someone who asked you not to is the one mistake in this
 * app with a legal edge to it, so the control is deliberately two steps: a
 * request to see it, then a checkbox that says in plain words what it does.
 * A checkbox sitting in the grid next to "City" would eventually get clicked by
 * accident, and nothing here can undo it.
 *
 * Once set, the form renders it as a fact and posts a hidden field instead — the
 * write in lib/contacts.ts is a whole-form update, so omitting the field would
 * read as an attempt to clear the opt-out and be rejected.
 */
function OptOut({
  locked,
  checked,
  open,
  error,
  onOpen,
  onCancel,
  onChange,
}: {
  locked: boolean;
  checked: boolean;
  open: boolean;
  error?: string;
  onOpen: () => void;
  onCancel: () => void;
  onChange: (checked: boolean) => void;
}) {
  if (locked) {
    return (
      <section className="rounded-lg border border-warning/40 bg-warning-subtle px-4 py-3">
        <input type="hidden" name="do_not_contact" value="on" />
        <h2 className="label-caps text-warning">Opted out</h2>
        <p className="mt-1 text-base text-ink">
          This contact has asked not to be contacted. Nothing will ever be drafted or sent to
          them.
        </p>
        <p className="mt-1 text-xs text-muted">
          Permanent by design, and not reversible from this form.
        </p>
        {error !== undefined ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      </section>
    );
  }

  if (!open && !checked) {
    return (
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-4 py-2.5">
        <p className="text-sm text-muted">
          Contactable. Follow-ups may be drafted for this person.
        </p>
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Opt them out…
        </Button>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-danger/40 bg-danger-subtle/50 px-4 py-3">
      <h2 className="label-caps text-danger">Opt out — permanent</h2>
      <ul className="mt-2 space-y-0.5 text-sm text-ink">
        <li>· No follow-up is ever drafted, and the send path refuses them outright.</li>
        <li>· Any follow-up date on this contact is cleared when you save.</li>
        <li>· Saving this cannot be undone from this form.</li>
      </ul>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <CheckboxField
          name="do_not_contact"
          label="Never contact this person again"
          checked={checked}
          error={error}
          onChange={(event) => onChange(event.target.checked)}
        />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Keep contacting them
        </Button>
      </div>
    </section>
  );
}
