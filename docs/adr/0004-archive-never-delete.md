# 0004 — Academic records are archived, never deleted
Status: accepted — except that "`CLOSED` sessions are terminal" is superseded by 0008 (closing is delayed and a closed session can be reopened) · Decided: Phase 1.1 · Recorded: 2026-10-07

## Context
Sessions, classes, subjects, schemes and scales will be referenced by results, fees and reports. A deleted row either breaks those references or silently rewrites history.

## Decision
The API has no delete for these records; "remove" means `archivedAt`. Archiving is refused while something live depends on it (`HAS_ACTIVE_ARMS`, `SUBJECT_IN_USE`, the default scale). An archived row frees its unique name through partial unique indexes on live rows. `CLOSED` sessions are terminal. The only real delete is `SubjectOffering` removal, until Phase 1.4 gives it an inbound reference.

## Consequences
Lists need an "include archived" switch; dialogs say nothing is ever deleted.

## Enforced by
No delete route exists (route-discovery guard in `tests/api/tenant-boundary.spec.ts`); the catalog test is meant to fail the day `SubjectOffering` gains an inbound reference; archive-refusal tests in `academic-structure.spec.ts`.

## Related
Plan decisions 7–18 · `phases/phase-1.1-academic-structure.md`.
