# Phase 0.5.E — Account self-service (profile, change email, active sessions)

**Status: BUILT AND VERIFIED (2026-10-05) — awaiting the maintainer's merge.** Branch `claude/account-self-service` of
`roji-tech/octalve-edu-fork`, **stacked on `claude/dev-email-inbox`** (merge order: … → CSP → password reset → TOTP → dev inbox → this). Live
work log until the merge; append-only after. Design of record: plan → Phase 0.5 addenda → **0.5.E** ("Design for the
self-service half", written before any code) and its "As built" note. Same change in both repos (AlEemaan has its own
record). Test guide: `tests/README.md`. *Invite & activate* and administrator *deactivation* — the other halves of 0.5.E —
are deliberately deferred to the Users pages (§0.5.2).

## What this phase delivers
A signed-in person can now look after their own account without an administrator, and every step that could be abused by
someone holding only a stolen session asks for something that person would not have.
- **Edit your name.** `PATCH /api/v1/account/profile { name }`. One rule, `checkName()` (`lib/auth/profile-policy.ts`,
  client-safe, used by the form for instant feedback and by the route as the backstop): NFC-normalised, inner whitespace
  collapsed, trimmed, 1–100 *characters* (an emoji counts once), **no control characters and no bidirectional overrides**
  (they can make a name *display* as something else in a member list) — but zero-width joiners are allowed (Persian,
  Arabic, Indic scripts and emoji sequences need them). 10 changes per account per 5 minutes; an unchanged name writes
  and audits nothing; audit `PROFILE_UPDATED` with before and after. Only the caller's own row can be touched — extra
  fields (`id`, `email`, `passwordHash`, `role`) are ignored, never mass-assigned.
- **Change your email address, confirmed by a link to the NEW one.** `POST /api/v1/auth/email-change/request
  { newEmail, password }` re-verifies the **current password**, then answers the same generic `{ requested: true }`
  *whatever the address* — the lookup, the token and every email happen after the response (`after()`), and an address that
  already has an account gets a *notice instead of a link*, so a signed-in person can't probe which addresses exist
  (identical status, body and headers; timing within noise). The link — 256-bit, URL fragment, **hash only at rest,
  single use, one hour, one live request per person** (a new request kills the old link) — goes to the new address; the
  old address gets a notice with the new one masked. `POST …/email-change/confirm { token }` is **public** (the link is
  opened from a mail client) and, in **one transaction**, claims the token with a conditional update, sets the new email
  (`emailVerified` now) and deletes **every session, pending password-reset link, sign-in challenge and other
  email-change request** of that person — the email is the recovery channel, so nothing issued for the old one survives
  it. If the address was taken in the meantime the unique index refuses it, the whole transaction rolls back and the
  answer is the same generic "this link can't be used" (unknown, expired, used, malformed and contested are
  indistinguishable). It does *not* sign anyone in and clears the browser's session cookie. The old address is told it
  happened; audit `EMAIL_CHANGE_REQUESTED` / `EMAIL_CHANGED` with before and after.
  Limits: wrong passwords 5 per account per 5 minutes (a right one is refunded; typos cost nothing); *verified*
  requests 3 per account per 5 minutes; 3 per target address per 5 minutes (beyond that the same generic answer, but no
  mail — no mail-bombing a stranger through us, and no 429 that would reveal how often an address was asked for); confirm
  failures 10 per IP per 5 minutes, a success refunded.
- **Active sessions.** `GET /api/v1/auth/sessions` lists the caller's own unexpired sessions — *this device* first, a short
  description parsed from the stored user agent ("Chrome on Windows", "Safari on iPhone"), when it was created and last used,
  whether "Keep me signed in" was ticked — and never a token, a token hash or an IP address (none is stored; none was added).
  `POST …/sessions/revoke { sessionId }` ends one of the caller's *other* sessions (the current one is refused — that is
  Sign out); a session that isn't theirs answers **exactly like one that doesn't exist**, so ids can't be probed.
  `POST …/sessions/revoke-others` ends all but this one (it can only reduce access, so it needs no password). Audit
  `SESSION_REVOKED` / `SESSIONS_REVOKED` (nothing when nothing was revoked). The page fetches the list in the browser, so
  "5 minutes ago" uses the viewer's clock and language and there is no hydration mismatch; a device that was ended
  elsewhere in the meantime simply disappears from the list.
