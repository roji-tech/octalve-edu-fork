# Octalve Edu — Domain Implementation: Full Step-by-Step Plan

> Companion to `docs/development-history/octalve_edu_progress.md` (what's actually built,
> verified against the real repo) and `docs/development-history/phases/*.md` (one detailed doc
> per completed phase). Mirrors the structure and rigor of `TheNiche`'s own
> `docs/development-history/domain-api-implementation-plan.md`, adapted to Octalve Edu's actual
> domains (school administration, not e-commerce/LMS-as-a-product). Every model and rule below is
> cross-checked against `docs/PRD.md`'s numbered sections and the Security & Compliance Audit tab
> of the same doc — cited inline as `(PRD §N)` or `(Audit #N)` so this plan doesn't drift from the
> documents it's derived from.

## Context

Unlike a from-scratch product with no prior art, Octalve Edu's requirements were stress-tested
twice before any schema was written: once through an ordinary requirements pass (`docs/PRD.md`
§1–§14), and a second time through an adversarial security/compliance audit (the same Claude Doc's
Security & Compliance Audit tab, cross-checked against a second, independently-produced audit).
Several schema decisions below exist *specifically* to close a finding from that audit, not from
the PRD's feature list alone — those are called out explicitly, because they're easy to lose track
of once the code exists and the audit document doesn't.

**What's already real, verified against the actual repo (not assumed):**

1. **Phase 0 is done** — see `docs/development-history/phases/phase-0-foundation.md` for the full
   record. Summary: Next.js 16 (App Router) + TypeScript + Tailwind scaffold, Prisma 6.19 +
   PostgreSQL with Auth.js's required tables plus `Tenant`/`Campus`/`TenantMembership` (the
   verified-membership table the tenant-trust-boundary check reads), a `tier-manifest.json`
   skeleton, and a local-dev `docker-compose.yml`. `pnpm build` is clean, first migration applied
   against a real local Postgres.
2. **No domain schema exists yet.** Every model in Phase 0.5 onward below is new.
3. **No auth wiring, RLS policies, or API routes exist yet**, despite Phase 0's schema already
   having the tables Auth.js needs — the schema existing is not the same as the auth flow being
   built. That's Phase 0.5, sequenced first for exactly this reason.

This document sequences Phase 0.5 onward. Phase 0 is included only as a retrospective pointer, not
as a step to execute.

---

## Phase 0.5 — Auth, RLS & Shared API Infrastructure

Nothing in Phase 1 onward is safe to build on top of until this phase closes the two Critical
findings from the security audit that are architectural, not feature-level: the tenant-trust
boundary and session revocability. Both are infrastructure, not "a school feature," which is why
they're their own phase rather than folded into Phase 1.

### 0.5.0 — First-run superadmin setup wizard (Solo only) — **Done**, built ahead of the rest of
this phase

PRD §4's onboarding table names this for Solo installs ("Run installer, one-time setup wizard") but
never specifies it — built now, out of sequence relative to 0.5.1–0.5.3 below, because it needed
almost none of that infrastructure (no Auth.js session, no tenant-trust-boundary resolver — it's the
one route that runs *before* either exists) and unblocks manually testing everything after it
without a `prisma db seed` script standing in for a real admin account. Adapted from `proplity`'s
own first-run-setup-wizard implementation (`docs/development-history/phases/first-run-setup-wizard.md`
in that repo), which solves the identical problem — a fresh production database has no admin user —
for a single-tenant app; the adaptation here is entirely about Octalve Edu having a `Tenant` model
that `proplity` doesn't.

- **Solo-only, not a SaaS concept.** SaaS tenants get their own self-serve signup flow later (not
  built yet); this wizard bootstraps the *one* tenant a Solo install ever has. `GET`/`POST
  /api/v1/setup` and the `/setup` page both hard-404 outside `DEPLOYMENT_MODE=solo` — not just a
  UI-level redirect, since the route doing anything at all in SaaS mode would be a bug, not a choice.
- **Schema** (retrofit into Phase 0's `schema.prisma`, this migration
  `20260927223904_add_setup_wizard`): `User.passwordHash String?` (the same field 0.5.1 below
  already planned to add — done here instead since this route needed it first); a `SystemSettings`
  singleton (`id = "global"`, `setupComplete Boolean`) — proplity's exact pattern, since Octalve
  Edu's own `Tenant` table can't answer "is setup done" by itself without a race (two concurrent
  requests both seeing zero tenants); `AuditLog` brought forward from Phase 1's design (§1.5 below)
  because this wizard needed a real audit trail same as everything after it will.
