import type { Metadata, Viewport } from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * The document, and nothing else.
 *
 * Chrome lives one level down, in `app/(app)/layout.tsx`. That split is why the
 * sign-in screen is not wrapped in an app it cannot use: a signed-out visitor
 * used to see Today / Inbox / Pipeline / Content / Money / Brain above the
 * magic-link form, every one of which bounced straight back to /login. Route
 * groups do not appear in the URL, so `/pipeline` is still `/pipeline`; the only
 * thing that changed is which pages get the nav.
 *
 * Two families, both self-hosted. `next/font/google` downloads the files at
 * build time and serves them from our own origin — there is no runtime request
 * to fonts.gstatic.com, and no CDN <link> in the document head.
 *
 * Inter carries the body text: it is the most legible face there is at 13px in
 * dense tables, and its job is to be invisible.
 *
 * Space Grotesk carries every number and heading. It is the proportional
 * sibling of Space Mono, so its figures keep the squared, drawn-with-a-ruler
 * character of a monospace while staying set-able as display type. That is
 * exactly the split the brief asks for: quiet body, characterful numbers.
 *
 * Both are variable fonts, so `weight` is a range, not a list of files.
 */
const sans = Inter({
  subsets: ['latin', 'greek'], // Greek: contact names and notes are often Greek.
  variable: '--font-sans-src',
  display: 'swap',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});

const display = Space_Grotesk({
  subsets: ['latin'], // No Greek cut — headings fall back to Inter for Greek text.
  variable: '--font-display-src',
  display: 'swap',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});

export const metadata: Metadata = {
  title: {
    default: 'Agency OS',
    template: '%s · Agency OS',
  },
  description: 'Internal operations app. One operator.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f2ec' },
    { media: '(prefers-color-scheme: dark)', color: '#131416' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="min-h-dvh bg-surface text-ink">{children}</body>
    </html>
  );
}
