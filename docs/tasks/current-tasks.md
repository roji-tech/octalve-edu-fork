# Current Tasks — Octalve Edu

> **Rule:** How to tick: change `[ ]` to `[x]`. The table shows the characters, not a clickable box.
> All dates and times are recorded in UTC with standard ISO format (`YYYY-MM-DD HH:MM:SS UTC`).
> **Grouping Policy:** Tasks represent cohesive phase-level milestones (design → schema → logic → UI → test → docs → PR) to prevent file proliferation.

---

## Active & Sequential Milestone Register

| # | Task ID | Milestone Title | Status | Started | Ended | PR / Branch |
|---|---|---|---|---|---|---|
| 1 | [TASK-0001](0001-phase-1-2-people-and-enrolment.md) | Phase 1.2: People & Enrolment (Option B duplicate override + ADR 0014) | [x] Completed | 2026-10-07 09:00:00 UTC | 2026-10-09 09:06:17 UTC | [PR #11](https://github.com/roji-tech/octalve-edu-fork/pull/11) (`claude/phase-1-2-people`) |
| 2 | [TASK-0002](0002-phase-1-3-attendance.md) | Phase 1.3: Attendance & Day-to-Day Operations | [x] Completed | 2026-10-09 15:06:00 UTC | 2026-10-09 21:07:00 UTC | [PR #12](https://github.com/roji-tech/octalve-edu-fork/pull/12) (`claude/phase-1-3-attendance`) |
| 3 | [TASK-0003](0003-phase-1-4-results-and-publishing.md) | Phase 1.4: Results, Grading & Publishing Workflow | [x] Completed | 2026-10-09 22:36:00 UTC | 2026-10-09 23:08:00 UTC | [PR #13](https://github.com/roji-tech/octalve-edu-fork/pull/13) (`claude/phase-1-4-results`) |
| 4 | [TASK-0004](0004-phase-1-5-finance-and-billing.md) | Phase 1.5: Finance, Invoicing & Paystack Integration | [x] Completed | 2026-10-10 00:07:00 UTC | 2026-10-10 08:45:00 UTC | [PR #14](https://github.com/roji-tech/octalve-edu-fork/pull/14) (`claude/phase-1-5-finance`) |
| 5 | [TASK-0005](0005-phase-1-6-announcements-and-timetable.md) | Phase 1.6: Announcements & Timetable Scheduling | [x] Completed | 2026-10-10 11:15:00 UTC | 2026-10-10 15:30:00 UTC | `claude/phase-1-6-timetable` |
| 6 | [TASK-0006](0006-phase-1-7-settings-and-mfa.md) | Phase 1.7: Settings UI, Step-up MFA & Audit Logging | [ ] Pending | — | — | `claude/phase-1-7-settings` |
| 7 | [TASK-0007](0007-phase-1-8-phase-gate-and-hardening.md) | Phase 1.8: End-to-End Hardening, Security Walk & Gate | [ ] Pending | — | — | `claude/phase-1-8-gate` |

---

## Detailed Milestone Checklist

### TASK-0001: Phase 1.2 — People & Enrolment
- **Started:** `2026-10-07 09:00:00 UTC`
- **Ended:** `2026-10-09 09:06:17 UTC`
- **Status:** Completed (PR #11 open and green, awaiting maintainer merge)
- [x] Design committed in plan doc (`9a98295`)
- [x] 1.2a pure rules (`1dd1129`), school type from server env (`bba8985`, ADR 0010 accepted), schema/migration/RLS (`c00f7b8`)
- [x] 1.2b students & session enrolment (`21b58fe`)
- [x] 1.2c guardians & primary contact links (`e580487`)
- [x] 1.2d staff records, assignments, account invitation linking (`134e36a`)
- [x] 1.2e CSV import & formula-neutralised export (`1d7aefd`)
- [x] 1.2f screens, student/staff detail pages, a11y focus restoration (`96d139f`)
- [x] Option B: Audited `allowDuplicate: true` override on create, update, restore, and import without PII
- [x] Migration: `docs/decisions/` → `docs/adr/`, 11-rule template adoption, and ADR 0014 recorded
- [x] Verification: Full suite 1,603 tests green + targeted 36 tests green
- [x] Pushed to fork: Commits `9493031` and `15cdde3` live on PR #11

---

### TASK-0002: Phase 1.3 — Attendance & Day-to-Day Operations
- **Started:** `2026-10-09 15:06:00 UTC`
- **Ended:** `2026-10-09 21:07:00 UTC`
- **Status:** Completed
- [x] Sub-phase A: Design committed in plan doc (`domain-implementation-plan.md`)
- [x] Sub-phase B: Schema & migration (AttendanceRecord table, unique per student+date, RLS policies)
- [x] Sub-phase C: Pure rules & bulk idempotent mark service
- [x] Sub-phase D: API routes (GET roll-call, POST bulk mark, edit window enforcement)
- [x] Sub-phase E: UI components (fast phone grid touch interface, summary cards, absentee list)
- [x] Sub-phase F: Unit, integration, API, and e2e test suite execution
- [x] Sub-phase G: Phase documentation & PR creation

---

### TASK-0003: Phase 1.4 — Results, Grading & Publishing Workflow
- **Started:** `2026-10-09 22:36:00 UTC`
- **Ended:** `2026-10-09 23:08:00 UTC`
- **Status:** Completed
- [x] Sub-phase A: Schema & migration (`prisma/schema/results.prisma`, RLS policies, append-only `ResultAudit`)
- [x] Sub-phase B: Pure rules & computation (`rules.ts`, `ranking.ts` 1224 ties, tamper-evident SHA-256 hash)
- [x] Sub-phase C: Domain services & HTTP schemas (`service.ts`, `http.ts`, IDOR protections)
- [x] Sub-phase D: API endpoints (results query/entry, status transitions, student report card, public token verification)
- [x] Sub-phase E: UI components (`ResultsEntryGrid`, `ResultsApprovalConsole`, `ReportCardView`, `VerifyCertificateForm`)
- [x] Sub-phase F: Unit, integration (RLS & append-only grants), and API testing green
- [x] Sub-phase G: Quality gates (`pnpm typecheck`, `pnpm lint`, `pnpm format:check`) and task synchronization

---

### TASK-0004: Phase 1.5 — Finance, Invoicing & Paystack Integration
- **Started:** `2026-10-10 00:07:00 UTC`
- **Ended:** `2026-10-10 08:45:00 UTC`
- **Status:** Completed
- [x] Sub-phase A: Schema & migration (`prisma/schema/finance.prisma`, PostgreSQL RLS policies, catalog guards)
- [x] Sub-phase B: Pure rules & computation (`rules.ts`, `crypto.ts`, timingSafeEqual HMAC-SHA512 verification)
- [x] Sub-phase C: Gateway client & dual-mode simulator (`mock-paystack.ts`, `paystack.ts`, fail-safe `PAYSTACK_NOT_CONFIGURED` in production)
- [x] Sub-phase D: Domain services & atomic concurrency (`service.ts`, `http.ts`, 20 simultaneous fulfilments locked to 1 credit)
- [x] Sub-phase E: API endpoints (fee structures, invoices, payment initialization, manual payment, discounts, public webhook)
- [x] Sub-phase F: UI components (`FeeStructuresPanel`, `InvoicesDashboard`, `InvoiceDetailView` with printable receipt, `PaystackMockModal`)
- [x] Sub-phase G: Testing & quality gates (unit tests 267/267, RLS 66/66, API tests 9/9, typecheck 0 errors, eslint 0 warnings, prettier check clean)

---

### TASK-0005: Phase 1.6 — Announcements & Timetable Scheduling
- **Started:** `2026-10-10 11:15:00 UTC`
- **Ended:** `2026-10-10 15:30:00 UTC`
- **Status:** Completed
- [x] Sub-phase A: Schema & migration (`timetable.prisma`, `announcements.prisma`, PostgreSQL RLS policies)
- [x] Sub-phase B: Pure rules & clash detection engine (`rules.ts`, teacher/room/class conflict detection)
- [x] Sub-phase C: Domain services & HTTP schemas (`service.ts`, `http.ts`, audience targeting)
- [x] Sub-phase D: API endpoints (timetable CRUD + batch, announcements broadcast & feed)
- [x] Sub-phase E: UI components (`TimetableCanvas`, `SlotEditModal`, `AnnouncementsFeed`, `AnnouncementComposerModal`)
- [x] Sub-phase F: Unit, integration, and API tests (287 unit, 66 RLS, 20 API)
- [x] Sub-phase G: Quality gates (`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm tasks:check`) and PR submission
