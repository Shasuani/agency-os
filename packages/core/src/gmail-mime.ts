/**
 * Turning a Gmail message resource into the few hundred words a classifier
 * should read, and nothing else.
 *
 * This file is pure. It imports one type and no values, opens no socket, reads
 * no environment variable and holds no clock. That is not tidiness: it is the
 * only way the parsing can be tested hard, and the parsing is where step 8
 * breaks in production. Every failure below is the same shape — the message is
 * fetched successfully, the run reports success, and the model is handed the
 * wrong text.
 *
 * `gmail-read.ts` re-exports everything here, so callers write
 * `@agency/core/gmail-read` and never learn this file exists. The split is for
 * the tests: a network module cannot prove it is pure, and this one can.
 *
 * ---------------------------------------------------------------------------
 * Greek is the normal case, and it decides most of what follows
 * ---------------------------------------------------------------------------
 *
 * `gmail.ts` makes this argument for the send path; the read path has the same
 * one pointing the other way.
 *
 *   - **Charset comes from the part, and the decoder is `TextDecoder`.**
 *     `Buffer.toString` knows utf8, latin1 and ucs2 and does **not** know
 *     `iso-8859-7`, which is exactly what a Greek mail client from ten years ago
 *     sends. Decoding iso-8859-7 as utf-8 does not throw: it produces a screen
 *     of replacement characters, the classifier reads noise, and the answer it
 *     gives is confidently wrong about a real customer. An unknown charset falls
 *     back to utf-8 inside a try/catch, because a mislabelled part is still
 *     better read as utf-8 than not read at all.
 *   - **Encoded words are decoded, both `B` and `Q`.** `=?UTF-8?B?…?=` is how
 *     every Greek display name and most Greek subjects arrive. Storing the raw
 *     encoded word as `contacts.name` puts `=?UTF-8?B?zpzOsc+Bzq/Osw==?=` on the
 *     operator's screen for the life of the contact. This is the exact inverse
 *     of `gmail.ts`'s `encodeHeaderWord`, and the tests round-trip against it.
 *   - **Case folding for the opt-out folds accents and final sigma.** `ΔΙΑΓΡΑΦΗ`
 *     typed with an accent, or with a trailing full stop, is still an opt-out.
 *
 * ---------------------------------------------------------------------------
 * Quoted history, and why trimming it is a correctness requirement
 * ---------------------------------------------------------------------------
 *
 * A reply from a real person is four lines of new text on top of three layers of
 * quoted history, and the history contains *our* previous email, footer
 * included. Handed that verbatim, the classifier reads mostly our own prose and
 * classifies the wrong message, and the reply drafter answers itself. So
 * `stripQuotedReply` removes, in this order:
 *
 *   1. everything from the first attribution line — `On … wrote:`, the Greek
 *      `Στις … έγραψε:`, `-----Original Message-----`, Outlook's underscore rule;
 *   2. everything from our own compliance footer marker, which is the lone em
 *      dash line from `gmail.ts`'s `complianceFooter` followed by one of the four
 *      sentences it prints — matched on those sentences rather than on the em
 *      dash alone, because an em dash on its own line is also just punctuation;
 *   3. every line beginning with `>`.
 *
 * The trimming is deliberately allowed to remove everything. When it does,
 * `parseMessage` falls back to the untrimmed text rather than to nothing: a
 * bottom-posted reply is rare, but a classifier with an empty body cannot
 * classify at all, whereas one reading quoted history at least sees the thread.
 *
 * The same cut is made in HTML, where the quote is a `<blockquote>` or a
 * `gmail_quote` div rather than a `>` prefix. Everything from the first of those
 * is dropped. A newsletter that opens with a pull-quote loses its tail; a reply
 * that keeps three layers of history costs a wrong classification and a wasted
 * Sonnet draft, so the trade is not close.
 *
 * ---------------------------------------------------------------------------
 * Judgement calls the interface contract did not make
 * ---------------------------------------------------------------------------
 *
 * 1. **Quoted-printable is decoded only when it is declared *and* still
 *    present.** Gmail normally decodes `Content-Transfer-Encoding` for you and
 *    hands back the decoded bytes in `body.data` — but `=E2=80=99` surviving into
 *    `body.data` is a well-known enough report that ignoring the case is not
 *    safe either. Decoding on the header alone would double-decode every normal
 *    message; decoding on the text alone would corrupt any body that happens to
 *    contain `=3D` in a URL. So both must hold: the part declares
 *    `quoted-printable`, and the text still carries a soft line break or a `=XX`
 *    escape. The residual risk is a declared-QP part containing a literal `=41`,
 *    which loses two characters.
 * 2. **The subject is capped at 500 characters and the body at
 *    `MAX_BODY_CHARS`.** Both go into a prompt that is paid for by the token. A
 *    50 KB body is not a message, it is a paste, and the first 8,000 characters
 *    of it classify exactly as well as all of it.
 * 3. **`parseMessage` does not read `ALLOWED_EMAIL` itself.** `isOwnMessage`
 *    needs the operator's own address, and reading it here would make this file
 *    impure for one comparison. `gmail-read.ts`'s `getMessage` supplies it. With
 *    no address supplied only the `SENT`/`DRAFT` labels decide, which is the
 *    honest degradation rather than a silent one.
 * 4. **Addresses are returned with their original case.** Sender matching folds
 *    case (contract §8.3) and so does `isOwnMessage`; storing the address as the
 *    customer wrote it keeps `contacts.email` looking like the address they use.
 */

