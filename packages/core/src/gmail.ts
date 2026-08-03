/**
 * The only way a message leaves this system.
 *
 * Gmail over REST with `fetch`, against two URLs and nothing else:
 * `oauth2.googleapis.com/token` to mint an access token, and
 * `gmail.googleapis.com/gmail/v1/users/me/messages/send` to send. `googleapis`
 * is not in the lockfile and step 6 may not add a dependency, which turns out
 * to be a small mercy: the library is thirty megabytes and a lifetime of
 * transitive updates for two POST requests.
 *
 * This module is not on the `@agency/core` barrel and must not be put there. It
 * opens sockets and it sends email to real people; a Server Action that can
 * reach it by autocomplete is one keystroke away from a mistake nobody can
 * un-send. `apps/web` imports the barrel, so the barrel stays free of it, the
 * same arrangement `llm.ts` already has.
 *
 * ---------------------------------------------------------------------------
 * Greek is the normal case
 * ---------------------------------------------------------------------------
 *
 * Most subjects and nearly every body will be Greek. Every encoding decision
 * below follows from that rather than from the ASCII case that happens to be
 * easier to test:
 *
 *   - The body is base64, not quoted-printable. A Greek body is almost entirely
 *     non-ASCII, so quoted-printable roughly triples it, and its soft-line-break
 *     rules are the classic source of mangled accents.
 *   - The subject is an RFC 2047 encoded-word whenever it is not pure ASCII, and
 *     never when it is. An encoded-word on an ASCII subject is legal and renders
 *     badly in a handful of clients.
 *   - Encoded words are chunked on the **UTF-8 byte** stream at at most 45
 *     bytes, split only on character boundaries. Splitting mid-codepoint is the
 *     exact bug that turns a Greek subject into a row of replacement characters,
 *     and it is invisible until somebody receives it.
 *
 * ---------------------------------------------------------------------------
 * Headers this module deliberately does not write
 * ---------------------------------------------------------------------------
 *
 * **No `From`.** `users.messages.send` with `userId: 'me'` fills it from the
 * authenticated account. PLAN §8 has no sender-address variable and this step
 * may not invent one, so the sender is Gmail's business. `BUSINESS_NAME` appears
 * in the footer, which is where GDPR wants the sender identity anyway.
 *
 * **No `List-Unsubscribe`.** There is no unsubscribe endpoint in v1 and no
 * address to point one at without a new environment variable. A header pointing
 * at nothing that silently fails is worse than its absence — it converts an
 * honest instruction into a broken promise. Now that step 8 honours a `STOP`
 * reply deterministically, the `mailto:` form of this header has a real
 * mechanism behind it for the first time; it is still not written, because it
 * needs a sender address the environment does not carry. Worth revisiting, and
 * worth revisiting for a reason rather than out of habit.
 *
 * ---------------------------------------------------------------------------
 * This function is the `sendRaw` PLAN §7 says does not exist. Read this before
 * calling it.
 * ---------------------------------------------------------------------------
 *
 * PLAN §7's first guardrail row reads: "The Gmail send function takes a
 * `taskId`, re-reads the row, and throws unless `status = 'approved'`. There is
 * no other send path and no `sendRaw` export."
 *
 * As built, that is half true and the half that is missing is worth stating
 * plainly rather than leaving for somebody to discover. `sendEmail` does take a
 * `taskId` — and uses it only in its log lines. It never touches the database.
 * The re-read, the `do_not_contact` check, the suppression tag, the autonomy
 * level and both rate limits all live in `assertSendAllowed` in
 * `guardrails.ts`, which is a **separate function the caller has to remember to
 * call**, and `@agency/core/gmail` is a published subpath.
 *
 * Why it is built that way: `guardrails.ts` argues the split at length — the
 * decision is pure and unit-testable, the I/O is not — and moving the re-read in
 * here would make this module import the service-role client, which is exactly
 * the coupling the barrel rule exists to prevent.
 *
 * What that costs, and it is a real cost: SPEC §8's "no exceptions, no quick
 * send path" now holds by **discipline rather than by construction**. There is
 * one caller today, `sendOne` in `send-queue.ts`, and it calls
 * `assertSendAllowed` first. Any future caller — a "send now" button, an inline
 * reply from the webhook, both of which `guardrails.ts` explicitly anticipates —
 * that imports this function directly sends without an approved task, without
 * the opt-out check and without the rate limits.
 *
 * **So: do not call `sendEmail` without `assertSendAllowed` immediately above
 * it, and send to `permit.to` rather than to an address you derived yourself.**
 *
 * ---------------------------------------------------------------------------
 * The compliance footer, and why an unset variable refuses the send
 * ---------------------------------------------------------------------------
 *
 * PLAN §7 requires four elements — opt-out line, sender identity, physical
 * business address, privacy policy link — and says the send function appends
 * them so the model cannot forget them and the operator cannot edit them out.
 * That is what `appendFooter` is for, and it runs here, after the operator's
 * edited body, on every single send.
 *
 * The footer is never stored. It is not part of `tasks.draft_body`, not part of
 * `tasks.final_body`, and not part of the `interactions.body` the send queue
 * writes. Storing it would put the same five lines of boilerplate on every row
 * step 9 later reads as training signal for prose the operator actually wrote.
 *
 * **A missing `BUSINESS_NAME`, `BUSINESS_ADDRESS` or `PRIVACY_POLICY_URL`
 * refuses the send**, including under dry run. The address is a legal
 * requirement on every outbound commercial message in the EU; a placeholder
 * would be a false statement to a customer; and silently omitting the footer is
 * precisely how a system ends up non-compliant without anyone ever deciding to
 * be. Checking it under dry run too is the same argument: a dry run whose only
 * difference from production is that production would have failed is not a dry
 * run.
 *
 * The opt-out is a reply keyword rather than a link because v1 has no endpoint
 * that could honour a link. **Step 8 now honours it, and deterministically**:
 * `detectOptOut` in `gmail-mime.ts` matches `STOP` / `ΔΙΑΓΡΑΦΗ` before any model
 * is called, and `inbox.ts` routes it to `not_interested`, which sets
 * `do_not_contact` permanently on every contact row carrying that address. A
 * model being down, rate-limited or over the cost cap therefore cannot turn a
 * legal opt-out into a marketing reply — which is why the check is not a
 * classification.
 *
 * ---------------------------------------------------------------------------
 * Two judgement calls the interface contract did not make
 * ---------------------------------------------------------------------------
 *
 * 1. **A `network` failure is retryable.** The contract's note beside
 *    `GmailError` says "429 and 5xx are retryable; nothing else is", which reads
 *    as a statement about status codes rather than about a socket that was reset
 *    mid-request. Treating a transient connection failure as terminal would mark
 *    the task `skipped` and the follow-up would never be sent — the worst
 *    outcome available in this file. The send queue leaves retryable failures
 *    `approved` for the next tick, so the cost of being wrong in this direction
 *    is one more attempt sixty seconds later.
 * 2. **A 5xx or 429 from the *token* endpoint is not an `auth` error.** Google's
 *    token service having a bad minute is not a revoked refresh token, and
 *    mapping it to non-retryable `auth` would skip real messages over it. Only a
 *    4xx that is not 429 means the credentials are actually wrong.
 * 3. **Nothing after a 2xx may throw.** Once `users.messages.send` has returned
 *    success the message is gone, and every failure from that point on is a
 *    failure to *learn about* a send rather than a failed send. An unreadable
 *    response body used to reject with a plain `SyntaxError`, which the send
 *    queue classifies as retryable — so the customer received the follow-up
 *    twice, sixty seconds apart, and the log said the first attempt failed. The
 *    parse is wrapped for that reason and the result comes back with a null
 *    Gmail id, which the `interactions` row records honestly.
 *
 * ---------------------------------------------------------------------------
 * What is never logged, in any path
 * ---------------------------------------------------------------------------
 *
 * No recipient address, no display name, no subject, no body, not even a
 * domain. No access token, no refresh token, and no raw response body from
 * Google — its error responses echo request parameters back, which is how a
 * client secret ends up in a log file. Error messages carry the HTTP status and
 * nothing else, which is enough to tell a 401 from a 429 from a 400 and is the
 * only thing an operator can act on anyway.
 */

