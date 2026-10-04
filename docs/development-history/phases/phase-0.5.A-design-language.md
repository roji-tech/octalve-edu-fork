# Phase 0.5.A — Shared UI design language, and a real "Keep me signed in"

**Status: BUILT AND VERIFIED (2026-09-30) — awaiting the maintainer's merge.** Branch
`claude/design-tokens-theme` of `roji-tech/octalve-edu-fork`, **stacked on `claude/auth-0.5.1-port`**
(same base commit `765d92e`): merge the auth branch first. This file is a live work log until the merge;
after it, append-only like every file in this folder.

Design of record: `docs/development-history/domain-implementation-plan.md` → "Phase 0.5 addenda" → **0.5.A**
(written before any code, including the exact semantics of "Keep me signed in"). Source of the look: the
private design canvas *"Octalve Edu & AlEemaan — UI Design"* (`https://claude.ai/artifact/8wGBA2trirEDaTQq1sUf74`),
which frames the admin app as *"same shell, one brand tweak"*. Sibling record:
AlEemaan's `docs/development-history/phases/phase-0.5.A-design-language.md` (same design, its own green,
plus the app shell). Test guide: `tests/README.md`.

## What this phase delivers

1. **The artifact's look as a token system**, so a brand is two small files and a theme is one attribute.
2. **Octalve Edu's brand** (indigo) on every signed-out and signed-in screen that exists today
   (`/login`, `/setup`, `/dashboard`) — the artifact's split sign-in layout, its labels, its copy.
3. **A light theme and a dark theme**, dark by default, chosen with a toggle, rendered by the *server* on
   first paint (no flash, no inline script).
4. **"Keep me signed in on this device", made real** — the artifact draws the checkbox, so it must do
   something: unchecked → a browser-session cookie and a 12-hour server-side cap; ticked → the existing
   30-day-idle / 90-day-absolute policy (7 days for admins).
5. Tests for all of it, in both themes, and a mutation check of the session-lifetime logic.

Not in scope, by design (see the plan): the app shell (sidebar / top bar / phone tab bar) — it lands here
with §0.5.2, when tenant routing gives it `/schools/[code]/…` to wrap; AlEemaan has it now.

## Work log

### 1. Design first
Read the artifact's canvases (login, branches, settings, mobile, landing) and wrote the plan section before
touching code: what the artifact fixes (colours, layout, copy), the mechanism, every deviation with its
numbers, scope by repo, and the verification plan. Then, before building it, the precise semantics of
"Keep me signed in" (wire format, both modes, how the admin cap composes, no schema change, the test and
mutation plan).

### 2. Tokens, theme, brand
- `src/app/globals.css` — semantic CSS variables for both themes (`--canvas --surface --surface-2
  --field --line --line-strong --fg --fg-2 --fg-muted`, the `danger/warn/info/ok` sets, shadows) exposed to
  Tailwind v4 through `@theme inline` (`bg-canvas`, `text-fg-muted`, `border-line`, `bg-brand-strong`, …),
  plus `color-scheme` per theme so native scrollbars and form controls follow. The dark values are the
  artifact's; the light values are its light theme.
- `src/app/brand.css` (colours) and `src/lib/brand.ts` (name, tagline, login headline/blurb/points, what a
  place is called) — the **only** brand-specific UI files. Everything else is shared and code-identical with
  AlEemaan.
- `src/lib/theme.ts` + `ThemeProvider` + `ThemeToggle`: the choice is a `theme` cookie (`dark` | `light`);
  the root layout reads it with `cookies()` and renders `<html data-theme>`, so the first paint is right and
  there is **no inline `<script>`** — which is what lets the nonce-based CSP (0.5.B) forbid inline scripts
  outright. Only exactly `"light"` means light; any other cookie value (including hostile ones) is dark.
  Consequence: every page is now server-rendered on demand (`ƒ` in the build output, including
  `/_not-found`), which the CSP needs anyway.

### 3. Shared components re-skinned (tokens only, no palette classes left)
`Button` (primary / secondary / ghost / danger, `min-h-11`), `TextField` (the artifact's small uppercase
label), `PasswordField`, `Alert`, new `Card`, `AuthShell` (the 46 % deep-brand panel with a CSS-gradient
grid, headline, blurb, three points, © line; compact centred brand header on phones; theme toggle
top-right), `AppHeader`, `SignOutButton`, `icons`; and the three screens. New `CheckboxField` (below).

### 4. The checkbox is drawn, not native
A native checkbox is 13–16 px — it fails this repo's own ≥ 44 px phone tap-target check, which measures the
`<input>` element itself — and its look is decided by the browser and OS, not by the brand or the theme.
`CheckboxField` keeps the platform for everything that matters — a real `<input type="checkbox">` inside a
real `<label>`, so the accessible name, Space to toggle, form semantics and a whole-row click target all
come for free — and draws the box so the contrast is *ours* and measured (WCAG 1.4.11 wants 3 : 1 for
the shape that identifies a control): unchecked outline `fg-muted` — 6.96 : 1 on the dark surface, 5.43 : 1
on the light; checked fill in the light brand colour — 8.96 : 1 / 7.90 : 1 against the page — with a dark
tick on it (10.1 : 1 / 7.55 : 1); a solid 2 px focus ring; and an invisible 44 × 44 px input laid over the
20 px box. `forced-colors` (Windows high contrast) gets the system text colour for the tick, because the
browser drops fills there.

