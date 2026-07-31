# Agency OS — design system

The rules for every screen in `apps/web`. If a screen contradicts this file, the
screen is wrong.

Source of truth for the actual values is [`app/globals.css`](./app/globals.css).
This file explains what the tokens mean and when to reach for each one.

---

## 0. The point of view, in one paragraph

This is an instrument, not a product page. One person opens it every morning
and should be able to finish with it in ninety seconds. So: **chrome is
monochrome, and colour is a data channel.** The nav, the buttons, the panels,
the table furniture — all of it is warm greys and ink. Hue appears only where it
carries meaning: a stage, an overdue date, an error, a won deal. If everything
is coloured, nothing is. The surface is warm paper rather than white, and the
one accent is a cool cobalt, because a cool accent on a warm ground stays
legible for an hour without buzzing.

Practical consequences you will feel while building:

- The primary button is **ink**, not accent. `variant="primary"` is black-on-bone.
- Do not introduce a colour to make something "pop". Introduce hierarchy instead:
  size, weight, or the display face.
- Density is the feature. Base font size is **13px**, table rows are **34px**.
  Whitespace is earned, not sprinkled.

---

## 1. Setup

Tailwind **v4, CSS-first**. There is deliberately **no `tailwind.config.ts`** —
the entire theme lives in the `@theme` block in `app/globals.css`, and
`postcss.config.mjs` loads the single `@tailwindcss/postcss` plugin. If you want
a new token, add it to `@theme`; do not create a config file.

Theming works by variable indirection:

```
:root { --surface: #f5f2ec; }          ← raw values, light
[data-theme='dark'] { --surface: … }   ← raw values, dark
@theme inline { --color-surface: var(--surface); }   ← becomes `bg-surface`
```

Because the utilities compile to `var(--surface)`, **they flip themselves**.
Write `bg-raised text-ink border-line` once and both themes are done.

> **If you are writing a `dark:` variant, you are missing a token.** Add the
> token here instead of branching at the call site. The `dark:` variant exists
> for inverted imagery and nothing else.

Dark follows the OS. `<html data-theme="light">` or `data-theme="dark"` pins it.
`color-scheme` is set, so native `<select>` popups, `<input type="date">`
pickers and scrollbars theme themselves — which is most of why the form
primitives are native controls.

---

## 2. Palette

Every value below is already a token. **No component in this app should contain
a hex value** — and Tailwind's default palette (`text-red-500`, `bg-slate-100`,
`text-gray-400`) is off limits too. Those colours are still generated because v4
ships them, but they do not flip with the theme and they are not part of this
system. If you reach for one, the token you actually want is in the tables
below; if it genuinely is not, add it to `@theme` first.

### Surfaces and ink

| Token (utility)             | Light     | Dark      | Use it for                                                        |
| --------------------------- | --------- | --------- | ----------------------------------------------------------------- |
| `surface` (`bg-surface`)    | `#f5f2ec` | `#131416` | The page. Warm bone / cool graphite.                              |
| `raised` (`bg-raised`)      | `#fbf9f5` | `#1a1c1f` | Panels, cards, table headers, inputs — anything above the page.   |
| `sunken` (`bg-sunken`)      | `#eae6de` | `#0e0f11` | Wells, disabled inputs, inert chips, hover on ghost buttons.      |
| `line` (`border-line`)      | `#ddd7cb` | `#292c30` | Hairlines: row separators, panel edges. The default border.       |
| `line-strong`               | `#c3bbab` | `#3d4146` | Borders that must actually read: inputs, selects, key dividers.   |
| `ink` (`text-ink`)          | `#1b1a17` | `#e9e6e0` | Primary text, headings, numbers. Also the primary button's fill.  |
| `muted` (`text-muted`)      | `#5d594f` | `#9a958c` | Secondary text, column headers, metadata, field labels.           |
| `faint` (`text-faint`)      | `#8a8478` | `#6d6961` | Tertiary: placeholders, units, "—" for an empty cell, stub marks. |

Three levels of text and no more. If you need a fourth, you need a different
layout.

### Accent — interaction only