- **The screens.** The account page: **Profile** (Edit → Save / Cancel / Escape; unchanged = nothing sent), **Email
  address** (idle → form → "Check your inbox", the same screen whether or not the address is taken), Password, Two-step,
  **Active sessions** (live region announces what was ended; focus returns sensibly). `/confirm-email`: ready (waits for a
  click) → "Email address changed" → Continue to sign in, or "This link can't be used". Phone and desktop, both themes.

## Operations
Nothing to configure. Needs working email in production (`RESEND_API_KEY` + `EMAIL_FROM`, as since 0.5.C) — an address
change is impossible without the mail reaching the new address. Locally and on staging the dev inbox (0.5.F) shows the
link. The migration is one new table (`EmailChangeToken`), additive and live-data-safe. Operator note: a person who lost
access to *both* addresses is an administrator's problem (and one of the things the Users pages will solve); `mfa:reset`
and the password-reset flow are unchanged.

## Verification
`pnpm test` (Octalve Edu): **740 passed, 5 skipped by design, 0 failed** (17.1 min; it was 622) — unit 115, integration 131,
api 234, e2e-desktop 128 (+1 skipped), e2e-mobile 128 (+4), https 8. Static: `tsc`, ESLint, `next build` clean. New:
- **unit (28)** — `describeUserAgent` (ten real user-agent strings, the fallbacks, a 255-character window, markup can't
  come out), `maskEmail` (code points never split, anything not shaped like an address becomes `***`, the *last* `@`),
  `checkName` (names from six scripts survive intact; NFC; whitespace; the 100-*character* limit with emoji counted once;
  control characters, bidi overrides refused; zero-width joiners allowed), `relativeTime` (the clock is a parameter;
  "just now", truncation not rounding, clock skew).
- **integration (18)** — the token lifecycle (only the SHA-256 hash in the database — the plaintext is nowhere, checked with a
  `LIKE` over the whole row; one hour; one live request per person, others' untouched), the confirm transaction (address
  switched and marked verified; *only that person's* sessions, reset links, challenges and other requests gone and everyone
  else's intact; single use; **20 simultaneous confirmations → exactly one winner**; expired; unknown/malformed; **address
  taken in the meantime → refused and the whole transaction rolled back, nothing half-done**; a deleted user), and the session
  devices (own sessions only, *this device* first even when it is the oldest, never a token or hash, expired by idle **and**
  by absolute expiry hidden, the "kept signed in" flag, revoking one / all others scoped to the owner, a foreign id answers
  like an unknown one).
- **api (40)** — every route: 401 without a session, 403 cross-origin, 405 for GET; profile (normalised, other scripts intact,
  every refusal with its reason and nothing written, mass-assignment ignored, audit before/after once and nothing for an
  unchanged name, the 11th change a 429); sessions (the list is described and token-free, revoke one / refuse the current /
  foreign = unknown **byte for byte**, idempotent, revoke-others keeps this one and spares others, limits 30 and 10);
  change-email request (generic answer; the right mail in the right inbox — link to the new address, notice **without** a link
  and with the new address masked to the old one; nothing changes yet and the old address still signs in; **free and taken
  addresses identical in status, body and headers**, and within 40 ms in median response time; taken → notice, no link, no
  token; wrong password refused with nothing sent; the password-guess limit holds even for a later right guess and a success
  is refunded; verified-request limit not spent by typos or wrong passwords; per-address limit sends **no fourth mail** and
  never a 429; a new request kills the old link; validation); confirm (switches the address, signs the person out on **every**
  device, clears the cookie, does not sign in, old address stops signing in and the new one works with the same password,
  old address told afterwards, audited; single use; unknown / expired / used / malformed / "taken meanwhile" **identical**;
  a link opened while signed in as someone else changes only its owner; kills pending reset links; CSRF; IP limit, success
  refunded).
- **browser (desktop + phone)** — edit the name (Save, Cancel, Escape, unchanged = nothing sent, errors beside the field,
  header follows, focus returns), the whole email journey (request → inbox → link → *no request until the click* → address
  scrubbed from the bar → confirm → signed out here and on another device → old address refused, new one signs in), a used
  link and a link with no token, **a second link in the same tab** (here and on `/reset-password`), local validation, wrong
  password, own and taken addresses look like success; sessions (this device first, described, revoke one → *that* device is
  signed out, revoke all others, an already-gone device just vanishes); axe (WCAG 2.2 A/AA) in both themes, no horizontal
  scroll and ≥ 44 px targets on the phone for every state of the account page and of `/confirm-email`.