### 5. "Keep me signed in", made real
- `createSession(userId, ua, { admin, remember })` — `remember` defaults to **false**, so a future caller
  that forgets to say gets the short session, never the 90-day one. Not remembered: absolute = idle =
  **12 h** (`SESSION_ONLY_MAX_AGE_SECONDS`). Remembered: as before. The admin cap composes as
  `min(mode cap, 7 d)`. Returns `persistent` alongside `expires`.
- `setSessionCookie(res, token, expires | null)` — `null` omits `Expires`/`Max-Age` (a browser-session
  cookie). The **server-side cap is the real bound**: browsers that "continue where you left off" restore
  session cookies across restarts, so closing the browser cannot be relied on to end a session.
- `POST /api/v1/auth/login` takes an optional `remember`, a **strict boolean** (`"true"`, `1`, `null`, …
  fail validation and get the same 401 as any malformed body — the validation rules stay unprobeable).
- The sign-in form has the checkbox, unchecked by default, sends `remember`, keeps the choice across a
  failed attempt, and stores nothing client-side.
- *Behaviour change worth naming:* the default session is now shorter than the first build's (12 hours vs.
  30 / 90 days) — the right default for a shared school computer; ticking the box restores the old policy.

### 6. Verification
Run against the production build, real Postgres, real Chromium (see "Results").

- **Both themes, every screen and state**: `checkScreen()` runs axe (WCAG 2.2 A/AA) and the horizontal-
  overflow check in dark and light for the sign-in idle / validation-error / server-error / revealed-password
  / paused states, the setup wizard idle / invalid / complete, and the dashboard (with a school, with none,
  with a long name).
- **Theme behaviour** (`e2e/theme.spec.ts`): dark by default and light when the cookie says so — in the *raw
  HTML*, before any script runs; hostile cookie values (`"><script>…`, `LIGHT`, empty, `light; x=1`) can't
  inject markup or flip the theme; the toggle flips the attribute, its own accessible name and a
  `SameSite=Lax` path-`/` cookie; the computed colours really change (`rgb(2, 6, 23)` → `rgb(248, 250, 252)`),
  i.e. the tokens are wired, not just the attribute; the choice survives a reload and a sign-in; Shift+Tab
  reaches the toggle, Enter and Space operate it, and focus stays on it.
- **Brand** (`e2e/brand.spec.ts`, the one spec that differs per repo): title, primary button
  `rgb(79, 70, 229)` in both themes, deep panel `rgb(55, 48, 163)` with the artifact's words, phone header.
- **Keep me signed in**: unit-level lifetime maths for every mode × admin combination; API `Set-Cookie`
  attributes and the database row for each mode; the strict boolean; browser tests that ticking yields a
  persistent cookie (`expires` ≈ 90 days) and not ticking a session cookie (`expires === -1`) with a 12-hour
  row; keyboard operation; and the same pair over **real HTTPS**, proving Chromium still accepts the
  `__Host-` cookie as a session cookie and that sign-out removes it.
- **Human review of the real flow** (screenshots at 1440×900 and 390×844, both themes) — see "Screenshot
  review" below.

## Findings and decisions during the build

| # | Found by | What | Resolution |
| :-- | :-- | :-- | :-- |
| 1 | Writing the theme spec | `test.skip(fn)` with a callback is only legal at `describe` level; inside a test body it throws, so the keyboard test failed instantly on both projects. A test bug, not a product bug. | Boolean form with the `isMobile` fixture; documented in `tests/README.md`. |
| 2 | Writing the brand spec | On a phone the (hidden, `aria-hidden`) brand panel still contains the product name, so `getByText("Octalve Edu")` is a strict-mode violation. | Scope to `getByRole("main")`; documented. |
| 3 | Designing the checkbox | A native checkbox is a 13–16 px target (fails the ≥ 44 px phone check on the input) and unbranded. | Drawn checkbox over a 44 px invisible real input, contrast measured (above). |
| 4 | Retargeting the existing tests | The keyboard-only sign-in test assumed Tab goes show/hide → Sign in; the checkbox is now between them. | Test extended: it asserts the focus ring on the drawn box and that Space ticks it. |
| 5 | Retargeting the existing tests | Four tests assert cookie lifetimes; with the safer default they no longer described what they tested. | They ask for `remember: true` explicitly; new tests cover the default. |
| 6 | The both-themes axe scan, once in a full run | A `color-contrast` failure with a colour that belongs to neither theme (`#565c6a` on `#a8acb4`): the scan ran while the *transition* triggered by flipping `data-theme` was mid-flight. A test race, not a contrast bug (the same screens pass once settled, in both themes). | `checkScreen()` waits for every running CSS transition to finish before measuring (only transitions — an infinite animation such as the spinner never "finishes"). |
| 7 | The axe scan, once in a full run | `document-title`: "Document does not have a non-empty `<title>`" right after a client-side navigation — Next.js applies the page title a beat after the URL changes. | `checkScreen()` waits for a non-empty title first; the scan is of the settled page. |

