# Phase 0.5.4 — Users pages and invitations

**Status: BUILT AND VERIFIED (2026-10-06), mutation re-check of the survivors DEFERRED by the maintainer's decision to run all mutation passes together at the end of Phase 2.**
Branch `claude/app-shell-users` (stacked on the app-shell work; base of this record's follow-up commits: `78eb3f5`). Design of record: plan §"Build design — Users and invitations (0.5.4)", written before any code;
the "As built" paragraph follows it. Roadmap: `roadmap-breakdown.md` §0.5.4.

## What this delivers
- **Invitations.** An administrator of a school invites someone by email; the link carries a 256-bit token in the URL **fragment**, only its SHA-256 is stored, it is single-use, revocable and expires in seven days.
  One live invitation per (school, address) — a new one revokes the earlier (audited), guaranteed under concurrency by a partial unique index and an advisory lock. Mail goes out after the response.
- **Accepting.** `/accept-invite` previews the school, the role and a *masked* address, then: a person with no account chooses a name and a password (shape rules + the breached-password check; the link proves the address); an existing
  account is attached **only by its owner** (signed in as that address); signed in as someone else is refused; dead links (unknown, malformed, used, revoked, expired) are one answer. Everything happens in one transaction through a
  read-only RLS path (`app_invitation_hash()` / `forInvitation`), then the tenant context is set from the row the secret named. A failed accept leaves no user, no membership and an unspent link.
- **Members.** `/schools/[code]/users` and `GET/PATCH …/members`, `…/deactivate`, `…/reactivate`, `…/invitations` (+ resend, revoke): paged, filtered (role, campus, status, search with `%`/`_` escaped), edited and deactivated by an
  ADMIN of that school only; the last active administrator can be neither demoted nor deactivated (row-locked); nobody changes themselves; a foreign or unknown id is one 404; deactivation keeps the history and the person loses the
  school on their next request; reactivation restores the same row.
- **Screens** in the shell (table from `md`, cards on a phone), native `<dialog>` forms with focus returned, one live region, axe in both themes.

## Verification
**Gate, in order, all clean: `pnpm typecheck` → `pnpm lint` → `pnpm build` → the whole Playwright suite, one lane, Node 24 (2026-10-06, head of `claude/app-shell-users` at the time of the run).** There is no formatter in the repo at this point
(Prettier is added in a separate commit afterwards).

**1145 tests: 1112 passed, 23 skipped by design (the shell/brand/sign-in/theme project skips — no new skips), 10 timed out at the 30 s default, 0 assertion failures.** Per project: setup 1 · unit 171 · integration 288 · api 323 · e2e-desktop 177 · e2e-mobile 177 · https 8.
The 10 timeouts are `account-self-service.spec.ts:337`, and `responsive-and-a11y.spec.ts` :284, :322, :531, :579 (both viewports) and :621 (mobile). **They are a machine-speed problem, not a defect:** the same code and config passed them in 8–11 s on the
clean baseline run of 2026-10-06 (commit 78eb3f5, same `src/`, same lockfile), but on the machine used for this run the CPU was held near 800–975 MHz (a hardware/firmware cap, not the OS profile: governor `powersave`, profile *balanced*, turbo allowed,
on AC) and a stand-alone run of :322 took 37 s instead of 8 s. All ten **pass with the harness's own slow-machine knob, `TEST_TIMEOUT_SCALE=3`** (12 passed incl. setup and one neighbour) — nothing was skipped, retried or loosened; the timeout multiplier only
stretches the clock. **Risk to record:** the long axe tests have little headroom (8–17 s of 30 s on a healthy machine); on a slow or throttled machine run the suite with `TEST_TIMEOUT_SCALE=2` or more, or on a machine that is not power-capped.

### Mutation testing — 122 injected bugs, first pass: 102 caught, 19 survived, 1 did not compile
The runs used the parallel runner (`handoff/tools/run-mutations-parallel.py`, 3 lanes, unmutated baseline first; parity with the serial runner was checked on six mutations). **Every survivor was a missing or weak test or an equivalent mutant**:
fifteen got new tests (listed below), five are justified-equivalent. The 15 survivors' **re-run was started and then stopped** when the maintainer postponed all mutation testing to the end of Phase 2 — their tests are written, pass, and are
covered by the deferred pass; until that runs they are *not* proven to kill their mutants.

| id | injected bug | first pass | disposition |
| :-- | :-- | :-- | :-- |
| I1 | no advisory lock: two administrators inviting the same person at once collide on the index | CAUGHT |  |
| I2 | a campus of ANOTHER school is accepted on an invitation (the check is dropped) | CAUGHT |  |
| I2b | campus lookup not scoped to the school (EXPECTED EQUIVALENT: Campus row-level security scopes it anyway) | SURVIVED | **Equivalent** — `Campus` row-level security already scopes the lookup to the school; removing the explicit `tenantId` filter cannot change a result (the query still names the tenant elsewhere). |
| I3a | a deactivated member is reported as an ordinary member | CAUGHT |  |
| I3b | a deactivated member CAN be invited again (instead of 'reactivate them') | CAUGHT |  |
| I3c | the member check matches ANY member of the school, not the invited address | CAUGHT |  |
| I4a | an earlier open invitation is not revoked when a new one is made | CAUGHT |  |
| I4b | the replaced invitation is revoked but not audited | CAUGHT |  |
| I5a | the TOKEN, not its hash, is stored | CAUGHT |  |
| I5b | who invited is not recorded | CAUGHT |  |
| I5c | the new invitation lasts one day, not seven | CAUGHT |  |
| I5d | creating an invitation is not audited | CAUGHT |  |
| I5e | the TTL constant is 30 days | SURVIVED | Test added (`SEVEN_DAYS_MS` literal, pinned constants). *Re-check pending.* |
| I6a | resend does not replace the token (the earlier link keeps working; the new one does not exist) | CAUGHT |  |
| I6b | resend does not renew the expiry | CAUGHT |  |
| I6c | an ACCEPTED invitation can be resent | CAUGHT |  |
| I6d | a REVOKED invitation can be resent | CAUGHT |  |
| I6e | resend is not audited | CAUGHT |  |
| I7a | an ACCEPTED invitation can be 'revoked' (and the answer is success) | CAUGHT |  |
| I7b | revoking an already-revoked invitation succeeds again (and is audited twice) | CAUGHT |  |
| I7c | revoke is not audited | CAUGHT |  |
| I8a | the open-invitations list includes revoked ones | CAUGHT |  |
| I8b | the open-invitations list includes accepted ones | SURVIVED | Test added (an accepted invitation must not be listed). *Re-check pending.* |
| I8c | the list is oldest first | CAUGHT |  |
| I8d | the list is not scoped to the school (EXPECTED EQUIVALENT: Invitation row-level security scopes it anyway) | SURVIVED | **Equivalent** — `Invitation` RLS scopes the list; the explicit filter is the belt, RLS the braces. |
| I8e | the token HASH is selected and returned in every invitation the API shows | CAUGHT |  |
| V1 | preview shows a used / revoked / expired invitation | CAUGHT |  |
| V2 | preview shows the FULL address | CAUGHT |  |
| V3 | preview says every signed-in viewer is the invitee | CAUGHT |  |
| V4 | status: an invitation is 'pending' at the instant it expires (>= instead of >) | CAUGHT |  |
| V5 | status: revoked outranks accepted | CAUGHT |  |
| V6 | status: an expired invitation is still 'pending' | CAUGHT |  |
| T1 | the token is 16 bytes (128 bits), not 32 | CAUGHT |  |
| T2 | the token shape check accepts any string | CAUGHT |  |
| T3 | the stored form changes (sha1 instead of sha256) | CAUGHT |  |
| A1 | accept does not check the invitation is live (the claim alone decides) | CAUGHT |  |
| A2 | someone signed in as ANOTHER account attaches the invitee's account | CAUGHT |  |
| A3 | a signed-out token holder attaches an EXISTING account (no sign-in needed) | CAUGHT |  |
| A4 | an ACTIVE member can accept again (and have their role rewritten) | CAUGHT |  |
| A5 | a deactivated member cannot come back through an invitation | CAUGHT |  |
| A6 | the claim ignores 'already accepted' (single use rests on the pre-read only) | SURVIVED | Test added: deterministic lost race (row held in a second connection). *Re-check pending.* |
| A7 | the claim ignores 'revoked' | SURVIVED | Test added: deterministic lost race (revoked in the meantime). *Re-check pending.* |
| A8 | the claim does not count the rows it changed | SURVIVED | Test added: deterministic lost race (claim count). *Re-check pending.* |
| A9 | a new account's address is not marked verified | CAUGHT |  |
| A10 | an account created in the meantime (unique violation) is a 500, not 'sign in' | SURVIVED | Test added: an account appears in the meantime → `SIGN_IN_REQUIRED`. *Re-check pending.* |
| A11 | reactivation leaves the person deactivated | CAUGHT |  |
| A12 | reactivation keeps the OLD role and campus | CAUGHT |  |
| A13 | the new membership ignores the invited campus | CAUGHT |  |
| A14 | the new membership ignores the invited role (always a parent) | CAUGHT |  |
| A15 | who accepted is not recorded | CAUGHT |  |
| A16 | acceptance is audited under the wrong action name | CAUGHT |  |
| A17 | the tenant context is never set from the invitation row (every write is refused by row-level security) | CAUGHT |  |
| M1a | an administrator can change THEMSELVES | CAUGHT |  |
| M1b | an administrator can deactivate THEMSELVES | CAUGHT |  |
| M1c | an administrator can 'reactivate' themselves (differs only by answer: SELF vs a quiet no-op — a test should still pin it) | CAUGHT |  |
| M2 | a deactivated member can still be changed | CAUGHT |  |
| M3 | a member's campus can be set to another school's campus | CAUGHT |  |
| M3b | campus lookup not scoped to the school (EXPECTED EQUIVALENT: Campus row-level security scopes it anyway) | SURVIVED | **Equivalent** — same reasoning as I2b for the member campus lookup. |
| M4 | a no-op change is written and audited as a change | CAUGHT |  |
| M5 | the role counts as changed whenever one is given (an audit entry for nothing) | CAUGHT |  |
| M6 | the campus counts as changed whenever one is given | CAUGHT |  |
| M7 | the last-administrator rule also blocks changing a non-administrator's role | CAUGHT |  |
| M8 | demoting an administrator never checks for another one | CAUGHT |  |
| M9 | deactivating an administrator never checks for another one | CAUGHT |  |
| M10 | the administrator count has no row lock (two administrators demote each other at the same instant) | CAUGHT |  |
| M11 | a deactivated administrator counts as 'another administrator' | CAUGHT |  |
| M12 | the threshold is 'at least one' (the last administrator is never the last) | CAUGHT |  |
| M13 | search text is a pattern ('%' lists everyone) | CAUGHT |  |
| M14 | the default status filter shows deactivated people too | CAUGHT |  |
| M15 | the member list leaks the whole row (ids, timestamps) | CAUGHT |  |
| M16 | pages are ordered without a tiebreak (rows with the same name may repeat or vanish across pages) | SURVIVED | Test added: same-name members, inserted in reverse address order, paged by 2. *Re-check pending.* |
| M17 | the member list is not scoped to the school (EXPECTED EQUIVALENT: TenantMembership row-level security scopes it anyway) | SURVIVED | **Equivalent** — `TenantMembership` RLS scopes the member list; the explicit filter is the belt. |
| M18 | reactivation is audited under the wrong action name | CAUGHT |  |
| M19 | deactivation does not record the person's role and campus | SURVIVED | Test added: the deactivation audit row carries the former role and campus. *Re-check pending.* |
| D1 | the tenant resolver still honours a deactivated membership | CAUGHT |  |
| D2 | the person's school list still shows a deactivated membership | CAUGHT |  |
| D3 | the sign-in audit still counts a deactivated membership's school | CAUGHT |  |
| D4 | a deactivated administrator still makes the instance 'has an administrator' | CAUGHT |  |
| H1 | GET members: any signed-in member of the school can list people | CAUGHT |  |
| H2 | PATCH member: any member can change people | CAUGHT |  |
| H3 | deactivate: any member can deactivate people | CAUGHT |  |
| H4 | reactivate: any member can reactivate people | SURVIVED | Test added: a non-admin cannot reactivate. *Re-check pending.* |
| H5 | GET invitations: any member can list invitations | CAUGHT |  |
| H6 | POST invitations: any member can invite | CAUGHT |  |
| H7 | revoke: any member can revoke invitations | CAUGHT |  |
| H8 | resend: any member can resend invitations | SURVIVED | Test added: a non-admin cannot resend or revoke. *Re-check pending.* |
| H9 | PATCH member accepts keys it does not name (tenantId, passwordHash…) and ignores them | CAUGHT |  |
| H10 | POST invitation accepts keys it does not name | CAUGHT |  |
| H11 | invited addresses keep their case (two spellings → two invitations) | CAUGHT |  |
| H12 | invited addresses are not trimmed | CAUGHT |  |
| H13 | preview: no CSRF check | CAUGHT |  |
| H14 | accept: no CSRF check | CAUGHT |  |
| H15 | accept: a successful acceptance is not refunded from the per-IP limit | CAUGHT |  |
| H16 | accept: the breached-password check is skipped for new accounts | CAUGHT |  |
| H17 | accept: the per-IP limit is effectively off | CAUGHT |  |
| H18 | preview: the per-IP limit is effectively off | SURVIVED | Test added: forty previews per IP, the forty-first is a 429. *Re-check pending.* |
| H19 | invite: the per-address limit is effectively off | CAUGHT |  |
| H20 | resend: the per-invitation limit is effectively off | CAUGHT |  |
| H21 | the mailed link carries the token in the QUERY (it would reach server logs) | CAUGHT |  |
| H22 | accept: a name that fails the profile rules is accepted | BUILD-FAIL | **Equivalent** — the `!checkedName.ok` clause is a type-narrowing guard (it makes `checkedName.name` legal below); when `!ok`, `details` already has an entry. The mutant does not compile. |
| Q1 | Invitation: ENABLE row level security dropped | CAUGHT |  |
| Q2 | Invitation: FORCE dropped | CAUGHT |  |
| Q3 | Invitation: the invitee's hash path to READ is removed (preview/accept could not find the row) | CAUGHT |  |
| Q4 | Invitation: any tenant's invitations readable | CAUGHT |  |
| Q5 | Invitation: rows can be inserted for another tenant | CAUGHT |  |
| Q6 | Invitation: a row can be updated to belong to another tenant (WITH CHECK dropped) | CAUGHT |  |
| Q7 | Invitation: any tenant's invitations can be updated | CAUGHT |  |
| Q8 | Invitation: any tenant's invitations can be deleted | CAUGHT |  |
| Q9 | the one-live-invitation index is gone | CAUGHT |  |
| Q10 | the one-live-invitation index is not partial (a revoked or accepted row would block a new invitation) | CAUGHT |  |
| Q11 | the token hash is not unique | SURVIVED | Test added: a duplicate token hash is refused. *Re-check pending.* |
| Q12 | an empty hash setting matches rows (NULLIF dropped; only matters if a row with an EMPTY hash exists — a test should insert one) | SURVIVED | Test added: a blank hash setting matches no row, even one stored with `''`. *Re-check pending.* |
| Q13 | the tenant foreign key is dropped (EXPECTED to be caught only if a test checks referential integrity / cascade on school removal) | SURVIVED | Test added: the tenant foreign key refuses a ghost school and cascades on removal. *Re-check pending.* |
| U1 | your own row offers Edit/Deactivate | CAUGHT |  |
| U2 | your own row has no 'You' marker | CAUGHT |  |
| U3 | the invite form sends no campus | CAUGHT |  |
| U4 | the invite form always sends the default role | CAUGHT |  |
| U5 | the deactivate dialog no longer opens on Cancel (the safe choice) | SURVIVED | Test added: the safe choice (Cancel) has initial focus in the deactivate dialog. *Re-check pending.* |
| U6 | 'Next page' is never disabled | CAUGHT |  |
| U7 | the Users page does not refuse non-administrators | CAUGHT |  |
| U8 | the accept page lets the Referer carry the link | CAUGHT |  |
| U9 | the accept form does not compare the two passwords | CAUGHT |  |

## Findings and decisions
1. **The mail outbox swallowed corruption** — a half-written `tests/.tmp/outbox.jsonl` made 63 mail tests fail with misleading timeouts. `readOutbox()` now throws on a corrupt line, and the setup project empties the file each run (`tests/unit/outbox.spec.ts`).
2. **A vacuous CSP test** — the `javascript:` link test could pass against a report-only policy; the payload now uses `void(…)` (a string result replaces the document and wipes the evidence) and polls for the report.
3. **A mis-built rate-limit test** (the tenth failure after a refunded success) and the **load-sensitive timing tests** (account-self-service, password-reset, two a11y two-step tests) which pass in 6–12 s of a 30 s timeout on a quiet machine — a risk, not a defect; run the one-lane suite on an idle machine.
4. **Lost races were tested only by luck** — the single-use claim's conditions (A6–A8, A10) matter only when a row changes *after* it was read; `whileHeld()` in `tests/integration/invitations.spec.ts` now makes that deterministic (hold the change in a second connection, wait for the lock wait, commit).
5. **Equivalent mutants are real** — four are redundant explicit filters sitting on top of RLS, one is a type-narrowing guard.

## What is not done (and why)
- **Admin-initiated email change (0.5.4-F)** — deliberately not built: the address is the person's *global* login identity (design item 7). Still designed, still open.
- **The survivors' mutation re-check** — deferred (see above).
- Reconciled in the trackers (not new work): roadmap rows 0.5.2-D T4–T6, 0.5.2-G and the 0.5.3 heading were verified against the code and ticked.
