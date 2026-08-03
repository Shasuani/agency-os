/**
 * Tests for `gmail.ts` — the message that actually leaves the building.
 *
 * `sendEmail` is not exercised against Gmail here. That needs a live refresh
 * token, a real mailbox and somebody's inbox to land in, and a test that sends
 * email is a test nobody dares run twice. What is tested is everything that
 * decides *what* would be sent — the MIME assembly, the Greek encoding, the
 * footer — plus the dry-run path, with a transport installed that counts calls
 * so the suite can prove no socket was opened rather than merely assume it.
 *
 * The bugs this file is aimed at all share a shape: they produce a message that
 * is sent successfully and arrives wrong. A subject split mid-codepoint arrives
 * as a row of black diamonds. A footer omitted arrives non-compliant. A bare LF
 * in a header arrives as whatever the receiving server felt like doing. None of
 * them throw, none of them fail a typecheck, and all of them are visible only to
 * the customer.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  GmailError,
  MAX_ENCODED_WORD_BYTES,
  MAX_RAW_BYTES,
  appendFooter,
  buildMimeMessage,
  complianceFooter,
  encodeHeaderWord,
  formatAddress,
  formatRfc2822Date,
  generateMessageId,
  resetAccessTokenCache,
  sendEmail,
  setGmailTransport,
  toBase64Url,
} from './gmail';
import type { ComplianceIdentity } from './gmail';

const IDENTITY: ComplianceIdentity = {
  businessName: 'Kolta Web',
  businessAddress: 'Ermou 12, 105 63 Athens, Greece',
  privacyPolicyUrl: 'https://example.gr/privacy',
};

/**
 * Reverse of `encodeHeaderWord`: unfold the continuation lines, decode each
 * encoded word, concatenate. Written from RFC 2047 rather than from the
 * implementation, so a symmetric bug in both would still be caught by the
 * byte-level assertions further down.
 */
function decodeHeaderWord(header: string): string {
  return header
    .split('\r\n ')
    .map((word) => {
      const match = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word);
      if (match === null) return word;
      return Buffer.from(match[1] ?? '', 'base64').toString('utf8');
    })
    .join('');
}

function encodedWordsOf(header: string): string[] {
  return header.split('\r\n ');
}

describe('encodeHeaderWord — ASCII stays readable', () => {
  it('leaves a plain ASCII subject alone', () => {
    // An encoded word here would be legal and would render as literal
    // =?UTF-8?B?...?= in a handful of clients. There is nothing to gain.
    assert.equal(encodeHeaderWord('Following up on the website'), 'Following up on the website');
  });

  it('leaves punctuation and digits alone', () => {
    assert.equal(encodeHeaderWord('Re: quote #1042 (revised)'), 'Re: quote #1042 (revised)');
  });

  it('encodes an ASCII string containing "=?", which would otherwise be misread', () => {
    const encoded = encodeHeaderWord('Is =?UTF-8?B?x?= a subject?');
    assert.notEqual(encoded, 'Is =?UTF-8?B?x?= a subject?');
    assert.equal(decodeHeaderWord(encoded), 'Is =?UTF-8?B?x?= a subject?');
  });
});

