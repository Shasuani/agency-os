/**
 * Reading the `contacts` table.
 *
 * **No `'use server'` here, and that is the point of the split.** A file-level
 * `'use server'` turns every export into a Server Action: Next assigns each one
 * an action id and publishes it as a POST endpoint that anyone who reads the
 * client bundle can call. For a write that is the deal you are making. For
 * `listContacts` it published a bulk contact-list endpoint in exchange for
 * nothing, since both reads are only ever awaited during a Server Component
 * render, where no directive is needed. The writes live next door in
 * ./contact-actions.ts, which does carry the directive.
 *
 * Rules this module holds to:
 *
 * - **Every export re-checks the operator.** Anon key only, under RLS, via
 *   `requireOperator()`. The middleware gates routing, but routing is not
 *   authorisation.
 * - **Filtering and sorting happen in Postgres.** `next_touch_at` and `stage`
 *   are both indexed (PLAN.md §4); reading every row and filtering in JS would
 *   make those indexes decorative.
 * - **Nothing about a contact is ever logged.** Not a name, not an address, not
 *   in an error path.
 */

import type { Contact } from '@agency/core';

import { requireOperator } from './supabase/server';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  isUuid,
  normaliseSearch,
  toContactSort,
  toStageFilter,
  toTagFilter,
  type ContactQuery,
} from './validation';

/** Column list, written out so a `select('*')` never quietly starts shipping a
 *  column added by a later migration to the browser. */
const CONTACT_COLUMNS =
  'id, name, business, email, phone, language, city, country, timezone, source, stage, value_estimate, notes, last_touch_at, next_touch_at, touch_count, do_not_contact, tags, created_at';

/**
 * The /pipeline list.
 *
 * Sort options, all resolved by Postgres:
 *   next_touch  who is due first, contacts with no date last  (default)
 *   recent      newest contact first
 *   name        alphabetical, unnamed last
 *   stage       grouped by stage, then by who is due first
 *   value       biggest estimate first
 *
 * `search` matches name, business, email or phone, case-insensitively.
 */
export async function listContacts(query: ContactQuery = {}): Promise<Contact[]> {
  const { supabase } = await requireOperator();

  const stage = toStageFilter(query.stage ?? 'all');
  const sort = toContactSort(query.sort);
  const search = normaliseSearch(query.search);
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  let request = supabase.from('contacts').select(CONTACT_COLUMNS);

  if (stage !== 'all') request = request.eq('stage', stage);

  // Array containment, served by contacts_tags_idx (GIN). `contains` sends
  // PostgREST's `cs` operator with a properly-encoded array literal, so the tag
  // is a bound value rather than string-spliced into the filter.
  const tag = toTagFilter(query.tag ?? '');
  if (tag !== '') request = request.contains('tags', [tag]);

  if (search !== null) {
    // `search` has already had PostgREST's filter delimiters stripped in
    // normaliseSearch(); do not interpolate a raw string here.
    const pattern = `%${search}%`;
    request = request.or(
      [
        `name.ilike.${pattern}`,
        `business.ilike.${pattern}`,
        `email.ilike.${pattern}`,
        `phone.ilike.${pattern}`,
      ].join(','),
    );
  }

  switch (sort) {
    case 'next_touch':
      request = request
        .order('next_touch_at', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false });
      break;
    case 'recent':
      request = request.order('created_at', { ascending: false });
      break;
    case 'name':
      request = request.order('name', { ascending: true, nullsFirst: false });
      break;
    case 'stage':
      request = request
        .order('stage', { ascending: true })
        .order('next_touch_at', { ascending: true, nullsFirst: false });
      break;
    case 'value':
      request = request.order('value_estimate', { ascending: false, nullsFirst: false });
      break;
  }

  const { data, error } = await request.limit(limit);

  // Reads throw: there is no sensible half-rendered pipeline, and the error
  // belongs to the page's error boundary. The message is Postgres', never a row.
  if (error !== null) throw new Error(`Failed to load contacts: ${error.message}`);

  return (data ?? []) as Contact[];
}

/** One contact, or null if it does not exist (or RLS hides it). */
export async function getContact(id: string): Promise<Contact | null> {
  if (!isUuid(id)) return null;

  const { supabase } = await requireOperator();

  const { data, error } = await supabase
    .from('contacts')
    .select(CONTACT_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error !== null) throw new Error(`Failed to load contact: ${error.message}`);

  return (data as Contact | null) ?? null;
}
