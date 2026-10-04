# Phase 0.5.D — TOTP two-step verification

**Status: BUILT AND VERIFIED (2026-10-05) — awaiting the maintainer's merge.** Branch `claude/totp-mfa` of
`roji-tech/octalve-edu-fork`, **stacked on `claude/password-reset`** (merge order: …→ design language → CSP →
password reset → this). Live work log until the merge; append-only after. Design of record: plan → Phase 0.5
addenda → **0.5.D** (written first, 2026-09-30) and its "As built" note. Same change in both repos (AlEemaan's
record is on its `claude/totp-mfa`). Test guide: `tests/README.md`.

## What this phase delivers
- **Sign-in in two steps for anyone with an *active* second factor.** `POST /api/v1/auth/login` verifies the
  password exactly as before; for an account with a confirmed credential it then creates **no session and sets no
  cookie** — it answers `{ mfaRequired: true, challenge }` (no user details), and the wrong-password answers are
  unchanged, so MFA status is revealed only to someone who already has the password. `POST /api/v1/auth/login/mfa`
  `{ challenge, code | recoveryCode }` is the only thing that then creates a session — with the "Keep me signed in"
  choice made at step 1, which travels inside the challenge (step 2 cannot change it). Both steps create sessions
  through one function, `completeSignIn()`.
- **The challenge** (`MfaChallenge`) is the "pending MFA" state promised since §0.5.1: 256 random bits, stored only
  as a SHA-256 hash, 5 minutes, **5 attempts spent atomically before the code is checked**, consumed by the
  successful one (exactly one of N simultaneous successes wins), at most 5 live per person, killed by a password
  reset or change. Held only in the sign-in page's memory — never storage, URL or cookie.
- **Our own RFC 6238 TOTP** (`lib/auth/mfa/totp.ts`, ~60 lines over `node:crypto`): HMAC-SHA1, 6 digits, 30 s,
  current step ±1, constant-time compare, base32 160-bit secrets — **checked against the RFCs' published vectors**.
  **Replay-proof:** the highest accepted step is stored and advanced with a conditional update, so a used code (or
  an older one) is refused, and ten simultaneous submissions of one code produce exactly one success.
- **Secrets encrypted at rest** (`secret-box.ts`): AES-256-GCM under a key derived (HKDF) from `MFA_ENCRYPTION_KEY`,
  with the owner's id as AAD — a database leak alone yields nothing, and a ciphertext moved to another person's row
  doesn't decrypt. **No key, no MFA, in every environment** (enrolment and step 2 answer 503; no dev fallback).
- **Recovery codes:** ten single-use `XXXXX-XXXXX` codes (Crockford base32, exactly 50 random bits), shown once,
  stored as **keyed** hashes (HMAC under a derived key — 50-bit codes would fall to offline grinding if hashed
  plainly), each spent by a conditional update (ten simultaneous uses of one code: one winner). A recovery-code
  sign-in reports how many are left and emails the person.
- **Managing it** (account page → "Two-step verification" card; every action re-asks for something a stolen
  session lacks): `POST /api/v1/auth/mfa/enroll {password}` (secret returned once; stored *unconfirmed* — not an
  active factor), `…/confirm {code}` (activates, issues the ten codes, signs out the other devices, notice + audit),
  `…/disable {password, code|recoveryCode}` (password checked *before* the one-time code is spent), `…/recovery-codes
  {code}` (authenticator code only; replaces all). Audit rows `MFA_ENABLED` / `MFA_DISABLED` /
  `MFA_RECOVERY_CODE_USED` / `MFA_RECOVERY_CODES_REPLACED` / `MFA_RESET`.
- **Limits on step 2:** per challenge 5; per **account 10 failures / 5 min across every challenge** (the real
  bound for someone who knows the password and can mint challenges); per IP 30. Correct codes are refunded; a
  malformed one is a typo, not a guess, and is refunded too.
- **The screens:** sign-in step 2 in place on the card (numeric `one-time-code` field, "Use a recovery code
  instead", "Back to sign in", the same error/pause treatment), the account card's states (off → password → scan →
  recovery codes → on / low-on-codes warning / replace / turn off), recovery codes with Copy and Download and a
  "I have saved them" gate. The QR code is drawn **in the browser** (pinned `qrcode`, dynamic import) — never by a
  third-party service.
