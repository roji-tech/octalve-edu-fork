# Phase 0.5.C — Password reset and change

**Status: BUILT AND VERIFIED (2026-10-04) — awaiting the maintainer's merge.** Branch `claude/password-reset` of
`roji-tech/octalve-edu-fork`, **stacked on `claude/csp-nonce`** (merge order: …→ design language → CSP → this). Live work log until
the merge; append-only after. Design of record: plan → Phase 0.5 addenda → **0.5.C** (written first) and its
"As built" note. Same change in both repos (AlEemaan's record is on its `claude/password-reset`). Test guide: `tests/README.md`.

## What this phase delivers
- **Forgot password** — `/forgot-password` and `POST /api/v1/auth/forgot-password`. The answer is **identical**
  whether or not the address has an account (status, body, headers, and timing — the lookup, token and email run
  in `after()`, i.e. after the response). Limits count every request: 10 per IP and 3 per address per 5 minutes;
  the per-address limit answers the same generic 200, never a 429 (which would reveal the address).
- **Reset** — the emailed link is `/reset-password#token=…`: the token is in the URL **fragment** (never sent to a
  server, so not in logs or a Referer); the page reads it and removes it from the address bar. `POST
  /api/v1/auth/reset-password` claims the token with a conditional `updateMany` (exactly one winner, even for
  concurrent requests), sets the password, **deletes every session of that person**, drops their other links and
  clears the browser's cookie — in one transaction. Unknown, expired and used links get the same 400. It does
  **not** sign anyone in (and, once 0.5.D exists, never bypasses a second factor).
- **Change** — `POST /api/v1/auth/change-password` behind `withAuth`: the *current* password is re-verified
  (constant time; 5 wrong attempts per account per 5 minutes), the new one must pass the rule and differ, all
  **other** sessions are revoked and this one kept. UI: a Password card on the account page.
- **One password rule** — `checkNewPassword()` (≥ 8, ≤ 128, ≤ **72 bytes**, a letter, a number); setup, reset,
  change and the live form feedback all call it.
- **Email** (`lib/email/`) — `resend` (plain `fetch`, no SDK), `console`, `file` transports via `EMAIL_TRANSPORT`;
  plain-text messages; a "your password was changed" notice after a reset or change; failures are logged,
  never shown. A console transport in production logs a loud warning.
- **Tokens** — 256-bit, only the SHA-256 hash stored (`PasswordResetToken`), 30-minute expiry, one live link per
  person. Migration is additive; the never-used Auth.js `VerificationToken` table is dropped.
- The sign-in screen's **"Forgot password?"** link (in the artifact, withheld until it led somewhere) is live.
- Audit rows `PASSWORD_RESET` / `PASSWORD_CHANGED`.

## Verification
`pnpm test`: **377 passed, 5 skipped by design, 0 failed** (5.5 min) — unit 36, integration 58, api 127,
e2e-desktop 75 (+1 skipped), e2e-mobile 72 (+4), https 8. Static: `tsc`, ESLint, `next build` clean. New: the shared
password rule (unit); the token library under concurrency — **20 simultaneous attempts, exactly one wins** — plus
hash-at-rest, expiry, single use, cascade (integration); the email transports and messages (integration); the three
routes over real HTTP — identical answers for known/unknown addresses, a statistical timing-parity check, every
limit, CSRF, sessions revoked, old password dead / new one live, change-password's current-password and
other-sessions rules (api); and in a real browser the whole journey (forgot → "inbox" → link → fragment scrubbed →
new password → other device signed out → sign in), the dead/used/incomplete-link states, inline errors that don't
spend the link, the account card, and axe in both themes for all the new screens and states, with phone tap targets.

### Mutation testing — 18 injected bugs, 18 caught
Token stored in plaintext; used links reusable; expiry unchecked at claim; sessions left alive by a reset; asking
again not killing the earlier link; a malformed email answered differently; no per-address limit; no per-IP limit
on forgot; none on reset; password rule skipped on reset; reset leaving the session cookie; change without the
current password; change not revoking other sessions; change revoking *this* session; no per-account limit on
change; same password accepted; token in the query string; and a weak-password typo counting against the IP
limit. **One survived the first time** (the typo refund) — the tests had no case for "typos never lock anyone
out"; one was added and the mutation re-run: caught.

## Findings and decisions
| # | Found by | What | Resolution |
| :-- | :-- | :-- | :-- |
| 1 | The first full run | The sign-in keyboard-order test assumed Tab went email → password; the new link sits in the Password label row, so it is now email → *Forgot password?* → password. Two new text links were 18 px tall — under the ≥ 44 px phone rule. | Test updated (and now asserts the link is a stop); links get `min-h-11`. |
| 2 | Mutation P18 | A mutation survived (above). | A test for it; caught. |
| 3 | Designing for Octalve | Its `AuditLog` requires a tenant; a password event is about a person. | One row per school the person belongs to (AlEemaan: one row). |
| 4 | Designing the page | A token in the query string leaks via logs and Referer. | URL fragment, scrubbed on load, `referrer: no-referrer` on the page. |

## Explicitly not done
Admin-initiated resets (with Users), breached-password check, SMS/security questions, the active-devices page —
and the extras mapped in plan §0.5.E (invite/activate, change email, edit profile, deactivation). **Next in this
series:** 0.5.D TOTP two-step verification.
