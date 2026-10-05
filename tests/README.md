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

The ports in `tests/support/env.ts` (`HTTP_PORT`, `HTTPS_APP_PORT`, `TLS_PORT`, `DEVTOOLS_PORT`, `SAAS_PORT`, `UNSAFE_RLS_PORT`, `PWNED_STUB_PORT`, and Redis's `REDIS_TEST_PORT`) must be free (the config never reuses a running server, so a stale one
can't be tested by accident).

## The database

**Two database roles — the suite runs the way production does.** `TEST_DATABASE_URL` is the **admin** (the migrator and table owner): it
creates the database, runs `prisma migrate deploy`, and arranges fixtures across schools (`db` in `support/db.ts`, `resetDatabase`). The app —
every in-process module and every `next start` server — connects as **`app_user`** (`TEST_APP_DATABASE_URL`; `DATABASE_URL` in the tests'
environment), a role with `NOSUPERUSER NOBYPASSRLS` and data-only grants, so **row-level security applies to everything the tests exercise**. A
test run as the owner would pass vacuously whether or not a policy filtered anything. Consequences:

- The admin **must itself bypass RLS** (a superuser — the docker compose role already is — or `BYPASSRLS`), or fixtures could not be arranged
  across schools. `database.setup.ts` checks this and prints the exact `ALTER ROLE … BYPASSRLS;` when it does not hold.
- `app_user` is created by `docker/postgres/init/01-roles.sql` (a fresh compose volume), by `pnpm db:roles` (an existing database — it also
  re-applies the grants), or by `database.setup.ts` when the admin may create roles. Defaults: user `app_user`, password `app_user`; override with
  `TEST_APP_DATABASE_URL`. If neither exists the setup fails with the command to run.
- Arrange data through `db` (admin) and read it back through `prisma` (runtime) — `integration/rls.spec.ts` is the model.


Tests run against **`<your database>_test`** (e.g. `octalve_edu_test`), never your dev database.
`tests/setup/database.setup.ts` creates it if missing, applies every migration with
`prisma migrate deploy` (exactly as production would — never `db push`), and empties it. Override
with `TEST_DATABASE_URL` (its database name **must** end in `_test`). Every destructive helper
re-checks `current_database()` and refuses to run against anything else.

## Lanes — the same suite, several at once

The suite is serial for a reason: its tests share ONE database and a fixed block of ports. A **lane** is an isolated copy of both, so
several runs of the same source can go at the same time — what is tested, and every assertion, is unchanged; only *how many at once* is.

- `TEST_LANE=<n>` (a digit; default 0) moves every port up by 10 × `n` (Redis by `n`) and makes the database `<name>_lane<n>_test` — see `tests/support/env.ts`.
  Each lane also needs its own directory (its own `.next` build, mail outbox and results); `node scripts/lanes.mjs` makes them: lane 0 is this checkout, lanes 1–9 are copies in
  `../.octalve-lanes/lane<n>` (override with `LANES_ROOT`), kept in sync from your working tree — committed or not — with dependencies taken from the pnpm store (≈ 10 s).
- **`pnpm test:lanes`** (= `node scripts/lanes.mjs test --lanes 3`): builds **only if the build is older than the code** (a stale `.next` is never reused), copies the build into the
  lanes, runs `playwright test --shard=k/N` in each lane concurrently, and prints one merged verdict — totals summed over lanes, every failing test named, **exit 1 if any lane failed**.
  The shards partition the same tests (each shard also runs the `setup` project once, so a 3-lane run reports 2 more passes than a 1-lane run — that is the only difference).
  Extra Playwright arguments go after `--`: `pnpm test:lanes -- --project=api`. `--lanes N` picks the count (4 cores: 3 is a good default); `--no-build` reuses the build.
- `pnpm lanes:sync [n…]` refreshes lane copies without running anything (used by mutation passes: each lane applies a bug to **its own copy**, so the working tree is never edited and
  work can carry on in it while a pass runs).
- Before a PR, `pnpm test` (one lane, `pnpm build` first) remains the reference; `test:lanes` is for the inner loop and for long runs. If a result ever differs between the two, the one-lane
  run is right and the difference is a bug in test isolation — fix that.

## Layout — what each project proves

| Project | Folder | Runs against | Proves |
| :--- | :--- | :--- | :--- |
| `setup` | `setup/` | Postgres | The test database exists, is migrated, and is empty. Everything else depends on it. |
| `unit` | `unit/` | nothing | **The CSP's shape** (`csp.spec.ts`: 128-bit never-repeating nonce, exact directives, no `unsafe-inline`/`unsafe-eval` in production, https-only `upgrade-insecure-requests`); the rate limiter (reserve-then-refund, sliding window, LRU bound, atomicity under concurrency, which IP header is trusted), password hashing (constant-time path, bcrypt's 72-byte limit), and that `withAuth` refuses `roles`/`permissions` until §0.5.2. **Two-step verification's crypto** (`totp.spec.ts`, `mfa-crypto.spec.ts`): TOTP/HOTP against the RFC 4226/6238 *published* vectors, base32, the ±1 drift window and replay rule, the AES-GCM secret box (tamper, wrong owner, wrong key, fail-closed without a key) and recovery codes (format, distribution, keyed hash). **The dev-tools gate** (`dev-tools.spec.ts`): every environment combination (1,344 of them) obeys the invariants — production never gets the tools, a typo in `APP_ENV` is production, staging needs a token — and the inbox ring buffer (cap, order, `globalThis`, truncation). |
| `integration` | `integration/` | modules + Postgres | `proxy.spec.ts` calls `src/proxy.ts` in-process (fresh nonce per call; the same policy forwarded on the *request* headers, where Next reads it; `CSP_REPORT_ONLY` flips only the header name); Session lifecycle: only a hash is stored, two-level expiry, the two modes ("Keep me signed in" → 30 d idle / 90 d absolute; not remembered → a 12-hour cap held by the server), sliding clamped to the cap, per-user cap, purge, revoke, cookie attributes (persistent vs browser-session); `withAuth`'s CSRF-before-session ordering and cache headers. **Two-step verification** (`mfa*.spec.ts`): the sign-in challenge lifecycle (hash at rest, five attempts spent atomically, single use, bounded growth), enrolment/confirm/verify/recovery/disable against Postgres **under concurrency** (ten simultaneous uses of one code or one recovery code: exactly one wins), a password reset leaving MFA on, the 503 paths called in-process with no key, and `scripts/mfa-reset.mjs` run as a child process. **The dev email inbox** (`dev-inbox.spec.ts`): transport selection (explicit wins; `inbox` fails loudly where the tools are off; the log line never carries the body) and the routes called in-process per environment (404 in production even with the token, open in development, token + per-IP limit + CSRF in staging). |
| `api` | `api/` | `next start` over HTTP | Login/logout/me/setup end to end: guard order, CSRF variants, enumeration-safe errors, timing parity, all three rate-limit layers, spoofed `X-Forwarded-For` ignored, hash-at-rest checked in the database, rotation, fixation, `Set-Cookie` attributes, security headers, `no-store` everywhere; **the nonce CSP** (`csp.spec.ts`: policy on pages/404/redirects, every `<script>` — inline ones too — carries this response's nonce, a new nonce per request, no inline styles, the API's static policy, `upgrade-insecure-requests` per deployment scheme); `remember` is a strict boolean whose default (not remembered) yields a session cookie **and** a 12-hour row. **Two-step sign-in and management** (`mfa-login.spec.ts`, `mfa-account.spec.ts`): step 1 hands out a challenge and *no* cookie or session, step 2 is the only thing that creates one (remember carried by the challenge, replay refused incl. under concurrency, all three limits, typos refunded), enrol/confirm/disable/recovery routes with their re-authentication, sessions revoked, emails and audit rows. **The dev inbox over HTTP** (`dev-inbox.spec.ts`): the three production-shaped servers 404 it and show no launcher; the staging-mode server needs the token, delivers forgot-password mail into the inbox and the link really resets the password. |
| `e2e-desktop`, `e2e-mobile` | `e2e/` | Chromium, 1280×720 and a Pixel 7 | Real user flows: sign-in ok/fail, focus management, validation, the paused state (fake clock), keyboard-only use, show/hide password, "Keep me signed in" (unchecked by default, persistent vs session cookie, survives a failed attempt), double-submit, reload persistence, sign-out + Back, cross-tab sign-out, revoked/expired sessions, credentials never in the URL, the whole setup → sign-in → dashboard journey; **the light/dark theme** (server-rendered from a cookie, no flash, toggle by mouse and keyboard, survives reload and navigation, hostile cookie values ignored); **the brand** (`brand.spec.ts` — the one spec that differs between the two repos); **CSP in a real browser** (`csp.spec.ts`: attacker markup spliced into the real response — inline `<script>`, `onerror=`, foreign `<script src>`, `javascript:` link, `<base>` — is inert and reported); axe-core WCAG 2.2 A/AA on every screen **and state, in both themes**; no horizontal scroll; ≥ 44 px tap targets on phones. **Two-step verification** (`two-step.spec.ts`): turn it on through the UI, the **QR code decoded with `jsqr` to prove it encodes the key shown**, sign in through both steps, recovery codes, back/expiry/lock-out states, download and clipboard, turning it off; axe in both themes on every new state. **The dev inbox widget** (`dev-inbox.spec.ts`): unlock, unread badge, read the mail and click the link, Escape/focus, hostile markup rendered inert; axe in both themes on every state. |
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
- **The inbox.** The servers run with `EMAIL_TRANSPORT=file`; every message they send is a JSON line in `tests/.tmp/outbox.jsonl`. `support/outbox.ts` reads it (`waitForMail(to)`, `mailAfterGrace(to)` for "nothing was sent", `tokenFrom`/`linkFrom`). Mail goes out *after* the HTTP response, so poll; use a unique address per test and tests never see each other's mail.
- **The dev tools have their own server.** Besides the three production-shaped servers (plain HTTP, https-flavoured, and the TLS proxy), the config starts a **fourth** — `DEVTOOLS_PORT`, `devToolsServerEnv()` in `support/env.ts` — the same build in `APP_ENV=staging` with `DEV_TOOLS=true`, a token (`DEV_TOOLS_TEST_TOKEN`) and *no* `EMAIL_TRANSPORT`, so mail goes where the app sends it by default in that mode: the in-memory dev inbox. It is the only server where that inbox exists; the other three set `APP_ENV=production` explicitly (whatever a developer's own `.env` says) and the specs assert they 404 it and render no launcher. A spec that uses it does `test.use({ baseURL: DEVTOOLS_URL })` (API tests pass `baseUrl: DEVTOOLS_URL`) and **clears the shared in-memory inbox first** (`DELETE` with the token) — it is one buffer for every test. In-process tests start from `APP_ENV=production` and set what they need with a `withEnv()` helper that restores every variable.
- **Two-step verification.** `support/db.ts` has `enableMfa(userId)` (a confirmed credential + ten recovery codes straight into the database, returning the secret and the codes — for tests about *sign-in*; enrolment itself is driven through the real routes/UI), `codeFor(secret, offsetSteps)` (the code an authenticator would show *now*) and `rewindMfa(userId)` (forgets the last accepted step — "time has passed"; never call it in a test about replay). **Clock rule:** the server accepts the current 30 s step ±1, so `offset 0` is safe even if a step boundary passes mid-request, and a code the server must *refuse* uses `±3` — never `±2`, which would be flaky at a boundary. The in-process tests and both servers share one fixed `TEST_MFA_KEY` (`support/env.ts`); "no key" tests delete it from `process.env` for their own duration.
- **Every browser test is a CSP test.** The auto `csp` fixture (`support/fixtures.ts`) records every `securitypolicyviolation` and fails the test if any occurred. A test that *provokes* one calls `csp.take()`, which returns and clears them. To test markup injection, splice the payload into the real server response with `page.route` — not `page.evaluate(createElement("script"))`: `'strict-dynamic'` trusts script made by trusted script and DevTools-evaluated code is exempt, so that "attack" simply runs.
- **Redis, the breach-service stub, and what runs where.** Playwright starts a throwaway `redis-server` on 6390 (prerequisite: `redis-server` on `PATH`,
  or set `TEST_REDIS_URL` to your own) and `tests/support/pwned-stub.mjs` (a stand-in for the breached-password range API, with a request log). Only the
  **SaaS-mode server** uses them (`RATE_LIMIT_STORE=redis`, `PWNED_PASSWORD_CHECK=on`); every other server and every in-process test has the breach check **off**
  and the memory store. The store conformance suite (`integration/rate-limit-store.spec.ts`) runs the same cases against both stores — add a case there, not in one
  store's own test. Code that calls `after()` (every route with a follow-up) cannot be called in-process: test its refusals in-process and its success paths over HTTP.
- **The sixth server is deliberately wrong.** `UNSAFE_RLS_PORT` (3105, `unsafeRlsServerEnv()`) is the SaaS-mode build connected as the **admin** — a production
  process that bypasses row-level security. `api/rls-assertion.spec.ts` proves it **refuses** tenant data (a generic 500, no role names, the page renders
  no school) while routes that touch no tenant still work. It exists to prove `assertRlsEnforced()` is wired in; do not point other tests at it.
- **The app shell in tests** (`e2e/shell.spec.ts`, runs on desktop **and** phone; each case skips the project it does not apply to). The shell has two copies of its navigation (sidebar from `lg`, tab bar below), and the phone sheet is a
  closed `<dialog>` that is still in the DOM: `getByRole` ignores hidden elements, **`getByText` does not** — scope text checks to `main`, `header`, or a named group (`getByRole("group", { name: "Signed in as" })`). To prove a
  disclosure's Escape handling, **Tab into the panel first** (with focus already on the button nothing can be lost); to prove its outside-click handler, click genuinely inert space (`page.mouse.click(760, 30)` is the top bar's
  empty middle) — clicking text inside `<main>` focuses it (`tabIndex=-1`) and the blur path closes the menu for you. `signOut(page)` in `helpers.ts` opens the account menu.