- Every browser test is still a CSP test (no violations).

### Mutation testing — 78 injected bugs, 78 caught (Octalve Edu); 25 re-run in AlEemaan, 25 caught
The tokens: stored in the clear; a day instead of an hour; reusable; an expired link still working; an earlier request not
killed. The confirm transaction: sessions kept; reset links kept; challenges kept; other requests kept; *everyone's* sessions
deleted; the address not marked verified; "taken" thrown instead of refused. The device list: expired and absolute-expired
sessions listed; everybody's listed; *this device* not first; revoke ignoring the owner; revoke-others also ending this one,
or everyone's; "kept signed in" always true; the token hash leaking. Pure helpers: control characters, bidi overrides allowed;
joiners refused; UTF-16 length; no NFC; whitespace not collapsed; limit 101; Edge reported as Chrome; a code point split; relative
time rounding, "just now" lasting too long or never. The profile route: not normalised, the rule not applied, no limit, mass
assignment, unchanged names audited, no "before". Sessions routes: the current session revocable; no limits; an audit row for
nothing. Change-email request: password not re-checked; a taken address answering differently, or also getting a link; the old
address not told; the link sent to the *old* address; no per-address / per-account / password limits; a success not refunded;
typos spending the password budget; no lower-casing; your own address accepted; no audit; either notice showing the full new
address. Confirm: no CSRF; a success not refunded; no IP limit; the cookie not cleared; no notice to the old address; no
audit; a malformed token refused differently; cacheable. The UI: the confirm page acting on arrival; the token left in the
address bar; a second link ignored (no `hashchange`) on `/confirm-email` and on `/reset-password`; the same link again not
resetting the page; Sign out on the current device; an already-ended device shown as an error; an unchanged name sent; the header
not following; the password kept after a failed request; focus lost after Cancel and after Save. **Everything was caught the
first time except two harness problems:** N11 (an *equivalent* mutant — the early "just now" return was redundant — so the dead
branch was removed) and P2 (the injected bug did not compile — redone as P2b and caught).

## Findings and decisions
| # | Found by | What | Resolution |
| :-- | :-- | :-- | :-- |
| 1 | Writing the API tests | The per-account request limit (3) was spent *before* the password check, so three typos locked the person out and the "5 wrong passwords" limit was unreachable. | The password limit comes first (refunded unless the password was wrong); the request limit counts only *verified* requests. Test: wrong passwords and typos don't spend the request budget. |
| 2 | First browser test | Two fields labelled "Current password" on one page (Password card and the new Email card). | The email form's field is "Your password" with a hint. |
| 3 | Browser test "link already used" | A second link opened in the same tab changes only the `#fragment` — no reload — so the page kept the first link's state. The same latent bug existed on `/reset-password` since 0.5.C. | `useFragmentToken()` (listens for `hashchange`, returns a `version`); both pages key their state on it. Tests on both. |
| 4 | Browser test | After Save, focus fell to `<body>`: a 0 ms timer runs before React commits after an `await` (Cancel, a click handler, worked). | Focus returns in an effect, after the commit. Same pattern in the email panel. |
| 5 | Reading the screenshots | The name editor showed "NAME" twice on a phone (the `<dt>` and the field's own label); the address wrapped mid-word. | The term is screen-reader-only while editing; `break-words` instead of `break-all`. |
| 6 | Design | An emailed confirmation link that acts on arrival can be spent by a mail scanner before the person ever sees it. | The page waits for a click; a test proves no request is made on arrival. |
| 7 | Mutation N11 | `relativeTime`'s early "just now" return was redundant (the fall-through returns the same) — an equivalent mutant. | Removed the dead branch. |
| 8 | Mutation P2 | The injected bug did not compile (type narrowing). | Re-done as P2b; caught. |

## Explicitly not done
*Invite & activate* and administrator *deactivation* (Users pages, §0.5.2); a "new sign-in from an unrecognised device"
notice; device location or IP (not stored); administrator-initiated email change; self-service account deletion;
per-device names or icons (every device shows the same monitor icon). **Next:** Octalve §0.5.2 (tenant trust boundary + RLS,
the app shell) / AlEemaan Phase 0.5.2 (School Settings), then the Users pages that finish 0.5.E.