import { randomBytes } from 'node:crypto';

import { complianceEnv, isDryRun, requireEnv } from './env';
import type { Language } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** RFC 2822 wants CRLF. A bare LF in a header is a malformed message, and the
 *  fact that Gmail currently tolerates it is not a thing to depend on. */
const CRLF = '\r\n';

/**
 * An encoded word may be at most 75 characters *including* `=?UTF-8?B?` and
 * `?=`. Base64 turns 45 bytes into 60 characters, and 60 + 12 = 72. Raising
 * this number is how a subject line stops rendering in Outlook.
 */
export const MAX_ENCODED_WORD_BYTES = 45;

/** RFC 2045: base64 body lines are at most 76 characters. */
const BASE64_LINE_LENGTH = 76;

/**
 * A follow-up is under 120 words. A megabyte means something upstream is
 * broken — a body field holding a stack trace, a paste of a whole thread — and
 * sending it is worse than refusing.
 */
export const MAX_RAW_BYTES = 1_000_000;

/** Refresh this far before expiry, so a token never expires mid-request. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three GDPR values that come from the environment. */
export type ComplianceIdentity = {
  businessName: string;
  businessAddress: string;
  privacyPolicyUrl: string;
};

export type GmailSendInput = {
  /** Bare address. */
  to: string;
  /** Display name for the To header. May be Greek. */
  toName?: string | null;
  subject: string;
  /** Plain text, the operator's own. No footer — this function appends it. */
  body: string;
  /** Which footer to append. Greek when null, because most contacts are Greek. */
  language: Language | null;
  /**
   * Gmail thread id, so a reply lands in the conversation it answers.
   *
   * Supplied by `send-queue.ts`'s `loadReplyTarget`, which finds the inbound
   * `interactions` row carrying this task's id. Null for a follow-up, which is
   * starting a conversation rather than continuing one.
   */
  threadId?: string | null;
  /** RFC 2822 Message-ID being replied to. Same source, same null case. */
  inReplyTo?: string | null;
  /** Written into the log line so a send is traceable without customer data. */
  taskId: string;
};