describe('encodeHeaderWord — Greek, which is the normal case', () => {
  it('encodes a Greek subject and decodes back byte-identically', () => {
    const subject = 'Καλημέρα, μια σύντομη υπενθύμιση';
    const encoded = encodeHeaderWord(subject);
    assert.match(encoded, /^=\?UTF-8\?B\?/);
    assert.equal(decodeHeaderWord(encoded), subject);
    assert.deepEqual(
      Buffer.from(decodeHeaderWord(encoded), 'utf8'),
      Buffer.from(subject, 'utf8'),
    );
  });

  it('splits a long Greek subject into several words, none over 75 characters', () => {
    // 75 is the RFC 2047 ceiling *including* the =?UTF-8?B? and ?= delimiters.
    // Exceeding it is how a subject line stops rendering in Outlook.
    // Trimmed: `encodeHeaderWord` strips leading and trailing whitespace, which a
    // header cannot carry meaningfully anyway.
    const subject = 'Καλημέρα σας, '.repeat(16).trim();
    const encoded = encodeHeaderWord(subject);
    const words = encodedWordsOf(encoded);
    assert.ok(words.length > 1, 'a 200-character Greek subject must fold');
    for (const word of words) {
      assert.ok(word.length <= 75, `encoded word was ${word.length} characters: ${word}`);
      assert.match(word, /^=\?UTF-8\?B\?.*\?=$/);
    }
    assert.equal(decodeHeaderWord(encoded), subject);
  });

  it('never splits a character across two words', () => {
    // The bug. Greek characters are two UTF-8 bytes; chunking on bytes without
    // respecting character boundaries puts half a character at the end of one
    // word and half at the start of the next, and both decode to U+FFFD. The
    // concatenated result would still look almost right, which is why this is
    // asserted per word rather than only on the whole.
    const subject = 'αβγδεζηθικλμνξοπρστυφχψω'.repeat(6);
    const words = encodedWordsOf(encodeHeaderWord(subject));
    for (const word of words) {
      const base64 = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word)?.[1] ?? '';
      const decoded = Buffer.from(base64, 'base64').toString('utf8');
      assert.equal(
        decoded.includes('�'),
        false,
        'an encoded word decoded to a replacement character — a codepoint was split',
      );
      assert.ok(Buffer.byteLength(decoded, 'utf8') <= MAX_ENCODED_WORD_BYTES);
    }
  });

  it('handles a character outside the BMP without splitting its surrogate pair', () => {
    // An emoji is one code point and two UTF-16 units. Iterating the string by
    // index rather than by code point would cut it in half.
    const subject = '🎉 '.repeat(30).trim();
    const words = encodedWordsOf(encodeHeaderWord(subject));
    for (const word of words) {
      const base64 = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word)?.[1] ?? '';
      assert.equal(Buffer.from(base64, 'base64').toString('utf8').includes('�'), false);
    }
    assert.equal(decodeHeaderWord(encodeHeaderWord(subject)), subject);
  });
});

describe('encodeHeaderWord — header injection', () => {
  it('a CRLF in a subject cannot become a second header', () => {
    // The draft comes from a language model and is then edited by hand. Neither
    // end of that pipeline is a place to assume clean input.
    const encoded = encodeHeaderWord('Hello\r\nBcc: someone@example.com');
    assert.equal(encoded.includes('\r'), false);
    assert.equal(encoded.includes('\n'), false);
    assert.equal(encoded, 'Hello Bcc: someone@example.com');
  });

  it('a control character in a Greek subject is removed before encoding', () => {
    const encoded = encodeHeaderWord('Γεια\r\nBcc: x@y.gr');
    assert.equal(decodeHeaderWord(encoded).includes('\n'), false);
  });

  it('an empty subject encodes to an empty string, which is legal', () => {
    // The guardrails allow an empty subject on purpose; Gmail accepts a
    // subjectless message and the card flags it instead.
    assert.equal(encodeHeaderWord(''), '');
    assert.equal(encodeHeaderWord('   '), '');
  });
});

