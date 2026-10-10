# Phase 1.6 — Announcements & Timetable Scheduling

**Status: BUILT AND VERIFIED (2026-10-10); Schema, RLS, Pure Rules (287/287), Services, APIs (20/20), and UI Components verified. All quality gates passing.**
Branch: `claude/phase-1-6-timetable`.
Design of record: `docs/tasks/0005-phase-1-6-announcements-and-timetable.md`.
Roadmap: `docs/development-history/roadmap-breakdown.md` §1.6.

---

## What this delivers

| Step | Scope | What |
|---|---|---|
| Schema & Migration | DB / RLS | `prisma/schema/announcements.prisma` (`Announcement`, `AnnouncementStatus`) & `prisma/schema/timetable.prisma` (`TimetableSlot`); migration `20261019090000_phase_1_6_timetable_announcements` applied to `octalve_edu` and `octalve_edu_test` with full RLS `ENABLE` & `FORCE`, check constraints (dayOfWeek 1–7, startTime < endTime), and runtime grants |
| Pure Rules | Domain | `src/lib/timetable/rules.ts` (time arithmetic, pure clash detection engine: teacher double-booking, class arm schedule overlap, room conflicts), `src/lib/announcements/rules.ts` (multi-audience targeting by `Role[]`, `campusId`, `classArmId`, active window verification) |
| API & Service | HTTP / Envelopes | `src/lib/timetable/http.ts`, `src/lib/timetable/service.ts`, `src/lib/announcements/http.ts`, `src/lib/announcements/service.ts`, `GET/POST /api/v1/schools/[code]/timetable`, `PATCH/DELETE /api/v1/schools/[code]/timetable/[id]`, `POST /api/v1/schools/[code]/timetable/batch`, `GET/POST /api/v1/schools/[code]/announcements`, `GET/PATCH/DELETE /api/v1/schools/[code]/announcements/[id]` |
| UI & Screens | Client Components | `src/components/timetable/TimetableCanvas.tsx` with TwoNode visual node/grid architecture, `SlotEditModal.tsx` with live clash detection preview, `src/components/academics/TimetablePanel.tsx` mounted in Academics; `src/components/announcements/AnnouncementsFeed.tsx` & `AnnouncementComposerModal.tsx` mounted on school Overview page |
| Tests | Playwright | `tests/unit/timetable-rules.spec.ts`, `tests/unit/announcements-rules.spec.ts`, `tests/api/timetable.spec.ts`, `tests/api/announcements.spec.ts`, verified against `tests/integration/rls.spec.ts` |

---

## Key Technical Decisions & Invariants
1. **Multi-Audience Broadcast Model:** Empty `targetRoles = []` indicates a school-wide broadcast visible to all roles. Null `campusId` or `classArmId` targets the whole school or all arms.
2. **Three-Dimensional Pure Clash Detection Engine:** Scheduling enforces strict conflict avoidance across teacher availability, class arm lesson overlap, and room bookings.
3. **Interactive TwoNode Canvas Architecture:** Timetable scheduling provides both a full desktop week grid (Mon-Fri/Sat) with real-time clash badges and a responsive mobile card stack.
4. **Tenant Isolation:** Enforced via `app_user` Row-Level Security on PostgreSQL.