import type { Language } from './types';

// ---------------------------------------------------------------------------
// The shapes Gmail returns, narrowed to what is read
// ---------------------------------------------------------------------------

export type GmailHeader = { name: string; value: string };

export type GmailPayload = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
};

export type GmailMessageResource = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPayload;
};

export type GmailAddress = { name: string | null; email: string };

export type InboundMessage = {
  id: string;
  threadId: string | null;
  /** RFC 2822 Message-ID header, angle brackets included. */
  rfcMessageId: string | null;
  inReplyTo: string | null;
  from: GmailAddress | null;
  to: GmailAddress[];
  subject: string | null;
  /** Plain text: quoted history and our own compliance footer removed, capped. */
  body: string;
  /** Gmail's own preview. The last-resort fallback when nothing decodes. */
  snippet: string;
  /** internalDate as an ISO instant. */
  receivedAt: string;
  labelIds: string[];
  /** SENT or DRAFT label, or From === the operator. Never processed. */
  isOwnMessage: boolean;
};

/** How much of a body reaches a prompt. See judgement call 2 in the header. */
export const MAX_BODY_CHARS = 8000;

/** A subject is a line, not a document. Anything longer is a paste or an attack. */
export const MAX_SUBJECT_CHARS = 500;

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * First header with this name, case-insensitively.
 *
 * Header names are case-insensitive per RFC 5322 and Gmail returns them in
 * whatever case the sending client used — `Message-ID`, `Message-Id` and
 * `MESSAGE-ID` all occur in the wild. A case-sensitive lookup here fails on a
 * subset of senders and looks like "some messages have no subject".
 */
export function headerValue(headers: readonly GmailHeader[] | undefined, name: string): string | null {
  if (headers === undefined) return null;
  const want = name.toLowerCase();
  for (const header of headers) {
    if (header === null || typeof header !== 'object') continue;
    if (typeof header.name !== 'string' || header.name.toLowerCase() !== want) continue;
    return typeof header.value === 'string' ? header.value : null;
  }
  return null;
}

/** The `charset=` parameter of a Content-Type header, lowercased, or null. */
function charsetOf(headers: readonly GmailHeader[] | undefined): string | null {
  const contentType = headerValue(headers, 'content-type');
  if (contentType === null) return null;
  const match = /;\s*charset\s*=\s*("([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(contentType);
  if (match === null) return null;
  const value = match[2] ?? match[3] ?? match[4] ?? '';
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Bytes to text
// ---------------------------------------------------------------------------

/**
 * Decode bytes in the declared charset, or utf-8 when that fails.
 *
 * `TextDecoder` throws on a charset label it does not know and — with
 * `fatal: false`, the default — never throws on bad bytes. That is the split we
 * want: an unknown label falls back to utf-8, and bad bytes come through as
 * replacement characters rather than losing the whole message.
 */
function decodeBytes(bytes: Uint8Array, charset?: string | null): string {
  const label = typeof charset === 'string' && charset !== '' ? charset : 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return '';
    }
  }
}