- **`pnpm mfa:reset -- <email>`** — operator recovery for someone who lost both factors (plain Node + Prisma,
  not reachable over HTTP; removes the factor, signs the person out everywhere, audits).
- Fix on the way: the header's "Sign out" button wrapped onto two lines on narrow phones; it is icon-only below `sm`.

## Operations
- **Set `MFA_ENCRYPTION_KEY`** (`openssl rand -base64 32`) before anyone can enrol; keep it out of the database
  and out of database backups. Without it the account card tells people two-step verification isn't available.
- **Changing or losing the key makes every stored secret undecryptable**: affected people get a 503 at step 2 and
  must be reset with `pnpm mfa:reset -- <email>` and re-enrol. (Key rotation with re-encryption is not built; the
  box is versioned (`v1.`) so it can be added.)
- Existing sign-in behaviour is untouched for everyone who has not enrolled; the migration is additive (three
  new tables).

## Verification
`pnpm test`: **548 passed, 5 skipped by design, 0 failed** (10 min; it was 377) — unit 63, integration 94, api 185,
e2e-desktop 100 (+1 skipped), e2e-mobile 97 (+4), https 8. Static: `tsc`, ESLint, `next build` clean; the migration
matches the schema (`prisma migrate diff` against a shadow database). New:
- **unit** — base32 against RFC 4648's vectors; HOTP against RFC 4226 appendix D; TOTP against RFC 6238 appendix B;
  the ±1 window and replay rule at fixed times; the `otpauth://` URL (an account name can't break out of the label);
  the AES-GCM box (round trip, no plaintext, fresh IV, tamper in any of the three parts, wrong owner, wrong key,
  malformed, fail-closed without a valid key, derived keys differ and the root is never used raw); recovery codes
  (format, uniform over all 32 symbols, normalising `o`/`i`/`l`, keyed hash).
- **integration** — the challenge lifecycle (hash at rest, **no session exists**, 5 attempts, *20 simultaneous
  guesses spend exactly 5*, expiry, single use under concurrency, bounded growth); enrolment (encrypted and
  unconfirmed, not an active factor, restart replaces it, **8 simultaneous confirmations: one winner, one set of
  codes**); verification (**10 simultaneous submissions of one code: exactly one succeeds**, replay, stale/future
  codes, another person's code, a box moved to another row); recovery codes (once each, **10 simultaneous uses: one
  winner**, regenerate kills the old set); disable; **a password reset leaves MFA on and kills pending
  challenges**; cascade on delete; no key / a different key (503 in-process, nothing spent); and `mfa:reset` run as
  a child process.
- **api** — step 1 over real HTTP (no cookie, no session, no user details; a wrong password answers *identically* for
  accounts with and without MFA; an unconfirmed credential changes nothing; a presented cookie neither skips step 2
  nor is rotated away until it succeeds); step 2 (cookie flags, `remember` carried by the challenge and not
  upgradeable, the admin cap, wrong/stale/foreign codes, **five wrong codes kill the challenge**, 20 simultaneous
  guesses, single use, expired/unknown/garbage all identical, **replay incl. 8 concurrent challenges with one code**,
  recovery codes with email + audit, typos never spend an attempt or the IP's allowance, **per-IP and per-account
  limits**, success refunded, CSRF); the four management routes (401/403/405, re-authentication, limits, sessions
  revoked, notices, audit, one person's session can't touch another's factor).
- **browser** — the whole journey (turn on → recovery codes → sign out → two-step sign-in → turn off → single-step
  again), **the QR code decoded with `jsqr` and checked against the key beside it**, nothing in storage/URL/cookie,
  cancel, every error state, step 2's focus/Enter/toggle/back/expiry/lock-out, remembered vs session cookie through
  step 2, Download and Copy, low-on-codes; and axe in **both themes** with phone tap targets on every new state
  (step 2 incl. the paused state; password, scan, wrong code, recovery codes, on, low, regenerate, turn-off).
- Every browser test is still a CSP test (the new QR `data:` image and the download pass the strict policy).

### Mutation testing — 49 injected bugs, 49 caught (in both repos)
Each run: the spec unmutated first (green — the full suite), then one bug injected, the targeted specs red, file
restored, tree verified clean. **Crypto:** the drift window widened; a different digit count; the secret stored without
encryption/authentication; the AAD dropped; a built-in key when none is set (fail *open*); the root key used raw;
recovery codes under a plain SHA-256; a biased recovery alphabet. **Service:** both replay defences removed; *only* the
conditional update removed (the read-then-write race); a recovery code reusable; confirm not recording its step;
confirm not conditional on "still unconfirmed"; starting enrolment deleting a *confirmed* credential; an unconfirmed
credential counting as active; regenerate/disable leaving codes behind. **Challenge:** reusable after success;
unlimited attempts; expiry ignored; attempts not spent; `remember` dropped; reset/change leaving challenges alive;
**a reset switching MFA off**; unbounded challenges per person. **Routes:** a **session at step 1 (password alone)**;
step 2 forcing a persistent cookie; no per-IP / per-account limit; typos counted; no CSRF; challenge never consumed;
a session even for a wrong code; both factors accepted at once; enrol/disable without the password; disable without a
factor; disable burning the one-time code *before* checking the password; confirm/disable not signing out other
devices; no limit on confirm; recovery-codes needing no factor; no audit on a recovery sign-in. **UI:** the form
ignoring `mfaRequired`; the recovery-codes screen leavable without the "saved" tick; the QR encoding the wrong thing;
the challenge written to `sessionStorage`; the browser's typo check skipped. Almost every one is caught by *one named
test* rather than a pile of collateral failures. One mutation (L1) first failed to *compile* (TypeScript rejected the
injected `if (false && …)`); it was re-injected in a form that compiles and caught.

## Findings and decisions
| # | Found by | What | Resolution |
| :-- | :-- | :-- | :-- |
| 1 | Designing the storage | Recovery codes have 50 bits; under a plain SHA-256 a stolen table could be ground offline. | HMAC-SHA256 under a key derived from `MFA_ENCRYPTION_KEY`; a test shows the hash changes with the key. |
| 2 | Designing the challenge | Counting attempts with read-then-write lets simultaneous guesses all slip under the limit. | A conditional increment, spent *before* the code is checked; 20 simultaneous guesses → 5 checked (API + integration). |
| 3 | Building the screens | `node:crypto` can't be in a client bundle, but the screens must apply the same code-shape rules as the server. | `lib/auth/mfa/codes.ts` is browser-safe; the server modules re-export from it. (Now a rule in `CLAUDE.md`.) |
| 4 | ESLint | `useRecoveryCode` looked like a React hook to `react-hooks/rules-of-hooks`. | Renamed `spendRecoveryCode`. |
| 5 | Writing the API tests | The server accepts the current step ±1, so a code the server must *refuse* at ±2 is flaky at a step boundary. | Offset 0 to accept, ±3 to refuse; `rewindMfa()` for "time has passed"; written up in `tests/README.md`. |
| 6 | In-process route tests | A `NextRequest` built from a URL has no `Host`, so the CSRF check answered 403. | The test sends `x-forwarded-host`. |
| 7 | Looking at the screenshots | The header's "Sign out" wrapped onto two lines on a Pixel 7 (not new — the new screens exposed it). | Icon-only below `sm`; the accessible name is unchanged. |
| 8 | Reviewing the failure paths | A stored secret the current key can't read (key changed, row altered) surfaced as an opaque 500. | `MfaUnavailableError` for every decrypt failure → 503 on all routes; a test; documented under Operations. |
| 9 | Mutation L1 | The mutation itself didn't compile. | Re-injected in a compiling form. |
| 10 | Product decision | Confirming records the step it used, so the code that *turned it on* can't also sign in. | Kept: the next code (≤ 30 s) works; the confirm screen and tests are written around it. |

## Explicitly not done
WebAuthn/passkeys and SMS codes (a later, separate design), trusted-device "remember for 30 days" (it would
quietly weaken the factor), mandatory-MFA policy for administrators and step-up re-verification before sensitive
Settings edits (policy layers — they arrive with the Settings work), key rotation with re-encryption, an admin
screen for resetting someone's factor (with Users), and an active-devices page. **Next:** 0.5.E account-lifecycle
extras are planned in the plan doc; then §0.5.2.
