# Octalve Edu — Development Progress Tracker

Last Updated: 2026-09-30

Companion to `docs/development-history/domain-implementation-plan.md` (the step-by-step build
plan), `docs/development-history/phases/*.md` (one detailed doc per completed phase), and
`docs/PRD.md` (requirements + every architecture decision, with reasoning, synced from the
canonical Claude Doc). Mirrors the structure of `TheNiche`'s own
`docs/development-history/theniche_progress.md` — this file tracks _what's actually built_, checked
against the real repo, not what a plan says should exist.

---

## Overall Status Summary

- **Planning & Architecture**: 100% — `docs/PRD.md` (14 sections + a Security & Compliance Audit
  tab in the canonical Claude Doc, cross-checked against a second independently-produced audit) and
  this implementation plan are written and cross-referenced. `docs/PRD.md` §7's tenant-trust
  boundary, §14's Settings model, and the payment-integrity fixes all trace to specific audit
  findings, cited inline in the plan.
- **Phase 0 — Foundation**: **100% Complete.** Next.js 16 + TypeScript + Tailwind scaffold,
  Prisma 6.19 + PostgreSQL with Auth.js's tables plus `Tenant`/`Campus`/`TenantMembership`,
  `tier-manifest.json` skeleton, local dev `docker-compose.yml`, git initialized. `pnpm build`
  clean, first migration applied against a real local Postgres, `pnpm dev` verified serving
  `HTTP 200`. See `docs/development-history/phases/phase-0-foundation.md` for the full record,
  including the one real judgment call (Prisma 8 rc → 6.19.3 downgrade, matching the sibling `ims`
  project).
