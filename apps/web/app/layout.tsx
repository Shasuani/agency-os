import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// NOTE: Tailwind is not wired up yet — it needs postcss.config.mjs and
// app/globals.css, which are outside step 1's file list. Step 2 adds both
// and imports globals.css here.

export const metadata: Metadata = {
  title: 'Agency OS',
  description: 'Internal operations app. One operator.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
