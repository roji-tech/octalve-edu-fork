# 0003 — "Locked" is enforced by database triggers
Status: accepted · Decided: Phase 1.1 · Recorded: 2026-10-07

## Context
Once a result references an assessment scheme or grade scale, changing it would silently change history. A service-only check depends on every writer, now and later, having no bug.

## Decision
`lockScheme` / `lockScale` (called by Phase 1.4 the first time a result references one) mark the row locked. Triggers `assessment_scheme_locked_guard`, `assessment_component_locked_guard`, `grade_scale_locked_guard` and `grade_band_locked_guard` refuse any change to a locked row or its children — the owner role included. The one allowance is `pg_trigger_depth() > 1`, so deleting a whole school can cascade. A change to a locked row is a new version (`new-version`, `supersedesId` linked).

## Consequences
Fixtures must create children first, then lock. Nothing reopens a locked row; there is no "unlock".

## Enforced by
`tests/integration/academic-scoring.spec.ts` (writes through the owner role; cascade delete of a school holding locked rows). Migration `20261013090000_phase_1_1c_assessment_grading`.

## Related
Plan "As built — Phase 1.1" · phase record, finding 2.