export type GmailSendResult = {
  /** Gmail's message id. `null` under dry run. */
  id: string | null;
  threadId: string | null;
  /** The Message-ID header this module generated. Goes in `interactions.meta`. */
  messageId: string;
  dryRun: boolean;
  rawBytes: number;
};

export type GmailErrorKind =
  /** A footer or OAuth variable is unset. */
  | 'config'
  /** Token exchange rejected the credentials, or a 401 survived one retry. */
  | 'auth'
  /** 429. */
  | 'rate_limit'
  /** Any other non-2xx. */
  | 'api_error'
  /** `fetch` threw — DNS, TLS, a reset socket. */
  | 'network'
  | 'message_too_large';

/**
 * Everything this module throws. The send queue branches on `retryable`: true
 * leaves the task `approved` for the next tick, false resolves it as `skipped`
 * with an alert. Getting that classification wrong in the retryable direction
 * costs a log line; getting it wrong the other way loses a customer email.
 */
export class GmailError extends Error {
  override readonly name = 'GmailError';
  readonly kind: GmailErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(kind: GmailErrorKind, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.status = options?.status;
    this.retryable = isRetryable(kind, options?.status);
  }
}

function isRetryable(kind: GmailErrorKind, status: number | undefined): boolean {
  if (kind === 'rate_limit') return true;
  // See judgement call 1 in the header.
  if (kind === 'network') return true;
  if (kind === 'api_error') return status !== undefined && status >= 500;
  return false;
}

// ---------------------------------------------------------------------------
// The HTTP seam
// ---------------------------------------------------------------------------

/**
 * How this module reaches the network.
 *
 * It exists so `gmail.test.ts` can install a transport that fails the test if it
 * is ever called, and thereby *prove* that the dry-run path sends nothing. A
 * test that asserts "the result had a null id" proves considerably less: the
 * same result would come back from a version that made the request and then
 * discarded it.
 *
 * Production never sets this. There is no other reason to.
 */
export type GmailTransport = (url: string, init: RequestInit) => Promise<Response>;

let transport: GmailTransport | null = null;

/** Test seam. Pass `null` to restore the real `fetch`. */
export function setGmailTransport(next: GmailTransport | null): void {
  transport = next;
}

async function httpPost(url: string, init: RequestInit): Promise<Response> {
  const send = transport ?? ((u: string, i: RequestInit) => fetch(u, i));
  try {
    return await send(url, init);
  } catch (cause) {
    // The message names the host and nothing else. `cause` carries the detail
    // for a debugger; it is never logged.
    throw new GmailError('network', `Request to ${new URL(url).host} failed.`, { cause });
  }
}

