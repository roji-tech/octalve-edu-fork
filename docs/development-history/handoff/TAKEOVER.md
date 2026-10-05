# Takeover — everything that is left, in order

**Read this first, then `PHASE-1-SLICE-1-PROMPT.md` (the ground rules there apply to everything below).**

The maintainer has handed development to **Claude Code running locally**. The previous ("reviewer") Claude session stops pushing to this
repository while you work and will resume later — on the maintainer's word — by **pulling your branch, reading your hand-off, and reviewing
the diff cold**. So: leave the repository in a state a stranger can verify, and write down everything you could not.

**Base:** the head of `fork/claude/app-shell-users` (remote `fork` = `roji-tech/octalve-edu-fork`). Record the SHA you started from in your hand-off.
No PRs, no merging (the maintainer merges), no force-push, no rewriting history, no skipped/disabled tests, no retries.

---

## 1. State at the hand-over — be sceptical of it

| Area | State |
| :-- | :-- |
| 0.5.2 application layer + RLS, app shell (0.5.2-H), 0.5.3 API infrastructure | built, mutation-tested, verified, documented (phase records `phase-0.5.2-tenant-boundary.md`, `phase-0.5.2H-app-shell.md`, `phase-0.5.3-api-infrastructure.md`) |
| Test lanes (`pnpm test:lanes`, `scripts/lanes.mjs`) | built, **not yet proven equivalent to the one-lane run** (see step 6). The one-lane `pnpm test` is the reference |
| **0.5.4 Users pages and invitations** | **built** (migration `20261009090000_users_invitations`, libraries, 9 routes, Users page, accept-invite page, tests) **and WIP-committed** — but its **mutation pass, a complete green run, and its docs/records are NOT done** |
| Two test files strengthened after the last run | `tests/integration/invitations.spec.ts` (the two-simultaneous-accepts race now loops 6 rounds) and `tests/api/invitations.spec.ts` (failures after a successful accept must still answer 400). **Never run** — the reviewer's sandbox lost its database before they could be. Committed separately, marked unverified |
| The mutation set for 0.5.4 | **written, never run**: `handoff/tools/users-mutations.py` (122 mutations) + `handoff/tools/run-mutations.py` |
| Last complete suite run | the first *scheduled-lane* run (11.6 min, 5 failures); each failure was then root-caused and fixed (deterministic Users-page focus, load-tolerant timeouts, recipient-based dev-inbox assertion, `test.slow()` on one `/account` test) and the fixed tests were run individually — **but no complete green run has been recorded since**. Treat the baseline as unknown until step 1 says otherwise |
| Why the reviewer could not continue | the reviewer's cloud container restarted and its sandbox Postgres (a hand-started cluster on :5433) did not come back; an attempt to relocate and restart it was **denied by the sandbox's permission classifier** and was not worked around. Nothing in this repository depends on that; you have your own `docker compose up -d db` |

## 2. Order of work

### Step 1 — baseline (do not skip; do not build on red)
Environment as in the brief §2 (Docker Postgres 16 on 5433, `pnpm db:roles`, `redis-server` on PATH, Chromium). Then **on `fork/claude/app-shell-users` as it is**:
```
pnpm install && pnpm exec prisma migrate deploy && pnpm db:roles
pnpm typecheck && pnpm lint && pnpm test        # one lane; record the per-project counts
```
If anything is red, **root-cause it as a finding** (including the two never-run strengthened tests above — a failure there may be the test being wrong or a real race:
decide which, and say which). Fix in a separate, clearly named commit. Do not weaken a test to get green.

### Step 2 — 0.5.4-F: the mutation pass (this is the phase's quality gate)
```
python3 docs/development-history/handoff/tools/run-mutations.py \
        docs/development-history/handoff/tools/users-mutations.py /tmp/users-mut.jsonl --baseline
```
(`--baseline` first proves each targeted command is green unmutated. The runner is resumable — rerun the same command to continue — and takes ids to re-run only some:
`… /tmp/users-mut.jsonl I1 M10 Q9`; delete a line from the jsonl to re-run that one.) 122 mutations × (a build + tests) is **several hours serially**; run them in the background and
work on docs meanwhile, or — if your machine has the cores — read `tests/README.md` "Lanes" and parallelise by copying the runner onto the lane directories (`scripts/lanes.mjs sync`);
the parallel runner the reviewer used is not in the repo, the serial one is.

**Every survivor is a missing or weak test, or an equivalent mutant.** Strengthen the test and re-run that mutation until it is caught; an equivalent mutant needs a one-line justification in the record.
Mutations marked `EXPECTED EQUIVALENT` in their description (campus/list/member queries that omit `tenantId` — row-level security still scopes them; `I2b`, `I8d`, `M3b`, `M17`) should survive
**and the record must say why that is acceptable** (the application still names the tenant on purpose: defence in depth, brief §1.2 — if you can write a test that shows the difference
without weakening RLS, better). Ones I *suspect* may survive and want a real test for: `M16` (page order without a tiebreak — needs two people with the same name across a page boundary),
`Q12` (needs a row with an empty `tokenHash`), `Q13` (needs a referential-integrity test), `M1c`, `M11` (needs an inactive third administrator in the concurrent-demotion test), `I3c`, `H12`, `H17`–`H20`
(rate-limit constants: the tests must actually exceed the limit), `U6` (needs an e2e that pages), `T3` (the stored hash form is pinned by a known-vector unit test).
Also add mutations of your own where you see a gap; the target is "I would be surprised if a bug here survived", not a number.

