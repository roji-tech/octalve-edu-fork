# TASK-0001: Octalve Edu Phase 1.2 — People & Enrolment

- **Status:** Completed
- **Priority:** Critical
- **Assignee:** Claude Agent / Maintainer
- **Target Branch / PR:** `claude/phase-1-2-people` / [PR #11](https://github.com/roji-tech/octalve-edu-fork/pull/11)
- **Created:** 2026-10-07 09:00:00 UTC
- **Started:** 2026-10-07 09:00:00 UTC
- **Ended:** 2026-10-09 09:06:17 UTC
- **Duration:** 2 days, 6 minutes

> **Note on checkmarks:** How to tick: change `[ ]` to `[x]`. The table shows the characters, not a clickable box.

---

## 1. Objective
Deliver the complete Phase 1.2 domain for Octalve Edu: Student, Staff, Guardian, and Enrolment management, CSV import/export, audited duplicate overrides (Option B), and migrate decisions to `docs/adr/`.

## 2. Context & Constraints
- Builds on Phase 1.0 (Foundations) and Phase 1.1 (Academic Structure).
- Tenant isolation enforced via PostgreSQL RLS on all 7 new tables with composite foreign keys.
- Auditing: All writes logged via `auditPeople` without leaking PII (zero names/birthdates in audit metadata).
- Relevant ADRs: 0001 (RLS), 0002 (rollback on refusal after write), 0009 (per-session enrolment), 0010 (school type from server env), 0014 (namesake duplicate override).

## 3. Work Breakdown / Checklist
- [x] Design committed in plan doc (`9a98295`)
- [x] Pure rules for people (`1dd1129`)
- [x] School type server env configuration (`bba8985`, ADR 0010)
- [x] Schema & migration: 7 new tables + RLS + catalog tests (`c00f7b8`)
- [x] Students service & per-session enrolment (`21b58fe`)
- [x] Guardians & primary contact management (`e580487`)
- [x] Staff records, teaching assignments, and account linking (`134e36a`)
- [x] CSV import & formula-neutralised export (`1d7aefd`)
- [x] Responsive screens, student/staff detail pages, a11y focus restoration (`96d139f`)
- [x] Option B: In-place `allowDuplicate: true` override on create, update, restore, and CSV import with zero PII audit logging
- [x] Migrate `docs/decisions/` to `docs/adr/`, adopt 11-rule template, record ADR 0014 (`9493031`)
- [x] Add ADR `template.md` with explicit rules and metadata headers (`15cdde3`)

## 4. Verification Gates
- [x] `tsc --noEmit` / typecheck clean (0 errors)
- [x] `pnpm lint` clean (0 errors)
- [x] `pnpm format:check` clean (100% Prettier compliant)
- [x] `pnpm build` clean (Next.js production build succeeded, 24/24 static routes generated)
- [x] Full single-lane suite executed: 1,603 tests pass (1,579 passed, 1 reload re-run passed 2/0, 23 designed viewport skips)
- [x] Targeted duplicate override suite: 36 passed / 0 failed in 1.4m

## 5. Notes & Deviations
- Maintainer confirmed Option B (audited duplicate override) over strict refusal to accommodate namesake family naming.
- `docs/decisions/` renamed to `docs/adr/`.
- ADR 0010 confirmed and marked Accepted.

## 6. Output & Deliverables
- **Commits:** `9a98295` through `15cdde3`
- **PR:** https://github.com/roji-tech/octalve-edu-fork/pull/11
- **Docs:** `docs/development-history/phases/phase-1.2-people.md`, `docs/development-history/handoff/phase-1-2-people.md`, `docs/adr/README.md`, `docs/adr/template.md`
