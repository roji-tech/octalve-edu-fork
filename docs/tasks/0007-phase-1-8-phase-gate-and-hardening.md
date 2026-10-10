# [TASK-0007]: Phase 1.8 — End-to-End Hardening, Security Walk & Gate

- **Period / Focus:** 2026-10-10 (IDOR Across All Routes, Complete Multi-Actor Lifecycle Walk, Adversarial Webhook Testing, Index Sanity & Final Phase 1 Gate)
- **Status:** Completed
- **Priority:** Critical
- **Assignee:** Claude Agent / Maintainer
- **Target Branch / PR:** [PR #17](https://github.com/roji-tech/octalve-edu-fork/pull/17) (`claude/phase-1-8-gate`)
- **Started:** 2026-10-10 17:35:00 UTC
- **Ended:** 2026-10-10 19:25:00 UTC
- **Duration:** ~1h 50m

> **How to tick:** change `[ ]` to `[x]`. The table shows the characters, not a clickable box.

---

## 1. Objective
Execute and pass the final **Phase 1 Verification Gate & Security Hardening Walk** for Octalve Edu before opening Phase 2:
1. **Automated IDOR & Cross-Tenant Isolation**: Exhaustive negative test suite proving entities created in Tenant A (students, staff, guardians, sessions, periods, class groups, arms, subjects, results, invoices, timetable slots, announcements, settings audit) cannot be read, updated, or deleted through Tenant B's credentials and API routes.
2. **Complete Multi-Actor Operational Lifecycle Walk**: End-to-end integration proving the entire Phase 1 workflow in sequence: Session & Structure setup $\to$ Staff assignment $\to$ Student enrollment $\to$ Daily attendance marking $\to$ Exam score entry $\to$ Administrative result approval & publication $\to$ Student/Parent report card inspection $\to$ Fee structure setup & batch invoicing $\to$ Dual-mode Paystack checkout & receipt $\to$ Timetable conflict-free scheduling $\to$ Broadcast announcement feed $\to$ Settings reconfiguration with step-up verification.
3. **Adversarial Webhook & Payment Attack Surface**: Stress tests verifying forged HMAC signatures, replay attempts, payload tampering (amounts/currency/invoice references), and concurrent race conditions.
4. **Database Index & Query Plan Sanity**: Verify that all high-volume queries in Phase 1 execute via PostgreSQL index scans without sequential table scans.
5. **Phase 1 Closure & Documentation**: Record full verification evidence in `docs/development-history/phases/phase-1.8-phase-gate.md`, update progress tracker, and submit final Phase 1 PR.

---

## 2. Context & Related Docs
- Canonical Reference: `docs/development-history/roadmap-breakdown.md` §1.8, `docs/PRD.md` §7 (Tenant Trust Boundary), §8 (Academics & SIS), §9 (Results & Grading), §10 (Finance & Payments), §14 (Settings).
- Preceding Phases: All sub-phases 1.0 through 1.7 built, verified, and passing quality gates.
- Quality Invariants: Run as PostgreSQL `app_user` role, strict RLS enforcement, zero cross-tenant leakage.

---

## 3. Work Breakdown

### Sub-phase A: Cross-Tenant IDOR Audit Suite
- [x] Create `tests/api/idor-audit.spec.ts` covering cross-tenant entity operations:
  - Academics: Class groups, arms, subjects, assessment schemes, grade scales, academic sessions, periods.
  - People: Student records, staff records, guardian records, student enrolments, staff assignments.
  - Attendance: Class arm roll-call attendance queries with alien arm IDs.
  - Results: Result submissions and batch queries with alien student/period/scheme IDs.
  - Finance: Invoices, fee structures, discounts, manual payments with cross-tenant target IDs.
  - Timetable & Announcements: Slot mutations, batch slot insertions, announcement updates with alien IDs.
  - Settings: School settings mutations and audit log access with cross-tenant context.

### Sub-phase B: Multi-Actor Lifecycle Walk
- [x] Create `tests/integration/phase-1-lifecycle-walk.spec.ts`:
  - Step 1: Admin configures academic session, terms, class groups, arms, subjects, assessment scheme, and grade scale.
  - Step 2: Admin creates teacher staff record, links user account, assigns subject & class arm.
  - Step 3: Admin enrols student into class arm, creates guardian, links parent account.
  - Step 4: Teacher logs in, takes daily attendance for the class arm, verifies roster presence.
  - Step 5: Teacher inputs component assessment scores for the student.
  - Step 6: Admin reviews scores, transitions status from `DRAFT` $\to$ `SUBMITTED` $\to$ `APPROVED` $\to$ `PUBLISHED`.
  - Step 7: Student and Parent log in, view published report card with grades, GPA, ranking, and attendance summary.
  - Step 8: Admin creates term fee structure for the class group, generates student invoice.
  - Step 9: Parent logs in, inspects invoice, simulates checkout via Paystack modal/webhook, receives valid receipt.
  - Step 10: Admin schedules timetable slots for the class arm, publishes announcement to parents & students.
  - Step 11: Admin updates school settings toggle with step-up MFA/password re-authentication, verifying audit trail.

### Sub-phase C: Payment & Webhook Adversarial Security Suite
- [x] Create `tests/api/finance-adversarial.spec.ts`:
  - Forged HMAC-SHA512 signature on `/api/v1/webhooks/paystack` rejected.
  - Replay of processed webhook event rejected/idempotent.
  - Altered payload amount or currency rejected without fulfilment.
  - Cross-tenant invoice payment attempt rejected.
  - High concurrency: 20 simultaneous webhook notifications against one invoice result in exactly 1 payment record and 1 status transition.

### Sub-phase D: Query Performance & Index Sanity
- [x] Create `tests/integration/query-performance.spec.ts`:
  - Run `EXPLAIN` query plans on key tenant-scoped tables:
    - `AttendanceRecord` by `(tenantId, classArmId, date)`
    - `Result` by `(tenantId, academicPeriodId, subjectId)`
    - `Invoice` by `(tenantId, studentId, status)`
    - `TimetableSlot` by `(tenantId, classArmId, dayOfWeek)`
    - `SettingsChangeAudit` by `(tenantId, createdAt)`
    - `StudentEnrollment` by `(tenantId, academicSessionId, classArmId)`
  - Assert query plans utilize index scans (Index Scan, Bitmap Index Scan, or Index Only Scan).

### Sub-phase E: Documentation, Phase Record & Final Phase 1 PR
- [x] Complete all checklist items in `docs/tasks/0007-phase-1-8-phase-gate-and-hardening.md`.
- [x] Update `docs/tasks/current-tasks.md`.
- [x] Create `docs/development-history/phases/phase-1.8-phase-gate.md`.
- [x] Update `docs/development-history/octalve_edu_progress.md` marking Phase 1 100% complete.
- [x] Run full repo quality gates (`pnpm test:unit`, `pnpm test:fast`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm tasks:check`).
- [x] Commit, push to `claude/phase-1-8-gate`, and open PR ([#17](https://github.com/roji-tech/octalve-edu-fork/pull/17)).
