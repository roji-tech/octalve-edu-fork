# Phase 0.5.2-H — The app shell (school-aware)

**Status: BUILT AND VERIFIED (2026-10-05).** Branch `claude/app-shell-users` (stacked on `claude/tenant-rls`). Design of record: plan §"0.5.2-H + 0.5.4 — The app shell, and the Users
pages with invitations" → "Build design — the shell", written before any code. Roadmap position: `roadmap-breakdown.md` §0.5.2-H. The Users pages (0.5.4) are the next step and are what
the sidebar's visibly-"Soon" **Users** entry waits for.

## What this delivers
Every signed-in screen now lives in one frame — ported from AlEemaan's shell (the design artifact's "same shell, one brand tweak"), then made **school-aware**, which is what differs here.
- **Frame.** From `lg`: a 248 px sidebar (brand, school, navigation, the signed-in person) and a 60 px top bar (breadcrumb, theme toggle, account menu). Below `lg`: a compact top bar, a
  floating bottom tab bar and a **More** sheet — a native modal `<dialog>`, so the focus trap, Escape, an inert page and focus return come from the platform. A skip link is first in the tab
  order; the page reserves room (`pb-32`) so the tab bar never covers the last thing on it.
- **Route group `src/app/(app)/`** holds `account`, `dashboard`, `schools/[code]/**` and the 403 view — **no URL changed**. `AppHeader` and `SignOutButton` are gone; each page drops its own
  `<main>`/header and uses `PageHeader` where it has a heading to share. `forbidden.tsx` moved into the group, so the 403 view now renders **inside the shell** (still a real HTTP 403 — verified), which
  means a person who followed a wrong link can reach their own schools from it.
- **School context without trusting the URL.** The layout reads the person's memberships once (`requirePageSession`, `React.cache`d — the layout and the page share one lookup) and gives the shell
  `{code, name, role}[]`. `ShellProvider` finds the school the **path** names among **those** (`schoolFromPath`: trimmed, lower-cased like the resolver; a school the person is not in matches
  *nothing*). That match is **display only** — which links to draw. The pages and APIs still authorise, every request, from the membership; a layout is not even re-rendered on client navigation, so it
  could not be the guard. A stale role changes what the sidebar *shows* on the next full load, never what is *allowed*.
- **Navigation is data** (`navFor(school)`; sidebar, tab bar and sheet derive from it so they cannot disagree): outside a school — **Your schools**; inside — **Overview** (everyone) and, for an **ADMIN
  of that school**, **Users** and **Settings** as visible "Soon" text with a screen-reader ", coming soon" (never a link to nothing). `home` = the school in the path, or the person's **only** school when
  they are on a page outside one (so `/account` still leads into it); with several, they choose first (no school is guessed).
- **School switcher** (sidebar; and the "Your schools" group in the phone sheet): one school → plain text; several → a disclosure listing each with **the role held there**, the current one `aria-current="true"`.
  The entries are links to the person's own schools and grant nothing. **`useDisclosure`** is the shared behaviour (Escape closes and returns focus, click-outside, Tab-away — including the Safari
  `relatedTarget` case — and navigation), used by the switcher and the account menu.
- **Account menu**: avatar → who you are and the role *in the school in view*, Profile, Settings (soon; admins), Sign out. Breadcrumb: `School / Page` (the product outside a school).