| Token            | Light     | Dark      | Use it for                                            |
| ---------------- | --------- | --------- | ----------------------------------------------------- |
| `accent`         | `#2b4c8c` | `#7fa5e0` | Focus rings, links, active nav rule, selection edge.   |
| `accent-hover`   | `#1f3a6d` | `#9cbaea` | Hover on accent-filled things.                         |
| `accent-fg`      | `#fbf9f5` | `#0e0f11` | Text on top of `accent`.                               |
| `accent-subtle`  | `#e1e8f4` | `#1b2635` | Tinted background: the `replied` badge, selected rows. |

Accent is never a stage colour and never a metric colour. It means "you can
interact with this" or "you are here".

### Data semantics

Each has a base, a foreground for use on top of the base, and a subtle tint for
backgrounds.

| Token group | Light base | Dark base | Means                                                                |
| ----------- | ---------- | --------- | -------------------------------------------------------------------- |
| `positive`  | `#2e6b3a`  | `#6fbe7c` | `won`. A confirmed save. Money in.                                    |
| `danger`    | `#a33127`  | `#ee7b70` | `lost`, field errors, destructive actions, **overdue `next_touch_at`**. |
| `warning`   | `#7d5a11`  | `#d9a94a` | Due today / due soon, `do_not_contact`, kill-switch on.               |

Suffixes: `-fg` (text on the base), `-subtle` (background tint). So
`bg-positive text-positive-fg` for a filled chip, `bg-danger-subtle text-danger`
for a tinted one.

**The date rule, since three screens will need it:** `next_touch_at` in the past
is `text-danger`; today or within 48h is `text-warning`; further out is
`text-muted`; null is `text-faint` and renders as `—`.

---

## 3. Type

Two families, both self-hosted by `next/font/google` in `app/layout.tsx`. No CDN
link, no runtime request to Google.

**Inter** — `font-sans`, the body. Chosen because it is the most legible face
that exists at 13px in a dense table, and because its job here is to be
invisible. Loaded with the Greek subset: contact names and notes are frequently
Greek and must not fall back mid-sentence. `cv05`/`cv08` are on, for a
single-storey `l` and a slashed zero.

**Space Grotesk** — `font-display`, every heading and every number. It is the
proportional sibling of Space Mono, so its figures keep the squared,
drawn-with-a-ruler character of a monospace while still setting as display type.
That is exactly the split the brief asks for: a quiet body face and numerals
with a face of their own. Latin only — Greek headings fall back to Inter, which
is fine because headings in this app are English UI labels.

`font-mono` is the system monospace stack. Zero payload. Use it for machine
strings a human copies: message ids, tokens, raw JSON in `/brain`.

`h1`–`h4` are already display-face and `-0.012em` tracked in the base layer.
You do not need to add `font-display` to a heading.

### Size ladder

Dense on purpose. Body is 13px.

| Utility     | px  | Use                                                    |
| ----------- | --- | ------------------------------------------------------ |
| `text-2xs`  | 10  | Micro caps: badges, column headers, field labels.       |
| `text-xs`   | 11  | Hints, errors, dense metadata.                          |
| `text-sm`   | 12  | Table cells, secondary text, small buttons.             |
| `text-base` | 13  | **Body default.** Already on `<body>`.                  |
| `text-md`   | 14  | Form controls, emphasised body.                         |
| `text-lg`   | 16  | Section headings.                                       |
| `text-xl`   | 20  | Page title.                                             |
| `text-2xl`  | 26  | Inline figures.                                         |
| `text-3xl`  | 34  | Metric tiles (step 6).                                  |

### Three utilities

- **`numeric`** — display face + tabular figures. Put it on **anything the
  operator reads as a number**: dates, counts, currency, value estimates, ids.
  Columns then line up and digits get their character. `<Input numeric />` does
  this for you.
- **`label-caps`** — 10px uppercase display, `0.07em` tracked. Table column
  headers and field labels. **Sets no colour** — pair it with `text-muted` or
  `text-faint`, or the two fight over source order.
- **`hairline`** — a 1px inset ring for panel edges where a real border would
  shift layout.

---

## 4. Space, geometry, density

**4px grid.** `--spacing` is `0.25rem`, so `p-2` = 8px, `gap-3` = 12px. Nothing
in this app uses an off-grid gap.

Spacing vocabulary, so screens agree with each other:

| Gap    | Where                                                      |
| ------ | ---------------------------------------------------------- |
| `1`    | Label to its control; badge internals.                     |
| `2`    | Inline controls in a toolbar; icon to text.                 |
| `3`    | Between fields in a form column.                            |
| `4`    | Between a heading and its content.                          |
| `6`    | Page gutter (`px-6`), between top-level sections.           |
| `8`    | Between unrelated blocks. Rare — this is a dense app.       |

**Radii are tight**: `rounded-xs` 2px, `rounded-sm` 3px, `rounded-md` 4px
(buttons, inputs, badges — the default), `rounded-lg` 6px (panels, cards). No
pills, no `rounded-full` except on a status dot.

**Heights** (not Tailwind namespaces — use them as arbitrary values):

| Var                | px | Use                            |
| ------------------ | -- | ------------------------------ |
| `--row-h`          | 34 | `h-[var(--row-h)]` table row.  |
| `--control-h-sm`   | 30 | Small button/input.            |
| `--control-h-md`   | 34 | Default button/input.          |

**Width**: `max-w-shell` (1344px) on the page container. `app/(app)/layout.tsx`
already applies it — page components should not add their own max width.

**Shadows**: two exist, and chrome uses neither. `shadow-card` is reserved for
the Today task cards in step 6, which SPEC §6 says are the one place with visual
weight. `shadow-pop` is for menus and dialogs. **A table does not get a shadow.**

**Density rules for tables:** 34px rows, `text-sm` cells, `label-caps text-muted`
headers, `border-b border-line` between rows, `bg-raised` header that sticks. No
zebra striping — the hairline is enough and stripes fight with stage badges.
Numbers right-aligned with `numeric`, text left-aligned.

---

## 5. Motion

Colour transitions only, ~120ms, on hover and focus. No layout animation, no
entrance animation, no skeleton shimmer. The operator is trying to leave.
`prefers-reduced-motion` is honoured globally in the base layer.

---

## 6. Components

All in `components/ui/`. Import `cx` from `./button` — it is the shared
class-name joiner; there is no `lib/` yet and one copy beats five.

### `<Button>` / `buttonClass()`

Variants — `primary` (solid ink, the one high-commitment action on a screen),
`secondary` (**the default**, outlined on raised), `ghost` (toolbar and row
actions that must not add weight), `danger` (outlined red — reachable, not
tempting). Sizes `sm` | `md`.

`type` defaults to `"button"`, because an unlabelled `<button>` inside a form
submits it and Server Actions do the writing here. Set `type="submit"`
deliberately.

Use `buttonClass({ variant, size })` on a `<Link>` so anchors and buttons look
identical.

### `<Input>` / `<Textarea>` / `<Select>`

Native controls, styled. Native is not laziness: they are keyboard-operable for
free, they have type-ahead, they post inside a `<form>` to a Server Action with
no client JS, and their popups follow `color-scheme`. A custom listbox loses all
four.

- `invalid` is the only state prop; it paints the border and sets `aria-invalid`.
- `<Input numeric />` for dates, money, counts.
- `<Select options={[{value,label}]} placeholder="…" />`, or pass children for
  grouped options.

### `<Field>` / `<CheckboxField>`

```tsx
<Field name="email" label="Email" hint="Used for follow-ups" error={errors?.email}>
  <Input type="email" />
</Field>
```

Ids come from `name` via `fieldId(name)` → `f-email`, **not** `useId()`. That is
deliberate: stable across server render and hydration, and a Server Action can
return `{ fieldErrors: { email: '…' } }` and the message lands in the right
place with no wiring.

`Field` clones its single element child and injects `id`, `name`,
`aria-describedby` and `invalid`. Anything you set on the child wins. If you
pass two controls or a fragment, nothing is injected — use `fieldId(name)`
yourself.

`error` presence is what marks a field bad. Never pass `''` to mean "fine";
pass `undefined`.

### `<StageBadge stage={contact.stage} />`

Covers all seven stages from `@agency/core`, plus `null` → `unset`. The
treatment encodes the pipeline rather than assigning seven arbitrary colours,
which would turn a table into confetti:

| Stage       | Treatment                    | Reads as               |
| ----------- | ---------------------------- | ---------------------- |
| `new`       | hollow, neutral, faint       | nothing has happened   |
| `contacted` | filled neutral (`sunken`)    | we moved               |
| `replied`   | tinted accent                | **they** moved         |
| `quoted`    | **solid accent**             | money on the table     |
| `won`       | **solid positive**           | terminal, good         |
| `lost`      | **hollow danger**            | terminal, bad          |
| `dormant`   | hollow, dashed, faint        | parked                 |
| `null`      | hollow, dashed, faint, "unset" | not set              |

