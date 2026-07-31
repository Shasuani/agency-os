/**
 * Tailwind v4 is a single PostCSS plugin. There is no autoprefixer entry: v4
 * handles vendor prefixing itself, and there is no tailwind.config.ts — the
 * whole theme is CSS-first, in app/globals.css.
 *
 * @type {import('postcss-load-config').Config}
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
