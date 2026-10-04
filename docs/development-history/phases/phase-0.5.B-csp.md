# Phase 0.5.B — Nonce-based script CSP

**Status: BUILT AND VERIFIED (2026-10-01) — awaiting the maintainer's merge.** Branch `claude/csp-nonce` of
`roji-tech/octalve-edu-fork`, **stacked on `claude/design-tokens-theme`** (merge that first). Live work log until the merge; append-only after.

Design of record: `docs/development-history/domain-implementation-plan.md` → Phase 0.5 addenda → **0.5.B**
(written before any code) and its "As built" note. Same change, same tests, in both repos
(AlEemaan's record: `phases/phase-0.5.B-csp.md` on `claude/csp-nonce` of `roji-tech/AlEemaan`). Test guide: `tests/README.md`.

## What this phase delivers

A strict Content-Security-Policy: the browser runs a script only if it carries **this response's secret
nonce**, so a markup-injection bug (XSS) can no longer execute inline script, inline event handlers, `javascript:`
URLs or foreign-origin scripts — and forms/`<base>` can't be redirected off-origin. Nothing else about the app
changes: the groundwork (no inline scripts, theme by cookie, every page dynamic) was laid in 0.5.A.

- `src/lib/security/csp.ts` — `generateNonce()` (128-bit, base64) and `buildCsp()`, pure functions.
- `src/proxy.ts` (Next 16's renamed middleware) — a fresh nonce per page request; the policy set on the
  **request** headers (Next reads the nonce from there and stamps its own framework scripts) and the
  **response**. Static assets and prefetches are skipped.
- Policy: `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…';
  img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self';
  form-action 'self'; frame-ancestors 'none'` — plus `upgrade-insecure-requests` **only** when `APP_URL` is
  https (on a plain-HTTP LAN install it would break every sub-request). No `'unsafe-inline'`; no
  `'unsafe-eval'` outside `next dev`.
- `next.config.ts` — the JSON API gets a static `default-src 'none'; frame-ancestors 'none'`; `frame-ancestors`
  moved out of the static header (the page policy carries it).
- `CSP_REPORT_ONLY=true` — the same policy as `Content-Security-Policy-Report-Only`: a valve for diagnosing an
  unforeseen violation on a live deployment without an outage. Only the exact value `true` relaxes it; the
  default is enforcing. No report-collection endpoint (extra unauthenticated surface).

## Verification

| Layer | What |
| :-- | :-- |
| unit (`csp.spec.ts`) | nonce is 16 bytes of base64 and never repeats in 10,000 draws; exact directive set; no `unsafe-inline`/`unsafe-eval` in production; `unsafe-eval`/websocket only in dev; `upgrade-insecure-requests` only on https |
| integration (`proxy.spec.ts`) | `proxy()` called in-process: a fresh nonce on each of 50 calls; the *same* policy forwarded on the request headers; `CSP_REPORT_ONLY` switches the header name (request and response) and nothing else; any value but `true` stays enforcing |
| API (`csp.spec.ts`) | over real HTTP against the production build: the policy on pages, the 404 and redirects; **every `<script>` in the HTML, inline ones included, carries this response's nonce**; no `<style>` blocks or `style=""` attributes; a different nonce on each of 12 requests and none reused in another body; API responses carry the static policy; static assets none; `upgrade-insecure-requests` absent on the http deployment, present on the https one |
| browser (`csp.spec.ts`) | the real `/login` response with attacker markup spliced in: an inline `<script>`, an `onerror=` handler, a `<script src>` from another origin and a `javascript:` link are all inert and each raises the matching violation; an injected `<base>` is refused; hydration still works |
| every browser test | the shared `csp` fixture records every `securitypolicyviolation` and **fails any test in which one occurred** — so every existing flow (sign-in, setup, theme, shell, https …) is a CSP test, in both themes, on desktop and phone |

### Results

`pnpm test` (production build, then every project; against `octalve_edu_test`): **311 passed, 5 skipped by
design, 0 failed** (5.3 min) — setup 1, unit 33, integration 44, api 104, e2e-desktop 62 (+1 skipped),
e2e-mobile 59 (+4 skipped), https 8. Static: `tsc` clean, ESLint 0 problems, `next build` clean (the build now
lists `ƒ Proxy`). The browser tests all ran under the enforcing policy with **zero** violations.

### Mutation testing — 11 injected bugs, 11 caught

| # | Bug injected | Failures |
| :-- | :-- | --: |
| C1 | nonce dropped from `script-src` | 8 |
| C2 | `'unsafe-inline'` added to `script-src` | 5 |
| C3 | a constant nonce | 4 |
| C4 | nonce not forwarded on the request headers (Next's own scripts go un-nonced) | 1 |
| C5 | `upgrade-insecure-requests` unconditional | 2 |
| C6 | the https rule inverted | 4 |
| C7 | report-only for anything but exactly `true` | 1 |
| C8 | `'unsafe-eval'` always on | 5 |
| C9 | `frame-ancestors` dropped | 4 |
| C10 | `style-src` loses its nonce for a blanket `'unsafe-inline'` | 4 |
| C11 | API responses lose their policy | 1 |

## Findings and decisions

| # | Found by | What | Resolution |
| :-- | :-- | :-- | :-- |
| 1 | The first browser injection tests | **The "attack" ran.** Injecting `createElement("script")` via `page.evaluate` is exempt: `'strict-dynamic'` trusts script created by trusted script, and DevTools-evaluated code is exempt anyway. The tests proved nothing about markup injection. | Rewritten to splice the payload into the **real server response** (headers and policy intact) — what an XSS bug actually does. The design note records the property: the policy protects against markup injection, by design. |
| 2 | Wiring the fixture | Whether the whole existing suite survives the policy was unknown. | It does: ≈250 browser tests, zero violations — Next emits no inline styles, so `style-src` needed no fallback. |
| 3 | Reading Next's guide | The recommended matcher excludes `/api`. | Static `default-src 'none'; frame-ancestors 'none'` on the API from `next.config.ts`. |
| 4 | Updating `security-headers.spec` | `/favicon.ico` carried the old static `frame-ancestors` header and now (excluded from the proxy) carries no policy. | The assertion is for pages and the API; a static-asset test pins that it has none. |

## Explicitly not done in this phase
A report endpoint, Trusted Types, SRI (no third-party scripts), the public marketing sites (Phase 5). **Still to
come in this series:** 0.5.C password reset / change, 0.5.D TOTP MFA.