`won` and `lost` differ in **fill as well as hue** — solid green vs. outlined
red — so they stay one glance apart in greyscale and under red/green colour
blindness. That distinction is the difference between a client and a dead lead;
it has to survive every viewing condition.

**The stage vocabulary is not defined in this component.** `CONTACT_STAGES`
(pipeline order), `STAGE_LABELS` and `STAGE_OPTIONS` live in
`lib/contact-vocab.ts`, together with the source and language lists. That module
imports **types only** from `@agency/core`, so it is safe in a client bundle, and
it is the same module the server-side validator mirrors the migration's CHECK
constraints through — so a dropdown and the thing that rejects its value can
never disagree. Import from there; do not retype a label anywhere.

> `lib/validation.ts` re-exports them for server callers, but **a Client
> Component must import from `lib/contact-vocab` directly.** `validation.ts`
> value-imports `@agency/core`, whose barrel reaches the Supabase *service role*
> client. Type-only imports from it are fine — they are erased.

### `<Kbd>`

One key cap, in `components/ui/kbd.tsx`. Keyboard shortcuts are a feature
(SPEC §6), so the hints that advertise them look like one thing everywhere.
`text-muted` by default; `tone="ink"` where the shortcut is the instruction
rather than a footnote.

### Table classes

`TH`, `TD` and `COLUMNS` live in `components/ui/table.ts` — a plain module with
no directive, so both the table (a Client Component) and its loading skeleton (a
Server Component) use the same strings. A skeleton that does not match the table
causes exactly the jump it exists to prevent.

### Dates and money

`lib/day.ts`. Pure, dependency-free, client-safe, and the **only** place a
calendar day is formatted or subtracted. It works on `'YYYY-MM-DD'` strings whose
timezone was already resolved server-side by `dayKeyInZone` (lib/validation.ts) —
that is the one function in apps/web that knows what a timezone is.

`formatDay`, `formatDayWithWeekday`, `daysBetween`, `addDays`, `futureLabel`
(for `next_touch_at`), `pastLabel` (for `last_touch_at` and `created_at`),
`toneFor` + `DUE_TEXT_TONE` (the date rule from §2), and `formatEuro`.

### `<Nav>`

Rendered by `app/(app)/layout.tsx` — the shell for every signed-in screen. Pages
do not render it, and `/login` and `404` sit outside that route group so they get
the document and nothing else. 44px, one hairline, active route marked by ink
weight plus a 2px accent rule. Routes not yet built carry a `·`, permanent v1
stubs carry a `–`, both explained in the `title` and in screen-reader text — and
a route whose `page.tsx` does not exist renders as an inert `<span>`, not a link.
A nav item that answers a click with a 404 is worse than one that plainly does
nothing.

The right rail holds sign-out today; the kill-switch indicator and run status
join it in step 6.

---

## 7. Writing

- Empty states **state what is true**. "No contacts yet." "Nothing needs you.
  9 things handled." Never "Oops!", never an illustration, never an apology.
- Labels are sentence case in prose, `label-caps` in tables and forms.
- Dates: absolute and unambiguous (`14 Aug`, `14 Aug 2026` across a year
  boundary), never "in 3 days" alone — relative time is a hint next to the
  absolute date, not a replacement for it.
- Never render a contact's email or name into a `console.*` call. It is customer
  data and this app runs under one operator's real Gmail.

---

## 8. Accessibility floor

- One focus treatment, set globally: a 2px accent outline at 1px offset. **Never
  remove it.** If a control looks wrong with a ring, fix the control.
- Every input reaches a `<label>` — that is what `Field` is for.
- Colour is never the only signal. Stage badges vary fill; nav marks stubs with
  a glyph and screen-reader text; errors carry text, not just a red border.
- The shell's first tab stop is a skip link to `#content`. Keep `id="content"`
  on the main region — and keep there being exactly **one** `<main>` in the tree.
  It lives in `app/(app)/layout.tsx`; a page renders a `<div>`. A nested `<main>`
  is invalid HTML and breaks the landmark navigation this bullet exists for.