- **Phase 0.5 — Auth, RLS & Shared API Infrastructure**: **In progress.** §0.5.0 (first-run
  superadmin setup wizard, Solo only) is **done and verified live** — see
  `docs/development-history/phases/phase-0.5.0-setup-wizard.md`. §0.5.1 (auth) went through a full
  two-AI security review, a hardening pass, and a Better-Auth-vs-hand-roll spike (resolved: hand-roll,
  adapting AlEemaan's already-built implementation), and **as of 2026-09-30 is built and verified**
  (branch `claude/auth-0.5.1-port` on the maintainer's fork, awaiting the maintainer's PR/merge into
  `octalve-core/octalve-edu` — see "Auth build" below and the work log in
  `docs/development-history/phases/phase-0.5.1-auth.md`): hashed-token database sessions, constant-time
  login, layered rate limiting, `withAuth`, `/login` + `/dashboard` + a retrofitted `/setup`, and a
  repeatable Playwright suite (`pnpm test`: unit, integration, API, browser at desktop + phone sizes,
  axe accessibility, and a real-HTTPS run that proves the `__Host-` cookie is set *and cleared*). §0.5.2
  (tenant-trust boundary: `resolve-tenant.ts` + `forTenant()` + explicit RLS role setup) and §0.5.3
  (shared API pagination/rate-limiting helpers beyond the response envelope) are designed, not built,
  both depending on §0.5.1 landing first. Nothing in Phase 1 should start before this phase's own
  verification gate (negative-test suite for cross-tenant/IDOR access, run as the `app_user` role)
  passes in CI.
- **Phase 1 — MVP: Core SIS + Finance**: **0% — not started.** Full schema designed
  (`sis.prisma`/`finance.prisma` in the plan doc, with every model's reasoning traced to a PRD
  section or a specific security-audit finding) but no migration written, no API routes, no UI.
- **Phase 2 — Communication**: **0% — not started.** Schema designed (`comms.prisma`).
- **Phase 3 — LMS**: **0% — not started.** Schema designed (`lms.prisma`).
- **Phase 4 — Operations**: **0% — not started.** Schema deliberately thin per the plan's own
  reasoning (PRD §6 marks this phase lower-priority; full design deferred to when it's actually
  scheduled).
- **Phase 5 — Expansion**: **0% — not started, and deliberately unscoped** beyond a directional
  sketch — PRD §6 itself frames this phase as conditional on which market segment gains traction
  first.

---

## What's real vs. what's designed-but-unbuilt

This section exists specifically to prevent the trap `TheNiche`'s own plan names: a schema decision
that "sounds right" getting treated as done because it's written down somewhere. As of this
update:

- **Two migrations beyond Phase 0 exist, both applied against a real local Postgres.**
  `20260927223904_add_setup_wizard` (`User.passwordHash`, `SystemSettings`, `AuditLog`) and — on the
  in-progress auth branch, 2026-09-30 — `20260930121043_rebuild_auth_hashed_sessions` (hashed
  `Session.tokenHash`, two-level expiry, dropped `Account`, DB-level lowercase-email `CHECK`, the
  latter verified by a live negative insert). Everything in Phase 0.5.2 onward is still Prisma syntax
  inside a markdown file, not validated against a real database.
- **No RLS policy exists yet**, including on the Phase 0 tables (`Campus`, `TenantMembership`)
  that already exist — Phase 0's own completion doc says this explicitly, so it doesn't get lost.
- **Authentication works end-to-end and is verified — on the in-progress branch, not yet on
  `master`:** sign-in, session, `GET /api/v1/auth/me`, sign-out, stale/expired/revoked-session
  rejection, layered rate limiting, `withAuth`, and the `/login`, `/dashboard`, `/setup` screens are
  covered by an automated suite (see "Auth build" below). On `master` (what `octalve-core/octalve-edu`
  shows today) none of it exists until the maintainer merges the PR. Auth.js is not used anywhere and is
  not a dependency.
- **A real test suite exists** (`tests/`, `playwright.config.ts`, `pnpm test`) — on the same branch.
  Before it, the only verification in the repo was hand-run curl against a dev server.
- **Still unbuilt and undesigned-in-code:** TOTP MFA, password reset, the tenant-trust boundary and every
  RLS policy, the shared API helpers (§0.5.3), and all of Phase 1+.

## Recent changes (2026-09-28)

- **Prisma schema is now multi-file**: `prisma/schema.prisma` split into
  `prisma/schema/{schema,auth,tenancy,setup}.prisma` (Prisma's "schema folder" mode, stable since
  6.7, no preview flag needed on the installed 6.19.3), with a new `prisma.config.ts` pointing the
  CLI at the folder — same convention already used by the sibling `ims` and `AlEemaan` projects.
  `pnpm prisma validate`, `pnpm prisma generate`, and `pnpm build` all verified clean against the
  split. Every future phase's models get their own file (`sis.prisma`, `finance.prisma`,
  `comms.prisma`, `lms.prisma` — already named in the plan doc's schema sketches) rather than one
  file growing indefinitely.
- **Cross-project finding folded into §0.5.1's design**: AlEemaan (sibling project, same stack)
  discovered building its own identical Phase 0.5.1 that Auth.js v5 refuses a `Credentials` provider
  combined with `session.strategy: "database"` outright — exactly the combination
  `domain-implementation-plan.md`'s §0.5.1 currently describes wiring. A warning citing AlEemaan's
  fix (hand-rolled login/logout against the `Session` table instead of Auth.js's own Credentials
  flow) is now inline in that section, so this doesn't get rediscovered live the same way.

## Auth hardening pass (2026-09-29)

`domain-implementation-plan.md` §0.5.1 now has a full route-level design for the hand-rolled
login/logout (guard order, cookie shape) instead of just "expect to do the same as AlEemaan" —
written to the same precision as AlEemaan's shipped version, plus fixes found by auditing that
version after the fact rather than repeating them here:

- A constant-time response (AlEemaan's version has a real timing side-channel — skips
  `bcrypt.compare` entirely on a missing user, so "no such account" answers faster than "wrong
  password" even with identical status codes).
- A `lib/auth/csrf.ts` call on both routes (the helper already exists in this repo from the setup
  wizard, but nothing said the hand-rolled login has to use it — easy to forget since Auth.js's own
  Credentials flow would have handled this invisibly).
- A fresh, server-generated 256-bit session token on every login (session-fixation defense, named
  explicitly rather than left implicit).
- Email normalization (`trim().toLowerCase()`) applied everywhere `User.email` is read or written,
  not just at login.
- The session lifetime (30 days) as one shared constant, not duplicated separately in `src/auth.ts`
  and the login route the way AlEemaan currently has it (a real drift risk in AlEemaan worth not
  repeating).
- Rate-limit bucket records failed attempts only, not every request — stated explicitly since
  §0.5.3 describes the limiter as generic middleware, vague enough to get built wrong.

§0.5.3's rate limiter is now also specified to key on `ip + email` combined, not IP alone, fixing a
shared-IP lockout problem in AlEemaan's current in-memory limiter.

## Second auth hardening pass (2026-09-30) — two-AI review

`domain-implementation-plan.md` §0.5.1–0.5.3 rewritten against a full two-AI cross-review of both
this plan and AlEemaan's shipped auth code (record: `docs/auth-review-2026-09-29.md`). Sixteen
findings incorporated, three of them changing real design decisions rather than just adding detail:
`SET LOCAL` string interpolation replaced with parameterized `set_config()` (the RLS safety net had
its own SQL-injection surface); RLS role setup made explicit (`app_user` with `NOBYPASSRLS` +
`FORCE ROW LEVEL SECURITY` — RLS policies are otherwise inert against the table-owner role Prisma
migrations typically use, meaning CI's own negative tests could pass while protecting nothing); and
`@upstash/ratelimit` identified as incompatible with the plain self-hosted Redis container
`docker-compose.yml` actually provisions. Also verified independently (web search, not assumed):
Better Auth's team now maintains Auth.js (took over September 2025; Vercel acquired Better Auth July
2026) — Auth.js is maintenance-mode only now, which reopened whether to evaluate Better Auth for this
phase specifically.

## Better Auth spike — resolved 2026-09-30: hand-roll, mirroring AlEemaan

Ran the spike rather than guess. Better Auth fits well on database sessions, TOTP MFA, and session
listing/revocation — but its **hashed-session-token-at-rest** support (the one genuinely
non-negotiable requirement here) is **not shipped**, only an unmerged draft PR
(better-auth/better-auth#11444). Its `organization`/`teams` plugin also doesn't map as cleanly onto
`Tenant`→`Campus` as the schema already built here. Decision: hand-roll §0.5.1, adapting
**AlEemaan's already-built, already-verified implementation** (`src/lib/auth/{session,password,
rate-limit}.ts`, full record in that repo's `docs/development-history/phases/phase-0.5.1.5-auth-rebuild.md`)
rather than building from scratch or adopting Better Auth. `domain-implementation-plan.md` §0.5.1
updated with the full reasoning and the explicit "port AlEemaan's code, adapted for
TenantMembership/Campus" instruction. This closes the last open design question blocking §0.5.1 —
nothing left to decide before writing code.

## Auth build (2026-09-30) — built and verified, awaiting merge

Full design decisions: `domain-implementation-plan.md` §0.5.1 → "Build design for the port" (including
"Decisions made during implementation", #1–#15). Live work log, defect table and mutation record:
`docs/development-history/phases/phase-0.5.1-auth.md`. Test guide: `tests/README.md`. Branch
`claude/auth-0.5.1-port` on the maintainer's fork `roji-tech/octalve-edu-fork` (the Claude GitHub App
isn't installed on `octalve-core`, so the maintainer merges by PR).

Built: the schema migration; `lib/auth/{session,password,password-policy,rate-limit,with-auth,
memberships}.ts`; `POST /api/v1/auth/{login,logout}` and `GET /api/v1/auth/me`; the setup route migrated
onto the new helpers; the `/login`, `/dashboard` and `/` screens plus the retrofitted `/setup` wizard on
shared, accessible UI primitives; baseline security headers.

Verified (`pnpm test`): 234 tests pass in under four minutes — 24 unit, 36 integration, 86 API, 80 browser (desktop + phone viewports; axe WCAG 2.2 A/AA clean on every screen *and* state), 7 real-HTTPS — plus clean `tsc`, ESLint and `next build`. Ten defects were found by the verification itself —
among them that bcrypt silently ignores everything past byte 72 (so the design's "128-character cap"
did not do what it said), that a no-JavaScript submit of the sign-in form put the password in the URL,
and that focus was lost after a failed sign-in — each fixed and pinned by a regression test. All 40
deliberately injected bugs (mutation testing) turned the suite red.

## Design language build (2026-09-30) — built and verified, stacked on the auth branch

Design of record: `domain-implementation-plan.md` → "Phase 0.5 addenda" → **0.5.A**. Work log, findings,
mutation record and screenshot review: `docs/development-history/phases/phase-0.5.A-design-language.md`.
Branch `claude/design-tokens-theme` of the same fork, **based on `claude/auth-0.5.1-port`** (merge that
first). Source of the look: the private design canvas "Octalve Edu & AlEemaan — UI Design".

Built: the artifact's colours and layout as a semantic-token system (`globals.css`, with `brand.css` and
`lib/brand.ts` as the only brand-specific files); Octalve's indigo brand; a light/dark theme rendered by the
server from a `theme` cookie (no flash, no inline script — the future nonce CSP depends on that); the shared
components re-skinned to tokens, plus `Card`, `CheckboxField`, `ThemeToggle`; the three existing screens in
the new look; and a **real "Keep me signed in"** — unchecked (the default) gives a browser-session cookie
and a 12-hour server-side cap, ticked gives the 30 d / 90 d policy (7 d for admins). The default session is
therefore *shorter than the first build's* — deliberate, for shared school computers.

Verified: 274 tests pass (5 skipped by design) — up from 234 — including axe WCAG 2.2 on every screen and
state **in both themes**, the theme's server-rendering and keyboard behaviour, the brand's exact colours,
and the remember-me pair over real HTTPS; plus clean `tsc`, ESLint and `next build`. All nine deliberately
injected remember-me bugs turned the suite red. Two flaky *test* races were found and fixed on the way (axe
sampling a colour mid-transition; axe running before Next applied the page's `<title>`).

Not in this branch, by design: the app shell (arrives here with §0.5.2; built in AlEemaan now); "Forgot
password?" (0.5.C); the artifact's search box and notification bell (nothing behind them).

## Nonce-based script CSP build (2026-10-01) — built and verified, stacked again

Design: plan §0.5.B (+ "As built"). Record: `docs/development-history/phases/phase-0.5.B-csp.md`. Branch
`claude/csp-nonce` of the fork, **based on `claude/design-tokens-theme`** (merge order: auth → design language →
this). `src/proxy.ts` mints a fresh 128-bit nonce per page request and sets a strict policy on request and
response (`script-src 'self' 'nonce-…' 'strict-dynamic'`, no `unsafe-inline`/`unsafe-eval`; `upgrade-insecure-requests`
only when `APP_URL` is https); the JSON API gets a static `default-src 'none'; frame-ancestors 'none'`;
`CSP_REPORT_ONLY=true` is the valve for diagnosing a violation on a live deployment. A new auto test fixture
fails any browser test during which the browser reports a violation, so the entire browser suite is a CSP test
— it passed with zero violations, both themes, desktop, phone and https. 11 injected bugs all caught. Finding
worth remembering: `'strict-dynamic'` trusts script created by trusted script, so the policy defends against
**markup** injection (what XSS is); the first injection tests used `createElement("script")` and the "attack"
ran — they now splice attacker markup into the real response.

## Next action

**Hand §0.5.1 and then 0.5.A to the maintainer for review and merge** (PRs from
`claude/auth-0.5.1-port`, then `claude/design-tokens-theme`, on the fork into
`octalve-core/octalve-edu`; the second is stacked on the first).

**The back-port to AlEemaan is done and verified** — shared names, the hardening deltas, the 72-byte
password policy, `method="post"`, the sign-in screens it lacked, and this test suite — on branch
`claude/octalve-auth-sync` of `roji-tech/AlEemaan` (its `phases/phase-0.5.1.6-octalve-sync.md`),
awaiting *that* repo's maintainer review/merge. From here on a change to the shared mechanism is made
in both repos or logged as a divergence in both plan docs (§0.5.1.6 there, the shared-names table here).

Then, in order: the rest of the Phase 0.5 addenda, each designed in the plan first and built in both repos
— ~~**0.5.B** the nonce-based script CSP~~ (done), **0.5.C** password reset and change, **0.5.D** TOTP MFA (must
precede Phase 1's Settings UI); then the tenant-trust-boundary resolver and `forTenant()` with its explicit
RLS role setup (§0.5.2 — needs a real `app_user` Postgres role created first, and `withAuth`'s
`roles`/`permissions` options and this repo's app shell arrive here); the shared API helpers (§0.5.3, and
the Redis-backed rate limiter before any multi-instance SaaS deployment). Then that phase's negative-test
verification gate — **run as the `app_user` role, not the migration owner** — before Phase 1 begins.
