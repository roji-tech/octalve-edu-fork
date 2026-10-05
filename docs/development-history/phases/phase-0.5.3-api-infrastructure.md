# Phase 0.5.3 — Shared API infrastructure

**Status: BUILT AND VERIFIED (2026-10-05), except the part that depends on row-level security (see "Not done").** Branch
`claude/tenant-trust-boundary` (the same branch as 0.5.2 — one branch carries everything unmerged). Design of record: plan §0.5.3
and "Build design for §0.5.3" (written before any code). Roadmap position: `roadmap-breakdown.md` §0.5.3.

## What this delivers
The helpers every route from Phase 1 onward is built from, plus the hardening the plan deferred to here.
- **A — envelope, pagination, validation.** `fail()` takes optional `details` (`[{ path, message }]`). `lib/api/pagination.ts`:
  *offset* (`page`/`limit`, defaults 1/25, cap 100, **repeated / signed / decimal / padded / non-numeric are a 400 that names the
  field — never clamped, never first-wins**) with exact `meta { page, limit, total, pages, hasNext }`; *cursor* (keyset on
  `(createdAt, id)`, opaque `base64url(JSON)`, ≤ 256 chars, strictly validated, `limit + 1` fetch so no COUNT is needed).
  `lib/api/validate.ts`: `validate({ body?, query? }, handler)` inside `withAuth` — non-JSON → 400 `INVALID_BODY`, body over 1 MiB
  (declared or actual) → 413, schema failure → 400 `VALIDATION` with `details` (≤ 20), **unknown keys stripped** (no mass assignment).
- **B — the first real tenant routes.** `GET` / `POST /api/v1/schools/[code]/campuses`: paginated list (an ADMIN sees the school's campuses,
  anyone else their own); `POST` is ADMIN-only, validated (trimmed, NFC, 1–100 characters, no control / bidi characters), unique per
  school (**new additive migration `20261007090000_campus_name_unique`**), audited **in the same transaction**, rate-limited (30 per
  person per school per window), a duplicate is a 409 naming the field. The file-system-discovered boundary test guarded them with no new test.
- **C — CSRF hardening.** `Sec-Fetch-Site` as a second signal (`cross-site` **and `same-site`** refused — a sibling subdomain such as the future
  uploaded-content domain must not ride a session). **`X-Forwarded-Host` is no longer trusted by default** (it was read unconditionally, so a
  client could choose the host its own Origin was compared with); it is read only when the operator sets `TRUST_FORWARDED_HOST=true`.
- **D — the Redis rate-limit store.** The limiter keeps its interface and gains a store: `memory` (unchanged, default) and `redis` (`ioredis`,
  one atomic Lua script per reserve over a sorted set, time taken from Redis so instances with skewed clocks agree). `RATE_LIMIT_STORE=redis` +
  `REDIS_URL`. **Redis down → this process's memory store** (never "no limit", never "everyone locked out"), logged once per outage, with a circuit
  breaker so an outage costs one slow request per cooldown. A SaaS production deployment on the memory store logs a loud warning. The SaaS-mode test
  server runs on Redis, so every limit test there goes through it.
- **E — auth-event audit.** `LOGIN_SUCCEEDED` (device kind and "remembered" — never an IP, never the raw user agent) written from `completeSignIn`;
  `LOGIN_BLOCKED` for a *known* account, **once per window** (a flood of attempts cannot become a flood of audit rows), the 429 identical for known
  and unknown addresses.
- **F — breached passwords.** k-anonymity range lookup (only the 5-character SHA-1 prefix leaves the server, with `Add-Padding`), 2 s timeout,
  **fail open**, applied server-side at setup, reset and change *before* a reset link is spent. `PWNED_PASSWORD_CHECK=off` disables it.

## Operations
- **`TRUST_FORWARDED_HOST=true`** only behind a reverse proxy that **overwrites** `X-Forwarded-Host`; unset otherwise. A deployment already behind
  a proxy must set it, or CSRF will compare Origin with the internal host and refuse every state-changing request.
- **`RATE_LIMIT_STORE=redis` + `REDIS_URL`** before running more than one instance. Test prerequisite: `redis-server` on `PATH` (Playwright starts
  one on 6390) or `TEST_REDIS_URL`.