describe('formatAddress', () => {
  it('returns the bare address when there is no name', () => {
    assert.equal(formatAddress('maria@example.gr'), 'maria@example.gr');
    assert.equal(formatAddress('maria@example.gr', null), 'maria@example.gr');
    assert.equal(formatAddress('maria@example.gr', '  '), 'maria@example.gr');
  });

  it('passes a simple ASCII name through unquoted', () => {
    assert.equal(formatAddress('maria@example.gr', 'Maria P'), 'Maria P <maria@example.gr>');
  });

  it('quotes an ASCII name containing a special character', () => {
    // Unquoted, the comma reads as an address separator and the message goes to
    // two recipients, one of whom does not exist.
    assert.equal(
      formatAddress('maria@example.gr', 'Papadopoulou, Maria'),
      '"Papadopoulou, Maria" <maria@example.gr>',
    );
  });

  it('encodes a Greek name and does NOT quote the encoded word', () => {
    // A quoted encoded-word is displayed literally by the receiving client,
    // which is worse than not encoding at all.
    const formatted = formatAddress('maria@example.gr', 'Μαρία Παπαδοπούλου');
    assert.match(formatted, /^=\?UTF-8\?B\?[^"]*\?= <maria@example\.gr>$/);
    assert.equal(formatted.includes('"'), false);
    assert.equal(decodeHeaderWord(formatted.split(' <')[0] ?? ''), 'Μαρία Παπαδοπούλου');
  });

  it('strips angle brackets and whitespace from the address itself', () => {
    assert.equal(formatAddress(' <maria@example.gr> ', 'Maria'), 'Maria <maria@example.gr>');
  });
});

describe('the compliance footer', () => {
  it('carries all four GDPR elements in English', () => {
    const footer = complianceFooter('en', IDENTITY);
    assert.ok(footer.includes('Reply STOP'), 'opt-out instruction');
    assert.ok(footer.includes('Kolta Web'), 'sender identity');
    assert.ok(footer.includes('Ermou 12, 105 63 Athens, Greece'), 'physical address');
    assert.ok(footer.includes('https://example.gr/privacy'), 'privacy policy link');
  });

  it('carries all four GDPR elements in Greek', () => {
    const footer = complianceFooter('el', IDENTITY);
    assert.ok(footer.includes('ΔΙΑΓΡΑΦΗ'), 'opt-out instruction');
    assert.ok(footer.includes('Kolta Web'), 'sender identity');
    assert.ok(footer.includes('Ermou 12, 105 63 Athens, Greece'), 'physical address');
    assert.ok(footer.includes('Απόρρητο: https://example.gr/privacy'), 'privacy policy link');
  });

  it('uses an em dash and never the RFC 3676 signature delimiter', () => {
    // "-- " makes mail clients collapse everything after it behind a "show
    // trimmed content" button. A legal notice hidden by default is not a legal
    // notice.
    for (const language of ['el', 'en'] as const) {
      const footer = complianceFooter(language, IDENTITY);
      assert.equal(footer.startsWith('—\n'), true);
      assert.equal(footer.includes('\n-- \n'), false);
      assert.equal(footer.startsWith('-- '), false);
    }
  });

  it('the Greek opt-out keyword is exactly the word step 8 will match on', () => {
    // If this word drifts, the reply-keyword opt-out silently stops working and
    // the promise in the footer becomes false.
    assert.ok(complianceFooter('el', IDENTITY).includes('Απαντήστε ΔΙΑΓΡΑΦΗ'));
    assert.ok(complianceFooter('en', IDENTITY).includes('Reply STOP'));
  });
});

describe('appendFooter', () => {
  const body = 'Καλημέρα Μαρία,\n\nΜια σύντομη υπενθύμιση για την προσφορά.\n\nΚώστας';

  it('leaves the body’s own newlines exactly as the operator typed them', () => {
    const combined = appendFooter(body, 'el', IDENTITY);
    assert.ok(combined.startsWith(body), 'the operator’s text must be untouched and first');
    assert.ok(combined.includes('\n\nΜια σύντομη'), 'interior paragraph breaks survive');
  });

  it('separates the body from the footer with exactly one blank line', () => {
    const combined = appendFooter(body, 'el', IDENTITY);
    assert.ok(combined.includes(`${body}\n\n—\n`));
    assert.equal(combined.includes('\n\n\n'), false);
  });

  it('does not open a gap when the draft ends in trailing whitespace', () => {
    // A model-written draft very often ends in a stray newline.
    const combined = appendFooter(`${body}\n\n  \n`, 'el', IDENTITY);
    assert.ok(combined.includes(`${body}\n\n—\n`));
  });

  it('appends the English footer for an English contact', () => {
    assert.ok(appendFooter('Morning Maria,', 'en', IDENTITY).includes('Reply STOP'));
    assert.equal(appendFooter('Morning Maria,', 'en', IDENTITY).includes('ΔΙΑΓΡΑΦΗ'), false);
  });
});

describe('buildMimeMessage', () => {
  const base = {
    to: 'maria@example.gr',
    toName: 'Μαρία Παπαδοπούλου',
    subject: 'Μια σύντομη υπενθύμιση',
    body: 'Καλημέρα,\n\nΜια υπενθύμιση.\n\n—\nKolta Web · Ermou 12',
    messageId: '<abc123.1700000000000@agency-os.local>',
    date: new Date('2026-08-04T07:07:00Z'),
  };

  it('uses CRLF everywhere and never a bare LF', () => {
    // A bare LF in a header is a malformed message. Gmail currently tolerates
    // it; relying on that is how a working system breaks on somebody else's
    // upgrade.
    const message = buildMimeMessage(base);
    assert.equal(/[^\r]\n/.test(message), false, 'found a bare LF');
    assert.equal(/\r[^\n]/.test(message), false, 'found a bare CR');
  });

  it('separates headers from body with one blank line', () => {
    const message = buildMimeMessage(base);
    const split = message.indexOf('\r\n\r\n');
    assert.ok(split > 0);
    const headers = message.slice(0, split).split('\r\n');
    assert.equal(headers[0], 'MIME-Version: 1.0');
  });

  it('writes the headers in the agreed order', () => {
    const message = buildMimeMessage(base);
    const headerNames = message
      .slice(0, message.indexOf('\r\n\r\n'))
      .split('\r\n')
      .filter((line) => !line.startsWith(' '))
      .map((line) => line.slice(0, line.indexOf(':')));
    assert.deepEqual(headerNames, [
      'MIME-Version',
      'Date',
      'Message-ID',
      'To',
      'Subject',
      'Content-Type',
      'Content-Transfer-Encoding',
    ]);
  });

  it('writes no From header — userId "me" fills it, and PLAN §8 has no sender variable', () => {
    assert.equal(/^From:/m.test(buildMimeMessage(base)), false);
  });

  it('writes no List-Unsubscribe header — there is nothing behind it in v1', () => {
    assert.equal(/List-Unsubscribe/i.test(buildMimeMessage(base)), false);
  });

  it('declares UTF-8 and base64', () => {
    const message = buildMimeMessage(base);
    assert.ok(message.includes('Content-Type: text/plain; charset="UTF-8"'));
    assert.ok(message.includes('Content-Transfer-Encoding: base64'));
  });

  it('encodes the body as base64 that decodes back to the exact text', () => {
    const message = buildMimeMessage(base);
    const body = message.slice(message.indexOf('\r\n\r\n') + 4);
    const decoded = Buffer.from(body.split('\r\n').join(''), 'base64').toString('utf8');
    assert.equal(decoded, base.body);
  });

  it('wraps base64 body lines at 76 characters', () => {
    const message = buildMimeMessage({ ...base, body: 'Καλημέρα σας. '.repeat(40) });
    const body = message.slice(message.indexOf('\r\n\r\n') + 4);
    const lines = body.split('\r\n').filter((line) => line !== '');
    assert.ok(lines.length > 1, 'a long body must wrap');
    for (const line of lines) assert.ok(line.length <= 76, `line was ${line.length} characters`);
  });

  it('omits In-Reply-To and References when there is no thread', () => {
    const message = buildMimeMessage(base);
    assert.equal(/In-Reply-To/.test(message), false);
    assert.equal(/References/.test(message), false);
  });

  it('writes In-Reply-To and References together when there is one', () => {
    // A client that sees one without the other threads inconsistently.
    const message = buildMimeMessage({ ...base, inReplyTo: '<prev@mail.gmail.com>' });
    assert.ok(message.includes('In-Reply-To: <prev@mail.gmail.com>'));
    assert.ok(message.includes('References: <prev@mail.gmail.com>'));
  });

  it('folds a long Greek subject across continuation lines correctly', () => {
    const subject = 'Καλημέρα σας, μια σύντομη υπενθύμιση για την προσφορά μας';
    const message = buildMimeMessage({ ...base, subject });
    const headerBlock = message.slice(0, message.indexOf('\r\n\r\n'));
    const start = headerBlock.indexOf('Subject: ');
    const rest = headerBlock.slice(start + 'Subject: '.length);
    const end = rest.search(/\r\n(?! )/);
    const value = end === -1 ? rest : rest.slice(0, end);
    assert.equal(decodeHeaderWord(value), subject);
    // Continuation lines must begin with a space, or the header ends early.
    for (const line of value.split('\r\n').slice(1)) assert.ok(line.startsWith(' '));
  });
});

describe('formatRfc2822Date', () => {
  it('formats in UTC with a numeric offset, not the obsolete GMT zone', () => {
    assert.equal(
      formatRfc2822Date(new Date('2026-08-04T07:07:00Z')),
      'Tue, 04 Aug 2026 07:07:00 +0000',
    );
  });

  it('zero-pads the day, hour, minute and second', () => {
    assert.equal(
      formatRfc2822Date(new Date('2026-01-05T03:04:05Z')),
      'Mon, 05 Jan 2026 03:04:05 +0000',
    );
  });
});

describe('toBase64Url', () => {
  it('produces no +, / or = characters', () => {
    // The three-replace hand-rolled version of this is one of the commonest
    // sources of a 400 from users.messages.send.
    const encoded = toBase64Url('Καλημέρα;;;???>>>???ÿþý');
    assert.equal(/[+/=]/.test(encoded), false);
  });

  it('round-trips through base64url back to the same bytes', () => {
    const value = 'MIME-Version: 1.0\r\n\r\nΚαλημέρα';
    assert.equal(Buffer.from(toBase64Url(value), 'base64url').toString('utf8'), value);
  });
});

describe('generateMessageId', () => {
  it('has the documented shape', () => {
    assert.match(generateMessageId(), /^<[0-9a-f]{16}\.\d+@agency-os\.local>$/);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateMessageId()));
    assert.equal(ids.size, 500);
  });
});