- **Several schools, one database (SaaS-mode server).** The Solo servers fail closed (500) when a second tenant exists, so anything
  with more than one school runs on the **fifth server** (`SAAS_PORT` 3103, `saasServerEnv()`): `test.use({ baseURL: SAAS_URL })` in browser
  specs, `{ baseUrl: SAAS_URL }` in API calls. Make schools with `createTenant({ name, campuses })`, members with `addMembership(userId,
  tenantId, role, campusId?)`, and **remove them in `afterAll` with `removeCreatedTenants()`** — a leftover tenant breaks every Solo test
  that follows. In-process, `withEnv({ DEPLOYMENT_MODE: "saas" }, …)` (`support/with-env.ts`) switches the mode for one test. The signed-in
  landing page is `HOME_URL` (a one-school person is redirected into `/schools/<code>`), never a hard-coded `/dashboard`.
- **Identity-changing flows (profile, email change, sessions).** Limits are per *account*, so one test's assertions share
  one budget — count them, or give each assertion its own `signedIn()` person (the profile-refusal tests are split for
  exactly that reason). A "second device" is `browser.newContext({ userAgent, extraHTTPHeaders: { "x-real-ip": uniqueIp() } })`
  signed in through the UI (the `context` fixture's IP header applies only to the default context). To start from a live
  confirmation link without driving the request flow, call `createEmailChangeToken(userId, newEmail)` in-process and open
  `/confirm-email#token=…`. Anything that must be *identical* for two inputs (a free and a taken address, a foreign and an
  unknown session id, every kind of dead link) is asserted as `expect(a.json).toEqual(b.json)` plus status and headers —
  not "both are errors". `withAuth` routes send `Cache-Control: private, no-store`, public ones `no-store`; assert exactly.
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