- **`PWNED_PASSWORD_CHECK`** is on by default; set `off` on an air-gapped install. `PWNED_PASSWORD_URL` overrides the service.
- Migration: one unique index on `Campus(tenantId, name)`.

## Verification
`pnpm test`: **896 passed, 5 skipped by design, 0 failed** (18.6 min; it was 811) — unit 154, integration 192, api 276, e2e-desktop 135 (+1
skipped), e2e-mobile 135 (+4), https 8. `tsc`, ESLint, `next build` clean. New: **unit** — pagination (every malformed form, repeated, cursor
tampering, padding), validate (every error shape, stripping, size cap, detail cap), the CSRF decision table, the breach check (prefix only, padding,
fail-open, timeout, off); **integration** — one **store conformance suite run against both stores** (limit, window, refund removes the newest,
no lockout extension, 60 concurrent reserves → exactly the limit, odd keys), Redis-only (two instances share one limit, TTL, prefix), fallback
(limit holds, once per outage, recovery, breaker), store selection from the environment, the breach refusals in-process; **api** — campuses (paging
exactness, role scoping, every validation error, mass assignment, duplicate 409 and no audit for the failed attempt, 413, CSRF, authorization before
validation, the 31st create a 429 **with the 30 slots visible in Redis**), CSRF over HTTP (forged forwarded host, `Sec-Fetch-Site`), the audit
rows, the breach flows against a local stand-in for the service.

### Mutation testing — 44 injected bugs, all caught (3 on the second pass)
Pagination (no cap, repeated accepted, signed accepted, no page cap, wrong rounding, `hasNext` constant, no next cursor, loose cursor time, no
cursor cap); validation (raw body passed, no size cap, uncapped details, wrong prefix); CSRF (header ignored, `same-site` allowed, forwarded host
always trusted — in-process and over HTTP, Referer fallback dropped); the stores (refund the oldest, no expiry, off-by-one, no fallback, breaker
never opens, outage logged every time, Redis selection ignored, missing URL silently falling back, memory uncapped); the campus routes (roles
dropped, duplicate a 500, no audit, no limit, non-admin sees all, name not normalised, body `tenantId` honoured); audit (sign-ins unaudited,
blocked audited every time, raw user agent copied); breach check (whole hash sent, padding counted, fail **closed**, skipped on reset / change /
setup, run before the shape rule). **Three survived at first**, each exposing a test that passed for the wrong reason: P3 (a signed number was also
refused by the *range* rule, so the message was never pinned), P9 (the cursor length cap was shadowed by the id cap) and S6 (the breaker's cooldown
hid whether the outage was logged once). Tests added; all caught.

## Findings and decisions
| # | Found by | What | Resolution |
| :-- | :-- | :-- | :-- |
| 1 | Reading `csrf.ts` against the plan | `X-Forwarded-Host` was trusted from any client. | Opt-in `TRUST_FORWARDED_HOST`; the proxied test server sets it. |
| 2 | The store conformance test | `enableOfflineQueue: false` with a lazy connection made the **first** commands of a fresh process fail and silently use memory. | Offline queue on (commands wait for the socket, still time out in 500 ms) + a breaker so an outage costs one slow request per cooldown. |
| 3 | Test design | Success paths call `after()`, which exists only inside a real request. | In-process tests cover refusals; success flows are API tests against a server — with a local stand-in for the breach service. |
| 4 | Mutations P3 / P9 / S6 | Tests that passed for the wrong reason. | Strengthened; caught. |
| 5 | Lint | A callback named `use` is read as a React hook. | Named `run`. |

## Not done
- **Negative tests as `app_user`** (plan §0.5.3 "Verification") — they need the RLS role (see phase 0.5.2). Everything else on that checklist (wrong
  tenant, no membership, revoked session, malformed pagination, rate limit exceeded) is covered at application level.
- The cookieless upload domain and `Sec-Fetch-Site`-aware CORS — designed with the LMS (Phase 3). Retrofitting existing routes onto `validate()` — not
  needed (they have their own tests); new routes use it.