### Step 3 — 0.5.4 documentation (same pass as the code; detailed — future sessions re-read it cold)
- `docs/development-history/phases/phase-0.5.4-users-invitations.md` (new): what was built per task, the findings (the ones in the brief §5 came from this phase — member search `%`, `$queryRaw` + `void`,
  nested live regions, dialog autofocus, the debounce-on-mount reset, deterministic focus after refresh, the duplicate-live-invitation index behaving as designed), the test inventory with counts, **the mutation table** (id, bug, caught-by, survivors and what you did).
- `domain-implementation-plan.md`: an **"As built — Users and invitations"** section after the design ("The app shell, and the Users pages with invitations"), listing deviations from the design.
- `CLAUDE.md`: the rules this phase made permanent (a deactivated membership is no membership in **every** reader; the invitation token travels in the fragment and only its SHA-256 is stored; accept = one transaction with a conditional-update claim;
  the invitation context is read-only and the tenant context is set from the row found; one generic answer for dead links; `escapeLike` for any user search; strict zod bodies; last-administrator row lock; people are read through `tenantMembership`, never `tx.user`).
- `tests/README.md`: new specs and their servers (SaaS-mode server for multi-school tests), the per-administrator rate-limit caveat.
- Trackers: `octalve_edu_progress.md` and `roadmap-breakdown.md` (0.5.4 → ✅ with the branch/SHA). **Also reconcile stale rows** while there: roadmap `0.5.2-D` T4–T6 and `0.5.2-G` are still marked open although the suites that cover them exist and ran (`front-door.spec.ts`, the multi-school API/e2e specs, the a11y blocks, the mutation records);
  verify each claim against the code/records and tick or correct it — do not tick on faith. The `0.5.3` heading still shows ⬜ although the table says built.

### Step 4 — verify and push
`pnpm typecheck && pnpm lint && pnpm build && pnpm test` (one lane): 0 failures, 0 new skips; record the counts. Commit in small named commits; `git push -u fork claude/app-shell-users`. **Say the head SHA in your hand-off.**
(Phase 0.5 is then complete on the Octalve side except what is listed in §4.)

### Step 5 — lanes: prove or label (optional but valuable; do it before relying on `test:lanes` for mutation runs)
`scripts/lanes.mjs` splits the suite across isolated copies (own ports, own `.next`, own `<db>_lane<N>_test`, own Redis) to use a multi-core machine. It is **experimental until proven**:
(a) run `pnpm test:lanes -- --lanes 3` and the one-lane `pnpm test` with `--reporter=json` into separate files and compare **per test** (same tests ran, once each, same outcome) — a ~40-line script over the JSON `suites[].specs[].tests[]`;
(b) re-run a sample of known mutations through the lanes and check the verdicts match the serial ones; (c) one more lane run to check it is stable. Write the result in `tests/README.md` "Lanes". If any of it fails, mark lanes "inner loop only" there. The one-lane run is always what counts at the end of a phase.

### Step 6 — Phase 1, Slice 1 (1.0 foundations + 1.1 academic structure)
Follow `PHASE-1-SLICE-1-PROMPT.md` exactly (its "Base" paragraph is superseded by this document: branch `claude/phase-1-0-1-1` from the head you pushed in step 4). Its hand-off file is `handoff/phase-1-slice-1.md`.
Do **not** start 1.2 or later.

### Step 7 — queued, only if you have the sibling checkout (otherwise leave it, and say so)
**AlEemaan** (`roji-tech/AlEemaan`, single-tenant live school) needs the **same Users pages and invitations**, ported by *reading the raw diff*, not by copying files: branches instead of tenants, **no RLS, no `forTenant`, no SaaS server, no tenant codes in URLs**,
live-data-safe additive migrations only (the school's data must survive), its own plan/phase docs, and every divergence logged in **both** plan docs (the "Shared naming conventions" table and §0.5.1.6 there). Its own backlog item "0.5.2 School Settings" still awaits the maintainer's go-ahead — do not start it.

## 3. Standing rules that are easy to forget
- Design before code: a "Build design" section in the plan (numbered decisions, tests paragraph, mutation list), committed alone, before the code it describes.
- Migrations are additive and immutable; RLS in the same migration as the table; add the table to the catalog guard.
- The app connects as `app_user`; tests arrange data with the admin `db` helper and read as the runtime role. **Do not create or alter database roles beyond what `docker/postgres/init/01-roles.sql` and `pnpm db:roles` do** — on the reviewer's sandbox such a change was denied and then explicitly approved by the maintainer, once, for that sandbox only.
- Every school route is `withAuth(handler, { tenant: true, roles | permissions })`; data only through `auth.tenant.run(tx => …)`; queries still name the tenant.
- Tests are never weaker than the code; a failing test is a finding. Mutation-test every phase; survivors become tests.
- Push after each phase; the maintainer merges. No PRs unless the maintainer asks.

## 4. What stays with the reviewer (do not do these)
- Adding **as-built artboards** for the new screens (shell, Users, accept-invite, invite/edit/deactivate dialogs) to the design artifact — one publish, later.
- The AlEemaan port if you have no checkout of it; reviewing your work.
- Opening PRs, and anything on `master`.

## 5. Your hand-off
When you stop — at any point, not only when finished — write `docs/development-history/handoff/takeover-report.md`: (1) base and head SHAs; (2) per step: done / partly / not started; (3) the mutation table or its location, survivors and
what you did; (4) test evidence — the one-lane summary per project and counts; (5) deviations from this document and why; (6) **security-sensitive spots for a second pair of eyes** (file:line + why); (7) known gaps, risks, things you were unsure about;
(8) open questions for the maintainer; (9) how to verify in five minutes. Be honest about what is not done or not verified. The reviewer starts from this file.