describe('GmailError classification', () => {
  it('a 429 is retryable', () => {
    assert.equal(new GmailError('rate_limit', 'x', { status: 429 }).retryable, true);
  });

  it('a 5xx is retryable and a 4xx is not', () => {
    assert.equal(new GmailError('api_error', 'x', { status: 503 }).retryable, true);
    assert.equal(new GmailError('api_error', 'x', { status: 400 }).retryable, false);
  });

  it('a network failure is retryable — a reset socket is not a bad message', () => {
    // Deliberately broader than the interface contract's note. Marking a
    // transient connection failure terminal would resolve the task as `skipped`
    // and the follow-up would never be sent.
    assert.equal(new GmailError('network', 'x').retryable, true);
  });

  it('auth, config and message_too_large are terminal', () => {
    assert.equal(new GmailError('auth', 'x', { status: 401 }).retryable, false);
    assert.equal(new GmailError('config', 'x').retryable, false);
    assert.equal(new GmailError('message_too_large', 'x').retryable, false);
  });

  it('is catchable by name and by instance', () => {
    const error = new GmailError('config', 'x');
    assert.equal(error.name, 'GmailError');
    assert.ok(error instanceof Error);
  });
});

describe('sendEmail under dry run', () => {
  const ORIGINAL = {
    DRY_RUN: process.env['DRY_RUN'],
    BUSINESS_NAME: process.env['BUSINESS_NAME'],
    BUSINESS_ADDRESS: process.env['BUSINESS_ADDRESS'],
    PRIVACY_POLICY_URL: process.env['PRIVACY_POLICY_URL'],
  };

  /** Counts requests. Nothing in this suite may make one. */
  let requests = 0;

  beforeEach(() => {
    requests = 0;
    setGmailTransport(async (url) => {
      requests += 1;
      throw new Error(`the test made a real request to ${url}`);
    });
    process.env['DRY_RUN'] = 'true';
    process.env['BUSINESS_NAME'] = IDENTITY.businessName;
    process.env['BUSINESS_ADDRESS'] = IDENTITY.businessAddress;
    process.env['PRIVACY_POLICY_URL'] = IDENTITY.privacyPolicyUrl;
  });

  afterEach(() => {
    setGmailTransport(null);
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns a stubbed result and opens no socket', async () => {
    const result = await sendEmail({
      to: 'maria@example.gr',
      toName: 'Μαρία',
      subject: 'Μια σύντομη υπενθύμιση',
      body: 'Καλημέρα Μαρία,\n\nΜια υπενθύμιση.',
      language: 'el',
      taskId: '00000000-0000-4000-8000-000000000001',
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.id, null);
    assert.equal(result.threadId, null);
    assert.match(result.messageId, /^<[0-9a-f]{16}\.\d+@agency-os\.local>$/);
    assert.ok(result.rawBytes > 0);
    assert.equal(requests, 0, 'a dry run must not touch the network');
  });

  it('carries the thread id straight back through', async () => {
    const result = await sendEmail({
      to: 'maria@example.gr',
      subject: 'Re: quote',
      body: 'Morning.',
      language: 'en',
      threadId: 'thread-1',
      taskId: '00000000-0000-4000-8000-000000000002',
    });
    assert.equal(result.threadId, 'thread-1');
    assert.equal(requests, 0);
  });

  it('still builds the whole message, so an encoding bug surfaces in development', async () => {
    // The dry run's rawBytes must include the footer. If it did not, the size
    // limit and the encoding would only ever be exercised on a live send.
    const withoutFooter = await sendEmail({
      to: 'maria@example.gr',
      subject: '',
      body: 'x',
      language: 'el',
      taskId: '00000000-0000-4000-8000-000000000003',
    });
    const footerBytes = Buffer.byteLength(complianceFooter('el', IDENTITY), 'utf8');
    assert.ok(
      withoutFooter.rawBytes > footerBytes,
      'the dry run did not build the footer into the message',
    );
  });

  it('refuses when BUSINESS_ADDRESS is unset, even under dry run', async () => {
    // A dry run whose only difference from production is that production would
    // have failed is not a dry run. And an EU commercial message without a
    // physical address is not a message this system may send.
    delete process.env['BUSINESS_ADDRESS'];
    await assert.rejects(
      () =>
        sendEmail({
          to: 'maria@example.gr',
          subject: 'Hello',
          body: 'Morning.',
          language: 'en',
          taskId: '00000000-0000-4000-8000-000000000004',
        }),
      (error: unknown) => {
        assert.ok(error instanceof GmailError);
        assert.equal(error.kind, 'config');
        assert.equal(error.retryable, false);
        assert.match(error.message, /BUSINESS_ADDRESS/);
        return true;
      },
    );
    assert.equal(requests, 0);
  });

  it('refuses a message over the size limit before anything is sent', async () => {
    await assert.rejects(
      () =>
        sendEmail({
          to: 'maria@example.gr',
          subject: 'Hello',
          body: 'a'.repeat(MAX_RAW_BYTES + 1),
          language: 'en',
          taskId: '00000000-0000-4000-8000-000000000005',
        }),
      (error: unknown) => {
        assert.ok(error instanceof GmailError);
        assert.equal(error.kind, 'message_too_large');
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(requests, 0);
  });

  it('defaults to the Greek footer when the contact has no language', async () => {
    // Most contacts are Greek and `contacts.language` is nullable. Defaulting to
    // English would send an English legal notice to a Greek recipient.
    const greek = await sendEmail({
      to: 'maria@example.gr',
      subject: 'x',
      body: 'y',
      language: null,
      taskId: '00000000-0000-4000-8000-000000000006',
    });
    const english = await sendEmail({
      to: 'maria@example.gr',
      subject: 'x',
      body: 'y',
      language: 'en',
      taskId: '00000000-0000-4000-8000-000000000007',
    });
    // The Greek footer is longer in bytes than the English one; identical
    // rawBytes would mean the language was ignored.
    assert.notEqual(greek.rawBytes, english.rawBytes);
    assert.equal(requests, 0);
  });
});

// ---------------------------------------------------------------------------
// The live path
// ---------------------------------------------------------------------------

/**
 * `DRY_RUN=false`, with a transport that answers instead of a socket.
 *
 * The header of this file used to say the live path needs "a real mailbox and
 * somebody's inbox to land in". The mailbox is real; the transport is the seam
 * that was built precisely so it does not have to be, and leaving it unused for
 * the one path that can actually send a customer two copies of the same message
 * was the wrong trade.
 *
 * Everything below is about the same fault line: **once Gmail has returned 2xx
 * the message is gone**, and every failure after that instant is a failure to
 * learn about a send rather than a failed send. Anything thrown from there is
 * classified by the send queue as retryable, which means the follow-up leaves
 * twice, sixty seconds apart, and the log says the first attempt failed.
 */
describe('sendEmail against a faked Gmail', () => {
  const ORIGINAL = {
    DRY_RUN: process.env['DRY_RUN'],
    BUSINESS_NAME: process.env['BUSINESS_NAME'],
    BUSINESS_ADDRESS: process.env['BUSINESS_ADDRESS'],
    PRIVACY_POLICY_URL: process.env['PRIVACY_POLICY_URL'],
    GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'],
    GOOGLE_CLIENT_SECRET: process.env['GOOGLE_CLIENT_SECRET'],
    GMAIL_REFRESH_TOKEN: process.env['GMAIL_REFRESH_TOKEN'],
  };

  const TOKEN_URL = 'https://oauth2.googleapis.com/token';

  /** URLs the transport was asked for, in order. */
  let calls: string[] = [];

  const originalLog = console.log;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  /** A 2xx whose body is not JSON — a proxy error page, a truncated read. */
  function garbage(status = 200): Response {
    return new Response('<html>gateway</html>', {
      status,
      headers: { 'content-type': 'text/html' },
    });
  }

  /** Installs a transport that mints a token and then answers the send. */
  function respondWith(send: () => Response): void {
    setGmailTransport(async (url) => {
      calls.push(url);
      if (url === TOKEN_URL) return json({ access_token: 'token-1', expires_in: 3600 });
      return send();
    });
  }

  function message(taskId: string) {
    return {
      to: 'maria@example.gr',
      subject: 'Μια σύντομη υπενθύμιση',
      body: 'Καλημέρα.',
      language: 'el' as const,
      taskId,
    };
  }

  beforeEach(() => {
    calls = [];
    console.log = () => {};
    // The access token is cached for the life of the process. Without this, the
    // second test in this block would assert against a token the first one
    // minted and would never reach the code it is about.
    resetAccessTokenCache();
    process.env['DRY_RUN'] = 'false';
    process.env['BUSINESS_NAME'] = IDENTITY.businessName;
    process.env['BUSINESS_ADDRESS'] = IDENTITY.businessAddress;
    process.env['PRIVACY_POLICY_URL'] = IDENTITY.privacyPolicyUrl;
    process.env['GOOGLE_CLIENT_ID'] = 'client-id';
    process.env['GOOGLE_CLIENT_SECRET'] = 'client-secret';
    process.env['GMAIL_REFRESH_TOKEN'] = 'refresh-token';
  });

  afterEach(() => {
    console.log = originalLog;
    setGmailTransport(null);
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns Gmail’s ids on a normal send', async () => {
    respondWith(() => json({ id: 'gmail-1', threadId: 'thread-1' }));

    const result = await sendEmail(message('00000000-0000-4000-8000-00000000000a'));

    assert.equal(result.dryRun, false);
    assert.equal(result.id, 'gmail-1');
    assert.equal(result.threadId, 'thread-1');
    assert.deepEqual(calls.length, 2, 'one token, one send');
  });

  it('does not throw when a 200 comes back with an unreadable body', async () => {
    // The message left. Throwing here — which is what `await response.json()`
    // outside a try does — hands the send queue a `SyntaxError`, which is not a
    // `GmailError`, which defers, and the same message goes out again a minute
    // later. There is no `interactions` row yet either, so nothing else in the
    // system would have caught it.
    respondWith(() => garbage());

    const result = await sendEmail(message('00000000-0000-4000-8000-00000000000b'));

    assert.equal(result.dryRun, false);
    assert.equal(result.id, null, 'the id is what was lost, not the message');
    assert.ok(result.messageId.length > 0);
  });

  it('keeps the thread id it was given when the response cannot be read', async () => {
    respondWith(() => garbage());

    const result = await sendEmail({
      ...message('00000000-0000-4000-8000-00000000000c'),
      threadId: 'thread-9',
    });

    assert.equal(result.threadId, 'thread-9');
  });

  it('retries a 401 once with a fresh token and gives up on the second', async () => {
    setGmailTransport(async (url) => {
      calls.push(url);
      if (url === TOKEN_URL) return json({ access_token: `token-${calls.length}`, expires_in: 3600 });
      return new Response('', { status: 401 });
    });

    await assert.rejects(
      () => sendEmail(message('00000000-0000-4000-8000-00000000000d')),
      (error: unknown) => {
        assert.ok(error instanceof GmailError);
        assert.equal(error.kind, 'auth');
        assert.equal(error.retryable, false, 'a revoked refresh token is not fixed by waiting');
        return true;
      },
    );

    assert.equal(calls.filter((url) => url !== TOKEN_URL).length, 2, 'exactly one retry');
  });

  it('treats a 429 from the send as retryable and a 400 as terminal', async () => {
    respondWith(() => new Response('', { status: 429 }));
    await assert.rejects(
      () => sendEmail(message('00000000-0000-4000-8000-00000000000e')),
      (error: unknown) => {
        assert.ok(error instanceof GmailError);
        assert.equal(error.kind, 'rate_limit');
        assert.equal(error.retryable, true);
        return true;
      },
    );

    calls = [];
    respondWith(() => new Response('', { status: 400 }));
    await assert.rejects(
      () => sendEmail(message('00000000-0000-4000-8000-00000000000f')),
      (error: unknown) => {
        assert.ok(error instanceof GmailError);
        assert.equal(error.kind, 'api_error');
        assert.equal(error.retryable, false, 'a malformed message fails identically forever');
        return true;
      },
    );
  });

  it('does not call a token-endpoint 503 an auth failure', async () => {
    // Judgement call 2 in the module header, never asserted until now. Mapping a
    // bad minute at Google to non-retryable `auth` resolves the morning's queue
    // to `skipped` and the follow-ups are never sent.
    setGmailTransport(async (url) => {
      calls.push(url);
      return new Response('', { status: 503 });
    });

    await assert.rejects(
      () => sendEmail(message('00000000-0000-4000-8000-000000000010')),
      (error: unknown) => {
        assert.ok(error instanceof GmailError);
        assert.equal(error.kind, 'api_error');
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it('does call a token-endpoint 400 an auth failure', async () => {
    setGmailTransport(async (url) => {
      calls.push(url);
      return new Response('', { status: 400 });
    });

    await assert.rejects(
      () => sendEmail(message('00000000-0000-4000-8000-000000000011')),
      (error: unknown) => {
        assert.ok(error instanceof GmailError);
        assert.equal(error.kind, 'auth');
        assert.equal(error.retryable, false);
        assert.match(error.message, /GMAIL_REFRESH_TOKEN/);
        return true;
      },
    );
  });

  it('never puts a credential, an address or a body in an error message', async () => {
    setGmailTransport(async (url) => {
      calls.push(url);
      // Google echoes request parameters back in token errors, which is how a
      // client secret reaches a log file. The body is deliberately not read.
      return new Response(JSON.stringify({ error: 'invalid_grant', client_secret: 'client-secret' }), {
        status: 400,
      });
    });

    await assert.rejects(
      () => sendEmail(message('00000000-0000-4000-8000-000000000012')),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('client-secret'));
        assert.ok(!error.message.includes('refresh-token'));
        assert.ok(!error.message.includes('maria@example.gr'));
        assert.ok(!error.message.includes('Καλημέρα'));
        return true;
      },
    );
  });
});