## Verification
**Full suite (`pnpm test`, 20.9 min): 952 passed, 23 skipped by design, 8 failed — all eight were assertions made stale by the shell, fixed in tests only (no source change afterwards) and re-run green with their neighbours
(111 passed, 2 skipped in the affected specs), i.e. 960 passing.** Per project: setup 1, unit 166, integration 224, api 279 (+1 fixed), e2e-desktop 140, e2e-mobile 134, https 8 (before the fixes). The eight: `getByText` of the school name,
role or person that the shell now *legitimately repeats* (sidebar card, breadcrumb, account menu — six, scoped to `main`/the heading/the menu button), the old header's visible "Sign out" button (now in the account menu), and
`rls-assertion`'s "page renders no school name", which was too coarse — the shell lists the person's **own** schools (identity data read through the user context, present in the RSC payload), so it now asserts what it means: the
campus read through the refused tenant context and the page's own content are absent.
- **unit** `shell-nav.spec.ts` (15): `navFor` per role and school (the same person is an admin in one school and a teacher in another — each school's nav follows its own role); `schoolFromPath`
  (case, encoding, whitespace, prefixes that are not matches, **hostile paths that never throw and match nothing**); `pageLabel` (no invented names); `isActive` (exact vs segment-boundary prefix);
  `initialsOf`. `lint-guards` now lints the moved `(app)` paths.
- **e2e** `shell.spec.ts` (desktop 11, phone 7): admin sidebar (Overview current; Users/Settings "coming soon", never links); staff see Overview only and no Settings in the menu; one school is plain text;
  several schools → switcher, role per school, current marked, switching updates breadcrumb and nav **per school**; Escape/click-outside; a foreign school → real **403 with no trace of it** and the shell still usable;
  the account page in the shell (one school → leads in; several → "Your schools" + "Choose a school"; the breadcrumb names the product); account menu; sign-out from the menu and from the sheet; skip link;
  the phone's tab bar (sidebar absent, not covering content), the sheet's content, Escape/focus return, tap-outside, several-schools list, no list for one school, Profile. `front-door.spec` adapted (the shell
  repeats the role and lists the person's own schools, so "no Alpha data in Beta" is asserted on `<main>`).
- **axe, both themes, desktop and phone** (`responsive-and-a11y.spec.ts`): the existing school/picker/403/account screens now include the shell; new — account menu open, school switcher open (desktop),
  More sheet open with several schools (phone), a teacher in a second school, the 403 view inside the shell; tap targets ≥ 44 px on the phone.
- `tsc`, ESLint (the `no-restricted-imports` globs now name `src/app/(app)/schools/**`), `next build` clean.

### Mutation testing — 26 injected bugs: 24 caught, 1 caught at build time, 1 equivalent (3 survived the first pass and drove stronger tests)
*Navigation model:* Users/Settings drawn for every role; a school the person is not in displayed as one they administer; the code not lower-cased; "current" on every page of a school (exact ignored) or by string prefix instead of path
segment; **Users as a real link** to a page that does not exist; an invented breadcrumb name. *Shell state:* with several schools the shell guessing the first; a path the person is not in falling back to their first
school. *Switcher:* every school marked current; the role omitted; one school still getting a button. *Disclosure:* Escape ignored; focus not returned; stays open after navigating; outside click ignored. *Menus and sheet:* Settings for every
role; Sign out doing nothing; the More sheet staying open after navigating, listing schools for a one-school person, or ignoring a tap outside. *Frame:* the breadcrumb showing a school outside any; the person card always saying
"Administrator"; the skip link pointing nowhere; the revalidator removed (the existing back/forward-cache tests catch it); the page guard's redirect removed (**a type error — the build refuses it**).
**Three survived the first pass, all gaps in the tests:** *D2* — Escape was pressed with focus already on the button, so "focus returns" was untested; the tests now Tab **into the panel** first (the panel's disappearance would
otherwise drop focus on `<body>`). *D4* — clicking the page heading closed the menu, but only because it focuses `<main>` (`tabIndex=-1`) and the **blur** path closed it; the outside-click handler was never exercised. The tests now click
genuinely inert space (the top bar's empty middle). *R1* — `.first()` matched the school page's own role paragraph, not the sidebar's person card; the card is now a named group (`Signed in as`) and asserted directly.
**N4** (dropping the format check in `schoolFromPath`) is **equivalent**: a path that is not a valid code can never be one of the person's schools, so the lookup fails the same way.

## Findings and decisions
| # | Found by | What | Resolution |
| :-- | :-- | :-- | :-- |
| 1 | Reading AlEemaan's shell | Its nav is a static list keyed on "admin or not" — one school, branches. Here the same person can be an admin in one school and a teacher in another. | `navFor(school)`: nav follows the role **in the school in view**; the shell state is "which school is this path in", not "what are you". |
| 2 | Design | The layout cannot see `[code]`, and does not re-render on client navigation. | The server layout passes the person's memberships; a small client provider matches the path against **them**. Display only; pages guard themselves. |
| 3 | Design | `/account` is not in a school, but a one-school person expects the sidebar to lead somewhere. | `home` falls back to the person's only school; with several they must choose (nothing is guessed — tested). |
| 4 | Build | Putting `forbidden.tsx` in the route group makes the 403 view render inside the shell. | Kept: still a real 403 (asserted), shows only the person's **own** schools, and gives them a way on. |
| 5 | Build | Playwright `getByText` counts elements in the closed `<dialog>` of the phone sheet too (hidden ≠ absent). | Specs scope to `main` / `header`; noted in `tests/README.md`. |
| 6 | Build | An ESLint `files` glob with `(app)` in it — parentheses in a route group name. | Verified by `lint-guards` (a virtual file at the new path still triggers the rule). |

## What is not done (and why)
- **The Users and Settings pages** — the entries are honest "Soon" text; Users is §0.5.4 (designed), Settings is §1.7.
- **AlEemaan** is unchanged: it has the shell already and no schools to switch between; the shared pieces (`useDisclosure`, `PageHeader`) can be adopted there when it next touches its shell.