- **API** (`src/app/api/v1/setup/route.ts`): `GET` returns `{ setupComplete, requiresToken }`;
  `POST` guarded by CSRF (`lib/auth/csrf.ts`), IP rate limiting (`lib/auth/rate-limit.ts` —
  in-memory, deliberately not the real `LoginAttempt`-backed limiter 0.5.1 will build for login,
  since Solo always runs as one long-lived process, never serverless), Zod validation, an optional
  `SETUP_TOKEN` compared with `crypto.timingSafeEqual`, and the same atomic-conditional-update
  transaction as `proplity` (`systemSettings.updateMany({ where: { setupComplete: false }, ... })` —
  `count === 0` means someone else's request already won the race). On success, creates the `Tenant`
  (code auto-derived from the school name via `lib/tenant/validate-code.ts`'s slugify + reserved-word
  check — Solo installs never see or choose a code, per PRD §7), the admin `User`, its
  `TenantMembership` (`role: ADMIN`), and an `AuditLog` row, all in one transaction. Every response
  uses PRD §7's mandatory `{ data, meta, error }` envelope (`lib/api/envelope.ts`) — the first route
  in the repo to need it, so that's where the shared helper was born.
- **Frontend** (`src/app/setup/`): `page.tsx` is a Server Component, 404s outside Solo, redirects to
  `/login` if `setupComplete` is already true (fails open on a DB error, same reasoning as
  `proplity`'s version — a transient blip shouldn't lock a deployer out of their own bootstrap
  step), otherwise renders `SetupWizardForm.tsx` (school name, admin name/email, password ×2 with a
  live checklist, optional setup-token field). No design-system dependency added for this — Octalve
  Edu has no component library yet, so it's plain Tailwind, not a port of `proplity`'s (which uses
  `lucide-react` icons and `sonner` toasts it already had installed).
- **Verified live, not just built**: `pnpm prisma migrate dev` applied against the real local
  Postgres; `pnpm build` clean; `DEPLOYMENT_MODE=solo pnpm dev` + a real `POST` created a tenant +
  admin + membership + audit row (confirmed via the response body), a second `POST` correctly got
  `409 ALREADY_COMPLETE`, and `GET` reflected `setupComplete: true` afterward; separately,
  `DEPLOYMENT_MODE=saas pnpm dev` confirmed both `/api/v1/setup` and `/setup` return `404`. Test data
  truncated from the local dev database afterward so it starts clean again.
- **Explicitly out of scope**: no email to the new admin (no delivery provider wired up yet, same
  gap `proplity` documents); no Campus/branch creation in the wizard (a Solo school can add
  campuses later via Settings, once that exists); a SaaS-side "platform operator" superadmin concept
  is not built and not requested — this is only ever a single school's first admin.

### 0.5.1 — Auth (revised 2026-09-30, second pass)

**Auth.js's `Credentials` provider is not used at all — this supersedes an earlier draft of this
section that described wiring it.** Auth.js v5 refuses `Credentials` combined with
`session.strategy: "database"` outright (`UnsupportedStrategy`, thrown by its own `assertConfig` on
every request under `/api/auth/*`). AlEemaan (sibling project, identical stack) hit this live and
kept database sessions — the deliberate PRD §7 decision here too — by dropping `Credentials`
entirely (`providers: []`) and hand-rolling login/logout against the same `Session` table Auth.js's
`PrismaAdapter` reads. Same approach here. Auth.js is kept only for its adapter/session-reading
machinery (the exported `auth()` helper) — a materially smaller role than originally planned, worth
noting given the section below on whether to keep it at all.

**Resolved 2026-09-30: hand-roll, mirroring AlEemaan — do not adopt Better Auth.** A research spike
(prompted by the fact below) checked Better Auth against this plan's actual non-negotiable
requirements. Verdict, point by point: database sessions with row-delete revocation fit well
(Better Auth's default, not an opt-in); TOTP MFA fits well (a real first-party `twoFactor` plugin,
worth using as a *reference implementation* later even without adopting the framework); session
listing/revocation fits well. But the one requirement that's actually non-negotiable —
**hashed-session-tokens-at-rest** — is **not shipped**: Better Auth stores the raw token value today,
and a `storeTokenHash` option exists only as an unmerged draft PR
(better-auth/better-auth#11444, tracking issue #11442), not in any released version. Redoing that
exact guarantee inside an unfamiliar library via a custom `databaseHooks` interception would add real
risk for no net gain, when AlEemaan's hand-rolled version already proves the identical guarantee out
in production. Separately, Better Auth's `organization`/`teams` plugin doesn't map as cleanly onto
`Tenant`→`Campus` (optional anchor) as this project's own purpose-built schema — team assignment
lives in a separate join table, not a nullable field on `Member`, so "admin anchored to one campus but
authorized across all of them" isn't a native concept there either. Full reasoning and sourced
citations: ask for the spike's original report if needed, or trust this summary — re-litigating it
without new information isn't necessary. Revisit only if Better Auth's `storeTokenHash` ships and
stabilizes.

**Practical consequence: build §0.5.1 by adapting AlEemaan's already-built, already-verified
implementation, not from scratch.** `AlEemaan/src/lib/auth/session.ts`, `password.ts`, and
`rate-limit.ts` (see that repo's `docs/development-history/phases/phase-0.5.1.5-auth-rebuild.md` for
the full build record) are the working reference for the mechanism described below — hashed session
tokens, timing-safe compare, the fixed rate limiter. Port and adapt for `TenantMembership`/`Campus`
(AlEemaan's `requireAdmin()` → this project's `withAuth()`, `Membership.branchId` →
`TenantMembership.campusId`), don't reinvent the mechanism itself.

**The fact that triggered this spike (found 2026-09-29, via a two-AI cross-review of this plan and
AlEemaan's shipped code — see `docs/auth-review-2026-09-29.md` for the full record): Better Auth's
team took over Auth.js maintenance in September 2025, and Vercel acquired Better Auth in July 2026.
Auth.js is now maintenance-mode — security patches only, no new features — and its own maintainers
now point new projects at Better Auth.** Auth.js's role in this plan was already reduced to "read
`Session` rows via an adapter" even before this decision — and per the resolution above, that role is
now dropped to zero: no Auth.js dependency at all, same as AlEemaan.

#### Build design for the port (added 2026-09-30, immediately before implementation)

Written before any code, per this repo's design-before-code rule. It records what the port keeps,
what it deliberately does *not* copy from AlEemaan, and what is built beyond AlEemaan's current
state — each with the reasoning, so none of it has to be re-derived later.

**Shared names — identical in both repos, on purpose.** File names, exported function names, route
paths and error codes match AlEemaan's already-built versions exactly, so a fix or review finding in
one repo maps 1:1 onto the other:

| Concern | Name (both repos) |
| :--- | :--- |
| Session helpers | `lib/auth/session.ts` — `createSession`, `getSession`, `getSessionFromRequest`, `deleteSessionByToken`, `revokeUserSessions`, `setSessionCookie`, `clearSessionCookie`, `SESSION_COOKIE_NAME` |
| Passwords | `lib/auth/password.ts` — `hashPassword`, `verifyPassword`, `BCRYPT_COST`; `lib/auth/password-policy.ts` — `PASSWORD_MAX_LENGTH` (128, login input bound), `PASSWORD_MAX_BYTES` (72, every set path), `passwordByteLength` |
| Rate limiting | `lib/auth/rate-limit.ts` — `reserveAttempt`, `refundAttempt`, `checkRateLimit`, `getClientIp` (all `async`) |
| Route guard | `lib/auth/with-auth.ts` — `withAuth(handler, options)` (replaces AlEemaan's `requireAdmin()`; AlEemaan migrates too — see its own plan, §0.5.1.6) |
| CSRF / envelope / db | `lib/auth/csrf.ts`, `lib/api/envelope.ts` (`ok`, `fail`, `noStore`), `lib/db.ts` |
| Routes | `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` |
| Error codes | `INVALID_CREDENTIALS`, `RATE_LIMITED`, `CSRF`, `INVALID_BODY`, `UNAUTHENTICATED` (AlEemaan adds `FORBIDDEN`) |
| Screens | `/login`, `/dashboard`, `/` (pure router), `/setup`; `components/ui/*`, `components/auth/*` |
| Tests | `tests/{setup,unit,integration,api,e2e,https}`, `playwright.config.ts`, `pnpm test` — same layout and helpers in both repos (own ports and own `*_test` database each) |

Deliberately **not** synced (different concepts, not naming drift): the models `Campus`/`Branch` and
`TenantMembership`/`Membership` (this repo has a `Tenant` above `Campus`; AlEemaan has no tenant and
"branch" is the school's own word), and the cookie's product prefix (`octalve.session-token` /
`__Host-octalve.session-token` here, `aleemaan.…` there — two products must never share a cookie name).

**Deliberate divergence #1 — `withAuth` ships session + CSRF only in this pass; role/permission
gating arrives with §0.5.2.** A straight port of AlEemaan's "any `ADMIN` membership row grants
access" would be a cross-tenant privilege escalation here: an `ADMIN` of School A would pass the
check on School B's routes. In a multi-tenant schema a role is only meaningful *against a specific,
verified tenant's membership*, and that verified tenant doesn't exist until `resolve-tenant.ts`
(§0.5.2) does. So `withAuth(handler, { roles, permissions })` keeps the shared call shape, but until
§0.5.2 lands, passing `roles`/`permissions` fails closed instead of guessing a tenant — **implemented
as a compile error (the options are typed `never`) plus a throw at module load if the types are
bypassed**, so `next build` fails rather than shipping an unguarded route. (The first draft of this
note said "500 misconfiguration" at request time; catching it at build time is strictly earlier, so
that is what was built.) The "ADMIN crosses every `Campus`" rule stays exactly as §0.5.2 states it —
scoped to *that tenant's* campuses.

**Deliberate divergence #2 — rate-limiter backend.** This pass ports AlEemaan's in-memory
reserve-then-refund limiter (trusted `X-Real-IP` only, size-capped, all three keys: per-IP, per-`ip+email`
hard gates and a soft per-account signal). That is correct for Solo and for a single-instance SaaS
deployment. It is **not** sufficient for multi-instance SaaS, where a different instance means a
different `Map`; that needs the Redis-backed version (§0.5.3, client library still to be chosen —
`@upstash/ratelimit` does not fit the plain Redis container `docker-compose.yml` provisions). Callers
`await` the limiter from day one so swapping in an async Redis backend later changes no call site.
This limitation is a known, tracked condition — **it must be closed before any multi-instance SaaS
production deployment**, and the setup wizard's own use of the limiter moves to the same API here
(the old `checkRateLimit`/`recordAttempt` pair, which trusted raw `X-Forwarded-For` and had the
check-then-record race, is removed entirely).

**Built beyond AlEemaan's current state** (AlEemaan deferred these; this repo's plan already lists
them as part of the hardened design, and retrofitting schema columns after data exists is the more
expensive path). Tracked for back-porting to AlEemaan in the cross-repo sync task:
- **Two-level session expiry.** `Session.expires` is the *idle* expiry (30 days, the one shared
  `SESSION_MAX_AGE_SECONDS`, slid forward on use — throttled to at most one write per 5 minutes per
  session); new `Session.absoluteExpires` is a hard cap set at login and never extended: **90 days
  normally, 7 days for a user holding any `ADMIN` membership.** The cookie's own expiry is set to the
  absolute expiry (the server is authoritative on idle expiry, so the cookie never needs refreshing).
  These numbers are policy defaults — the PRD specifies none — and live as named constants.
- **Bounded growth.** `createSession` also deletes that user's already-expired rows in the same
  transaction; `purgeExpiredSessions()` is exported for the scheduled nightly purge (the job runner
  arrives with BullMQ infrastructure later — the function exists and is verified now).
- **Email case-insensitivity enforced in Postgres**, not only in code: a `CHECK (email = lower(email))`
  constraint added in the migration's SQL (Prisma's schema language can't express it).
- **`Cache-Control: no-store`** on every auth response (new additive `noStore()` helper in
  `lib/api/envelope.ts`).
- **Password max length (128)** on the setup wizard's schema too, not just login.

**Decisions made during implementation (2026-09-30), recorded as they were made** — each is either a
refinement of the design above or something the design left open. The first three differ from
AlEemaan's shipped code and are tracked for back-porting (cross-repo sync task):
1. **Per-IP login limit is 30 per 5 minutes; per-`ip+email` stays 5.** AlEemaan gates all three
   layers at 5. A hard 5-per-IP gate lets one person's typos lock out everyone sharing that IP — and
   shared IPs are the norm here (mobile-carrier NAT, a school's single egress address). The per-IP
   layer is a coarse anti-spraying gate; the per-`ip+email` layer is what stops grinding one account.
2. **Client IP is configurable, not hard-wired to `X-Real-IP`:** `CLIENT_IP_HEADER` (default
   `x-real-ip`) or `x-forwarded-for` read from the *right* (`TRUSTED_PROXY_HOPS`, default 1). Needed
   because the Solo installer's reverse proxy is Caddy, which appends to `X-Forwarded-For` but does not
   set `X-Real-IP` unless told to. With no usable header the limiter falls back to one shared bucket
   and **warns once in production**, since that turns the per-IP limit into a school-wide one.
3. **True LRU eviction in the limiter.** AlEemaan's sweep evicts oldest-*inserted* keys (a `Map` keeps
   first-insertion order on overwrite), so an attacker flooding new keys could evict a hot legitimate
   key; here every write re-inserts the key so eviction is oldest-*touched*.
4. **Limiter functions are `async` from day one** (their bodies must stay synchronous — an async
   function runs synchronously to its first `await`, which is what keeps each reservation atomic).
   Callers `await`, so the Redis backend is a drop-in. Documented as an invariant in the file.
5. **`GET /api/v1/auth/me` added** — session introspection (user + memberships) for any client, and
   the first route on `withAuth`, which is what makes the guard verifiable over HTTP.
6. **Cache headers:** `noStore()` on every auth response; `withAuth` adds `private, no-store` to every
   authenticated response.
7. **Cookie lifetime = absolute expiry**; idle expiry is enforced server-side only (so the cookie is
   never refreshed and Server Components, which can't set cookies, still slide the idle window).
8. **Setup wizard migrated and retrofitted:** onto the reserve/refund limiter and `hashPassword()`, with
   a 128-char password cap; on the shared UI primitives with real `<label>` associations,
   `autocomplete` hints, and the design's "served over plain HTTP in production" warning; the 3.5 s
   auto-redirect after success was replaced by an explicit "Continue to sign in" button (an unrequested
   timed context change fails WCAG 2.2.1).
9. **UI shipped with the phase** (not just API): `/login`, `/dashboard`, `/` (pure router), shared
   `ui/` primitives and `AuthShell`. Two behaviours worth naming because a server-rendered page can't
   notice them itself: **cross-tab sign-out** (BroadcastChannel) and **`pageshow` revalidation** so the
   browser's back/forward cache can't resurrect a signed-out user's dashboard on a shared computer.
   New modules: `lib/setup/status.ts`, `lib/auth/memberships.ts`, `lib/roles.ts`.
    Found by driving the real flow in a browser (not by review): after a rejected sign-in the password
    input was still `disabled` when `focus()` was called, so focus silently fell to `<body>` — keyboard
    and screen-reader users lost their place. Focus now returns to the (emptied) password field after
    render; covered by a regression test.
10. **The migration was authored with `prisma migrate diff` + hand-written SQL**, not `migrate dev`:
    `migrate dev` refuses to run non-interactively when it must confirm a destructive column drop
    (`Session.sessionToken`). Recorded so the next migration author doesn't lose time to it.
11. **Where the work lives:** `octalve-core/octalve-edu` has no Claude GitHub App installed, so this
    phase is developed on `claude/auth-0.5.1-port` in the maintainer's fork
    (`roji-tech/octalve-edu-fork`) and merged by PR into `octalve-core/octalve-edu` by the maintainer.

12. **Password limits corrected: 72 bytes at every *set* path, 128 characters at *login*.** The design
    above (and AlEemaan's shipped code) capped passwords at 128 *characters* with the stated reason that
    "bcrypt silently truncates at 72 bytes" — but a 128-character cap does not address truncation at all:
    verified empirically (bcryptjs 3) that a 72-byte prefix plus anything else verifies as the same
    password, so a 100-character passphrase is really protected by its first 72 bytes and a typo after
    byte 72 still signs the user in. (Bytes, not characters: 25 emoji is 100 bytes.) Fix, in
    `lib/auth/password-policy.ts` (client-safe, no Node imports): `PASSWORD_MAX_BYTES = 72` is *rejected*,
    never truncated, wherever a password is set (setup wizard now; signup / change / reset later), with a
    message the user can act on and live feedback in the setup form; `hashPassword()` throws as a backstop.
    `PASSWORD_MAX_LENGTH = 128` remains, but only as the input-size bound for login — login must keep
    accepting whatever an existing account's password was set to (bcrypt truncates identically at verify
    time), so tightening it could lock out a real user. **Tracked for back-porting to AlEemaan** (it has
    live accounts, so its login must stay at 128 while its set paths adopt the byte limit).
13. **`withAuth`'s own refusals (401 `UNAUTHENTICATED`, 403 `CSRF`) are `no-store` too** — found by the
    API suite: the first version only marked the handler's success response, so the guard's early
    returns carried no `Cache-Control`. Every response the wrapper emits is now uncacheable.
14. **Baseline security headers** (`next.config.ts`, all routes): `X-Frame-Options: DENY` plus
    `Content-Security-Policy: frame-ancestors 'none'` (clickjacking — the login form was frameable),
    `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (tenant
    codes and record IDs live in paths; cross-origin referrers get the origin only), and
    `poweredByHeader: false`. **HSTS is deliberately *not* set by the app**: TLS terminates at the
    reverse proxy, `headers()` in `next.config.ts` is fixed at build time while the scheme is a runtime
    setting (`APP_URL`), and the header is meaningless over HTTP — so it belongs in the proxy config
    (add `Strict-Transport-Security "max-age=15552000"` to the Solo installer's Caddyfile; no
    `includeSubDomains`/`preload` — a school's other subdomains may not be HTTPS-ready). A full
    nonce-based script CSP is a separate, larger piece of work tracked under §0.5.3.
15. **Test infrastructure is part of the deliverable** (`tests/`, `playwright.config.ts`, `pnpm test`):
    Playwright Test as the single runner — `unit` (pure logic), `integration` (modules against Postgres),
    `api` (real HTTP against a production build), `e2e-desktop`/`e2e-mobile` (real Chromium), `https`
    (real Chromium over real TLS via a local proxy, so the `__Host-` rules are enforced). Runs against a
    dedicated `<db>_test` database (created and migrated with `migrate deploy` automatically; every
    destructive helper refuses to run against any database whose name doesn't end in `_test`). Each test
    creates its own users and its own client IP (the servers trust `X-Real-IP`, exactly as in
    production) so tests can't exhaust each other's rate-limit buckets. Every security-relevant assertion
    was mutation-checked (a deliberate bug is injected and the suite must fail) — see the phase record.

**Explicitly out of scope for this pass, tracked, not forgotten:** TOTP MFA and its pending-state
token (design above stands; must land **before Phase 1's Settings UI**, which needs step-up MFA and
`mfaRequiredForTeaching`), password reset, breached-password check, the active-devices page. The login
route is structured so the pending-MFA step slots between "password verified" and "session created"
without restructuring.

**UI in this pass** (the setup wizard already redirects to `/login`, which did not exist — an auth API
with no way to sign in is not a finished phase): a `/login` page in the wizard's visual language
(properly associated labels, `aria-live` errors, show/hide password, correct `autocomplete`
attributes, enumeration-safe copy, a clear rate-limited state), a minimal `/dashboard` (who is signed
in, which schools they belong to, sign out) that becomes the §0.5.2 front-door router, and `/` as a
pure router (session → `/dashboard`; Solo with setup incomplete → `/setup`; otherwise `/login`),
replacing the create-next-app placeholder. No `?next=` redirect parameter yet — when one is added it
must accept only same-origin relative paths (open-redirect defense).

**Verification for this pass** — the standard AlEemaan's rebuild set, made repeatable rather than
hand-run: (1) scripted API checks against a real Postgres, including direct `psql` inspection that
`Session.tokenHash` never equals the cookie value and that the email `CHECK` rejects mixed case;
(2) timing comparison of the no-such-user and wrong-password paths; (3) rate-limit trip test with
spoofed `X-Forwarded-For` proving it is ignored while `X-Real-IP` is honored; (4) `Set-Cookie`
attribute assertions for both cookie shapes, plus a **real-browser HTTPS run** (self-signed local TLS
proxy, Chromium enforcing the actual `__Host-` rules) proving login sets and logout *actually clears*
the cookie — the open item the two-AI review flagged as unverified (P0 #4); (5) Playwright flow tests
for the UI: sign-in success, wrong password, rate-limited state, keyboard-only use, session persisting
across reload, sign-out then back-button, direct navigation to `/dashboard` when signed out, and the
setup → login hand-off.

**Result (2026-09-30): all five were delivered and exceeded** — see `phases/phase-0.5.1-auth.md`:
234 tests (`pnpm test`), every security assertion mutation-checked (40 of 40 injected bugs caught), axe
WCAG 2.2 on every screen and state, and the real-HTTPS run that closes P0 #4 (the `__Host-` cookie is
accepted on login and actually removed on logout; a bare `cookies.delete()` makes it fail). The
verification also found ten defects the design had not anticipated — decisions #12–#15 above.

#### Login/logout route design

Guard order, same as every other mutating route in this codebase: `validateCSRF(req)` (the helper
already exists, `lib/auth/csrf.ts`, built for the setup wizard) → rate limit (key strategy in §0.5.3)
→ Zod-validate → look up `User` → compare password → create `Session` row → set cookie.

- **Constant-time response, not just a constant-time password compare.** Always run
  `bcrypt.compare` against a fixed dummy hash — generated once at boot, at the real production cost
  factor, never a malformed placeholder (a malformed hash makes bcrypt return instantly, which
  defeats the fix) — even when no user matches the email, or when `passwordHash` is null (an
  invited-but-not-yet-activated user). Both branches must cost the same regardless of outcome;
  verify with a test asserting similar timing across both paths, not just code review.
- **Enumeration-safe error messages** — identical `401 INVALID_CREDENTIALS` for "no such user" and
  "wrong password."
- **Password max length: 128 characters, enforced in the Zod schema at both login and account
  creation.** bcrypt silently truncates at 72 bytes — without a cap, a long passphrase loses
  entropy with no warning, and nothing stops an oversized payload from being submitted.
  **Corrected 2026-09-30 (see "Decisions made during implementation" #12):** a 128-character cap
  bounds the payload but does *not* stop bcrypt's silent truncation. New passwords are limited to 72
  *bytes* and rejected past that; 128 remains only as login's input-size bound.
- **Fresh, server-generated, high-entropy session token on every login, never client-supplied**
  (`crypto.randomBytes(32).toString("hex")`, 256 bits) — the actual defense against session
  fixation. Stated explicitly so a future change can't "simplify" it into accepting or reusing a
  token from anywhere else.
- **Hash the session token before storing it** (SHA-256 is fine — the token itself is already
  256-bit random, so a fast hash doesn't weaken anything). The client keeps the plaintext token in
  its cookie; the database stores only the hash. This is the standard pattern documented by Lucia's
  (no-longer-maintained-as-a-library, but still a correct reference) session guide — a leaked
  database backup or a read-only SQL injection elsewhere in the app then yields no directly-replayable
  session tokens, only hashes. **Resolved: write a small custom `getSession()`, same as AlEemaan's
  `src/lib/auth/session.ts` — Auth.js's Prisma adapter looks sessions up by the raw cookie value and
  can never find a hashed row without being patched, so wrapping it isn't viable. Drop
  `next-auth`/`@auth/prisma-adapter` entirely rather than keep an adapter that no longer does
  anything.**
- **Normalize email (`trim().toLowerCase()`) at every point `User.email` is read or written** — the
  setup wizard, this login route, and any future signup/invite flow. Enforce it at the database
  level too (Postgres `citext` on the column, or a `CHECK (email = lower(email))` constraint) — app-
  code normalization alone doesn't protect against a seed script or direct SQL import bypassing it.
- **Cookie**: `httpOnly`, `sameSite: "lax"`, explicit `cookies.sessionToken.name`. Use the
  **`__Host-` prefix in production, not `__Secure-`** — `__Host-` additionally forces `Path=/` and
  forbids a `Domain` attribute, closing a subdomain-cookie-planting risk `__Secure-` alone doesn't.
  Derive the `secure` flag from the actual configured scheme (an explicit env var or the app's own
  base URL), **not from `NODE_ENV`** — a Solo install genuinely running on `http://` in production
  mode (a LAN deployment with no reverse-proxy TLS yet) would otherwise get a `200` from login with
  no cookie ever set, since browsers silently refuse a `Secure` cookie over plain HTTP. Warn about
  this in the setup wizard if it detects a non-HTTPS base URL in production mode. Add
  `Cache-Control: no-store` on every auth response. Define the session lifetime as **one shared
  constant**, imported by both `src/auth.ts`'s `session.maxAge` and the login route's
  `Session.expires` calculation — never duplicated as a separate literal in each file.
- `POST /api/v1/auth/logout` — `validateCSRF(req)` → delete the `Session` row (match by the hashed
  token, per the hashing note above) → **delete the cookie with the exact same attributes it was set
  with** (`path`, `secure`, `sameSite`, the `__Host-`/`__Secure-` name). A bare `cookies.delete(name)`
  with no attributes can silently fail to clear a `__Host-`/`__Secure-`-prefixed cookie in a real
  HTTPS deployment even though the dev-mode unprefixed cookie clears fine — this needs an actual
  HTTPS end-to-end test before trusting it, not just the dev-mode verification AlEemaan's own logout
  route was checked against.

#### Session lifecycle (not just create/delete)

- **Rotate at login**: if the incoming request already presents a session cookie, delete that
  session row before minting the new one — don't let old and new sessions both stay valid.
- **Cap concurrent sessions per user** (e.g. 10) — evict the oldest on overflow, so a scripted login
  loop can't grow `Session` rows for one account without bound.
- **`revokeUserSessions(userId, { except? })`** — one helper, called on every password change, role
  change, or account deactivation. Without this, a dismissed staff member's session or a password
  reset's *old* session both stay valid until natural expiry (up to 30 days).
- **Absolute lifetime cap, shorter for `ADMIN`**, layered on top of the idle/`maxAge` expiry already
  planned.
- **A nightly purge job** for expired `Session` rows — nothing currently deletes them once `expires`
  passes; Auth.js's adapter just stops honoring them, the rows themselves accumulate forever.
- **Extra `Session` columns needed for the "active devices" UI below to be useful at all**:
  `createdAt`, `lastUsedAt`, `userAgent` — the current `Session` model (`id`, `sessionToken`,
  `userId`, `expires`) has nothing to show a user besides "a session exists." Add these to the
  schema design when this section is actually built, not retrofitted after the UI is written against
  an incomplete model.
- `otplib`-based TOTP for MFA, `mfaSecret String?` (encrypted at rest — PRD §10) and
  `mfaEnabled Boolean @default(false)` on `User`. **The step order matters and needs to be explicit,
  or MFA becomes decorative**: password verification must **not** create a real `Session` row
  directly. Issue a short-lived (~5 minute), single-purpose pending-MFA token that `auth()` cannot
  read as a valid session, and only create the real `Session` row after TOTP verification succeeds
  (recording `mfaVerifiedAt`). Otherwise an attacker who obtains the password alone gets a real,
  usable session the instant they submit it, and the TOTP prompt is just UI theater on top of an
  already-valid session. Rate-limit TOTP attempts separately from login attempts; store recovery
  codes hashed, never plaintext.
- Session revocation surface: a "your active devices" page reading the current user's `Session` rows
  (now with the columns above to actually be useful), with a delete action per row (Audit #23's
  server-revocable-sessions fix) — cheap specifically *because* database sessions were chosen over
  JWT in Phase 0.

#### Rate limiting for the login route specifically

Full shared rate-limiting design lives in §0.5.3; the login-specific requirement: **the bucket
records failed attempts only, not every request** — a correct login must never count against it, or
a naive "generic auth-route-group middleware" implementation ends up locking out someone switching
devices or retrying after a network blip.

### 0.5.2 — Tenant trust boundary (closes Audit's most severe finding)

This is PRD §7's own words, made real:

```
authenticated user → verified tenant membership → SET LOCAL app.tenant_id → RLS
```

- `lib/tenant/resolve-tenant.ts`: given a request and its authenticated session, reads the URL's
  `[code]` segment **only as a lookup key** — resolves it to a `Tenant.id`, then queries
  `TenantMembership` for `(userId, tenantId)`. No membership row → 403, regardless of what the URL
  says. This function's own test suite is the negative-test requirement from Audit #21: change
  `[code]` to a different tenant's code and confirm every protected route rejects it, not just a
  sample. Returns a **branded `VerifiedTenantId` type** (`type VerifiedTenantId = string & { readonly
  __brand: "VerifiedTenantId" }`), not a bare `string` — this is a compile-time guarantee on top of
  the ESLint import restriction below, not instead of it: TypeScript won't accept a raw `req.url`
  substring where a `VerifiedTenantId` is expected, so the mistake the ESLint rule catches at review
  time is also caught by `tsc` before that.
- **`ADMIN` role scoping, resolved explicitly (2026-09-30) rather than left ambiguous**: same rule
  AlEemaan already uses for its own `Membership.branchId` — any `TenantMembership` with `role: ADMIN`
  grants access across every `Campus` under that tenant, regardless of which `campusId` that row
  happens to anchor to (`campusId` is bookkeeping — which campus onboarded them — never a
  restriction). Keeping this identical between the two projects matters now that AlEemaan's own auth
  is being aligned to this plan (see AlEemaan's `domain-implementation-plan.md`) — one authorization
  rule, not two subtly different ones that happen to look similar.
- `lib/tenant/for-tenant.ts`: the `forTenant(tenantId: VerifiedTenantId)` Prisma client extension
  already named in PRD §7 — the parameter type itself is the branded type above, so a caller can't
  pass an unverified string even if they tried. Wraps every query in a transaction that sets the
  tenant context first. **Use `set_config`, not string-interpolated `SET LOCAL`**: `SET LOCAL app.tenant_id
  = '<id>'` requires the value to be lexically part of the SQL string, since `SET LOCAL` doesn't
  accept bind parameters — if any future code path ever calls this with a value that isn't already
  the verified branded type (e.g. someone reaching for `$executeRawUnsafe` directly instead of going
  through `forTenant()`), that's a SQL injection vector in the tenant-isolation safety net itself.
  `set_config()` is a regular function call and *does* accept a bind parameter:
  `await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}::text, true)``. Read it back
  with `current_setting('app.tenant_id', true)` (the `true` "missing OK" argument matters — without
  it, a context where the setting was never set throws instead of returning null, and every RLS
  policy below needs the unset case to mean "return zero rows," not "error").
- **RLS is inert unless the database role connecting actually has it enforced — this needs explicit
  role setup, not just `CREATE POLICY` statements.** Postgres RLS policies do not apply to a table's
  owner, to a role with `BYPASSRLS`, or to a superuser, by default — and Prisma's migration role
  typically *is* the table owner. If the app's runtime `DATABASE_URL` connects as that same owner
  role, every RLS policy silently does nothing, while `CREATE POLICY` succeeds and a naive negative
  test can even pass (because the test also runs as the owner). Required: two distinct Postgres
  roles — a `migrator` role that owns the tables (used only for `prisma migrate`), and a separate
  `app_user` role with `NOBYPASSRLS` and DML-only grants (used by the actual running app's
  `DATABASE_URL`). Add `ALTER TABLE ... FORCE ROW LEVEL SECURITY` on every tenant-scoped table so
  policies apply even to the owner as a second layer. Every policy needs both a `USING` clause (for
  reads) and a `WITH CHECK` clause (for writes) — a `USING`-only policy lets a query *insert* a row
  belonging to a different tenant even though it can never be *read* back.
- RLS policies added in this phase's migration for every tenant-scoped table that exists so far
  (currently: `Campus`, `TenantMembership`). Every table added in Phase 1 onward gets its RLS
  policy in the *same* migration that creates the table — never a follow-up migration, so there's
  no window where a new table exists without RLS.
- **Identity tables queried before any tenant is known, listed explicitly rather than discovered by
  trial and error**: `User`, `Session`, `Tenant`, `TenantMembership` itself. Login and session lookup
  happen before `resolve-tenant.ts` has run — if `TenantMembership` were RLS-filtered the same way
  as tenant-scoped business data, `resolve-tenant.ts` could never read the very row it exists to
  verify (a chicken-and-egg lockout). These identity tables are deliberately **not** RLS-scoped by
  tenant; everything they need protected is protected by ordinary query conditions
  (`WHERE userId = ...`), not RLS. Keep this list reviewed and short — it's the explicit exception
  list to "every tenant-scoped table gets RLS," and it should only ever contain tables that
  structurally can't be tenant-scoped, not tables where RLS was merely inconvenient.
- **Use one interactive transaction per request** (`forTenant(id).$transaction(async (tx) => {...})`
  style), not `forTenant()` re-wrapping each individual query — a per-query wrapper costs a
  round trip per call for something that should be set once per request. Size the connection pool
  with this in mind (each request holds a transaction, not just a query, for its duration); if a
  pooler sits in front of Postgres, it needs to support transaction-scoped session state (PgBouncer's
  transaction-pooling mode does).
- **Cross-tenant identity takeover, closed at the provisioning step, not the auth step**: `User` is
  global (one row per email, across every tenant) while `TenantMembership` is per-tenant — so a
  tenant admin directly setting a password for `teacher@gmail.com` at their school, when that same
  email already belongs to a real person teaching at a *different* school, hands the admin (however
  unintentionally) a working password for someone else's account at another tenant. **Tenant admins
  must only ever send an email invite, never set a password directly for an email address they
  don't already have a verified relationship with.** The invitee proves ownership of the email (a
  time-limited invite-acceptance link) and sets their own password; if that email already has a
  `User` row, the new `TenantMembership` attaches to the existing account only once the invitee
  accepts it while authenticated as themselves, never created silently by the inviting admin alone.
- **`DEPLOYMENT_MODE=solo` needs a runtime invariant, not just a code-path branch.** The current
  design has `resolve-tenant.ts` return the install's one `Tenant` row directly under Solo mode,
  skipping the membership lookup. If that env var were ever mistakenly set on a SaaS deployment (or
  a second `Tenant` row somehow appeared in what's supposed to be a Solo install), this silently
  becomes "every authenticated user gets access to whichever tenant row happens to be first" —  a
  full cross-tenant data leak from a single misconfigured environment variable. Assert, at startup
  and on every request under this code path, that exactly one `Tenant` row actually exists in the
  database — fail closed (500, not silently proceed) if that invariant doesn't hold. The env var
  should only ever change *where the tenant ID comes from*, never skip the membership-verification
  step itself.
- Front-door routing (PRD §7 "URL scheme"): `/dashboard`, `/list/*` resolve the session's active
  tenant and redirect into `/schools/[code]/...` when the user belongs to exactly one tenant; a
  school picker otherwise. Built here because it depends on 0.5.2's membership lookup existing
  first.
- **Keep authorization checks inside route handlers, never in Next.js middleware/`proxy`.** This
  design already does this (every check above lives in `resolve-tenant.ts`/`withAuth`, called from
  handlers) — stated explicitly because CVE-2025-29927 was a real, critical Next.js middleware
  bypass (a spoofed internal header skipped middleware entirely, patched in 15.2.3) affecting any
  app that put authorization logic in middleware. Use `proxy`/middleware for routing and UX only;
  keep a rebuild-and-patch routine for Next.js security advisories regardless.

### 0.5.3 — Shared API infrastructure

Per PRD §7's API-conventions paragraph, built once and reused by every route from Phase 1 onward:

- `lib/api/envelope.ts` — `{ data, meta, error }` response shape, one helper, never constructed
  inline per route.
- `lib/api/pagination.ts` — both offset (`page`/`limit`) and cursor helpers (PRD §7: offset for
  small stable lists, cursor for high-churn ones like `AttendanceRecord`/`AuditLog`).
- `lib/api/validate.ts` — wraps a Zod schema around a route handler; the same schema instance is
  later fed to `zod-openapi` (PRD §7 stack table) for the generated API docs, so validation and
  documentation cannot drift apart.
- `lib/api/rate-limit.ts` — closes Audit finding #14. **Client library correction (2026-09-30):**
  `@upstash/ratelimit`'s default client talks to Upstash's own hosted REST proxy over HTTP, not the
  plain Redis wire protocol — it will not work against a self-hosted `redis:7-alpine` container the
  way `docker-compose.yml` provisions one for local dev, without also running Upstash's separate
  self-hosted REST-proxy shim. Either actually provision Upstash's hosted Redis for this, or use
  `ioredis` (talks the real Redis protocol) with a Lua script for atomic increments, or
  `rate-limiter-flexible` (supports an `ioredis` backend natively) — decide which before this section
  is built, since the plan currently names a library that doesn't fit the infrastructure already
  provisioned.
  - **Layered keys, not a single key** — the earlier "key on `ip + email` combined" note was a real
    improvement over IP-only but still leaves two gaps open on its own: one IP spraying one common
    password across *every* account never trips an `ip+email` limit (each combination is fresh), and
    a botnet hitting *one* account from many IPs never trips it either (each IP's own count stays
    low). Use three limits together: per-IP across all accounts (stops spraying), per-`ip+email`
    (stops a single attacker grinding one account), and per-account across all IPs (stops distributed
    credential stuffing). Make the per-account limit a *soft* response — a delay, a CAPTCHA, a
    "someone tried to sign in" email notice — rather than a hard lockout, so an attacker can't
    weaponize the limit itself to lock a real user out.
  - **Atomic reserve, not check-then-record.** The current AlEemaan-derived pattern checks the limit
    *before* the slow async work (JSON parse, DB lookup, `bcrypt.compare`) and only records the
    attempt *after* — concurrent requests can all pass the check before any of them records anything,
    letting an attacker fire many parallel guesses through in one window regardless of the configured
    limit. Reserve the attempt atomically at the very start of the handler (a Redis `INCR`+`EXPIRE`,
    or a Lua script bundling check-and-increment into one round trip), before any `await` — and
    refund/clear it on a successful login, consistent with "failures only" above.
- `withAuth(handler, { roles })` — checks the resolved tenant membership's `role` against an
  allow-list, `.some()`-style if a user can ever hold more than one role in the future (not true
  today per PRD §7's Role enum, but this guards against the same class of bug TheNiche's own
  migration plan flagged: don't write `.includes()` against a value that might become an array
  later without noticing). **CSRF is enforced inside this wrapper for every non-`GET` route**, not
  left as a per-route opt-in call — a single forgotten `validateCSRF()` call in one route is a real
  gap in a per-route-call design, and in a multi-tenant app sharing one origin across every school, a
  stored-XSS payload in any one tenant's user-generated content (rich text, an uploaded SVG) could
  otherwise ride a logged-in session across tenants. Supplement with a `Sec-Fetch-Site` header check
  as a second signal, only trust `x-forwarded-host` when the reverse proxy itself sets it (not a
  client-suppliable header), and keep uploaded user content on a separate, cookieless domain with
  `X-Content-Type-Options: nosniff` so it can't execute as same-origin script even if a sanitizer
  gap lets something through.
- **Missing controls, worth planning now rather than discovering as a gap later**: no
  password-reset/forgot-password flow, no minimum-password-length or breached-password check (a
  HaveIBeenPwned-style k-anonymity check at account-creation/reset time), and no audit logging of
  auth events specifically (logins, failures, resets, role changes, session revocations) beyond the
  general `AuditLog` model already in the schema. Password reset needs the same care as login:
  hashed single-use short-lived tokens, a uniform response regardless of whether the email exists,
  rate limiting, and `revokeUserSessions()` (§0.5.1) called on completion so a compromised-password
  reset can't be silently followed by the attacker's own still-valid old session.

**Verification for this phase, before Phase 1 starts:** a negative-test file exercising every item
above — wrong tenant in the URL, no membership, session revoked mid-request, malformed pagination
params, rate limit exceeded — passes in CI, **run as the `app_user` role** (§0.5.2), not the
migration-owner role — a negative test that runs with `BYPASSRLS`-equivalent privileges passes
vacuously regardless of whether the RLS policies actually filter anything. This is the one phase
where "the code compiles" is not sufficient evidence of done; per Audit finding #21,
RLS-looking-correct and RLS-being-correct are different claims until a real cross-tenant test fails
when it should.

### Phase 0.5 addenda (2026-09-30, after the auth build)

Four pieces of work that sit between "auth works" and "Phase 1 can start", each designed here first
and built in **both** repos (AlEemaan's plan has the same sections): **A** the shared UI design
language, **B** a nonce-based script CSP, **C** password reset and change, **D** TOTP MFA. (Named A–D
rather than numbered, because §0.5.3 already means something different in each repo.)

#### 0.5.A — Shared UI design language (from the design artifact)

Source: the private design canvas "Octalve Edu & AlEemaan — UI Design"
(`https://claude.ai/artifact/8wGBA2trirEDaTQq1sUf74`) — its own framing is *"Admin app — same shell,
one brand tweak"* and *"Public marketing sites — bespoke per brand"*. This section covers the first;
the marketing sites are Phase 5.

**What the artifact fixes.** Octalve Edu is **indigo** (`#4F46E5`, deep `#3730a3`, light `#a5b4fc`,
tint `#1e1b4b`); AlEemaan is **sea green** (`#2E8B57`, deep `#0b3d24`, light `#6ee7b7`, tint
`#052e22`). Both share: a dark theme by default with a **light theme toggle**; the login split layout
(46 % brand panel in the deep colour with a faint dot/cross pattern, headline, blurb, three check-mark
points, and the form on the right with uppercase 12 px labels, a "Forgot password?" link and a "Keep me
signed in on this device" checkbox); the admin shell (248 px sidebar with brand mark, nav, user card;
60 px top bar with breadcrumb, theme toggle and profile menu); and on phones a floating **bottom tab
bar** with a "More" sheet in place of a hamburger drawer. Dark tokens `#020617` canvas / `#0f172a`
surface / `#1e293b` line / `#f8fafc` text; light tokens `#f8fafc` / `#ffffff` / `#e2e8f0` / `#0f172a`.

**Mechanism — the shared components stay code-identical; only two per-repo files differ.**
1. *Semantic tokens, not palette classes.* `globals.css` defines CSS variables for both themes
   (`--canvas --surface --surface-2 --line --fg --fg-2 --fg-muted`, status colours) and exposes them to
   Tailwind through `@theme inline` (`bg-canvas`, `bg-surface`, `text-fg`, `text-fg-muted`,
   `border-line`, `bg-brand`, `text-brand-fg`, …). No component names a colour any more, so re-skinning
   is a token change, and a theme switch is one attribute.
2. *Per-repo brand.* `app/brand.css` (colour tokens) and `lib/brand.ts` (strings: name, login
   headline/blurb/points, what a `Campus`/`Branch` is called) are the **only** brand-specific files.
3. *Theme without an inline script.* The choice lives in a `theme` cookie (`dark` | `light`, default
   `dark` per the artifact). The root layout reads it (`cookies()`) and renders `<html data-theme=…>`, so
   the first paint is already correct — no flash, and **no inline `<script>`**, which is what makes the
   nonce-based CSP (0.5.B) possible. The toggle sets the cookie and the attribute.

**Deliberate deviations from the artifact, each for a stated reason** (all checked numerically):
- **Filled-button green is `#2A7F4F`, not `#2E8B57`.** White on `#2E8B57` is **4.25 : 1** — below the
  4.5 : 1 that WCAG AA requires for 14 px text. `#2A7F4F` is 4.94 : 1 (hover `#267349`, 5.78 : 1).
  `#2E8B57` stays for the logo mark and other non-text accents (3 : 1 is enough there). Octalve's
  `#4F46E5` is 6.29 : 1 and needs no change.
- **Muted text is `#94a3b8` in dark and `#5b6b82` in light**, not the artifact's `#64748b` — which is
  3.75 : 1 on the dark surface and 4.34 : 1 on the light input background. (The same class of defect the
  0.5.1 verification found in the first build's `slate-500`.)
- **Dead controls are omitted, not drawn.** The artifact's top-bar search box and notification bell
  (with a hard-coded "3" badge) have nothing behind them; shipping them would be a lie. They arrive
  with the features that back them. "Users" and "Settings" show as *soon* until they exist.
- **"Keep me signed in" is real.** Unchecked → a browser-session cookie and a 12-hour absolute lifetime;
  checked → the existing 30-day idle / 90-day absolute policy (7 days for admins). (Shorter by default
  than the first build — the right default for a shared school computer.)
- The artifact's "First time on this instance? Run the setup wizard at /setup" line is omitted: the
  wizard disables itself, and `/login` already redirects to it while it is still needed.
- Typeface stays Geist (self-hosted via `next/font`); the artifact's system-font stack is the canvas
  tool's default, not a brand decision. Arabic/RTL UI is out of scope until the school asks for it.

**Scope by repo.** Tokens, theme, brand files and the re-skinned sign-in / setup / dashboard land in
both. The **app shell** (sidebar, top bar, mobile tab bar, More sheet) lands in AlEemaan now — it has
real admin pages (branches) to put in it — and in Octalve Edu with §0.5.2, when tenant routing gives it a
`/schools/[code]/…` to wrap. Octalve Edu's `Campus` is what the artifact draws as "Branches".

**Verification.** axe-core WCAG 2.2 AA on every screen and state **in both themes**; theme persistence
across reloads (cookie, no flash); toggle keyboard/aria; tap targets; no horizontal scroll; and
screenshots of the real flow at desktop and phone sizes, read by a human.

**"Keep me signed in on this device" — exact semantics** (designed before it is built).
- *Wire.* `POST /api/v1/auth/login` takes an optional `remember` — a strict boolean, **default `false`**
  (the least-privilege default for API callers too). Any other type fails validation and gets the same
  401 as every other malformed body, so the validation rules stay unprobeable.
- *Not remembered* (`false`): the cookie carries **no `Expires`/`Max-Age`** (a browser-session cookie) **and**
  the server caps the session at **12 hours** (`SESSION_ONLY_MAX_AGE_SECONDS`), idle and absolute alike.
  The server cap is the real bound: browsers that "continue where you left off" restore session cookies
  across restarts, so "closing the browser" alone can't be relied on to end a session.
- *Remembered* (`true`): exactly today's policy — 30-day sliding idle, 90-day absolute, 7-day absolute for
  anyone holding an ADMIN membership — and a persistent cookie expiring at the absolute cap.
- *Admin rule composes.* The applicable absolute cap is `min(mode cap, 7 days if ADMIN)`, so an admin who
  doesn't tick the box still gets 12 hours.
- *No schema change.* `Session.expires` / `absoluteExpires` already differ per row; sliding the idle
  expiry is already clamped to `absoluteExpires`, so a 12-hour session can never be extended past 12 hours.
- *UI.* An unchecked-by-default native checkbox with a visible label (as drawn), keyboard-operable, ≥ 44 px
  hit area; the value is sent as `remember` and nothing about it is persisted client-side.
- *Tests.* Unit/integration on `createSession` (each mode × admin/non-admin, sliding is clamped);
  API on `Set-Cookie` attributes per mode and on the strict boolean; browser test that ticking the box
  yields a persistent cookie (`expires > now`) and not ticking yields a session cookie (`expires === -1`);
  the same pair over real HTTPS for the `__Host-` cookie; and mutation checks (ignore `remember`, flip the
  default, keep the cookie session-only but leave a 90-day row) — each must fail the suite.

**As built (2026-09-30)** — the full record is `phases/phase-0.5.A-design-language.md`. Where the build
refined or departed from the design above, and why:
- *The checkbox is drawn, not native.* A native one is a 13–16 px target (the repo's own ≥ 44 px phone rule
  measures the `<input>`) and unbranded, so `CheckboxField` keeps a real `<input>` in a real `<label>` and
  draws the box, with measured contrast (outline 6.96 : 1 dark / 5.43 : 1 light; checked fill 8.96 : 1 /
  7.90 : 1; tick 10.1 : 1 / 7.55 : 1) and an invisible 44 × 44 px input over it.
- *`remember` defaults to false at **both** layers* — the API and `createSession()` — so a future caller
  (password-reset sign-in, MFA step 2) that forgets to say gets the short session, never the 90-day one.
  MFA's pending-challenge must carry the user's choice from step 1 to step 2 (0.5.D).
- *Every page is now dynamic* (the theme cookie is read in the root layout) — noted for 0.5.B, which needs
  exactly that.
- *`useSignOut()`* (a hook) now backs every sign-out control, so the header button, AlEemaan's account menu
  and its phone "More" sheet share one routine and one failure message.
- *Test-suite rules learned* (in `tests/README.md`): both themes on every screen; wait for CSS transitions
  and for the page `<title>` before an axe scan (two flakes, both test races); `test.skip(fn)` only at
  `describe` level; sign-in helpers take `remember` explicitly.

#### 0.5.B — Nonce-based script CSP (designed 2026-09-30, before any code)

**Why.** The baseline headers (0.5.1) stop framing, sniffing and referrer leaks but say nothing about *script*:
if an XSS bug ever ships, injected inline script runs with the session. A strict CSP makes that class of bug
inert — the browser refuses any script that doesn't carry this response's secret nonce. Same design in both
repos; both are already prepared for it (no inline `<script>`, theme via cookie, every page dynamic).

**Mechanism** (Next.js 16: `proxy.ts`, the renamed middleware).
1. A `proxy.ts` runs on every request except static assets (`/_next/static`, `/_next/image`, `favicon.ico`),
   mints a **128-bit random nonce** (`crypto.getRandomValues`, base64), builds the policy, and sets it on
   the **request** headers (so Next applies the nonce to its own bootstrap scripts) and on the **response**.
   Prefetch requests are skipped, as Next's guide does.
2. Policy (production):
   `default-src 'self'; script-src 'self' 'nonce-<n>' 'strict-dynamic'; style-src 'self' 'nonce-<n>';
   img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self';
   form-action 'self'; frame-ancestors 'none'` — and `upgrade-insecure-requests` **only when `APP_URL` is
   https** (on a plain-HTTP LAN install it would break every request). `'strict-dynamic'` lets the nonced
   bootstrap load Next's chunks without a host allow-list. **No `'unsafe-inline'`, no `'unsafe-eval'`** in
   `script-src`; development alone adds `'unsafe-eval'` (React's dev tooling needs it).
3. `frame-ancestors 'none'` moves from `next.config.ts` into the proxy so the policy has a single source;
   `X-Frame-Options`, `nosniff`, `Referrer-Policy` stay where they are. HSTS stays the reverse proxy's job.
4. **Rollout valve for a live school:** `CSP_REPORT_ONLY=true` sends the same policy as
   `Content-Security-Policy-Report-Only` (violations show in the browser console, nothing is blocked). The
   default is enforcing; the flag exists so an unforeseen violation in production can be diagnosed without
   an outage. There is deliberately **no report-collection endpoint** (extra unauthenticated surface).
5. **Styles.** Start strict (`style-src 'self' 'nonce-<n>'`, and no `style=""` attributes in our own markup —
   audited by grep and by the zero-violation test below). If Next's own output turns out to need inline style
   *attributes*, the fallback is `style-src-attr 'unsafe-inline'` alone (an attribute can't execute script) —
   recorded in the as-built note with the reason, never a blanket `'unsafe-inline'` on `style-src`.

**Verification.**
- *Shape:* every page and API response carries the policy; the directive set is exactly the above; the nonce
  is 128-bit base64, **different on every request**, present in the header and on every inline `<script>` in
  the HTML (and every inline script *has* it); no `unsafe-inline`/`unsafe-eval` in `script-src`;
  `upgrade-insecure-requests` present on the https deployment and absent on http; `frame-ancestors 'none'`
  survives; `CSP_REPORT_ONLY` flips the header name and nothing else.
- *It actually blocks:* in real Chromium, an injected inline `<script>` and an injected `onclick=` attribute
  do **not** run and raise a `securitypolicyviolation`; the page's own scripts do.
- *Zero violations everywhere:* the shared `page` fixture records `securitypolicyviolation` events and fails
  **any** test in which one occurred — so every existing flow (sign-in, setup, theme toggle, shell, …) is a
  CSP test for free, in both themes and on the https deployment.
- *Mutations (each must go red):* nonce dropped from the policy; `'unsafe-inline'` added; a constant nonce;
  nonce not forwarded on the request headers (Next's own scripts blocked); `upgrade-insecure-requests`
  unconditional; the https-only rule inverted.

**Not in scope:** a CSP report endpoint, Trusted Types, SRI (no third-party scripts exist), and the public
marketing sites (Phase 5 decides their own policy).

**As built (2026-09-30/10-01)** — record: `phases/phase-0.5.B-csp.md`. `src/proxy.ts` mints the nonce and sets
the policy on request and response; `lib/security/csp.ts` builds it (pure, unit-tested). Where the build refined
the design: **(1)** the proxy's matcher excludes `/api` (Next's own guidance), so JSON responses get a *static*
`default-src 'none'; frame-ancestors 'none'` from `next.config.ts` instead — same effect, no per-request work;
static assets carry neither. **(2)** The strict style policy worked first time: Next emits no inline `<style>` and
no `style=""` attributes, so `style-src 'self' 'nonce-…'` needed no fallback. **(3)** Nothing reads an `x-nonce`
header, so none is set. **(4) A property worth knowing:** `'strict-dynamic'` trusts script *created by* trusted
script, and DevTools-evaluated code is exempt — so the protection is against **markup injection** (a
parser-inserted `<script>`, `onerror=`, `javascript:` link, injected `<base>`), which is what an XSS bug is; the
first draft of the injection tests used `page.evaluate(createElement("script"))`, the "attack" ran, and the test
was rewritten to splice the payload into the real server response instead. **(5) The auto-fixture works:** the
whole browser suite (≈250 tests, both themes, desktop and phone, https) passes with **zero** policy violations —
every flow is a CSP test.

#### 0.5.C — Password reset and change (designed 2026-09-30, before any code)

**Scope.** Forgotten-password recovery by email, and change-password for a signed-in person. Built in both
repos, same design. Nothing here can weaken 0.5.1: no new way to obtain a session, and every path that sets a
password uses the one 72-byte policy.

**Email transport** (`lib/email/`): one interface, three implementations chosen by `EMAIL_TRANSPORT` —
`resend` (uses `RESEND_API_KEY`, already in `.env.example`; `EMAIL_FROM` names the sender), `console` (prints the
message, link included, to the server log — development), and `file` (appends JSON lines to a path — what the
tests read as "the inbox"). Default: `resend` when a key is set, otherwise `console` **with a loud
production warning**. A send failure is logged, never shown to the requester (it would be an oracle).
Messages are plain text (accessible, nothing to track), branded from `lib/brand.ts`.

**Tokens.** 256-bit random, URL-safe; only the **SHA-256 hash** is stored (`PasswordResetToken`: `id`,
`userId` cascade, `tokenHash` unique, `createdAt`, `expiresAt` = 30 minutes, `usedAt`). One live token per
person: requesting a new one deletes the previous unused ones. Expired rows are removed on the next request
for that person and by the same purge that clears sessions (bounded growth). Additive migration only.

**Flow.**
1. `POST /api/v1/auth/forgot-password` `{ email }` — CSRF; rate-limited **per IP and per email, counting every
   request** (each can send mail — unlike login, success is not refunded); answers **200 with the same body
   whether or not the account exists**. To leave no timing oracle the lookup, token insert and email send run
   in Next's `after()` — the response is sent first, so its time doesn't depend on the account.
2. The email links to `/reset-password#token=…`. The token is in the **URL fragment**: never sent to the
   server, so it isn't in access logs or a `Referer`. The page (client) reads it, **removes it from the
   address bar** (`history.replaceState`), and asks for the new password (live policy feedback, as in setup).
3. `POST /api/v1/auth/reset-password` `{ token, password }` — CSRF; per-IP limit on failures; policy check;
   then **one transaction**: an `updateMany where usedAt is null and expiresAt > now` on the token's hash
   (count must be 1 — so the token is single-use even under concurrent requests), set the new hash, delete
   **every session** of that user (`revokeUserSessions`), delete their other reset tokens, write an audit row.
   Any invalid / expired / already-used token gets the same 400 message ("This link is invalid or has expired").
   Success does **not** sign the person in — they sign in with the new password (and, once 0.5.D exists,
   their second factor: a reset never bypasses or disables MFA). A "your password was changed" notice is emailed.
4. **Change password** — `POST /api/v1/auth/change-password` behind `withAuth`: `{ currentPassword,
   newPassword }`; the current password is verified in constant time and its failures are rate-limited per
   account; the new one must pass the policy and differ from the old; then the hash is replaced, **every
   other session is revoked (this one kept)**, an audit row is written and the notice emailed. UI: a
   "Password" card on the account page. The sign-in screen's "Forgot password?" link (drawn in the artifact,
   deliberately absent until now) appears with `/forgot-password`.

**Shared code.** The password rules currently inline in the setup route move to `lib/auth/password-policy.ts`
(`checkNewPassword`) so setup, reset and change cannot drift; screens use the shared `AuthShell` and
components, in both themes.

**Verification.** Unit: token generation/hash, policy. Integration: create/consume — only the hash stored,
expiry, single use, **20 concurrent consumes → exactly one wins**, sessions revoked, other tokens dropped. API:
identical response and status for known/unknown emails, the mail sent only for a known one (read from the
`file` transport), every rate limit, CSRF, the reset outcomes (success, bad/expired/used/replayed token, weak
or over-72-byte password with the reason), old password stops working and the new one works, change-password's
wrong-current / same-password / other-sessions-revoked-this-one-kept, statistical timing parity of
`forgot-password`. Browser: the whole journey (forgot → "inbox" → link → new password → sign in), the token
gone from the address bar, keyboard use, axe in both themes for the three new screens and their error states,
phone tap targets. **Mutations (each must go red):** store the raw token; drop the single-use condition; drop
the expiry check; don't revoke sessions; respond differently for unknown emails; drop each rate limit; put the
token in the query string; let change-password skip the current-password check.

**Not in scope:** SMS or security-question recovery (weaker than email), admin-initiated resets (with
Users/Settings), breached-password checking, and "active devices" (needs its own page).

**As built (2026-10-04)** — record: `phases/phase-0.5.C-password-reset.md`. As designed, with these refinements:
the password rule now lives in one function, `checkNewPassword()` (client-safe; setup, reset, change and the
live form feedback all call it); the limiter's window is its fixed 5 minutes, so limits are *per 5 minutes*
(forgot: 10 per IP, 3 per address; reset: 10 failures per IP, successes and typos refunded; change: 5 wrong
current passwords per account); the new `lib/email/` is plain `fetch` to Resend (no SDK dependency) with
`console` and `file` transports; `sendEmailQuietly()` never throws, because a send failure shown to the
requester would be an oracle; the notice and audit work runs in `after()` too; a reset also clears the browser's
session cookie. The never-used Auth.js `VerificationToken` table was dropped in the migration (replaced by
`PasswordResetToken`). The sign-in screen's "Forgot password?" link — drawn in the artifact — is now real.
Octalve Edu has no app shell until §0.5.2, so its Account page (profile + Password card) is a plain page
with an "Account" link in the header; AlEemaan's lives in the shell. Audit: Octalve Edu writes one row per
school the person belongs to; AlEemaan one row.

#### 0.5.D — TOTP two-step verification (designed 2026-09-30, before any code)

**Scope.** Optional per person for now: enrol an authenticator app, be challenged at sign-in, use recovery
codes, disable. (Requiring it for administrators, and step-up re-verification before sensitive Settings edits,
are policy layers that build on this and arrive with the Settings work.) Same design in both repos. Nothing
in `withAuth` changes — the second factor is enforced **at sign-in**, so a request either carries a full
session or none.

**The algorithm is implemented here, not imported:** RFC 6238 TOTP over HMAC-SHA1 (`node:crypto`), 6 digits,
30 s step, accepting the current step ±1 for clock drift, constant-time comparison, base32 (RFC 4648) secrets
of 160 bits — checked against the RFC's own published test vectors. (Security code is worth the ~60 lines to
own; the QR image is not — see below.)

**Storage.**
- `MfaCredential { userId (unique, cascade), secretEnc, confirmedAt?, lastUsedStep?, createdAt }`. The secret
  must be recoverable (unlike a password), so it is **AES-256-GCM encrypted at rest** with `MFA_ENCRYPTION_KEY`
  (32 bytes, base64) — a database leak alone yields no usable secrets. Enrolment **fails closed (503)** in
  production when the key is missing. An unconfirmed credential is not an active factor.
- `MfaRecoveryCode { userId, codeHash, usedAt }` — ten single-use codes (`xxxxx-xxxxx`, 50 random bits each
  from an unambiguous alphabet), stored as SHA-256 hashes, shown **once** at generation.
- `MfaChallenge { tokenHash, userId, remember, expiresAt, attempts }` — the *pending-MFA state* promised since
  §0.5.1. It is **not a session**: no cookie, invisible to `withAuth`. A 256-bit random token is returned in the
  JSON of sign-in step 1 (held in memory by the sign-in page only), stored hashed, valid 5 minutes, five
  attempts, single-use.

**Sign-in.** Step 1 (`POST /api/v1/auth/login`) is unchanged up to "password verified"; for a person with a
confirmed credential it then creates **no session** and returns `{ mfaRequired: true, challenge }` (the same
generic 401 as ever for a wrong password — MFA status is only revealed after the password is proven). Step 2
(`POST /api/v1/auth/login/mfa` `{ challenge, code }` or `{ challenge, recoveryCode }`): CSRF, rate limits (per
IP, per account, per challenge), verify, then — and only then — the shared "complete sign-in" routine used by
both steps rotates any presented session and creates the session **with the `remember` choice made in step 1**
(carried in the challenge; see 0.5.A), setting the cookie. **Replay protection:** a code for a step ≤
`lastUsedStep` is refused, and the step is recorded with a conditional `updateMany` so two simultaneous
submissions of the same code can't both win.

**Enrolment** (account page, "Two-step verification" card; every action needs a fresh password, and none needs
a second factor until one exists): `POST …/mfa/enroll` `{ password }` → generates and stores an unconfirmed
secret and returns the `otpauth://` URL plus the base32 key for manual entry; the page renders a **QR code
in the browser** (the `qrcode` package, dynamically imported, pinned — **never an online QR service; the secret
never leaves the device**) beside the manual key; `POST …/mfa/confirm` `{ code }` marks it confirmed, issues the
recovery codes, revokes the person's *other* sessions and emails a notice. `POST …/mfa/disable` `{ password,
code | recoveryCode }` removes everything, revokes other sessions, emails a notice. `POST …/mfa/recovery-codes`
`{ code }` replaces all recovery codes. The UI warns when two or fewer remain.

**Interplay.** Password reset (0.5.C) never touches MFA — after a reset the person still needs their second
factor. A person who has lost both authenticator and recovery codes is recovered by an operator: `pnpm
mfa:reset -- <email>` (a small, tested script; an admin UI comes with Users), which also writes an audit row.

**Screens.** Step 2 appears in place on the sign-in card: a numeric, `autocomplete="one-time-code"` field, a
"Use a recovery code instead" toggle, "Back", the same error/pause treatment as step 1. Enrolment and
management states on the account page. All in both themes, ≥ 44 px targets.

**Verification.** Unit: the RFC 6238 vectors, base32, ±1 window edges, encryption round-trip and tamper
detection (GCM auth failure), recovery-code format. Integration: challenge lifecycle (expiry, five attempts
then dead, single use, **no session exists until step 2 succeeds**), replay under concurrency, recovery-code
single use, disable. API: the two-step sign-in end to end (no `Set-Cookie` after step 1; wrong / reused / stale
codes; lock-out; `remember` honoured through the challenge; MFA users can't sidestep by presenting an old
cookie), enrol/confirm/disable/regenerate and their re-auth requirements, 503 without the key. Browser: enrol
with a code computed by the test, sign in with it, sign in with a recovery code, disable; axe in both themes
for every new state; keyboard use. **Mutations (each must go red):** accept ± several steps; skip the replay
check; store the secret in plaintext; create the session at step 1; let a challenge be reused or attempted
without limit; let a recovery code be reused; disable without the password; let password reset clear MFA; drop
the per-IP limit on step 2.

**Not in scope:** WebAuthn/passkeys and SMS codes (a later, separate design), trusted-device "remember for 30
days" (it would quietly weaken the factor), mandatory-MFA policy and step-up (Settings work), an active-devices
page.

**As built (2026-10-05)** — record: `phases/phase-0.5.D-totp-mfa.md`. As designed, with these refinements:
- **No key, no MFA — in every environment, not only production.** `MFA_ENCRYPTION_KEY` (32 bytes, base64) is
  required; without a valid one the account page says two-step verification isn't available, enrolment answers
  503 `MFA_UNAVAILABLE`, and sign-in step 2 answers the same *before* spending anything. There is deliberately
  no development fallback key — a baked-in default is the kind of thing that ships to production by accident.
- **Recovery codes are stored as keyed hashes (HMAC-SHA256), not plain SHA-256.** A code has 50 bits, so a
  stolen table of plain hashes could be ground through offline; the key lives in the environment, not the
  database. Both the AES key and the HMAC key are *derived* from the root key with HKDF (one root secret is never
  used raw for two purposes). The AES-GCM box carries the owner's user id as AAD, so a ciphertext copied onto
  another person's row fails to decrypt. Recovery codes are Crockford base32 (`XXXXX-XXXXX`, exactly 50 random
  bits); typing `o`/`i`/`l` still works.
- **The challenge spends an attempt *before* the code is checked**, atomically (a conditional increment), so
  twenty simultaneous guesses on one challenge get five checks, not twenty; a person holds at most five live
  challenges; and a password **reset or change deletes pending challenges** (a challenge is proof of the old
  password). A reset still never touches the second factor itself.
- **Limits on step 2:** per challenge 5 attempts; per **account 10 failures / 5 minutes across all challenges**
  (hard — the real bound for someone who knows the password and can mint challenges at will); per IP 30. A
  correct code is refunded; a malformed one (not 6 digits / not a recovery code) is a typo and is refunded too.
- **Confirming records the step it used**, so the very code that turned two-step verification on can't also sign
  in — the next code can (an authenticator shows it within 30 s). Confirming and turning off both sign the person
  out of their *other* devices and send a notice; so does a recovery-code sign-in and a recovery-code
  regeneration. Audit actions: `MFA_ENABLED`, `MFA_DISABLED`, `MFA_RECOVERY_CODE_USED`,
  `MFA_RECOVERY_CODES_REPLACED`, `MFA_RESET`.
- **One `completeSignIn()` creates every session from a sign-in** (rotate a presented session, admin cap,
  `remember`); step 1 and step 2 both call it. The browser-safe half of the code rules (`lib/auth/mfa/codes.ts`)
  has no `node:crypto`, so the screens check a code's *shape* with the same function the server uses.
- **The QR code is drawn in the browser** by the pinned `qrcode` package (dynamic import, `data:` PNG, always
  dark-on-white in both themes); the tests decode it with `jsqr` and check it encodes the key shown beside it.
  The secret is held in component state only — never storage, URL or cookie.
- **Operator recovery:** `pnpm mfa:reset -- <email>` (`scripts/mfa-reset.mjs`, plain Node + Prisma, tested as a
  child process) removes the factor, signs the person out everywhere and audits it.
- Small fix on the way: the signed-in header's "Sign out" button wrapped onto two lines on narrow phones; it is
  now icon-only below `sm` (the accessible name is unchanged).

#### 0.5.E — Account lifecycle extras (planned 2026-10-04; self-service half BUILT 2026-10-05 — invite/activate and deactivation wait for the Users pages)

Prompted by the question "what else would a Django/Djoser-style auth give us?". Mapping and decisions:
- **Built or designed already:** login/logout/current-user (0.5.1), password reset and change (0.5.C), two-step
  verification (0.5.D). **Deliberately not used:** token/JWT endpoints (revocable database sessions are a design
  decision), social login.
- **Invite & activate** (Djoser's activation flow, adapted): schools invite people; the email carries a
  single-use, hashed, short-lived link built on exactly the 0.5.C token machinery to set a first password.
  Arrives with the Users pages (self-signup for Octalve Edu's SaaS mode is a later, separate design).
- **Change email with confirmation:** the new address must prove it is reachable (a link to the NEW address),
  the old address is told, other sessions are revoked; reuses the token table with a `purpose` column.
- **Edit profile** (name) — trivial once the above exist; audited.
- **Active devices:** list sessions (user agent, last used — the columns already exist), revoke one or all
  others. Needs its own page.
- **Account deletion:** for a school this is an administrator *deactivation* (history must survive), not
  self-service; designed with the Users pages.

**Design for the self-service half (2026-10-05, written before any code).** Built now: *edit profile*, *change email
with confirmation* and *active devices*. **Deferred, deliberately:** *invite & activate* and *deactivation* — both are
administrator actions on other people and belong with the Users pages (they need a way to say who may invite whom,
which is §0.5.2's tenant-scoped roles). Same design in both repos.
- **Edit profile.** `PATCH /api/v1/account/profile { name }` behind `withAuth`: trimmed, inner whitespace collapsed,
  1–100 characters, no control characters; 10 changes per account per 5 minutes; audit `PROFILE_UPDATED` with
  before/after. The Profile card gets an Edit → Save/Cancel; the header and shell show the new name on refresh.
- **Active devices.** `GET /api/v1/auth/sessions` (this person's unexpired sessions: when created, last used, a short
  device description parsed from the stored user agent, `current`, and whether it was "kept signed in"), `POST
  …/sessions/revoke { sessionId }` (only the caller's own; the current one is refused — that is sign-out; a session
  that isn't theirs answers exactly like one that doesn't exist) and `POST …/sessions/revoke-others`. Rows are
  fetched by the page after it loads (so relative times use the viewer's clock and zone — no hydration mismatch). A
  revoked device finds out on its next request (the existing session revalidation sends it to sign-in). **No IP
  address is stored or shown** — no column exists and none is added for this (it is personal data; "last used 5
  minutes ago on Chrome / Windows" is enough to spot a stranger). Audit `SESSION_REVOKED` / `SESSIONS_REVOKED`.
- **Change email with confirmation.** `POST /api/v1/auth/email-change/request { newEmail, password }`: the current
  password is re-verified (5 wrong per account per 5 minutes, refunded on success), then — *whatever the address* —
  the answer is the same generic "we've sent a link to the new address" (an authenticated user must not be able to
  probe which addresses have accounts). If the address is free, a **single-use, hashed, 1-hour link in the URL
  fragment** goes to the NEW address and a notice (masked new address) to the OLD one; if it is already in use, that
  address gets a different notice ("someone asked to use this address; you already have an account here") and no
  link. Limits: per account and per target address, so it can't be used to mail-bomb. One live request per person.
  `POST …/email-change/confirm { token }` (public — the link is opened from a mail client, signed in or not):
  claims the token with a conditional update and, **in one transaction**, sets the new email (lower-cased,
  `emailVerified` now), deletes **every session** of the person, their pending password-reset links, MFA
  challenges and other email-change requests (the email is the recovery channel — nothing issued for the old one
  survives it); if the address was taken in the meantime the unique index refuses it and the answer is the same
  generic "link can't be used". The OLD address is told it happened; audit `EMAIL_CHANGE_REQUESTED` /
  `EMAIL_CHANGED` (before/after). New page `/confirm-email` (token read from the fragment and scrubbed,
  `referrer: no-referrer`, like `/reset-password`).
  *Deviation from the first sketch:* a **separate `EmailChangeToken` table** (it must carry the new address)
  rather than a `purpose` column on `PasswordResetToken`; same hash-only / single-use / conditional-claim machinery.
- **Tests (before the code).** unit: user-agent description, address masking. integration: the token lifecycle
  (hash at rest, 1 hour, one live per person, **20 simultaneous confirms → exactly one**, single use, expiry), the
  confirm transaction (email changed, all sessions / reset links / challenges / other requests gone, address taken
  meanwhile → refused and nothing changed), sessions listing/revoking scoped to the owner. api: every route's auth,
  CSRF and limits; generic answers for free / taken / own / malformed addresses (**identical bodies**); the right
  mail to the right inbox (new: link; old: notice; taken: notice, no link); the old address can no longer sign in
  and the new one can; revoking another person's session id answers like an unknown one. e2e: edit name; the whole
  email change (request → "inbox" → link → signed out → sign in with the new address); two devices, revoke one and
  watch it get signed out; revoke all others; axe in both themes on every state, phone tap targets.
  Mutations: link not single-use / not expiring / not hashed; sessions kept after the change; reset links kept;
  password not re-checked; the taken-address answer differing; notice to the old address missing; revoking someone
  else's session; revoking the current session; listing expired sessions; no limits; the IP-free promise (no new
  column).

**As built — self-service half (2026-10-05).** Built as designed, in both repos, with the deviations and findings below
(each was found by a test or a screenshot, not by inspection). Record: `phases/phase-0.5.E-account-self-service.md`.
- **What exists.** Migration `20261006090000_email_change_tokens` (one new table, purely additive). `lib/auth/`:
  `email-change.ts` (token + the confirm transaction), `session-devices.ts` (list / revoke one / revoke others),
  `profile-policy.ts` (`checkName` — the one name rule, client-safe), `user-agent.ts` (`describeUserAgent` — "Chrome on
  Windows" from a fixed list of patterns, only ever rendered as text), `mask-email.ts` (`a***@school.example` for the
  notices). Routes: `PATCH /api/v1/account/profile`, `GET /api/v1/auth/sessions`, `POST …/sessions/revoke`,
  `POST …/sessions/revoke-others`, `POST …/email-change/request`, `POST …/email-change/confirm`. UI: the account page now
  has **Profile** (name editable in place), **Email address**, Password, Two-step verification and **Active sessions**
  cards; a new public page `/confirm-email`. Four emails: the link (to the new address), a "change requested" notice and a
  "changed" notice (both to the old address, new address masked), and a "someone tried to use your address" notice (to an
  address that already has an account).
- **The confirm page never acts on arrival.** The link opens a page that says what will happen and waits for a click:
  mail clients and security scanners open links (some run scripts) to preview them, and a page that spent the
  single-use token on load would be consumed before the person saw it. (Tested: no request is made until the button is
  pressed.) Like `/reset-password`, the token comes from the URL fragment, is removed from the address bar at once, and
  the page sends `referrer: no-referrer`.
- **Deviation 1 — where the per-account request limit sits.** The design said "limits per account and per target
  address". Written first, the account limit (3) was spent *before* the password was checked, so three typos locked the
  person out and the 5-wrong-passwords limit could never trigger. Now: the password limit (5, refunded for anything but a
  wrong password) comes first; the request limit (3 per 5 minutes) is counted only for a *verified* request, so it bounds
  the mail one signed-in person can cause without being spent by guesses. Found while writing the API tests.
- **Deviation 2 — the password field is labelled "Your password"**, not "Current password": the Password card on the same
  page already has a field with that label, and two identically-labelled fields on one page confuse screen-reader users
  and password managers. Found by a strict-mode locator clash in the first browser test.
- **Finding — a second link in the same tab was ignored** (here and, since 0.5.C, on `/reset-password`): pasting a
  link whose URL differs only in the `#fragment` is a same-document navigation, so the page kept the first link's state
  (including "done"). The fragment reading is now one hook, `components/auth/useFragmentToken.ts`, that also listens
  for `hashchange` and returns a `version`; both pages key their state on it, so every link starts clean (even the same
  link opened again). Tested on both pages.
- **Finding — focus after an awaited save.** Returning focus with a 0 ms timer loses to React's commit after an `await`
  (it worked on Cancel, a click handler, and failed on Save). Focus now moves in an effect that runs after the commit;
  the email panel does the same when it returns to its first state.
- **Notes.** "Active" times are approximate — `lastUsedAt` is only written when it is more than 5 minutes stale
  (existing behaviour, `TOUCH_INTERVAL_MS`). The change-email notice goes to the old address *before* the audit and the
  token (all in `after()`), so a failure later still tells the person. Octalve's audit writes one row per school the person
  belongs to and none for a person with no school (as since 0.5.C); AlEemaan writes one row. `withAuth` routes answer
  `Cache-Control: private, no-store`, the public confirm route `no-store` (the tests assert both exactly).
- **Not done, deliberately:** *invite & activate* and administrator *deactivation* (they act on other people and need the
  Users pages / tenant-scoped roles of §0.5.2); a "new sign-in from an unrecognised device" notice; showing a device's IP
  or location (none is stored); an administrator changing someone else's email; self-service account deletion (a school
  deactivates, history must survive).
- **Verification.** `pnpm test`: 740 passed, 5 skipped by design, 0 failed (it was 622); `tsc`, ESLint and `next build` clean; **78 injected bugs, all caught** (one equivalent mutant removed as dead code, one non-compiling mutation redone). Details in the phase record.

---

#### 0.5.F — Dev tooling: a dev email inbox now, a mock Paystack with Finance (planned 2026-10-05; inbox half BUILT 2026-10-05 — the Paystack half waits for Finance)

**Source.** The maintainer's guide *"Development Email System & Dual-Mode Paystack Integration"* (a pattern already
used locally and on a staging deploy of another project). It has two halves: (1) an in-app **dev email inbox** —
when no real mail key is set, outgoing mail is captured in a 50-message ring buffer bound to `globalThis` (so HMR
doesn't wipe it) and shown in a floating widget; (2) a **dual-mode Paystack engine** — a `PaymentTransaction` table, a
REST client (Naira ↔ kobo only at the HTTP boundary, HMAC-SHA512 over the *raw* body with `timingSafeEqual`), a
**mock checkout** that fires genuinely signed webhooks at our own handler (no tunnels, no test cards), and one atomic
`fulfillPayment(reference)` — `updateMany({ where: { reference, status: 'PENDING' } })` as the lock — called by both
the webhook and the browser's return page, so the redirect-beats-webhook race resolves to exactly one fulfilment;
the amount is re-checked against Paystack's verify call (< ₦0.01 tolerance). The architecture is adopted; the
details below are what had to change to fit *these* repos.

**Where each half lands.**
- **The dev inbox → a fourth email transport, `inbox`,** in `lib/email/transport.ts` (beside `resend` / `console` /
  `file`), plus `GET`/`DELETE /api/v1/dev/email-inbox` and a floating widget on the layout. It is the natural next
  small step: reset links and the 0.5.D notices become visible locally *and* on a staging deploy with no mail
  provider. Our messages are plain text, so the widget shows text — it never injects HTML.
- **The Paystack engine → the Finance phase (M2).** It needs the fee/invoice models it fulfils (`PaymentTransaction`
  gains a `tenantId` in Octalve Edu — RLS, §0.5.2 — or a branch in AlEemaan), so it is *designed* here and *built*
  there, with the guide as the reference.

**Changes the guide needs before it is safe here** (each becomes a test):
1. **The gate must fail closed.** The guide's `devToolsEnabled()` is `VERCEL_ENV !== 'production'`. On any host that
   is not Vercel — our self-hosted Solo installs and AlEemaan's live school — `VERCEL_ENV` is unset, so the gate is
   **open in production**, and (with the mock) a missing `PAYSTACK_SECRET_KEY` would silently turn the system into
   one that accepts free "payments". Replace it with an explicit opt-in: dev tools are on only when `DEV_TOOLS=true`
   **and** `APP_ENV` is `development` or `staging`; an unset `APP_ENV` under `NODE_ENV=production` is production.
   Production **never** enables them, and a missing `PAYSTACK_SECRET_KEY` in production is a hard `PAYSTACK_NOT_CONFIGURED`,
   never a fallback to the mock. A unit test walks the whole environment matrix.
2. **The inbox must not be public on a reachable staging URL.** It is unauthenticated in the guide — but a reset link
   or a recovery-code notice in it is an account takeover for anyone who finds the URL. It cannot just require a
   session (password reset happens signed out). On `development` (localhost) it stays open; on `staging` it requires
   `DEV_TOOLS_TOKEN`, entered once in the widget. Both routes answer 404 when tools are off.
3. **No `dangerouslySetInnerHTML`.** Plain text only here; if HTML mail is ever added, render it in a
   `sandbox`ed `srcdoc` iframe. The widget must also pass our nonce CSP (no inline script/style) and axe, in both themes.
4. **CSRF uses our `validateCSRF()`.** The guide's `origin.includes(host)` is a substring test (`evil-localhost:3000.com`
   passes it).
5. **The webhook keeps the guide's discipline** — raw body first, constant-time signature check, 200 even when
   fulfilment throws — and gains our limiter. `GET …/status` runs `fulfillPayment` (a side effect behind an
   unauthenticated GET that makes an outbound Paystack call per request), so it is rate-limited per IP and per reference.
6. **Money stays `Decimal` Naira everywhere**; kobo exists only inside `lib/paystack.ts`.

**Tests this implies (written before the code, like every phase):** the gate matrix; inbox ring buffer (50 cap,
survives a simulated reload, newest first); routes 404 when off and token-gated on staging; an email containing
`<script>`/`<img onerror>` renders inert; the `inbox` transport selected by default only when tools are on;
and, with Finance: a signature computed over a *re-stringified* body is refused, 20 simultaneous `fulfillPayment`
calls produce exactly one fulfilment, an amount mismatch throws, the mock cannot be reached or used in production,
and the mock's self-webhook goes through the real handler.

**Build order:** the `inbox` transport + widget first (small; both repos; after 0.5.D); the Paystack engine with Finance.

**Design for the inbox half (2026-10-05, written before any code; approved to build next, ahead of §0.5.E).**
- **The gate** — `lib/dev-tools.ts`, pure and unit-tested over the whole environment matrix. `appEnv()` is
  `APP_ENV` if it is exactly `development` / `staging` / `production` (case-insensitive), else `production` when
  `NODE_ENV=production` **or `VERCEL_ENV=production`**, else `development`; **any unrecognised value is production**
  (fail closed — `prod`, a typo, an empty string under `next start`). `devToolsEnabled()` is false in production
  always (even with `DEV_TOOLS=true` and a token); in `staging` it needs `DEV_TOOLS=true` **and** a non-empty
  `DEV_TOOLS_TOKEN` (no token → off, not open); in `development` it is on unless `DEV_TOOLS=false`. `next start`
  forces `NODE_ENV=production`, so a deployed server is production unless `APP_ENV` says otherwise on purpose.
- **The store** — `lib/dev/email-inbox.ts`: newest-first ring buffer of 50 on `globalThis.__devEmailInbox` (survives
  HMR), each message `{ id, to, subject, text, sentAt }`, text capped at 20 KB. Per process, so it works for a
  long-lived server (local, Solo, single-instance staging) and **not** across serverless instances — said so in the docs.
- **The transport** — `inbox`, a fourth `EmailTransport`. `EMAIL_TRANSPORT` always wins; unset → `resend` if
  `RESEND_API_KEY`, else `inbox` if dev tools are on, else `console` (with the existing production warning).
  Choosing `inbox` explicitly while dev tools are off is an error (the send fails loudly in the log, never
  silently into a buffer nobody can read). It also prints one line (`[EMAIL → to] subject — captured in the dev
  inbox`) — never the body, so a reset link doesn't land in the log.
- **The routes** — `GET`/`DELETE /api/v1/dev/email-inbox`: **404** when tools are off (a plain 404 in the standard envelope); in `staging`, header `x-dev-tools-token` compared in constant time (hash-then-`timingSafeEqual`),
  wrong/missing → 401, five wrong in 5 minutes per IP → 429; `DELETE` also needs `validateCSRF()`; every response
  `no-store`. `development` is open (it is your own machine).
- **The widget** — `components/dev/DevEmailInbox.tsx` (client), mounted from the root layout only when the gate is
  on: a launcher bottom-right with an unread count, a dialog (list → message), live refresh every 4 s while
  authorised, a token form on 401 (kept in `sessionStorage`, best-effort), a "DEV" badge so it is never mistaken
  for product UI. The body is rendered as **text** (`white-space: pre-wrap`); every `http(s)` URL in it is also
  offered as a real link (so a reset link is one click). Escape closes and returns focus to the launcher; ≥ 44 px
  targets; both themes; no inline script or style (nonce CSP).
- **Tests (before the code).** unit: the gate matrix; the buffer (cap, order, cap on text, lives on `globalThis`).
  integration: transport selection matrix; the routes in-process (404 when off — including `DEV_TOOLS=true` in
  production; open in development; token + rate limit + CSRF in staging; prefix-of-token fails). api + e2e against a
  **third server in staging mode** (`:3102`, token set, `EMAIL_TRANSPORT` unset): forgot-password → the mail is in
  the inbox → the link works; the main servers 404 and show no launcher; a message containing `<script>` /
  `<img onerror>` renders inert; axe in both themes for the launcher, token form, list and message; focus return.
  Mutations: gate open in production; token unchecked / prefix-compared; DELETE without CSRF; no 404 when off;
  `inbox` as the production default; body rendered as HTML; buffer uncapped; log line printing the body.

**As built — inbox half (2026-10-05)** — record: `phases/phase-0.5.F-dev-email-inbox.md`. As designed, with these
refinements the build itself forced:
- **One decision, not two functions.** The first draft had `devToolsEnabled()` and a separate `devToolsToken()`
  that returned `null` for *both* "no token needed" and "staging with no token configured" — a caller reading
  `null` as "open" would have failed open. A sweep over all 1,344 combinations of `APP_ENV` / `NODE_ENV` /
  `VERCEL_ENV` / `DEV_TOOLS` / `DEV_TOOLS_TOKEN` found it. There is now one `devToolsAccess()` returning `off`,
  `open` or `{ token }` (and `devToolsEnabled()` is just "not off"); the route switches on it.
- **A fourth test server.** The same build in `APP_ENV=staging` with the tools on, a token and *no*
  `EMAIL_TRANSPORT`; the other three servers pin `APP_ENV=production` regardless of a developer's own `.env` and
  the specs assert they 404 the route and render no launcher.
- **The launcher is bottom-right**, not bottom-left: AlEemaan's admin shell has a left sidebar and Next's own dev
  indicator lives bottom-left. On phones it sits above the tab bar.
- **Two UX bugs the browser tests caught.** Clicking "Back to the list" unmounted the focused button, focus fell
  to `<body>`, and Escape then did nothing — focus now goes to the dialog heading (to the Back button when a
  message opens), and Escape listens on the document while the dialog is open. The "unread" memory lived in
  component state and reset on every full page load (the widget remounts per navigation); it is now kept in
  `sessionStorage` for the tab.
- Message bodies are text (`white-space: pre-wrap`); every `http(s)` URL in a body is also offered as a link,
  and a `javascript:` URL can never become one. The route answers a plain 404 in the standard envelope when the
  tools are off (not byte-identical to an unmatched path — the route's existence isn't a secret).
- **Not built, by design:** HTML rendering, persistence across restarts or instances (it is process memory), and
  the Paystack half — that waits for Finance.

## Phase 1 — MVP: Core SIS + Finance

Matches PRD §5/§6's MVP scope exactly. Two new schema files, `prisma/schema/sis.prisma` and
`prisma/schema/finance.prisma` (multi-file schema mode, same convention `ims` uses).

### 1.1 — Retrofit into Phase 0's `Tenant`

```prisma
enum SchoolType {
  K12
  HIGHER_ED
  VOCATIONAL
}
```

Add `schoolType SchoolType` to `Tenant` — decides whether `AcademicPeriod` below means "term"
(K12), "semester" (HIGHER_ED), or "cohort with no fixed calendar" (VOCATIONAL), per PRD §3's
decision to support all three school types from day one.

### 1.2 — `sis.prisma`

**`AcademicSession` / `AcademicPeriod` — two levels, not one flat "Term" table.**

```prisma
model AcademicSession {
  id        String   @id @default(cuid())
  tenantId  String
  label     String            // "2026/2027"
  startDate DateTime
  endDate   DateTime
  isCurrent Boolean  @default(false)

  tenant Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  terms  AcademicPeriod[]

  @@index([tenantId])
}

enum PeriodKind {
  TERM      // K12: 1st/2nd/3rd term
  SEMESTER  // HIGHER_ED
  COHORT    // VOCATIONAL: a running cohort, no fixed term boundary
}

model AcademicPeriod {
  id        String     @id @default(cuid())
  tenantId  String
  sessionId String
  kind      PeriodKind
  label     String     // "1st Term", "Semester 1", "Cohort — Jan 2027 Intake"
  startDate DateTime
  endDate   DateTime?  // nullable for COHORT — no fixed end at creation
  isCurrent Boolean    @default(false)

  tenant  Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  session AcademicSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([sessionId])
}
```

**Why two levels (Decision, PRD §14):** the billing-cycle setting (per-term vs. per-session) has to
bill against *either* a whole session or one period — `Invoice.periodId` needs a foreign key that's
meaningful at both grains, which a single flat table can't give without picking one grain up front
and being wrong for the other setting value.

**`ClassGroup` / `ClassArm` — capacity lives on the arm, not the group.**

```prisma
model ClassGroup {
  id       String @id @default(cuid())
  tenantId String
  campusId String?
  name     String  // "JSS1", "Year 10", "Cohort A"

  tenant Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  campus Campus?    @relation(fields: [campusId], references: [id], onDelete: SetNull)
  arms   ClassArm[]

  @@index([tenantId])
}

model ClassArm {
  id           String @id @default(cuid())
  classGroupId String
  name         String // "A", "B"
  capacity     Int?   // null = uncapped

  classGroup  ClassGroup          @relation(fields: [classGroupId], references: [id], onDelete: Cascade)
  enrollments StudentEnrollment[]

  @@index([classGroupId])
}
```

**Why (Decision, PRD §5/§14 "class capacity/streaming — manual for MVP, Settings-ready"):**
"JSS1 is full" isn't a real statement — "JSS1-A is full" is. Putting `capacity` on the arm now
means the future auto-assign-on-capacity feature needs zero schema migration when it ships; MVP
just never reads the field for automation, only for display.

**`Subject`, `StaffRecord`, `StaffSubjectAssignment` — staff record ≠ staff account.**

```prisma
enum StaffCategory {
  TEACHING
  NON_TEACHING
}

model Subject {
  id       String @id @default(cuid())
  tenantId String
  name     String
  code     String?

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
}

model StaffRecord {
  id        String        @id @default(cuid())
  tenantId  String
  campusId  String?
  userId    String?       @unique  // nullable — a record does not require an account (PRD §5/§7)
  category  StaffCategory
  firstName String
  lastName  String
  phone     String?
  email     String?
  isActive  Boolean       @default(true)

  tenant Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  campus Campus? @relation(fields: [campusId], references: [id], onDelete: SetNull)
  user   User?   @relation(fields: [userId], references: [id], onDelete: SetNull)

  subjectAssignments StaffSubjectAssignment[]

  @@index([tenantId])
}

model StaffSubjectAssignment {
  id            String @id @default(cuid())
  staffRecordId String
  subjectId     String
  classArmId    String

  staffRecord StaffRecord @relation(fields: [staffRecordId], references: [id], onDelete: Cascade)
  subject     Subject     @relation(fields: [subjectId], references: [id], onDelete: Cascade)
  classArm    ClassArm    @relation(fields: [classArmId], references: [id], onDelete: Cascade)

  @@unique([staffRecordId, subjectId, classArmId])
}
```

**Why `userId` is nullable *and* `@unique` (Decision, PRD §5/§7):** this is the field that makes
"staff records vs. staff accounts" a real constraint, not just prose — a security guard gets a
`StaffRecord` with `userId: null` forever; a teacher gets one, then an admin action sets `userId`
once (never twice, hence `@unique`) when an account is provisioned.

**`StudentRecord` — no NIN/BVN field, ever, without a named exception.**

```prisma
model StudentRecord {
  id          String  @id @default(cuid())
  tenantId    String
  campusId    String?
  userId      String? @unique
  firstName   String
  lastName    String
  dateOfBirth DateTime
  admissionNo String   // school-assigned, human-facing — never used as a URL/lookup key
  isActive    Boolean  @default(true)

  tenant Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  campus Campus? @relation(fields: [campusId], references: [id], onDelete: SetNull)
  user   User?   @relation(fields: [userId], references: [id], onDelete: SetNull)

  enrollments   StudentEnrollment[]
  guardianLinks GuardianLink[]
  attendance    AttendanceRecord[]
  results       Result[]
  invoices      Invoice[]

  @@unique([tenantId, admissionNo])
  @@index([tenantId])
}
```

**Why no national-ID field (Decision, PRD §9, closes Audit #3/#7):** data minimization isn't a
policy statement if the schema has a `nin` column sitting there "just in case." There isn't one.
`admissionNo` is unique per tenant only (not globally), and every lookup route resolves a student
through the authenticated/authorized path (Phase 0.5), never through `admissionNo` in a URL —
closes Audit #27 (predictable export/lookup URLs) at the data-access-pattern level, not just the
URL-signing level.

**`StudentEnrollment` — the year-end-rollover model.**

```prisma
enum EnrollmentStatus {
  ACTIVE
  PROMOTED
  REPEATED
  WITHDRAWN
  TRANSFERRED
  ALUMNI
}

model StudentEnrollment {
  id         String           @id @default(cuid())
  studentId  String
  classArmId String
  periodId   String
  status     EnrollmentStatus @default(ACTIVE)

  student  StudentRecord @relation(fields: [studentId], references: [id], onDelete: Cascade)
  classArm ClassArm      @relation(fields: [classArmId], references: [id], onDelete: Cascade)

  @@unique([studentId, periodId])
}
```

**Why this is *the* rollover implementation (Decision, PRD §5/§6):** rollover is "close the current
`ACTIVE` enrollment with an outcome status, create a new row in the next period" — one function,
called either by a scheduled job (`SchoolSettings.rolloverMode = AUTOMATIC`) or an admin
click-through (`ADMIN_CONFIRMED`). The setting changes *which code path calls the function*, never
the data model — this is what "the state machine isn't optional, only whether it's automatic is"
(PRD §5) means concretely.

**`GuardianLink` — the fix for the audit's most-cited AuthZ finding.**

```prisma
enum GuardianLinkStatus {
  PENDING
  APPROVED
  REVOKED
}

model GuardianLink {
  id               String             @id @default(cuid())
  studentId        String
  guardianUserId   String
  status           GuardianLinkStatus @default(PENDING)
  approvedByUserId String?
  linkingCodeUsed  String?
  createdAt        DateTime           @default(now())

  student      StudentRecord @relation(fields: [studentId], references: [id], onDelete: Cascade)
  guardianUser User          @relation("GuardianOf", fields: [guardianUserId], references: [id], onDelete: Cascade)

  @@unique([studentId, guardianUserId])
  @@index([studentId])
}
```

**Why (closes Audit #12/#15, SEC-001/SEC-005 directly):** application code can only ever `INSERT` a
`GuardianLink` as `PENDING` from a self-service request — no code path lets a parent create their
own `APPROVED` row. A separate admin action or one-time linking-code redemption is the *only* way
`status` becomes `APPROVED`. Every parent-facing query joins through
`GuardianLink WHERE status = 'APPROVED'`, never a bare `studentId` lookup — this is what makes
Abuse Case 1 from the audit (self-link by guessing an admission number) actually impossible rather
than just discouraged.

**`AttendanceRecord` — carries the offline-sync provenance flag.**

```prisma
enum AttendanceStatus {
  PRESENT
  ABSENT
  LATE
  EXCUSED
}

enum AttendanceSource {
  ONLINE
  OFFLINE_SYNC
}

model AttendanceRecord {
  id              String   @id @default(cuid())
  studentId       String
  classArmId      String
  date            DateTime @db.Date
  status          AttendanceStatus
  markedByStaffId String
  markedAt        DateTime @default(now())
  source          AttendanceSource @default(ONLINE)

  student StudentRecord @relation(fields: [studentId], references: [id], onDelete: Cascade)

  @@unique([studentId, classArmId, date])
  @@index([classArmId, date])
}
```

**Why `source` exists (closes Audit #8, Abuse Case 2):** an `OFFLINE_SYNC` row is one that arrived
through the sync endpoint, not a live request — lets the audit trail and any anomaly detection
distinguish "marked live" from "marked offline, synced later" without a second table. The sync
endpoint itself re-runs the exact same authorization + business-rule checks as the online path
(same `withAuth`/`forTenant()` machinery from Phase 0.5) — there is no separate, weaker "offline
write" code path for an attacker to find.

**`Result` / `ResultAudit` — the state machine from PRD §5, made real.**

```prisma
enum ResultStatus {
  DRAFT
  SUBMITTED
  APPROVED
  PUBLISHED
  LOCKED
}

model Result {
  id                String       @id @default(cuid())
  studentId         String
  subjectId         String
  periodId          String
  score             Decimal
  maxScore          Decimal      @default(100)
  status            ResultStatus @default(DRAFT)
  enteredByStaffId  String
  approvedByStaffId String?
  publishedAt       DateTime?
  lockedAt          DateTime?

  student StudentRecord @relation(fields: [studentId], references: [id], onDelete: Cascade)
  subject Subject       @relation(fields: [subjectId], references: [id], onDelete: Cascade)
  history ResultAudit[]

  @@unique([studentId, subjectId, periodId])
  @@index([periodId])
}

model ResultAudit {
  id          String        @id @default(cuid())
  resultId    String
  actorUserId String
  fromStatus  ResultStatus
  toStatus    ResultStatus
  fromScore   Decimal?
  toScore     Decimal?
  reason      String?
  createdAt   DateTime      @default(now())

  result Result @relation(fields: [resultId], references: [id], onDelete: Cascade)

  @@index([resultId])
}
```

**Why (closes Audit #11, SEC-003):** every status transition writes a `ResultAudit` row in the same
transaction as the `Result.status` change. `reason` is enforced as non-null at the application
layer for any transition originating from `LOCKED` — the DB column stays nullable (a
`DRAFT → SUBMITTED` transition genuinely has no "reason") but the API route for a post-lock
correction rejects a missing reason before it ever reaches Prisma.

**`TimetableSlot`, `Announcement` — straightforward, no audit-driven decisions.**

```prisma
model TimetableSlot {
  id            String @id @default(cuid())
  classArmId    String
  subjectId     String
  staffRecordId String
  dayOfWeek     Int    // 0–6
  startTime     String // "08:00" — a recurring weekly pattern, not a dated event, hence not DateTime
  endTime       String

  classArm ClassArm @relation(fields: [classArmId], references: [id], onDelete: Cascade)
  subject  Subject  @relation(fields: [subjectId], references: [id], onDelete: Cascade)

  @@index([classArmId])
}

model Announcement {
  id              String   @id @default(cuid())
  tenantId        String
  classArmId      String?  // null = school-wide
  title           String
  body            String
  createdByUserId String
  createdAt       DateTime @default(now())

  tenant   Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  classArm ClassArm? @relation(fields: [classArmId], references: [id], onDelete: SetNull)

  @@index([tenantId])
}
```

### 1.3 — `SchoolSettings` (PRD §14) and its step-up-auth audit trail

```prisma
enum BillingCycle          { PER_TERM  PER_SESSION }
enum RolloverMode          { AUTOMATIC  ADMIN_CONFIRMED }
enum DiscountWorkflowMode  { MANUAL_OVERRIDE  APPROVAL_REQUIRED }
enum FeeCostBearer         { SCHOOL_ABSORBS  PASSED_TO_PARENT }

model SchoolSettings {
  tenantId               String              @id  // one row per tenant, by construction
  resultApprovalRequired Boolean              @default(true)  // secure default
  rolloverMode           RolloverMode         @default(ADMIN_CONFIRMED)
  classAutoAssignment    Boolean              @default(false) // MVP: always false; field exists for later
  billingCycle           BillingCycle         @default(PER_TERM)
  feeReminderEnabled     Boolean              @default(true)
  discountWorkflowMode   DiscountWorkflowMode @default(MANUAL_OVERRIDE)
  feeCostBearer          FeeCostBearer        @default(SCHOOL_ABSORBS)
  multiCampusEnabled     Boolean              @default(false)
  mfaRequiredForTeaching Boolean              @default(true)

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
}

model SettingsChangeAudit {
  id               String   @id @default(cuid())
  tenantId         String
  actorUserId      String
  field            String
  fromValue        String
  toValue          String
  stepUpVerifiedAt DateTime // MFA re-confirmation timestamp for THIS change — PRD §7/§14
  createdAt        DateTime @default(now())

  @@index([tenantId])
}
```

**Why `tenantId` is the primary key, not a separate `id` (Decision):** exactly one settings row
exists per school by definition — making the tenant FK the PK rules out ever accidentally creating
two, rather than relying on a `@unique` constraint someone could theoretically bypass with raw SQL.

**Why `SettingsChangeAudit` is separate from the general `AuditLog` (below), not a variant of it
(Decision, closes Audit #22):** every settings change specifically requires `stepUpVerifiedAt` to
be non-null — a column-level guarantee a generic polymorphic audit table can't enforce. The API
route for changing any `SchoolSettings` field is the only place allowed to write to this table, and
it does so *before* applying the actual settings change, not after — a step-up check that fails
never lets the underlying toggle flip.

### 1.4 — `finance.prisma`

```prisma
model FeeStructure {
  id           String  @id @default(cuid())
  tenantId     String
  periodId     String
  classGroupId String? // null = applies to all classes
  name         String  // "Tuition", "Sports Levy"
  amount       Decimal

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
}

enum InvoiceStatus { UNPAID  PARTIALLY_PAID  PAID  WAIVED }

model Invoice {
  id          String        @id @default(cuid())
  tenantId    String
  studentId   String
  periodId    String
  totalAmount Decimal
  amountPaid  Decimal       @default(0)
  status      InvoiceStatus @default(UNPAID)
  createdAt   DateTime      @default(now())

  student   StudentRecord     @relation(fields: [studentId], references: [id], onDelete: Cascade)
  payments  Payment[]
  discounts InvoiceDiscount[]

  @@index([studentId])
  @@index([tenantId, status])
}

enum PaymentProvider { PAYSTACK  FLUTTERWAVE }
enum PaymentStatus   { PENDING  SUCCESS  FAILED }

model Payment {
  id                 String          @id @default(cuid())
  invoiceId          String
  amount             Decimal
  provider           PaymentProvider
  providerRef        String          // the idempotency key
  status             PaymentStatus   @default(PENDING)
  verifiedServerSide Boolean         @default(false)
  createdAt          DateTime        @default(now())

  invoice Invoice @relation(fields: [invoiceId], references: [id], onDelete: Cascade)

  @@unique([provider, providerRef])
  @@index([invoiceId])
}

model InvoiceDiscount {
  id               String               @id @default(cuid())
  invoiceId        String
  amount           Decimal
  reason           String
  mode             DiscountWorkflowMode
  appliedByUserId  String
  approvedByUserId String?
  createdAt        DateTime             @default(now())

  invoice Invoice @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
}

model PaymentWebhookEvent {
  id             String          @id @default(cuid())
  provider       PaymentProvider
  eventId        String
  signatureValid Boolean
  processedAt    DateTime?
  rawPayloadHash String          // a hash, never the raw payload — PII/secret-in-logs discipline
  receivedAt     DateTime        @default(now())

  @@unique([provider, eventId])
}
```

**Why `Payment.verifiedServerSide` plus `@@unique([provider, providerRef])` together (Decision,
closes Audit #17 and #24 — the two Critical payment findings):** a webhook handler may `INSERT` a
`Payment` row the instant its signature checks out, but the code path that flips `Invoice.status`
to `PAID` is gated on `verifiedServerSide = true`, set only after a *separate*, independent
server-to-server call to the provider's transaction-verification API confirms amount, currency, and
reference all match the invoice. A forged webhook can create an unverified, `PENDING` `Payment`
row — it cannot make an invoice show as paid. The unique constraint on `(provider, providerRef)` is
enforced at the database level, so a replayed webhook physically cannot insert a second row, not
just "shouldn't."

**Why `PaymentWebhookEvent` is a second table, separate from `Payment` (Decision):** `Payment`
records a payment attempt; `PaymentWebhookEvent` records that a webhook call happened at all,
including invalid-signature attempts, which have no associated `Payment` row and would otherwise
leave no trace — closing the "rejected/invalid webhook attempts are logged and alertable" half of
the security-audit fix, not just the "valid ones are verified" half.

### 1.5 — Cross-cutting: `AuditLog`

```prisma
model AuditLog {
  id            String   @id @default(cuid())
  tenantId      String
  actorUserId   String
  action        String   // "result.approve", "invoice.discount.apply", "settings.change"
  targetType    String
  targetId      String
  beforeValue   Json?
  afterValue    Json?
  reason        String?
  correlationId String?
  createdAt     DateTime @default(now())

  @@index([tenantId, targetType, targetId])
  @@index([tenantId, createdAt])
}
```

**Migration-level enforcement, not just convention (closes Audit #19/#31):** the Phase 1 migration
`REVOKE UPDATE, DELETE ON "AuditLog", "ResultAudit", "SettingsChangeAudit" FROM <app role>` after
creating the tables — application code can only ever `INSERT` into any of the three audit tables,
enforced by Postgres itself, not by "we don't call `.update()` on these in the code."

### 1.6 — Build order within Phase 1

1. Migration: all models above + RLS policies + the audit-table `REVOKE`, in one migration.
2. `SchoolSettings` row auto-created (all defaults) whenever a `Tenant` is created — never a
   nullable "settings not configured yet" state.
3. API routes, in dependency order: `AcademicSession`/`Period` → `ClassGroup`/`Arm`/`Subject` →
   `StaffRecord` → `StudentRecord` + `GuardianLink` → `StudentEnrollment` → `AttendanceRecord` →
   `Result` (+ approval-workflow endpoints) → `FeeStructure`/`Invoice` → `Payment` + webhook
   handlers → `Announcement`/`TimetableSlot`.
4. Admin UI screens in the same order, reusing `DashboardShell`-style layout per role (Admin,
   Teaching Staff, Non-Teaching Staff, Student, Parent — PRD §3/§7).
5. Settings UI: one screen, all toggles from §1.3's table, each write going through the step-up-MFA
   flow from Phase 0.5.

**Verification gate before Phase 1 is "done" (not just "code exists"):** the cross-tenant/IDOR
negative-test suite from Phase 0.5 extended to cover every new route; a live end-to-end walk of
enroll → mark attendance → enter result → approve → publish → parent views it; a live Paystack/
Flutterwave sandbox payment, including a deliberately forged webhook attempt that must fail.

### 1.7 — Lightweight permissions (shared design with AlEemaan)

A deliberately small addition on top of Phase 0's `Role` enum, not a full RBAC engine — scoped down
specifically so MVP doesn't grow a custom-role builder or a per-resource ACL matrix it doesn't need
yet. Same design ships in the AlEemaan PRD's §4 (Users, Roles & Lightweight Permissions), so both
projects stay in sync rather than drifting into two different permission models.

```prisma
enum Permission {
  CAN_APPROVE_RESULTS
  CAN_MANAGE_FINANCE
  CAN_PUBLISH_CONTENT
  CAN_MANAGE_USERS
}

model TenantMembership {
  // ...existing fields from Phase 0 (userId, tenantId, campusId?, role)
  permissions Permission[] @default([])
}
```

- `ADMIN` implicitly has every `Permission` — the enum only exists so a *non-admin* membership can
  be granted one extra capability (a bursar who's `NON_TEACHING_STAFF` getting
  `CAN_MANAGE_FINANCE`; a senior teacher getting `CAN_APPROVE_RESULTS` without being made `ADMIN`),
  closing the gap where the only way to do more than your base role today is to become an admin.
- `withAuth(handler, { roles, permissions })` (§0.5.3's auth helper) checks `role` OR an entry in
  `permissions` — a route can require either, not both, unless it explicitly asks for both.
- **Explicit non-goals, so this doesn't become full RBAC by accretion:** no UI for a school to
  invent new permissions, no per-resource/per-record ACLs, no permission inheritance hierarchy, no
  custom roles. If a school needs more granularity than these four permissions later, that's a
  deliberate future phase, not a Phase 1 scope-creep.

---

## Phase 2 — Communication

Matches PRD §6 Phase 2. New schema file `prisma/schema/comms.prisma`.

```prisma
enum NotificationChannel  { SMS  WHATSAPP  EMAIL  IN_APP }
enum NotificationCategory { TRANSACTIONAL  EDUCATIONAL_ADMIN  MARKETING }  // NCC classification, PRD §9
enum NotificationStatus   { QUEUED  SENT  FAILED }

model NotificationTemplate {
  id           String                @id @default(cuid())
  tenantId     String
  key          String                // "fee_reminder", "result_published"
  channel      NotificationChannel
  category     NotificationCategory
  bodyTemplate String

  @@unique([tenantId, key, channel])
}

model NotificationLog {
  id                String              @id @default(cuid())
  tenantId          String
  recipientUserId   String?
  channel           NotificationChannel
  category          NotificationCategory
  templateKey       String
  status            NotificationStatus  @default(QUEUED)
  providerMessageId String?
  sentAt            DateTime?
  createdAt         DateTime            @default(now())

  @@index([tenantId, createdAt])
}

model StaffParentMessage {
  id              String   @id @default(cuid())
  tenantId        String
  senderUserId    String
  recipientUserId String
  body            String
  createdAt       DateTime @default(now())

  @@index([tenantId, recipientUserId])
}
```

**Why templates are DB rows, not hardcoded strings (Decision, closes Audit #9/#23):** every
outbound message is rendered from a `NotificationTemplate` row, never a string literal in
application code. A CI check (added in this phase) parses every `SMS`/`WHATSAPP` template tagged
`TRANSACTIONAL` and fails the build if its `bodyTemplate` contains a `{{score}}`, `{{amount}}`, or
similar sensitive placeholder — this is what makes "no grades/fee amounts in SMS body" (PRD §5/§14,
Audit #9) a build-time guarantee instead of a code-review hope. Delivery itself runs through
BullMQ jobs (PRD §7 stack table), reading these rows.

Fee reminders (already in Phase 1's `SchoolSettings.feeReminderEnabled`) get their first real
channel here — Phase 1 shipped the setting and the scheduling hook; Phase 2 is what actually sends
anything.

---

## Phase 3 — LMS

Matches PRD §6 Phase 3. New schema file `prisma/schema/lms.prisma`.

```prisma
enum FileScanStatus { PENDING  CLEAN  INFECTED  SCAN_FAILED }

model Assignment {
  id           String   @id @default(cuid())
  classArmId   String
  subjectId    String
  title        String
  instructions String
  dueAt        DateTime
  createdByStaffId String

  submissions AssignmentSubmission[]
}

model AssignmentSubmission {
  id             String         @id @default(cuid())
  assignmentId   String
  studentId      String
  fileUrl        String?        // S3/MinIO object key — never a raw filesystem path (PRD §7)
  fileMime       String?
  fileScanStatus FileScanStatus @default(PENDING)
  textResponse   String?
  submittedAt    DateTime       @default(now())
  score          Decimal?
  feedback       String?

  @@unique([assignmentId, studentId])
}

model LearningMaterial {
  id                String         @id @default(cuid())
  classArmId        String
  subjectId         String
  title             String
  fileUrl           String
  fileMime          String
  fileScanStatus    FileScanStatus @default(PENDING)
  uploadedByStaffId String
}

model Quiz {
  id        String @id @default(cuid())
  subjectId String
  title     String

  questions QuizQuestion[]
}

model QuizQuestion {
  id              String @id @default(cuid())
  quizId          String
  prompt          String
  options         Json   // [{ id, text }]
  correctOptionId String

  quiz Quiz @relation(fields: [quizId], references: [id], onDelete: Cascade)
}

model QuizAttempt {
  id          String    @id @default(cuid())
  quizId      String
  studentId   String
  answers     Json
  score       Decimal
  startedAt   DateTime  @default(now())
  submittedAt DateTime?
}
```

**Why `fileScanStatus` defaults to `PENDING` and gates the download link (Decision, closes Audit
#15/#26):** the literal enforcement point for the file-upload security finding — the application
never returns a usable `fileUrl` to anyone but the uploader until `fileScanStatus = 'CLEAN'`,
checked via ClamAV (PRD §7 stack table) in a BullMQ job triggered on upload. Extensions/MIME types
are allowlisted at the upload route before the file ever reaches storage, not just scanned after.

---

## Phase 4 — Operations

Matches PRD §6 Phase 4. Deliberately thin here — PRD §6 itself calls this "lower urgency for
typical private school pilot," so inventing exact payroll tax logic or NEMIS field mappings now
would be designing against requirements nobody has validated yet, the same reasoning `TheNiche`'s
own plan applies to its own lower-certainty phases. Full design happens when this phase is actually
scheduled against a real customer need.

```prisma
model StaffLeaveRequest {
  id            String   @id @default(cuid())
  staffRecordId String
  startDate     DateTime
  endDate       DateTime
  status        String   // approved/pending/rejected — enum deferred until the approval chain is designed
  approvedByUserId String?
}

model PayrollRun {
  id       String @id @default(cuid())
  tenantId String
  periodId String
  status   String // deliberately a string, not an enum, until tax/pension rules are scoped
}

model LibraryItem {
  id              String @id @default(cuid())
  tenantId        String
  title           String
  isbn            String?
  copiesTotal     Int
  copiesAvailable Int
}

model LibraryLoan {
  id         String    @id @default(cuid())
  itemId     String
  studentId  String
  borrowedAt DateTime  @default(now())
  dueAt      DateTime
  returnedAt DateTime?
}

model TransportRoute {
  id       String @id @default(cuid())
  tenantId String
  name     String
}

model TransportAssignment {
  id        String @id @default(cuid())
  routeId   String
  studentId String
}

model InventoryItem {
  id             String @id @default(cuid())
  tenantId       String
  name           String
  quantityOnHand Int
}

model NemisExportBatch {
  id          String    @id @default(cuid())
  tenantId    String
  periodId    String
  status      String
  submittedAt DateTime?
}
```

`NemisExportBatch` exists as a placeholder table, not a working exporter — PRD §13's competitive
note that EDVES already offers NEMIS reporting means this is worth reserving schema space for, but
PRD §6 explicitly keeps it off the roadmap "until requested," so no export logic is built here.

---

## Phase 5 — Expansion

Matches PRD §6 Phase 5, which the PRD itself frames as conditional ("depends on which market
segment gains traction first") — matching that uncertainty here rather than over-specifying:

- **Native mobile:** no new backend schema — the same versioned REST API (Phase 0.5) is consumed
  by a React Native/Expo client. Nothing to design until this phase starts.
- **Higher-ed course registration/credit units:** extends `AcademicPeriod`/`StudentEnrollment`
  with a `Course` model carrying `creditUnits`, and a registration step distinct from
  `ClassArm`-based K12 placement.
- **Vocational certifications:** a `Certificate` model tied to cohort (`AcademicPeriod{kind:
  COHORT}`) completion.
- **White-labeling/custom domains:** a `CustomDomain` model mapping a domain string to a
  `tenantId`, resolved in the *same* middleware tenant-trust-boundary layer built in Phase 0.5 for
  `/schools/[code]` — a new lookup key into the same verified-membership machinery, not a parallel
  system.

No schema for any of these should be finalized before a real signal (a paying customer, a specific
request) exists — inventing it now risks the exact "a field or enum value that sounds right but was
never actually decided" trap `TheNiche`'s own plan names as the thing to guard against.
