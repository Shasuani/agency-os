-- Agency OS — tighten RLS from "any authenticated user" to "the operator".
--
-- WHY THIS EXISTS
--
-- 20260731120000_init.sql shipped the policy PLAN.md §4 asks for:
--
--     create policy "authenticated" on contacts
--       for all using (auth.uid() is not null) with check (auth.uid() is not null);
--
-- That policy tests only that a JWT exists. It does not test *whose*. The whole
-- ALLOWED_EMAIL model lives in apps/web (middleware, /auth/callback,
-- requireOperator) — but PostgREST sits on the same public origin as the app and
-- does not run any of it. The anon key is public by construction: it is inlined
-- into the browser bundle. So on a Supabase project with the default
-- email sign-up setting, anybody can:
--
--     POST /auth/v1/signup          -> a JWT with a non-null auth.uid()
--     GET  /rest/v1/contacts?select=*   -> the entire pipeline
--     DELETE /rest/v1/contacts?id=eq... -> `for all` means writes too
--
-- The database has to enforce the same single-user rule the app claims. This
-- migration replaces every table's policy with an identity check.
--
-- WHAT YOU MUST DO AFTER RUNNING IT  (both, not either)
--
--   1. Tell the database who the operator is — the same address as ALLOWED_EMAIL:
--
--        insert into public.settings (key, value)
--        values ('allowed_email', to_jsonb('you@example.com'::text))
--        on conflict (key) do update
--          set value = excluded.value, updated_at = now();
--
--      Until that row exists, is_operator() returns false and every table reads
--      as empty. That is deliberate: this fails closed.
--
--   2. Supabase dashboard -> Authentication -> Sign In / Providers -> Email:
--      turn "Allow new users to sign up" OFF. The app needs exactly one
--      pre-existing user and never creates another. (login/page.tsx passes
--      shouldCreateUser: true so the first sign-in works — do this after it.)
--
--   3. Supabase dashboard -> Authentication -> URL Configuration: list the exact
--      deploy origin(s) under Redirect URLs. No wildcards. This is what stops a
--      magic link being pointed at somebody else's origin.
--
-- The worker is unaffected: it uses the service role key, which bypasses RLS.
--
-- Idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- is_operator() — the one authorisation predicate.
--
-- SECURITY DEFINER so it can read `settings` (which is itself RLS-protected)
-- without the policy recursing into itself. STABLE so the planner may call it
-- once per statement rather than once per row.
--
-- Two sources for the address, checked in order, so a deploy that would rather
-- not keep it in a table can use a database GUC instead:
--   settings.allowed_email        (recommended — one row, editable in /brain later)
--   current_setting('app.allowed_email')   e.g. alter database ... set app.allowed_email = '…'
-- ---------------------------------------------------------------------------
create or replace function public.is_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    lower(nullif(btrim(auth.jwt() ->> 'email'), '')) = lower(
      nullif(
        btrim(
          coalesce(
            (select s.value #>> '{}' from public.settings s where s.key = 'allowed_email'),
            current_setting('app.allowed_email', true)
          )
        ),
        ''
      )
    ),
    false
  );
$$;

comment on function public.is_operator() is
  'True only for the single operator named by settings.allowed_email (mirrors the ALLOWED_EMAIL env var). Fails closed when unset.';

revoke all on function public.is_operator() from public;
grant execute on function public.is_operator() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Policies. RLS is already enabled on all seven tables by the init migration;
-- `enable` is repeated here so this file stands on its own.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'brain',
    'contacts',
    'interactions',
    'tasks',
    'agent_runs',
    'settings',
    'push_subscriptions'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    -- The old, too-permissive policy from 20260731120000_init.sql.
    execute format('drop policy if exists "authenticated" on public.%I', t);
    execute format('drop policy if exists "operator" on public.%I', t);
    execute format(
      'create policy "operator" on public.%I for all using (public.is_operator()) with check (public.is_operator())',
      t
    );
  end loop;
end;
$$;
