# 0009 — Enrolment is per session, not per term
Status: accepted (default — the maintainer may overrule) · Decided: during Phase 1.2 design · Recorded: 2026-10-08

## Context
The first sketch keyed `StudentEnrollment` on an academic period. A pupil stays in the same class for all three terms of a year, so a row per term would be copied three times a year and drift.

## Decision
One row per (student, session): `UNIQUE (tenantId, studentId, sessionId)`. Moving class inside a session edits the row (audited); withdrawing sets `WITHDRAWN` with a typed reason. Capacity is displayed, never enforced.

## Consequences
A school where terms differ in class would need a new table. Promotion (1.4) writes the next session's row.

## Enforced by
The unique index; `integration/people-schema`, `people-students`.

## Related
Plan "Build design — Phase 1.2", reconciliation 3 and decision P7 · `phases/phase-1.2-people.md`.
