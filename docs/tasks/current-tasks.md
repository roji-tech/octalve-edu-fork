# Current Tasks — Octalve Edu

> **Rule:** How to tick: change `[ ]` to `[x]`. The table shows the characters, not a clickable box.
> All dates and times are recorded in UTC with standard ISO format (`YYYY-MM-DD HH:MM:SS UTC`).
> **Grouping Policy:** Tasks represent cohesive phase-level milestones (design → schema → logic → UI → test → docs → PR) to prevent file proliferation.

---

## Active & Sequential Milestone Register

| # | Task ID | Milestone Title | Status | Started | Ended | PR / Branch |
|---|---|---|---|---|---|---|
| 1 | [TASK-0001](0001-phase-1-2-people-and-enrolment.md) | Phase 1.2: People & Enrolment (Option B duplicate override + ADR 0014) | [x] Completed | 2026-10-07 09:00:00 UTC | 2026-10-09 09:06:17 UTC | [PR #11](https://github.com/roji-tech/octalve-edu-fork/pull/11) (`claude/phase-1-2-people`) |
| 2 | [TASK-0002](0002-phase-1-3-attendance.md) | Phase 1.3: Attendance & Day-to-Day Operations | [ ] In Progress | 2026-10-09 15:06:00 UTC | — | `claude/phase-1-3-attendance` |
| 3 | [TASK-0003](0003-phase-1-4-results-and-publishing.md) | Phase 1.4: Results, Grading & Publishing Workflow | [ ] Pending | — | — | `claude/phase-1-4-results` |
| 4 | [TASK-0004](0004-phase-1-5-finance-and-billing.md) | Phase 1.5: Finance, Invoicing & Paystack Integration | [ ] Pending | — | — | `claude/phase-1-5-finance` |
| 5 | [TASK-0005](0005-phase-1-6-announcements-and-timetable.md) | Phase 1.6: Announcements & Timetable Scheduling | [ ] Pending | — | — | `claude/phase-1-6-timetable` |
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
- **Ended:** —
- **Status:** In Progress
- [ ] Sub-phase A: Design committed in plan doc (`domain-implementation-plan.md`)
- [ ] Sub-phase B: Schema & migration (AttendanceRecord table, unique per student+date+period, RLS policies)
- [ ] Sub-phase C: Pure rules & bulk idempotent mark service
- [ ] Sub-phase D: API routes (GET roll-call, POST bulk mark, edit window enforcement)
- [ ] Sub-phase E: UI components (fast phone grid touch interface, summary cards, absentee list)
- [ ] Sub-phase F: Unit, integration, API, and e2e test suite execution
- [ ] Sub-phase G: Phase documentation & PR creation