// ---------------------------------------------------------------------------
// Header encoding
// ---------------------------------------------------------------------------

/**
 * Remove everything that could start a second header.
 *
 * A subject containing `\r\nBcc: someone@example.com` must never become a Bcc
 * header. The draft comes from a language model and is then edited by hand, so
 * neither end of that pipeline is a place to assume clean input. Control
 * characters become a single space rather than being deleted, so a mangled
 * subject reads as odd spacing instead of as two words run together.
 */
function stripHeaderControls(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
}

function isPlainAscii(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code > 126) return false;
  }
  return true;
}

/**
 * RFC 2047 encoded-word, base64, UTF-8.
 *
 * Returns `value` unchanged when it is plain printable ASCII and contains no
 * `=?`, because an encoded-word on an ASCII subject is legal and renders as
 * literal `=?UTF-8?B?…?=` in a few older clients. `=?` in an otherwise ASCII
 * string is encoded anyway: left alone it would be read as the start of an
 * encoded word and mangled by the receiving client instead of by us.
 *
 * Long values become several encoded words folded onto continuation lines with
 * CRLF + space, which is how RFC 2047 says to exceed 75 characters. The chunking
 * is over UTF-8 bytes and never splits a character — see the module header.
 */
export function encodeHeaderWord(value: string): string {
  const safe = stripHeaderControls(value);
  if (safe === '') return '';
  if (isPlainAscii(safe) && !safe.includes('=?')) return safe;

  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;

  // Iterating the string with for..of walks code points, not UTF-16 units, so a
  // character outside the BMP is never split across two chunks either.
  for (const char of safe) {
    const size = Buffer.byteLength(char, 'utf8');
    if (chunkBytes + size > MAX_ENCODED_WORD_BYTES && chunk !== '') {
      words.push(encodeOneWord(chunk));
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += size;
  }
  if (chunk !== '') words.push(encodeOneWord(chunk));

  return words.join(`${CRLF} `);
}

function encodeOneWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** Characters that force a display name to be quoted (RFC 5322 `specials`). */
const ADDRESS_SPECIALS = /[()<>@,;:\\".[\]]/;

/**
 * `Name <addr>`, or `addr` alone when there is no usable name.
 *
 * Three cases, and the order matters:
 *
 *   - A non-ASCII name becomes an encoded word, which must **not** be quoted —
 *     quoting it makes the receiving client display the raw `=?UTF-8?B?…` .
 *   - An ASCII name containing a special character is quoted, so
 *     `Papadopoulos, Maria` does not read as two addresses.
 *   - Anything else goes through as it is.
 *
 * The address itself is stripped of whitespace, angle brackets and control
 * characters. It has already been validated by the guardrails as containing an
 * `@`; this is the second lock, and it is the one that stops header injection
 * through a contact record.
 */
export function formatAddress(address: string, name?: string | null): string {
  const addr = address.replace(/[\s<>]/g, '').replace(/[\u0000-\u001F\u007F]/g, '');
  const raw = typeof name === 'string' ? stripHeaderControls(name) : '';
  if (raw === '') return addr;

  const encoded = encodeHeaderWord(raw);
  if (encoded !== raw) return `${encoded} <${addr}>`;
  if (ADDRESS_SPECIALS.test(raw)) return `"${raw.replace(/(["\\])/g, '\\$1')}" <${addr}>`;
  return `${raw} <${addr}>`;
}

// ---------------------------------------------------------------------------
// The compliance footer
// ---------------------------------------------------------------------------

/**
 * The four GDPR elements, in the contact's language.
 *
 * The separator is a blank line and then an em dash on its own line.
 * Deliberately **not** `"-- "`: that is the RFC 3676 signature delimiter and
 * mail clients collapse everything after it behind a "show trimmed content"
 * button. A legal notice that is hidden by default is not a legal notice.
 *
 * The Greek is written out rather than machine-translated at runtime, because
 * `ΔΙΑΓΡΑΦΗ` has to be a word step 8's classifier can match exactly and a
 * translation layer that drifts would break the opt-out silently.
 */
export function complianceFooter(language: Language, identity: ComplianceIdentity): string {
  const { businessName, businessAddress, privacyPolicyUrl } = identity;
  if (language === 'en') {
    return [
      '—',
      `You are receiving this because we met or because you contacted ${businessName}.`,
      'Reply STOP and you will not be contacted again.',
      `${businessName} · ${businessAddress}`,
      `Privacy: ${privacyPolicyUrl}`,
    ].join('\n');
  }
  return [
    '—',
    `Λαμβάνετε αυτό το μήνυμα επειδή έχουμε συναντηθεί ή επικοινωνήσατε με τη/τον ${businessName}.`,
    'Απαντήστε ΔΙΑΓΡΑΦΗ και δεν θα λάβετε άλλο μήνυμα.',
    `${businessName} · ${businessAddress}`,
    `Απόρρητο: ${privacyPolicyUrl}`,
  ].join('\n');
}

/**
 * The operator's text, then a blank line, then the footer.
 *
 * Trailing whitespace on the body is removed first so that a draft ending in two
 * newlines does not open a four-line gap before the em dash. Interior newlines
 * are left exactly as the operator typed them — the paragraph breaks in a
 * follow-up are part of how it reads as a person.
 */
export function appendFooter(body: string, language: Language, identity: ComplianceIdentity): string {
  return `${body.replace(/[\s]+$/, '')}\n\n${complianceFooter(language, identity)}`;
}

/**
 * Read the three footer variables, or refuse.
 *
 * Wraps `complianceEnv()`'s `MissingEnvError` into a `GmailError` so the send
 * queue has one error type to branch on. The message names the missing variable
 * — a variable name is not a secret, and "BUSINESS_ADDRESS is unset" is the only
 * form of this error the operator can do anything about.
 */
export function complianceIdentity(): ComplianceIdentity {
  try {
    return complianceEnv();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown';
    throw new GmailError('config', `Cannot send: ${detail}`, { cause });
  }
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

export type MimeInput = {
  to: string;
  toName?: string | null;
  subject: string;
  /** Footer already appended. */
  body: string;
  messageId: string;
  date: Date;
  inReplyTo?: string | null;
};

const RFC2822_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const RFC2822_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * `Tue, 04 Aug 2026 07:07:00 +0000`.
 *
 * Built from the UTC getters and two fixed tables rather than from
 * `toUTCString()`, which ends in the obsolete `GMT` zone, or from `Intl`, which
 * would render the day and month name in whatever locale it was handed. The
 * date is written in UTC because the header records when the message was
 * created, not where the recipient lives — the send window already decided that.
 */
export function formatRfc2822Date(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = RFC2822_DAYS[date.getUTCDay()] ?? 'Mon';
  const month = RFC2822_MONTHS[date.getUTCMonth()] ?? 'Jan';
  return (
    `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/** Base64 wrapped at 76 characters, CRLF between lines. */
function encodeBase64Body(body: string): string {
  const encoded = Buffer.from(body, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += BASE64_LINE_LENGTH) {
    lines.push(encoded.slice(i, i + BASE64_LINE_LENGTH));
  }
  return lines.join(CRLF);
}

/**
 * A complete RFC 2822 message.
 *
 * Header order is fixed so that a diff of two generated messages is readable,
 * and so that a test can assert on it. `In-Reply-To` and `References` are
 * written together or not at all: a client that sees one without the other
 * threads inconsistently, and step 8's replies are the whole point of having
 * them.
 */
export function buildMimeMessage(input: MimeInput): string {
  const headers = [
    'MIME-Version: 1.0',
    `Date: ${formatRfc2822Date(input.date)}`,
    `Message-ID: ${input.messageId}`,
    `To: ${formatAddress(input.to, input.toName)}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];

  const inReplyTo = typeof input.inReplyTo === 'string' ? input.inReplyTo.trim() : '';
  if (inReplyTo !== '') {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }

  return `${headers.join(CRLF)}${CRLF}${CRLF}${encodeBase64Body(input.body)}${CRLF}`;
}

/**
 * Base64url without padding — what `users.messages.send` wants in `raw`.
 *
 * Standard base64 is rejected: `+` and `/` are not URL-safe and Gmail's decoder
 * takes the URL-safe alphabet. Node's `'base64url'` encoding produces exactly
 * this, unpadded, and doing it by hand with three `replace` calls is one of the
 * commonest ways to get a "Invalid value for ByteString" back from the API.
 */
export function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * `<16-hex.epoch-ms@agency-os.local>`, angle brackets included.
 *
 * Gmail rewrites `Message-ID` on send, which is why `sendEmail` returns both
 * this value and the id Gmail reports: `interactions.meta` stores both so a
 * reply can be matched to the message that provoked it from either side.
 *
 * The domain is `agency-os.local` rather than the real one because it is never
 * resolved and never delivered to, and putting a real domain here would only
 * create the impression that it is.
 */
export function generateMessageId(): string {
  return `<${randomBytes(8).toString('hex')}.${Date.now()}@agency-os.local>`;
}

// ---------------------------------------------------------------------------
// Access token
// ---------------------------------------------------------------------------

type TokenCache = { token: string; expiresAt: number };

let cachedToken: TokenCache | null = null;
let inFlightRefresh: Promise<TokenCache> | null = null;

/**
 * A module-level cache with a single in-flight refresh.
 *
 * The send queue is serial, so the cache is mostly a way to avoid a second HTTP
 * round trip per message. The in-flight promise is for step 8: a Gmail webhook
 * arriving in parallel with a poller tick would otherwise mint two tokens for
 * the same account within a millisecond of each other, and Google rate-limits
 * that.
 */
async function accessToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cachedToken !== null && cachedToken.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken.token;
  }
  if (force) cachedToken = null;

  if (inFlightRefresh === null) {
    inFlightRefresh = refreshToken().finally(() => {
      inFlightRefresh = null;
    });
  }
  const fresh = await inFlightRefresh;
  return fresh.token;
}

/**
 * The shared access token, for `gmail-read.ts`.
 *
 * The only reason this exists is that there must be exactly one token cache in
 * the process. `gmail-read.ts` needs the same credentials the send path uses,
 * and a second copy of the refresh exchange over there would mean two caches,
 * two in-flight guards, and the precise failure the comment on `accessToken`
 * above describes: a Gmail webhook arriving in parallel with a poller tick
 * minting two tokens for the same account within a millisecond, which Google
 * rate-limits. One wrapper over the private function is cheaper than that in
 * every way that matters.
 *
 * It is exported rather than the read path importing `accessToken` directly
 * because `accessToken` stays private: it is the send path's, and a named,
 * documented export is what makes the sharing deliberate instead of incidental.
 */
export async function gmailAccessToken(force?: boolean): Promise<string> {
  return accessToken(force);
}

/**
 * Drop the cached access token.
 *
 * Test seam, in the same spirit as `setGmailTransport`: the cache is
 * module-level and lives for the life of the process, so without this a test
 * that asserts what the *token* endpoint returned would be answering a question
 * an earlier test already cached the answer to — and would pass while asserting
 * nothing. It is also the honest thing to call after `GMAIL_REFRESH_TOKEN` is
 * changed under a running process, which is how re-auth works here (PLAN §1).
 */
export function resetAccessTokenCache(): void {
  cachedToken = null;
}

async function refreshToken(): Promise<TokenCache> {
  // `gmailEnv()` is deliberately not used: it also asserts GMAIL_PUBSUB_TOPIC
  // and GMAIL_WEBHOOK_SECRET, which belong to step 8 and will not be set. A send
  // failing with a MissingEnvError naming two variables that have nothing to do
  // with sending is a twenty-minute detour for whoever reads the alert.
  let clientId: string;
  let clientSecret: string;
  let refresh: string;
  try {
    clientId = requireEnv('GOOGLE_CLIENT_ID', 'the Gmail send path');
    clientSecret = requireEnv('GOOGLE_CLIENT_SECRET', 'the Gmail send path');
    refresh = requireEnv('GMAIL_REFRESH_TOKEN', 'the Gmail send path');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown';
    throw new GmailError('config', `Cannot send: ${detail}`, { cause });
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });

  const response = await httpPost(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    // The response body is not read and not logged. Google echoes request
    // parameters back in token errors, and the request parameters include the
    // client secret and the refresh token.
    throw tokenError(response.status);
  }

  const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  const token = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (token === '') {
    throw new GmailError('auth', 'Token endpoint returned no access_token.');
  }
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;

  cachedToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return cachedToken;
}

