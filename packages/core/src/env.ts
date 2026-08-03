/**
 * Validated environment access.
 *
 * The variable names below are exactly those in PLAN.md §8 — do not rename, do
 * not add. Anything that needs a new variable adds it to PLAN.md first.
 *
 * Two things this file is careful about:
 *
 * 1. `NEXT_PUBLIC_*` variables are inlined by Next.js at build time only when
 *    they appear as a *static* `process.env.NEXT_PUBLIC_FOO` expression. A
 *    dynamic `process.env[name]` lookup silently yields `undefined` in the
 *    browser bundle. So every variable is read through an explicit static
 *    reference in `readAll()` rather than by computed key.
 * 2. Missing variables fail loudly, naming the variable, at the point of use —
 *    never with a `undefined is not a string` three frames deeper.
 */

export const ENV_VARS = [
  // Supabase
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', // worker only
  // Auth
  'ALLOWED_EMAIL',
  // Anthropic
  'ANTHROPIC_API_KEY',
  // Gmail
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  'GMAIL_PUBSUB_TOPIC',
  'GMAIL_WEBHOOK_SECRET',
  'GMAIL_WEBHOOK_AUDIENCE',
  'GMAIL_PUBSUB_SERVICE_ACCOUNT',
  // Web Push
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  // Compliance footer (GDPR — all four elements required)
  'BUSINESS_NAME',
  'BUSINESS_ADDRESS',
  'PRIVACY_POLICY_URL',
  // Behaviour
  'DRY_RUN',
  'TZ',
] as const;

export type EnvVar = (typeof ENV_VARS)[number];

/** All cadence math and the 08:00 trigger are computed in this zone (PLAN.md §1). */
export const DEFAULT_TIMEZONE = 'Europe/Athens';

export class MissingEnvError extends Error {
  readonly missing: readonly EnvVar[];

  constructor(missing: readonly EnvVar[], context?: string) {
    const names = missing.join(', ');
    const where = context ? ` (needed by ${context})` : '';
    super(
      `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${names}${where}. ` +
        `Set ${missing.length > 1 ? 'them' : 'it'} in .env / the deployment environment — see PLAN.md §8.`,
    );
    this.name = 'MissingEnvError';
    this.missing = missing;
  }
}

/**
 * Static reads, one per variable. Verbose on purpose: see note 1 at the top.
 */
