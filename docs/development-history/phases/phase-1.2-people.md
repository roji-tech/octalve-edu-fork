# Phase 1.2 — People and enrolment (staff, students, guardians, enrolment, CSV import/export, screens)

**Status: BUILT (2026-10-08); test evidence is in `handoff/phase-1-2-people.md` §6, the full-suite run in §7; the mutation pass is PENDING** — **all Phase 1 and 2 mutation passes are deferred to the end of Phase 2 by the maintainer's decision (ADR 0007).**
Branch `claude/phase-1-2-people`, **stacked on `claude/phase-1-0-1-1`** (PR #10) — merge that first. Design of record: plan §"Build design — Phase 1.2 (people and enrolment)", committed alone before any code (`9a98295`). Roadmap: `roadmap-breakdown.md` §1.2.
Built in six steps, each its own commit group, gate after each (typecheck → lint → format:check → build → tests).

## What this delivers
| Step | Commit | What |
|---|---|---|
| design | `9a98295` | the plan section, decisions P1–P9 |
| 1.2a | `1dd1129`, `bba8985`, `c00f7b8` | pure rules + CSV reader/writer; school type from the server; schema, migration `20261015090000_phase_1_2_people`, RLS |
| 1.2b | `21b58fe` | students and enrolment (create/update/archive/restore, enrol/move/withdraw, occupancy) |
| 1.2c | `e580487` | guardians and links (primary contact, relationship, remove/restore, siblings share a guardian) |
| 1.2d | `134e36a` | staff records, sign-in accounts (invite from the record, link, unlink), teaching assignments; invitations carry a staff record |
| 1.2e | `1d7aefd` | student CSV import (all or nothing, dry run, idempotent) and export |
| 1.2f | `96d139f` | People pages, staff read-only Academic setup, custom 404, e2e and axe states |
| 1.2g | `b81e957`, `5711b1c` | docs (phase record, plan As-built, ADRs 0009–0013, CLAUDE.md, tests/README, handoff) |

New tables (each `ENABLE`+`FORCE` RLS with `USING` and `WITH CHECK`, composite `(tenantId, parentId)` foreign keys, in the same migration, and in the catalog guard): `StaffRecord`, `StaffSubjectAssignment`, `StudentRecord`, `AdmissionCounter`, `GuardianRecord`, `GuardianLink`, `StudentEnrollment`; plus `Invitation.staffRecordId` (additive).
27 route files (33 handlers) under `/api/v1/schools/[code]/people/…`, so the route-discovery guard in `tests/api/tenant-boundary.spec.ts` covers every one (signed-out, cross-school, deactivated).

- **Students.** Admission number typed or generated `YYYY/NNNN` (`UPDATE … RETURNING` on `AdmissionCounter` under the row lock, same transaction as the insert, so a failed insert burns no number; taken numbers are skipped at most 50 times, then refused and rolled back). Duplicate rule: same first name, last name and date of birth (trimmed, case-insensitive) as a live student is refused, naming the existing number; there is no override. Archive never deletes; a student who is still enrolled cannot be archived (the screen says so in words).
- **Enrolment is per session** (one row per student and session; moving class edits the row, withdrawing sets `WITHDRAWN` with a typed reason of 5–300 characters in the audit entry). Capacity is shown ("27 of 30", "3 over") and never enforced.
- **Guardians** are people with contact details; a link says whose they are. The first link is primary; making another primary demotes the first in one transaction (partial unique index is the guard). Only an administrator creates links, always `APPROVED`.
- **Staff.** A record exists without an account. "Invite to sign in" creates a normal invitation carrying `staffRecordId`; accepting it creates the membership and links the record **in the same transaction** (if the record was linked or archived meanwhile the membership is still created and the link is skipped and noted). "Link account" picks a member of this school whose role fits the category; "Unlink" clears it; all audited. Teaching assignments are subject × arm and the subject must be offered to the arm's class group.
- **Import/export.** `POST …/students/import { csv, dryRun }`: header required, unknown columns refused, 1 MiB / 1,000 rows / 200-character cells, names looked up by name inside the school, one transaction under a per-school lock; the dry run is the same code followed by a rollback; the confirm step re-validates everything. A re-run of the same file skips matching rows. Export: `text/csv`, same columns as the import (so an export can be imported), formula-neutralised cells, at most 10,000 rows, audited, administrators only, rate-limited.
- **School type** comes from the server setting `DEFAULT_SCHOOL_TYPE` (`K12` default); the setup body is strict and refuses a `schoolType`; no school administrator can change it. *(Separate commit `bba8985` so it can be dropped — the maintainer has not yet confirmed.)*
- **Who may do what.** Reads: administrators and staff (campus-scoped for a staff member tied to a campus). Writes: administrators only. Students and parents get the same 403 as a stranger. Unknown, foreign and other-campus ids answer one 404 (compared by body in the API tests).
- **Screens.** `/schools/[code]/people?section=students|staff` (real links), student and staff detail pages, dialogs for every write, import dialog with the full problem report, export link, filters (search, campus, class, "not in a class yet", archived). "People" in the nav for administrators and staff. **Staff now see Academic setup read-only** (every button and form absent, one line "Only an administrator can change this."; the API still enforces). Cards on a phone, ≥ 44 px tap targets, axe WCAG 2.2 A/AA in both themes, focus returns to the opener, results announced in one polite live region.

## Verification
Executed full single-lane suite on final tree (`pnpm build && TEST_LANE=1 TEST_TIMEOUT_SCALE=3 pnpm exec playwright test`):
- **1,579 passed, 1 failed, 23 skipped** across 1,603 tests (1.4 h).
- The single failure (`tests/e2e/shell.spec.ts:229:7` mobile sheet tap-outside timeout under high CPU load) re-ran immediately via `--last-failed`: **2 passed, 0 failed** (57.2 s).
- Every test in the 1,603-test suite has now passed on the final code (also covering the session-close timer debt from 1.1). Full breakdown in `handoff/phase-1-2-people.md` §6 and §7.

## Findings and decisions (read these)
1. **A real defect found by the export test, fixed:** exporting 10,000 rows made Postgres answer "stack depth limit exceeded" (one huge `IN (…)` list). Related rows (guardians, enrolments) are now fetched in 1,000-id chunks.
2. **A real gap found by the import test, fixed:** the API's global 1 MiB JSON cap rejected a 1 MiB CSV (JSON escaping makes it bigger) with a 413. `validate()` now takes a per-route `maxBodyBytes`; the global default is unchanged and only the import route raises it.
3. **A real bug found by the browser tests, fixed — and it was older than this phase:** every dialog's counter starts at 1 and was used as its React `key`, so two dialogs rendered as siblings on one page (e.g. Enrol and Archive) shared the key `1`; after a dialog had been opened, the next one was mounted a second time and the first stayed open ("Cancel" did nothing). Slice 1's panels had the same pattern (latent: never two dialogs opened in one visit by the old tests). **Every dialog key now carries the dialog's name** (`archiving-1`), in all panels, and `useDialog`'s doc says why.
4. **Default Next 404 page violates our CSP** (it carries an inline `<style>`; the CSP fixture fails any test on a violation). `src/app/(app)/not-found.tsx` is a plain page like `forbidden.tsx`, naming nothing.
5. **Phone tap targets:** the student/staff name links in the lists were 18 px high; they are now `min-h-11`.
6. **Deviations from the design text** (also in the plan's "As built — Phase 1.2"): lists use offset pagination (`page`/`limit`, like Users) instead of the cursor the design mentioned; an import row whose admission number already exists *and matches* is **skipped** (reported), not an error; the export has exactly the import's columns (no `status` column) so a file round-trips; guardian validation errors take precedence over "student archived" so a form shows what is wrong first.
7. Re-running the earlier slice's tests after the key change was necessary because the change touches all panels: see the handoff for what ran.

## Not done (and why)
- **Mutation pass: NOT RUN — pending, end of Phase 2.** The list is the "Mutation plan (pending)" paragraph of the plan's Build design for 1.2 (≥ 25 targets). First targets: the admission counter and its retry bound, the primary-contact index predicate, the conditional link (`userId IS NULL`), the import's all-or-nothing and dry-run rollback, the export neutraliser and cap, campus scoping on every read.
- No student sign-in account linking, no gender field, no "create anyway" for a duplicate, no per-term enrolment (the five overridable defaults of the design — still the maintainer's to confirm).
- No parent/student views, attendance, or promotions (1.3/1.4).
