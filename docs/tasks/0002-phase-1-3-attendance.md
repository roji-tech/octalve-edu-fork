# TASK-0002: Octalve Edu Phase 1.3 — Attendance & Day-to-Day Operations

- **Status:** Pending
- **Priority:** High
- **Assignee:** Agent / Maintainer
- **Target Branch / PR:** `claude/phase-1-3-attendance`
- **Created:** 2026-10-09 10:00:00 UTC
- **Started:** —
- **Ended:** —
- **Duration:** —

> **How to tick:** change `[ ]` to `[x]`. The table shows the characters, not a clickable box.

---

## 1. Objective
Build the complete Phase 1.3 Attendance domain for Octalve Edu: daily and per-period attendance tracking, high-speed mobile touch grid for teachers, absence reason classification, reporting, and absentee notification hooks.

## 2. Context & Constraints
- Builds on Phase 1.2 (Students, Classes, Sessions).
- Attendance record uniqueness: `(tenantId, studentId, date, periodId?)`.
- Teacher phone UX: Must allow marking an entire class of 30+ students in under 30 seconds.
- Row-Level Security on all new tables; immutable audit logging.

## 3. Work Breakdown / Checklist
### Sub-Phase A: Design & Specification
- [ ] Write and commit Phase 1.3 Build Design in `docs/development-history/domain-implementation-plan.md`.

### Sub-Phase B: Schema, Migration & Pure Rules
- [ ] Schema: `AttendanceRecord` table with composite foreign keys, RLS enabled and forced.
- [ ] Additive migration with catalog tests.
- [ ] Pure rules: status enum (`PRESENT`, `ABSENT`, `LATE`, `EXCUSED`), edit window boundaries.

### Sub-Phase C: Services & API Routes
- [ ] Idempotent bulk mark attendance service.
- [ ] Class roll call retrieval with existing status overlay.
- [ ] API endpoints: `GET/POST /api/v1/schools/[code]/academics/classes/[armId]/attendance`.

### Sub-Phase D: Screens & Mobile Grid
- [ ] Phone-optimised touch grid UI (toggle all present by default, tap to cycle absent/late).
- [ ] Summary stats (daily attendance %, absentee list).
- [ ] WCAG 2.2 AA accessibility and dark mode compliance.

### Sub-Phase E: Verification & Documentation
- [ ] Unit, integration, API, and e2e browser test suites.
- [ ] Update `docs/development-history/phases/phase-1.3-attendance.md`.
- [ ] PR created and verified.

## 4. Verification Gates
- [ ] `tsc --noEmit` / typecheck clean
- [ ] `pnpm lint` clean
- [ ] `pnpm format:check` clean
- [ ] `pnpm build` clean
- [ ] Targeted Playwright suites passed
- [ ] Full test suite green

## 5. Notes & Deviations
- To be recorded during execution.

## 6. Output & Deliverables
- **Commit:** —
- **PR:** —
- **Docs:** —