/** See judgement call 2 in the module header. */
function tokenError(status: number): GmailError {
  if (status === 429) {
    return new GmailError('rate_limit', 'Token endpoint rate-limited the refresh.', { status });
  }
  if (status >= 500) {
    return new GmailError('api_error', `Token endpoint returned ${status}.`, { status });
  }
  return new GmailError(
    'auth',
    `Token endpoint rejected the credentials (${status}). ` +
      'GMAIL_REFRESH_TOKEN has most likely been revoked and needs to be reissued.',
    { status },
  );
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'gmail', ...fields }));
}

/**
 * Send one message. The only export in this repo that talks to Gmail.
 *
 * Order of operations is deliberate: the compliance variables are checked first,
 * then the whole MIME message is built, and only then is `isDryRun()` consulted.
 * A dry run therefore exercises the footer, the Greek encoding and the size
 * limit — so an encoding bug surfaces in development rather than on the first
 * live send.
 *
 * Everything else about a dry run is real. The caller still writes the
 * `interactions` row, still moves `contacts.last_touch_at`, still marks the task
 * `sent`. That means a day of dry-run testing consumes the daily cap and trips
 * the 48-hour per-contact cooldown, which is the point: the arithmetic is what
 * needs exercising, not the socket.
 */
export async function sendEmail(input: GmailSendInput): Promise<GmailSendResult> {
  const identity = complianceIdentity();
  const language: Language = input.language ?? 'el';

  const messageId = generateMessageId();
  const raw = buildMimeMessage({
    to: input.to,
    toName: input.toName,
    subject: input.subject,
    body: appendFooter(input.body, language, identity),
    messageId,
    date: new Date(),
    inReplyTo: input.inReplyTo,
  });

  const rawBytes = Buffer.byteLength(raw, 'utf8');
  if (rawBytes > MAX_RAW_BYTES) {
    throw new GmailError(
      'message_too_large',
      `Refusing to send: the message is ${rawBytes} bytes, over the ${MAX_RAW_BYTES}-byte limit. ` +
        'A follow-up is under 120 words, so something upstream has put the wrong text in the body.',
    );
  }

  const threadId = input.threadId ?? null;

  if (isDryRun()) {
    log({
      dry_run: true,
      task_id: input.taskId,
      raw_bytes: rawBytes,
      language,
      thread_id: threadId,
    });
    return { id: null, threadId, messageId, dryRun: true, rawBytes };
  }

  const payload: { raw: string; threadId?: string } = { raw: toBase64Url(raw) };
  if (threadId !== null && threadId !== '') payload.threadId = threadId;

  let response = await postSend(payload, await accessToken());

  if (response.status === 401) {
    // One retry, with a freshly minted token. A second 401 means the refresh
    // token itself has been revoked, and no amount of retrying fixes that.
    response = await postSend(payload, await accessToken(true));
    if (response.status === 401) {
      throw new GmailError(
        'auth',
        'Gmail rejected the access token twice. GMAIL_REFRESH_TOKEN needs to be reissued.',
        { status: 401 },
      );
    }
  }

  if (response.status === 429) {
    throw new GmailError('rate_limit', 'Gmail rate-limited the send (429).', { status: 429 });
  }
  if (!response.ok) {
    throw new GmailError('api_error', `Gmail returned ${response.status}.`, {
      status: response.status,
    });
  }

  // Everything below this line happens *after* Gmail has accepted the message.
  //
  // `response.json()` can reject — a truncated body, a proxy that returned HTML
  // with a 200, a socket reset while the body was being read. None of those are
  // evidence that the message did not go out; the status line already said it
  // did. Throwing here would hand the send queue an error it classifies as
  // retryable, and sixty seconds later the same message leaves a second time.
  // So a body that cannot be read costs the Gmail message id and nothing else.
  let sent: { id?: unknown; threadId?: unknown } = {};
  let bodyUnreadable = false;
  try {
    sent = (await response.json()) as { id?: unknown; threadId?: unknown };
  } catch {
    bodyUnreadable = true;
  }

  const id = typeof sent.id === 'string' ? sent.id : null;
  const returnedThreadId = typeof sent.threadId === 'string' ? sent.threadId : threadId;

  log({
    dry_run: false,
    task_id: input.taskId,
    raw_bytes: rawBytes,
    language,
    gmail_message_id: id,
    thread_id: returnedThreadId,
    // Only ever true on the path above: the message left, the receipt did not
    // arrive. Worth a line, because it is the one case where a `sent` row has no
    // Gmail id to reconcile against later.
    ...(bodyUnreadable ? { body_unreadable: true } : {}),
  });

  return { id, threadId: returnedThreadId, messageId, dryRun: false, rawBytes };
}

function postSend(payload: { raw: string; threadId?: string }, token: string): Promise<Response> {
  return httpPost(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}
