# Phase 1 Slice 1 — hand-off (roadmap 1.0 foundations + 1.1 academic structure)

Written 2026-10-07 by the local Claude Code session, at the end of the slice. Read this first; it says what exists, what does not, and what to check.
Records: `phases/phase-1.0-foundations.md`, `phases/phase-1.1-academic-structure.md`. Design of record: plan §"Build design — Phase 1.0 and 1.1" (decisions 1–18).

## 1. Base and head
- Octalve Edu, branch `claude/phase-1-0-1-1` (fork `roji-tech/octalve-edu-fork`), **base `cc3479a`** (fork master after PR #9). Commits, oldest first:
  - design: `a9d17a8`
  - 1.0: `6f437bc` (data layer) · `e220a75` (`withAuth` permissions) · `94e86fe` (Users page: grant/revoke) · `4994543` (e2e + axe) · `236483d` (docs)
  - 1.1a sessions/periods: `2be0f08` (schema, migration, rules) · `cb16aed` (service + tests) · `d1abf40` (API)
  - 1.1b classes/subjects: `d3ca56a` (schema, migration, service, tests) · `37b32a3` (API)
  - 1.1c/d schemes and scales: `2f9f19f` (schema, migration, rules, services) · `a87e704` (integration + RLS tests, **the rollback fix**) · `216fd3e` (API)
  - screens: `6bc8eed` (UI + e2e) · `9168aea` (axe states)
  - then the 1.1 docs and this file (last commit on the branch).
- AlEemaan is untouched by this slice (its own PR #10 is open: 0.5.G).

## 2. What was built
| | |
|---|---|
| Migrations (4, additive only, RLS in each table's own migration) | `20261010090000_phase_1_0_foundations` · `20261011090000_phase_1_1a_sessions_periods` · `20261012090000_phase_1_1b_classes_subjects` · `20261013090000_phase_1_1c_assessment_grading` |
| New tenant-scoped tables (all `ENABLE`+`FORCE` RLS, in the catalog guard) | `SchoolSettings`, `AcademicSession`, `AcademicPeriod`, `ClassGroup`, `ClassArm`, `Subject`, `SubjectOffering`, `AssessmentScheme`, `AssessmentComponent`, `GradeScale`, `GradeBand` |
| API | 34 routes under `/api/v1/schools/[code]/academics/…` + `permissions` on member PATCH |
| Screens | `/schools/[code]/academics` (4 sections, admin only) · permission checkboxes in the Users Edit dialog |
| Pure rules (unit-tested) | `lib/auth/authorize.ts`, `lib/academics/rules.ts`, `lib/academics/scoring.ts` |
| Functions Phase 1.4 will call | `lockScheme`, `lockScale`, `snapshotOfScheme`/`snapshotScheme`, `gradeFor`/`bandFor`, `getDefaultScale`, `currentSessionFor`, `getSchoolSettings` |

## 3. Deviations from the design (all recorded in the plan's "As built")
Composite FKs use `ON DELETE NO ACTION`; one migration per family (not one); locks are **database triggers**; a new version archives its predecessor in the same transaction; the page is administrators-only with sections as real links ("Academics" in the nav); copy-forward needs a typed name when the label is not a year pair; screens built after the backend of all four families.

## 4. Security spots to review (where a mistake would hurt most)
1. **RLS and composite FKs** — `20261011…`, `20261012…`, `20261013…`: every table has USING + WITH CHECK on `"tenantId" = app_tenant_id()` and a composite FK to its parents; the catalog guard (`tests/integration/rls.spec.ts`) enumerates the tables and demands forced RLS.
2. **Lock triggers** (`20261013…`) — `assessment_scheme_locked_guard`, `assessment_component_locked_guard`, `grade_scale_locked_guard`, `grade_band_locked_guard`: a locked row's meaning cannot change even through the owner role; `pg_trigger_depth() > 1` is the one allowance (a whole-school cascade delete).
3. **Refusal-after-write rollback** — `refuseAndRollBack`/`rollingBack` in `lib/academics/sessions.ts` and where they are used (`activateSession`, `setCurrentPeriod`, `makeDefaultScale`); new versions check the name before archiving. This was a real defect (see the phase record, finding 1).
4. **Permissions** — only an ADMIN grants (never delegable), only on staff roles (a CHECK), cleared with a role change in the same transaction (`lib/members/service.ts`); `withAuth` decision in `lib/auth/authorize.ts` (ADMIN implies permissions, **not** roles).
5. **404 sameness / campus scope** — `visibleTo` in `sessions.ts`, `classes.ts`, `assessment.ts`; every id route answers one 404 for unknown, foreign and other-campus ids.

## 5. Test evidence
Gate order: `pnpm typecheck` → `pnpm lint` → `pnpm format:check` → `pnpm build` → `playwright test` (one lane, `TEST_LANE=1`, `TEST_TIMEOUT_SCALE=3`; this machine is CPU-capped at ~800–975 MHz, so long axe/e2e tests exceed the unscaled 30 s — see the final-run section below for exactly which, and how they were re-run).
New this slice (counts are `test(` blocks): unit `academic-rules`, `scoring-rules` 15, `authorize`, `with-auth`; integration `phase-1-0-foundations`, `permissions`, `academic-sessions` 31, `academic-structure` 22, `academic-scoring` 33, `rls` (new groups); api `academic-sessions` 15, `academic-structure` 13, `academic-scoring` 17, `members`, `setup`; e2e `academics` 8 and axe blocks for Users and Academic setup (34 states), each on desktop **and** phone.
**Mutation testing: NOT RUN. Deferred by the maintainer to the end of Phase 2** (all Phase 1 and 2 passes together). The mutation lists are in the plan ("Mutation plan", paragraphs 1.0 and 1.1); the parallel runner is `handoff/tools/run-mutations-parallel.py`. The first targets are listed in the 1.1 record, "Not done".

## 6. Not done / not started
- Phase 1.2 onward (people and enrolment, attendance, results, fees, parent/student views, settings UI) — **not started, by instruction**.
- No staff read-only screens for the academic setup (the read API exists and is tested).
- No consumer of any permission, of `lockScheme`/`lockScale`, `snapshotScheme` or `gradeFor` yet (first consumers: 1.4 results, 1.5 fees).
- Octalve 0.5.4-F (admin-initiated email change) is still open. Octalve's HTTPS test proxy does not yet rewrite `Host` as AlEemaan's does.
- The AlEemaan port of the Users pages and invitations, and AlEemaan School Settings, are next and untouched.

## 7. Open questions for the maintainer
1. **Does a campus's own active session shadow the school-wide one** (built so; one function, `currentSessionFor`, to change)? Or should a school choose one mode?
2. `schoolType` defaults to K12 and the setup wizard does not ask; should it ask now, or wait for the Settings screen (1.7)?
3. Is `CLOSED` terminal for a session (built so — no reopening)?
4. Half-open grade bands `[min, max)` with 100 in the top band (built so, because a "70–74 / 75–100" table leaves 74.5 in no band) — acceptable, or should the UI offer whole numbers only?
5. One default grade scale per school (a per-class-group scale is deferred to 1.4) — agreed?
6. Should staff get a read-only Academic setup screen now, or with the Phase 1.2 people pages?
7. AlEemaan: where does the Arabic branch's data come from, and what seeds its School Settings (the setup wizard stores no school name)?

## 7a. Answers received from the maintainer (2026-10-07)
1. **Campus session shadows school-wide: keep as built.**  3. **Closed sessions:** not final any more — closing is a 24-hour countdown (1 minute with the password) and a closed session can be reopened with a reason (ADR 0008; built on this branch after the first push, see the PR).  4. **Half-open bands: keep**; whole-number rounding before grading stays an option for 1.4.  5. **One default scale per school: yes**, per-class scales later.  6. **Staff read-only screen: with Phase 1.2.**  2. **School type is not asked in the wizard**: it comes from the superadmin's settings or an environment setting at creation (proposal: `DEFAULT_SCHOOL_TYPE` for self-hosted + set when a school is created; a school's own administrator cannot change it) — to be confirmed and built with 1.2.

## 8. Five-minute verification
```bash
git fetch fork && git checkout claude/phase-1-0-1-1
pnpm install && pnpm prisma migrate deploy        # four additive migrations
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build
TEST_LANE=1 TEST_TIMEOUT_SCALE=3 npx playwright test --project=unit --project=integration tests/integration/academic-scoring.spec.ts tests/integration/rls.spec.ts tests/unit
TEST_LANE=1 npx playwright test --project=api tests/api/academic-scoring.spec.ts tests/api/tenant-boundary.spec.ts   # needs the build above
```
Then sign in as an administrator and open `/schools/<code>/academics`: create a session, open it, add a term, make it current, preview a copy-forward; create a class with an arm and subjects; create a scheme whose parts do not add up (the form refuses, saying by how much); create the standard A–F scale.

## 9. Final run
Gate order: `pnpm typecheck` → `pnpm lint` → `pnpm format:check` → `pnpm build` → tests, one lane (`TEST_LANE=1`, `TEST_TIMEOUT_SCALE=3`). The four static steps are clean on the final tree. **The suite did not finish in one clean pass, and this is exactly what happened:**
1. **Full run, 1.2 h:** 1063 passed · **280 failed** · 23 skipped · 18 did not run. 278 of the failures were `ERR_CONNECTION_REFUSED` / timeouts: the lane's browser-test server on :3110 went away part-way through (an environment loss on this CPU-capped machine, not a code failure). The other two were real: **one stale expectation of mine** (`resolveTenant` now also returns `schoolType` and `permissions`; fixed in `tests/integration/tenant-boundary.spec.ts`) and **one timing test** (`email-change/request`, 52.9 s against a 30 s limit).
2. **Re-run of exactly those 280 (`--last-failed`), 41.6 min:** **281 passed (including the setup step), 0 failed.** The timing test and the corrected expectation are among them.
3. **The 18 "did not run"** were the nine serial tests of `setup-handoff.spec.ts` on each browser project (a serial group stops after its first failure), and `--last-failed` re-ran only the first test of each. **Run whole afterwards, both projects: 20 passed, 0 failed.**
4. The 23 skipped are the viewport-specific tests that skip themselves on the other project.
So every test in the suite has passed at least once on the final code, but **not in a single uninterrupted run**; a fresh one-lane run on a machine that keeps its servers alive is still the reviewer's confirmation to make. Mutation testing: **NOT RUN** (deferred to the end of Phase 2).