/**
 * Gmail's `body.data`: base64url, sometimes padded, into text.
 *
 * Node's `'base64url'` decoder accepts the standard alphabet and padding too,
 * which matters because Gmail is not perfectly consistent about either and
 * hand-rolling the three `replace` calls is the usual way to get this wrong.
 */
export function decodeBase64Url(data: string, charset?: string | null): string {
  if (typeof data !== 'string' || data === '') return '';
  return decodeBytes(Buffer.from(data, 'base64url'), charset);
}

/** Evidence that a string is still quoted-printable. See judgement call 1. */
function looksQuotedPrintable(text: string): boolean {
  return /=[0-9A-Fa-f]{2}|=\r?\n|=$/.test(text);
}

/**
 * Quoted-printable bytes out of an ASCII quoted-printable string.
 *
 * Byte-level on purpose: `=CE=91` is one Greek letter in two escapes, and
 * decoding each escape to a *character* would produce two mojibake characters
 * that no later charset decode can repair.
 */
function decodeQuotedPrintableBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (char !== '=') {
      out.push(char.charCodeAt(0) & 0xff);
      continue;
    }
    const next = text.slice(i + 1, i + 3);
    if (next === '\r\n') {
      i += 2;
      continue;
    }
    if (next.startsWith('\n')) {
      i += 1;
      continue;
    }
    if (/^[0-9A-Fa-f]{2}$/.test(next)) {
      out.push(Number.parseInt(next, 16));
      i += 2;
      continue;
    }
    // A lone `=` that is not an escape. Left as written rather than dropped:
    // dropping it silently edits the customer's text.
    out.push(0x3d);
  }
  return Uint8Array.from(out);
}

/** One part's body as text, honouring charset and (conditionally) QP. */
function decodePartBody(part: GmailPayload): string {
  const data = part.body?.data;
  if (typeof data !== 'string' || data === '') return '';

  const bytes = Buffer.from(data, 'base64url');
  const charset = charsetOf(part.headers);
  const encoding = (headerValue(part.headers, 'content-transfer-encoding') ?? '').toLowerCase();

  if (encoding.includes('quoted-printable')) {
    // latin1 keeps one byte per character, so the QP scanner sees exactly the
    // bytes Gmail sent rather than a utf-8 interpretation of them.
    const ascii = bytes.toString('latin1');
    if (looksQuotedPrintable(ascii)) {
      return decodeBytes(decodeQuotedPrintableBytes(ascii), charset);
    }
  }

  return decodeBytes(bytes, charset);
}

// ---------------------------------------------------------------------------
// Part selection
// ---------------------------------------------------------------------------

/**
 * Depth-first search for the first part of a mime type that is not an
 * attachment.
 *
 * A non-empty `filename` means an attachment, and an attachment is never
 * decoded and never stored: a PDF decoded as text is 40 KB of binary in a prompt
 * that is paid for by the token, and a `.txt` attachment somebody forwarded is
 * not the message we were asked to classify.
 */