function readAll(): Record<EnvVar, string | undefined> {
  // `process` does not exist in every browser runtime; the static reads below
  // are wrapped so a ReferenceError degrades to `undefined` instead of a crash.
  const safe = (read: () => string | undefined): string | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const env: Record<string, string | undefined> =
    typeof process !== 'undefined' && process.env
      ? (process.env as Record<string, string | undefined>)
      : {};

  return {
    NEXT_PUBLIC_SUPABASE_URL: safe(() => process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: safe(() => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: env['SUPABASE_SERVICE_ROLE_KEY'],
    ALLOWED_EMAIL: env['ALLOWED_EMAIL'],
    ANTHROPIC_API_KEY: env['ANTHROPIC_API_KEY'],
    GOOGLE_CLIENT_ID: env['GOOGLE_CLIENT_ID'],
    GOOGLE_CLIENT_SECRET: env['GOOGLE_CLIENT_SECRET'],
    GMAIL_REFRESH_TOKEN: env['GMAIL_REFRESH_TOKEN'],
    GMAIL_PUBSUB_TOPIC: env['GMAIL_PUBSUB_TOPIC'],
    GMAIL_WEBHOOK_SECRET: env['GMAIL_WEBHOOK_SECRET'],
    GMAIL_WEBHOOK_AUDIENCE: env['GMAIL_WEBHOOK_AUDIENCE'],
    GMAIL_PUBSUB_SERVICE_ACCOUNT: env['GMAIL_PUBSUB_SERVICE_ACCOUNT'],
    VAPID_PUBLIC_KEY: env['VAPID_PUBLIC_KEY'],
    VAPID_PRIVATE_KEY: env['VAPID_PRIVATE_KEY'],
    BUSINESS_NAME: env['BUSINESS_NAME'],
    BUSINESS_ADDRESS: env['BUSINESS_ADDRESS'],
    PRIVACY_POLICY_URL: env['PRIVACY_POLICY_URL'],
    DRY_RUN: env['DRY_RUN'],
    TZ: env['TZ'],
  };
}

/** Raw value, or undefined. Empty strings are treated as unset. */
export function optionalEnv(name: EnvVar): string | undefined {
  const raw = readAll()[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Raw value, or throw a `MissingEnvError` naming the variable. */
export function requireEnv(name: EnvVar, context?: string): string {
  const value = optionalEnv(name);
  if (value === undefined) throw new MissingEnvError([name], context);
  return value;
}

/**
 * Validate a set of variables in one go — call at process startup so a
 * misconfigured deploy dies immediately instead of at 08:00 the next morning.
 * Reports every missing variable, not just the first.
 */
export function assertEnv(names: readonly EnvVar[], context?: string): void {
  const values = readAll();
  const missing = names.filter((name) => {
    const raw = values[name];
    return raw === undefined || raw.trim() === '';
  });
  if (missing.length > 0) throw new MissingEnvError(missing, context);
}

// ---------------------------------------------------------------------------
// Grouped accessors — each validates exactly what it returns
// ---------------------------------------------------------------------------

/** Anything running in the browser or a Next.js server component. */
export function supabaseBrowserEnv(): { url: string; anonKey: string } {
  assertEnv(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'], 'the Supabase browser client');
  return {
    url: requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  };
}

/** Worker only. The service role key bypasses RLS — never ship it to a browser. */
export function supabaseServiceEnv(): { url: string; serviceRoleKey: string } {
  assertEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], 'the Supabase service client');
  return {
    url: requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    serviceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

/** Single-user auth gate (PLAN.md §1). */
export function authEnv(): { allowedEmail: string } {
  return { allowedEmail: requireEnv('ALLOWED_EMAIL', 'the single-user auth gate') };
}

export function anthropicEnv(): { apiKey: string } {
  return { apiKey: requireEnv('ANTHROPIC_API_KEY', 'the LLM wrapper') };
}

export function gmailEnv(): {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  pubsubTopic: string;
  webhookSecret: string;
} {
  assertEnv(
    [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GMAIL_REFRESH_TOKEN',
      'GMAIL_PUBSUB_TOPIC',
      'GMAIL_WEBHOOK_SECRET',
    ],
    'Gmail send/read',
  );
  return {
    clientId: requireEnv('GOOGLE_CLIENT_ID'),
    clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
    refreshToken: requireEnv('GMAIL_REFRESH_TOKEN'),
    pubsubTopic: requireEnv('GMAIL_PUBSUB_TOPIC'),
    webhookSecret: requireEnv('GMAIL_WEBHOOK_SECRET'),
  };
}

/**
 * The three variables the Gmail Pub/Sub webhook route needs, and the one
 * accessor in this file that reports rather than throws.
 *
 * Every other grouped accessor asserts, because every other caller is code that
 * has already decided to do the thing and cannot proceed without the value. The
 * webhook is different: "not configured" is a state it is *designed* to be in.
 * The route ships refusing everything with a `503` — an open webhook that
 * creates contacts and spends Anthropic money is not a thing that turns itself
 * on — and a machine with no Gmail setup is the machine this is built on. So
 * being unconfigured has to be an answer the route can act on, once per process,
 * not an exception thrown on every one of the deliveries Pub/Sub will retry with
 * backoff for days.
 *
 * `missing` names the variables rather than describing them, so the single log
 * line the route emits says which of the three to go and set. Values never
 * appear in it; two of these three are secrets.
 *
 * `GMAIL_WEBHOOK_AUDIENCE` and `GMAIL_PUBSUB_SERVICE_ACCOUNT` are separate from
 * `gmailEnv()` on purpose: `gmailEnv()` is about talking to Gmail, and these two
 * are about deciding whether a caller claiming to be Google actually is. Without
 * the audience check, a Google-signed token minted for any other service
 * verifies; without the service-account check, any Google account holder with
 * the right audience passes. Neither is optional and neither belongs to the send
 * path.
 */
export function gmailWebhookEnv():
  | { ok: true; secret: string; audience: string; serviceAccount: string }
  | { ok: false; missing: readonly EnvVar[] } {
  const names = [
    'GMAIL_WEBHOOK_SECRET',
    'GMAIL_WEBHOOK_AUDIENCE',
    'GMAIL_PUBSUB_SERVICE_ACCOUNT',
  ] as const;

  const missing = names.filter((name) => optionalEnv(name) === undefined);
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    secret: requireEnv('GMAIL_WEBHOOK_SECRET'),
    audience: requireEnv('GMAIL_WEBHOOK_AUDIENCE'),
    serviceAccount: requireEnv('GMAIL_PUBSUB_SERVICE_ACCOUNT'),
  };
}

export function webPushEnv(): { publicKey: string; privateKey: string } {
  assertEnv(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'], 'Web Push');
  return {
    publicKey: requireEnv('VAPID_PUBLIC_KEY'),
    privateKey: requireEnv('VAPID_PRIVATE_KEY'),
  };
}

/** All four GDPR footer elements (PLAN.md §7). The opt-out line is written in code. */
export function complianceEnv(): { businessName: string; businessAddress: string; privacyPolicyUrl: string } {
  assertEnv(['BUSINESS_NAME', 'BUSINESS_ADDRESS', 'PRIVACY_POLICY_URL'], 'the outbound email compliance footer');
  return {
    businessName: requireEnv('BUSINESS_NAME'),
    businessAddress: requireEnv('BUSINESS_ADDRESS'),
    privacyPolicyUrl: requireEnv('PRIVACY_POLICY_URL'),
  };
}

// ---------------------------------------------------------------------------
// Behaviour flags
// ---------------------------------------------------------------------------

/**
 * Dry run defaults to TRUE. Only the literal string 'false' turns real sending
 * on — an unset, misspelt, or empty DRY_RUN must never send email.
 */
export function isDryRun(): boolean {
  return (optionalEnv('DRY_RUN') ?? 'true').toLowerCase() !== 'false';
}

/** The operator's timezone. Falls back to Europe/Athens rather than the host clock. */
export function appTimezone(): string {
  return optionalEnv('TZ') ?? DEFAULT_TIMEZONE;
}