## Verification results

`pnpm test` (production build, then every project; `octalve_edu_test`; Playwright, Chromium, Node 22,
Postgres 16, one worker, no retries):

| Project | Tests |
| :-- | --: |
| `setup` | 1 |
| `unit` | 24 |
| `integration` | 40 (was 36) |
| `api` | 92 (was 86) |
| `e2e-desktop` | 56 + 1 skipped by design (was 41) |
| `e2e-mobile` | 53 + 4 skipped by design (was 39) |
| `https` | 8 (was 7) |
| **Total** | **274 passed, 5 skipped, 0 failed** (was 234 + 2) |

Static: `tsc --noEmit` clean, ESLint 0 problems, `next build` clean (all routes dynamic).

Four full runs were needed, and each red was a defect in a *test*, fixed and re-verified rather than
retried: 246 of 248 (the theme spec's keyboard test — finding 1), then 273 of 274 (a brand-spec locator —
finding 2), then 273 of 274 (the mid-transition axe scan — finding 6), then 273 of 274 (the pre-title axe
scan — finding 7). After the last fix the a11y spec was repeated four times in a row (0 failures) and the
whole suite then passed: **274 / 274 (5 skipped by design), 4.3 minutes.** The numbers in the table are from
that final run.

### Mutation testing — remember-me

Each row: one deliberate bug injected, the named specs run against a fresh build, the file restored.

| # | Bug injected | Failures |
| :-- | :-- | --: |
| M1 | `createSession` ignores `remember` (every session persistent, 90 days) | 6 |
| M2 | the default flipped to remembered (`remember !== false`) | 3 |
| M3 | login sets a persistent cookie even when not remembered (the row is still 12 h) | 3 |
| M4 | the 12-hour cap is really 90 days — a session cookie over a long-lived row | 6 |
| M5 | the admin cap no longer composes (an un-ticked admin gets 7 days) | 2 |
| M6 | `remember` coerced instead of strict (`"false"` would mean true) | 1 |
| M7 | sliding no longer clamped to the absolute cap | 2 |
| M8 | the form never sends `remember` | 4 |
| M9 | the box is checked by default | 7 |
| | **All nine caught**; every file restored and re-verified afterwards | |

## Screenshot review

Drove the real flow in Chromium against a production build and a fresh database — setup wizard (empty,
invalid, complete), sign-in (idle, wrong password with the box ticked, signed in), dashboard — at 1440×900
and 390×844, dark and light, and read the screenshots. What was checked and what was found:

- The split layout matches the artifact: 46 % deep-indigo panel with the faint grid, headline, blurb and
  three ticks; the form on the right with uppercase labels; theme toggle top-right; on a phone the panel
  gives way to a centred brand header and the form sits in a card. Both themes read cleanly — text on
  every surface is legible, the ticked box is unmistakable (light-indigo fill, dark tick), the error alert
  keeps its icon and colour treatment, the focus ring on the auto-focused email field is visible.
- Nothing needed changing. One thing that *looks* wrong but is intended: in a **full-page** capture the
  brand panel ends at the viewport height while a tall form (the setup wizard) continues below it — the
  panel is `sticky` and viewport-tall on purpose (it was the fix for "the panel stretched with tall
  forms" in the 0.5.1 review), so in a real browser it stays put while the form scrolls.
- The dashboard is still the plain page from 0.5.1 in the new colours — deliberately: its real shape
  arrives with §0.5.2 (see "Explicitly not done").
- No page errors in the console beyond the 401 from the deliberately wrong password.

## Cross-repo: AlEemaan

Built and verified there too, on branch `claude/design-tokens-shell` of `roji-tech/AlEemaan` (stacked on its
sync branch; its `phases/phase-0.5.A-design-language.md`): its own sea-green brand on these shared
components, **plus the app shell** and three pages (Overview, Branches with a working "New branch" form,
Account) — 367 tests pass, 20 injected bugs all caught. **Kept different on purpose:** the brand files and
`brand.spec.ts`, the cookie names, the shell and its pages (Octalve Edu adopts the shell with §0.5.2),
`page-session.ts`. Back-ported here from that work: `useSignOut()`, `Button`'s `ref`, the shell icons, the
`signOut()` test helper, and the two a11y-scan waits. One lesson crossed over: a wholesale copy of `session.ts`
carried *this* repo's cookie name into AlEemaan (58 failures) — see `CLAUDE.md`.

## Explicitly not done in this phase
The app shell (arrives with §0.5.2 here; already built in AlEemaan); a "Forgot password?" link (added with
0.5.C, when there is a page behind it — a dead link would be a lie); the artifact's search box and
notification bell (nothing sits behind them); Arabic/RTL; Firefox/WebKit runs. **Still to come in this
series:** 0.5.B nonce-based CSP, 0.5.C password reset / change, 0.5.D TOTP MFA.