function findPart(payload: GmailPayload, mimeType: string): GmailPayload | null {
  const filename = typeof payload.filename === 'string' ? payload.filename : '';
  if (filename !== '') return null;

  const own = (payload.mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (own === mimeType && typeof payload.body?.data === 'string' && payload.body.data !== '') {
    return payload;
  }

  for (const part of payload.parts ?? []) {
    if (part === null || typeof part !== 'object') continue;
    const found = findPart(part, mimeType);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The plain text of a message: first `text/plain`, else `text/html` stripped,
 * else nothing.
 *
 * `multipart/alternative` carries both, and the HTML half is the one with the
 * tracking pixels, the inline CSS and the invisible preheader text. Preferring
 * `text/plain` is not just cheaper — it is the copy with the least noise in it.
 * A message with no `text/plain` part at all is common enough (every message
 * Outlook's web client sends) that the HTML path is a first-class case here, not
 * a fallback nobody exercises.
 */
export function extractPlainText(payload: GmailPayload | undefined): string {
  if (payload === undefined || payload === null) return '';

  const plain = findPart(payload, 'text/plain');
  if (plain !== null) {
    const text = decodePartBody(plain);
    if (text.trim() !== '') return normaliseNewlines(text);
  }

  const html = findPart(payload, 'text/html');
  if (html !== null) {
    const text = stripHtml(decodePartBody(html));
    if (text.trim() !== '') return text;
  }

  return '';
}

function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  euro: '€',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
};

/**
 * The handful of entities that actually appear, plus numeric references.
 *
 * Gmail's `snippet` is HTML-escaped even though it is presented as text, so this
 * runs over the snippet as well as over any HTML body. Without it an apostrophe
 * reaches the model as `&#39;` and a Greek quote as `&laquo;`, which is noise the
 * model then has to spend attention on.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return HTML_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML to something a model can read.
 *
 * Everything from the first `<blockquote` or `gmail_quote` container is dropped
 * before any tag stripping, for the reason in the header: in an HTML reply that
 * marker is where the quoted history starts, and there is no `>` prefix to catch
 * it further down.
 */
export function stripHtml(html: string): string {
  if (typeof html !== 'string' || html === '') return '';

  const quote = /<blockquote|class\s*=\s*["'][^"']*gmail_quote/i.exec(html);
  const visible = quote === null ? html : html.slice(0, quote.index);

  const text = visible
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(?:br|p|div|tr|li|ul|ol|h[1-6]|table|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');

  return decodeHtmlEntities(normaliseNewlines(text))
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded words
// ---------------------------------------------------------------------------

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

/**
 * `=?UTF-8?B?…?=` and `=?ISO-8859-7?Q?…?=` back to text.
 *
 * Two details that are easy to miss and both visible to the operator:
 *
 *   - Whitespace *between* two encoded words is not part of the text and must be
 *     dropped (RFC 2047 §6.2). A long Greek name arrives as several encoded
 *     words folded across lines; keeping the separators inserts spaces into the
 *     middle of the name.
 *   - `Q` encoding maps `_` to a space, not to an underscore. Getting that wrong
 *     turns `Μαρία Παπαδοπούλου` into `Μαρία_Παπαδοπούλου`.
 *
 * A charset label with an RFC 2231 language suffix (`UTF-8*el`) is accepted by
 * splitting on `*`. Anything that does not decode is returned as written, which
 * is ugly but honest and never throws.
 */
export function decodeEncodedWords(value: string): string {
  if (typeof value !== 'string' || value === '') return '';
  if (!value.includes('=?')) return value;

  // Fold the whitespace that separates two adjacent encoded words, including a
  // header continuation (CRLF + whitespace), before decoding.
  const folded = value.replace(/\?=(?:\r?\n)?[ \t]+(?==\?)/g, '?=');

  ENCODED_WORD.lastIndex = 0;
  return folded.replace(ENCODED_WORD, (whole, rawCharset: string, encoding: string, payload: string) => {
    const charset = (rawCharset.split('*')[0] ?? 'utf-8').toLowerCase();
    try {
      if (encoding.toLowerCase() === 'b') {
        return decodeBytes(Buffer.from(payload, 'base64'), charset);
      }
      const bytes = decodeQuotedPrintableBytes(payload.replace(/_/g, ' '));
      return decodeBytes(bytes, charset);
    } catch {
      return whole;
    }
  });
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function cleanAddress(raw: string): string | null {
  const address = raw.replace(/[\s<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
  if (address === '' || !address.includes('@')) return null;
  return address;
}

/**
 * The longest display name that will ever be stored.
 *
 * Nobody is called anything longer than this. The bound is not about tidiness:
 * `matchOrCreateContact` writes this string straight into `contacts.name`, and
 * from there it is rendered into `system[1]` of every classification, every
 * reply draft and every later follow-up draft for that contact. An unbounded
 * `From:` display name is therefore an unbounded per-message input-token cost
 * chosen by whoever sent the mail, repeated on every prompt about them for as
 * long as the row exists. A hundred and twenty characters is a name; anything
 * past it is a payload, and cutting it costs a real person nothing.
 */
export const MAX_DISPLAY_NAME_CHARS = 120;

/**
 * Normalise a `From:` display name into something safe to store.
 *
 * Control characters were already collapsed — a name is one line, and a name
 * carrying a newline is somebody laying out prompt structure rather than
 * introducing themselves. The length cap is the other half of the same idea;
 * see `MAX_DISPLAY_NAME_CHARS`. Truncated rather than rejected, because the
 * front of an over-long name is usually still the person's name and dropping it
 * entirely would leave the operator with a row identified only by an address.
 */
function cleanDisplayName(raw: string, email: string): string | null {
  let name = raw.trim().replace(/[\u0000-\u001f\u007f]+/g, ' ');
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    name = name.slice(1, -1);
  }
  name = decodeEncodedWords(name.replace(/\\(["\\])/g, '$1')).replace(/\s+/g, ' ').trim();
  if (name === '' || name.toLowerCase() === email.toLowerCase()) return null;
  return name.length > MAX_DISPLAY_NAME_CHARS ? name.slice(0, MAX_DISPLAY_NAME_CHARS).trim() : name;
}

/**
 * `Μαρία <maria@example.gr>` → `{ name: 'Μαρία', email: 'maria@example.gr' }`.
 *
 * The address is taken from the **last** angle-bracket pair, because a display
 * name is allowed to contain one (`"info@old.gr (was)" <info@new.gr>`) and taking
 * the first would silently address the wrong mailbox. A value with no `@` in it
 * returns null rather than a `GmailAddress` with a junk address: a contact row
 * created from that is a permanent piece of garbage in the operator's pipeline.
 */
export function parseAddress(header: string | null): GmailAddress | null {
  if (typeof header !== 'string') return null;
  const value = header.trim();
  if (value === '') return null;

  const open = value.lastIndexOf('<');
  const close = value.lastIndexOf('>');
  if (open !== -1 && close > open) {
    const email = cleanAddress(value.slice(open + 1, close));
    if (email === null) return null;
    return { name: cleanDisplayName(value.slice(0, open), email), email };
  }

  const email = cleanAddress(value);
  if (email === null) return null;
  return { name: null, email };
}

/**
 * A comma-separated header into addresses, ignoring commas inside quotes or
 * angle brackets — `"Παπαδόπουλος, Μαρία" <m@x.gr>` is one recipient, not two.
 */
export function parseAddressList(header: string | null): GmailAddress[] {
  if (typeof header !== 'string' || header.trim() === '') return [];

  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngles = false;

  for (const char of header) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === '<' && !inQuotes) inAngles = true;
    else if (char === '>' && !inQuotes) inAngles = false;

    if (char === ',' && !inQuotes && !inAngles) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  const out: GmailAddress[] = [];
  for (const part of parts) {
    const parsed = parseAddress(part);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quoted history
// ---------------------------------------------------------------------------

/**
 * The separators that mean "everything below here is the previous message".
 *
 * `On … wrote:` is allowed to span lines because Gmail wraps a long attribution
 * onto a second line ending in a bare `wrote:`, and the bounded `{0,400}` is what
 * stops the pattern matching a sentence at the top of the message against a
 * `wrote:` four paragraphs later.
 */
const QUOTE_SEPARATORS: readonly RegExp[] = [
  /^[ \t]*On\b[\s\S]{0,400}?\bwrote:[ \t]*$/m,
  // No `\b` on the Greek: JavaScript's word boundary is defined over ASCII word
  // characters only, so `\bέγραψε` never matches after a space and the whole
  // Greek attribution silently stops being recognised. This is the single most
  // load-bearing regex in the file and it fails open — the classifier just
  // quietly starts reading our own previous email.
  /^[ \t]*Στις[\s\S]{0,400}?έγραψε:[ \t]*$/m,
  /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}[ \t]*$/im,
  /^[ \t]*-{2,}[ \t]*Αρχικό μήνυμα[ \t]*-{2,}[ \t]*$/im,
  /^[ \t]*_{10,}[ \t]*$/m,
  /^[ \t]*(?:From|Από):[ \t]*.+[\r\n]+[ \t]*(?:Sent|Στάλθηκε|Ημερομηνία):[ \t]*.+$/m,
];

/**
 * The first line of our own compliance footer, in both languages.
 *
 * Matched on the sentence rather than on the em dash that precedes it: an em
 * dash alone on a line is ordinary punctuation, and cutting there would truncate
 * a customer's message at a dash they typed themselves. These strings are the
 * ones `gmail.ts`'s `complianceFooter` prints, and the test asserts that by
 * building the footer and feeding it back through.
 */
const FOOTER_OPENERS: readonly string[] = [
  'You are receiving this because',
  'Λαμβάνετε αυτό το μήνυμα επειδή',
  'Reply STOP and you will not be contacted again.',
  'Απαντήστε ΔΙΑΓΡΑΦΗ και δεν θα λάβετε άλλο μήνυμα.',
];

function footerCutIndex(text: string): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (FOOTER_OPENERS.some((opener) => line.startsWith(opener))) {
      // Cut at the em dash separator above it when there is one, so the divider
      // does not survive as a stray line.
      const previous = (lines[i - 1] ?? '').trim();
      if (i > 0 && (previous === '—' || previous === '--' || previous === '')) {
        return Math.max(0, offset - ((lines[i - 1] ?? '').length + 1));
      }
      return offset;
    }
    offset += (lines[i] ?? '').length + 1;
  }
  return -1;
}

/**
 * The customer's own new text, with the conversation history removed.
 *
 * Allowed to return the empty string. `parseMessage` decides what to do about
 * that; see the header.
 */
export function stripQuotedReply(text: string): string {
  if (typeof text !== 'string' || text === '') return '';
  const normalised = normaliseNewlines(text);

  let cut = normalised.length;
  for (const separator of QUOTE_SEPARATORS) {
    const match = separator.exec(normalised);
    if (match !== null && match.index < cut) cut = match.index;
  }
  const footer = footerCutIndex(normalised);
  if (footer !== -1 && footer < cut) cut = footer;

  const head = normalised.slice(0, cut);

  return head
    .split('\n')
    .filter((line) => !/^[ \t]*>/.test(line))
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------

/**
 * The exact words `complianceFooter` promises will work, folded so that case,
 * accents, final sigma and surrounding punctuation do not defeat them.
 */
const OPT_OUT_WORDS = new Set(['stop', 'unsubscribe', 'διαγραφη']);

function foldWord(line: string): string {
  return line
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/[^\p{L}]/gu, '');
}

/**
 * True when the message is a bare opt-out.
 *
 * Deterministic, free, and run **before** Haiku. A model call must not be the
 * thing that decides whether a legal opt-out was honoured: a classifier that
 * returns `question` for a message saying `ΔΙΑΓΡΑΦΗ` produces an automated reply
 * to somebody who has just exercised a right, which is the one mistake in this
 * system with a legal edge to it.
 *
 * Only the bare word counts. "Please stop sending me these" is an opt-out too,
 * but it is a sentence, and sentences are what the classifier is for — matching
 * loosely here would start closing contacts on the strength of a substring.
 */
export function detectOptOut(body: string): boolean {
  if (typeof body !== 'string' || body === '') return false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('>')) continue;
    return OPT_OUT_WORDS.has(foldWord(line));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

const GREEK_LETTERS = /[\u0370-\u03ff\u1f00-\u1fff]/gu;
const LATIN_LETTERS = /[A-Za-z]/g;

/**
 * Which language this was written in, for a contact that has none yet.
 *
 * A ratio rather than a majority, and the threshold is low on purpose. A Greek
 * message routinely carries an English signature block, a URL and a company
 * name, so "more Greek characters than Latin ones" would file real Greek mail as
 * English and answer a Greek customer in English. The reverse mistake — an
 * English message with a Greek name in the signature — needs the Greek to reach
 * a sixth of the letters, which a signature never does.
 *
 * With no letters at all the answer is `el`: it is the column default, the
 * operator's language, and the safer of the two to be wrong about here.
 */
export function guessLanguage(text: string): Language {
  if (typeof text !== 'string' || text === '') return 'el';
  const greek = (text.match(GREEK_LETTERS) ?? []).length;
  const latin = (text.match(LATIN_LETTERS) ?? []).length;
  const total = greek + latin;
  if (total === 0) return 'el';
  return greek / total >= 0.15 ? 'el' : 'en';
}

// ---------------------------------------------------------------------------
// The whole message
// ---------------------------------------------------------------------------

/** Cap without splitting a surrogate pair — a lone surrogate breaks JSON encoders. */
function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

function sanitiseSubject(raw: string | null): string | null {
  if (raw === null) return null;
  const decoded = decodeEncodedWords(raw)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return decoded === '' ? null : cap(decoded, MAX_SUBJECT_CHARS);
}

function isoFrom(internalDate: string | undefined, dateHeader: string | null, fallback: Date): string {
  if (typeof internalDate === 'string' && /^\d+$/.test(internalDate)) {
    const ms = Number(internalDate);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  if (dateHeader !== null) {
    const parsed = Date.parse(dateHeader);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback.toISOString();
}

export type ParseMessageOptions = {
  /** The operator's own address, for `isOwnMessage`. See judgement call 3. */
  ownAddress?: string | null;
  /** Only used when a message carries neither `internalDate` nor a `Date` header. */
  now?: Date;
};

/**
 * A Gmail message resource into the object the inbox agent works with.
 *
 * The body falls through three sources, and the order is the point:
 *
 *   1. the trimmed plain text — what the customer actually wrote this time;
 *   2. the untrimmed text, when trimming removed everything (a bottom-posted
 *      reply, a forward with no covering note);
 *   3. Gmail's `snippet`, when nothing decoded at all — an attachment-only
 *      message, a part in an encoding we could not read.
 *
 * Falling all the way to (3) is a bad outcome and is meant to be: a snippet is
 * 200 characters and the classifier will be unsure. It is still better than an
 * empty string, which classifies as nothing at all.
 */
export function parseMessage(resource: GmailMessageResource, options?: ParseMessageOptions): InboundMessage {
  const payload = resource.payload;
  const headers = payload?.headers;

  const labelIds = Array.isArray(resource.labelIds)
    ? resource.labelIds.filter((label): label is string => typeof label === 'string')
    : [];

  // The raw header is parsed before any encoded word is decoded. Decoding first
  // would let a display name that decodes to `<someone@else>` change which
  // address the structure parse finds, which is an inbound-controlled way of
  // choosing which contact a message is attributed to.
  const from = parseAddress(headerValue(headers, 'from'));

  const ownAddress = typeof options?.ownAddress === 'string' ? options.ownAddress.trim().toLowerCase() : '';
  const isOwnMessage =
    labelIds.includes('SENT') ||
    labelIds.includes('DRAFT') ||
    (ownAddress !== '' && from !== null && from.email.toLowerCase() === ownAddress);

  const raw = extractPlainText(payload);
  const trimmed = stripQuotedReply(raw);
  const snippet = decodeHtmlEntities(typeof resource.snippet === 'string' ? resource.snippet : '').trim();
  const body = trimmed !== '' ? trimmed : raw.trim() !== '' ? raw.trim() : snippet;

  return {
    id: resource.id,
    threadId: typeof resource.threadId === 'string' && resource.threadId !== '' ? resource.threadId : null,
    rfcMessageId: (headerValue(headers, 'message-id') ?? '').trim() || null,
    inReplyTo: (headerValue(headers, 'in-reply-to') ?? '').trim() || null,
    from,
    to: parseAddressList(headerValue(headers, 'to')),
    subject: sanitiseSubject(headerValue(headers, 'subject')),
    body: cap(body, MAX_BODY_CHARS),
    snippet,
    receivedAt: isoFrom(resource.internalDate, headerValue(headers, 'date'), options?.now ?? new Date()),
    labelIds,
    isOwnMessage,
  };
}
