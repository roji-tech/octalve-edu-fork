# Tests

One runner — [Playwright Test](https://playwright.dev/docs/intro) — for everything: pure logic,
modules against a real Postgres, real HTTP against a production build, real Chromium (desktop and
phone viewports), and real Chromium over real TLS. The suites exist to prove the auth design in
`docs/development-history/domain-implementation-plan.md` §0.5.1 *repeatably*; the write-up of what
they found is `docs/development-history/phases/phase-0.5.1-auth.md`.

## Running

Prerequisites: Node 22, pnpm, a reachable Postgres (`docker compose up -d db`), Chromium
(`pnpm exec playwright install chromium`, once), and `openssl` on the PATH (for the throwaway TLS
certificate).

| Command | What it does |
| :--- | :--- |
| `pnpm test` | `pnpm build`, then every project. **Use this before opening a PR** — the servers under test are a *production* build, so a stale `.next` would silently test old code. |
| `pnpm test:fast` | Every project, reusing the existing build (fine when only `tests/` changed). |
| `pnpm test:unit` / `test:api` / `test:e2e` / `test:https` | One layer. |
| `pnpm typecheck` | `tsc --noEmit` — also enforces the compile-time `@ts-expect-error` checks (`tests/unit/with-auth.types.ts`). |
| `pnpm exec playwright test <file> --headed` | Watch a spec run. `PWDEBUG=1` for the inspector. |
| `pnpm exec playwright show-report` / `show-trace <trace.zip>` | After a failure: HTML report, or the trace (DOM snapshots, network, console). |

The three ports in `tests/support/env.ts` (`HTTP_PORT`, `HTTPS_APP_PORT`, `TLS_PORT`) must be free (the config never reuses a running server, so a stale one
can't be tested by accident).

## The database

Tests run against **`<your database>_test`** (e.g. `octalve_edu_test`), never your dev database.
`tests/setup/database.setup.ts` creates it if missing, applies every migration with
`prisma migrate deploy` (exactly as production would — never `db push`), and empties it. Override
with `TEST_DATABASE_URL` (its database name **must** end in `_test`). Every destructive helper
re-checks `current_database()` and refuses to run against anything else.

## Layout — what each project proves

| Project | Folder | Runs against | Proves |
| :--- | :--- | :--- | :--- |
| `setup` | `setup/` | Postgres | The test database exists, is migrated, and is empty. Everything else depends on it. |
| `unit` | `unit/` | nothing | **The CSP's shape** (`csp.spec.ts`: 128-bit never-repeating nonce, exact directives, no `unsafe-inline`/`unsafe-eval` in production, https-only `upgrade-insecure-requests`); the rate limiter (reserve-then-refund, sliding window, LRU bound, atomicity under concurrency, which IP header is trusted), password hashing (constant-time path, bcrypt's 72-byte limit), and that `withAuth` refuses `roles`/`permissions` until §0.5.2. |
| `integration` | `integration/` | modules + Postgres | `proxy.spec.ts` calls `src/proxy.ts` in-process (fresh nonce per call; the same policy forwarded on the *request* headers, where Next reads it; `CSP_REPORT_ONLY` flips only the header name); Session lifecycle: only a hash is stored, two-level expiry, the two modes ("Keep me signed in" → 30 d idle / 90 d absolute; not remembered → a 12-hour cap held by the server), sliding clamped to the cap, per-user cap, purge, revoke, cookie attributes (persistent vs browser-session); `withAuth`'s CSRF-before-session ordering and cache headers. |
| `api` | `api/` | `next start` over HTTP | Login/logout/me/setup end to end: guard order, CSRF variants, enumeration-safe errors, timing parity, all three rate-limit layers, spoofed `X-Forwarded-For` ignored, hash-at-rest checked in the database, rotation, fixation, `Set-Cookie` attributes, security headers, `no-store` everywhere; **the nonce CSP** (`csp.spec.ts`: policy on pages/404/redirects, every `<script>` — inline ones too — carries this response's nonce, a new nonce per request, no inline styles, the API's static policy, `upgrade-insecure-requests` per deployment scheme); `remember` is a strict boolean whose default (not remembered) yields a session cookie **and** a 12-hour row. |
| `e2e-desktop`, `e2e-mobile` | `e2e/` | Chromium, 1280×720 and a Pixel 7 | Real user flows: sign-in ok/fail, focus management, validation, the paused state (fake clock), keyboard-only use, show/hide password, "Keep me signed in" (unchecked by default, persistent vs session cookie, survives a failed attempt), double-submit, reload persistence, sign-out + Back, cross-tab sign-out, revoked/expired sessions, credentials never in the URL, the whole setup → sign-in → dashboard journey; **the light/dark theme** (server-rendered from a cookie, no flash, toggle by mouse and keyboard, survives reload and navigation, hostile cookie values ignored); **the brand** (`brand.spec.ts` — the one spec that differs between the two repos); **CSP in a real browser** (`csp.spec.ts`: attacker markup spliced into the real response — inline `<script>`, `onerror=`, foreign `<script src>`, `javascript:` link, `<base>` — is inert and reported); axe-core WCAG 2.2 A/AA on every screen **and state, in both themes**; no horizontal scroll; ≥ 44 px tap targets on phones. |
| `https` | `https/` | Chromium over TLS | The production cookie shape: `__Host-` accepted on login (Chromium only accepts it if Secure + `Path=/` + no Domain) — as a persistent cookie when remembered and a browser-session cookie when not — and **actually removed on logout** — the auth review's P0 #4. |

The `https` project runs the *same build* a second time with `APP_URL=https://localhost:<TLS_PORT>`
behind `tests/support/tls-proxy.mjs`, a small TLS-terminating reverse proxy with a throwaway
self-signed certificate. Like a correctly configured Caddy/nginx it overwrites `X-Real-IP` with the
real peer address; the only test hook (`x-test-client-ip` → `X-Real-IP`) lives in the proxy, never
in the app.

## Conventions

- **Independent tests.** Each test creates its own users (`createUser`) and gets its own client IP
  (`clientIp` fixture / `uniqueIp()`), sent as `X-Real-IP` — the header the servers trust, exactly as
  in production — so tests can't exhaust each other's rate-limit buckets. One worker, no file-level
  parallelism, because the suites share a database and `setup-handoff.spec.ts` deliberately starts
  from an empty one.
- **No retries.** A flaky test is a bug to fix (`retries: 0`), not something to retry away.
- **API tests use plain `fetch`**, not Playwright's request context: that keeps a cookie jar which
  would silently attach a session to a request meant to be anonymous.
- **Prove the test can fail.** Every security-relevant assertion here was *mutation-checked*: inject
  the bug the test claims to catch (skip the dummy bcrypt, believe `X-Forwarded-For`, bare
  `cookies.delete()`, drop CSRF, store the plaintext token, …) and confirm the suite goes red, then
  restore. A test that has never been seen failing has not been shown to test anything — and run it
  *unmutated* first: a test that fails both ways proves nothing (the `pageshow` test once looked
  "caught" only because it always failed). The record is in the phase doc.
- **Selectors: role and label first.** Next.js renders its own `<next-route-announcer role="alert">`,
  so scope alerts to `<main>` (`alerts(page)` in `e2e/helpers.ts`). The sign-in brand panel is
  `aria-hidden` and repeats the product name, so a bare `getByText("Octalve Edu")` is a strict-mode
  violation on a phone — scope it (`getByRole("main")`).
- **Every browser test is a CSP test.** The auto `csp` fixture (`support/fixtures.ts`) records every `securitypolicyviolation` and fails the test if any occurred. A test that *provokes* one calls `csp.take()`, which returns and clears them. To test markup injection, splice the payload into the real server response with `page.route` — not `page.evaluate(createElement("script"))`: `'strict-dynamic'` trusts script made by trusted script and DevTools-evaluated code is exempt, so that "attack" simply runs.
- **Both themes, every time.** `checkScreen()` in `responsive-and-a11y.spec.ts` runs axe and the
  overflow check in the dark *and* the light theme (flipping `data-theme` — the colours are CSS
  variables, so that is exactly what the toggle changes); the toggle itself is covered by `theme.spec.ts`.
- **`test.skip(fn)` is only valid at `describe` level.** Inside a test body use the boolean form with
  the fixture: `async ({ page, isMobile }) => { test.skip(isMobile, "…"); … }`.
- **Sign-in helpers take the "Keep me signed in" choice explicitly**: `signInThroughUi(page, user,
  { remember: true })`, `loginAs(user, { remember: true })`. Left out, they exercise the default — not
  remembered — so a test that asserts a long cookie lifetime has to ask for it.
- Adding a route that uses `withAuth`? Add API tests for 401/403 and an integration test for any
  new behaviour; adding a screen? Add it to `responsive-and-a11y.spec.ts` (every state that changes
  the DOM, not just first paint).

## Known limits

- Chromium only. Firefox/WebKit would be the next step; the cookie and CSRF behaviour under test is
  standard, but engine differences (bfcache, cookie-prefix enforcement) are exactly where
  browsers diverge.
- The timing-parity check is statistical (medians, generous bounds). It reliably catches a skipped
  bcrypt (≈ 1000× faster); it cannot detect sub-millisecond leaks and isn't meant to.
- Chromium doesn't put `no-store` pages into the back/forward cache, so the `pageshow` revalidation
  path is driven with a synthetic `pageshow` event rather than a real cache restore.
- The rate limiter is in-process memory (correct for Solo and single-instance SaaS). A Redis-backed
  limiter — required before any multi-instance deployment — will need these limiter tests re-pointed
  at it.
