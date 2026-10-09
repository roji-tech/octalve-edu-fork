# Phase 1.3 — Attendance & Day-to-Day Operations

**Status: BUILT & VERIFIED (2026-10-09); Unit (5/5), API (7/7), Catalog & RLS (66/66), E2E Browser Desktop & Mobile (3/3), and Academics Full Suite (34/34) all green.**
Branch: `claude/phase-1-3-attendance`.
Design of record: `docs/development-history/domain-implementation-plan.md` §"Build design — Phase 1.3 (Attendance & Day-to-Day Operations)".
Roadmap: `docs/development-history/roadmap-breakdown.md` §1.3.

---

## What this delivers

| Step | Scope | What |
|---|---|---|
| Design | Architecture | Sub-Phase A design written in `domain-implementation-plan.md` |
| Schema & Migration | DB / RLS | `prisma/schema/attendance.prisma` (`AttendanceRecord`, `AttendanceStatus`, `AttendanceSource`); migration `20261016090000_phase_1_3_attendance` applied to `octalve_edu` and `octalve_edu_test` with full RLS `ENABLE` & `FORCE` and runtime grants |
| Pure Rules | Domain | `src/lib/attendance/rules.ts` (pure date calculations, role-based 7-day edit grace period, summary counters & rates) |
| API & Service | HTTP / Envelopes | `src/lib/attendance/http.ts`, `src/lib/attendance/service.ts`, `GET/POST /api/v1/schools/[code]/academics/arms/[id]/attendance`, `GET /api/v1/schools/[code]/people/students/[id]/attendance` |
| UI & Screens | Client Components | `src/components/academics/AttendancePanel.tsx` wired into `/schools/[code]/academics?section=attendance`; touch-optimised (≥ 44px tap targets), "Mark All Present" 1-tap action, live summary KPI strip, inline absentee remarks |
| Tests | Playwright | `tests/unit/attendance-rules.spec.ts`, `tests/api/attendance.spec.ts`, `tests/e2e/attendance.spec.ts`, verified against `tests/integration/rls.spec.ts` |

---

## Key Technical Decisions & Invariants
1. **Idempotent Bulk Upsert:** Roster attendance marking uses PostgreSQL transactions with composite uniqueness on `(tenantId, studentId, date)` ensuring multiple submissions cleanly update rather than duplicate records.
2. **7-Day Teacher Edit Window:** Regular teaching staff can mark and adjust attendance up to 7 days into the past. Historical edits beyond 7 days require `ADMIN` role privileges to preserve audit integrity. Future dates are strictly rejected.
3. **Zero PII Audit Logging:** Status updates and bulk changes emit structured audit logs containing actor ID, student ID, date, and status change — zero student names or personal data are exposed in log streams.
4. **Touch-First UX:** Attendance buttons use `min-h-11` (44px) tap targets with high-contrast color coding (green for `PRESENT`, amber for `LATE`, red for `ABSENT`, sky for `EXCUSED`), satisfying WCAG 2.2 AA accessibility in both dark and light modes.
