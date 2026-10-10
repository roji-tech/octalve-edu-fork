# [TASK-0005]: Phase 1.6 — Announcements & Timetable Scheduling

- **Period / Focus:** 2026-10-10 (Announcements Broadcast, Audience Filtering, Timetable Slots, Clash Detection Engine & Interactive Visual Canvas)
- **Status:** Completed
- **Priority:** High
- **Assignee:** Claude Agent / Maintainer
- **Target Branch / PR:** `claude/phase-1-6-timetable`
- **Started:** 2026-10-10 11:15:00 UTC
- **Ended:** 2026-10-10 15:30:00 UTC
- **Duration:** ~4h 15m

> **How to tick:** change `[ ]` to `[x]`. The table shows the characters, not a clickable box.

---

## 1. Objective
Implement Phase 1.6 in Octalve Edu:
1. **School Announcements**: Multi-audience broadcast messaging targeted by role (`ADMIN`, `TEACHING_STAFF`, `NON_TEACHING_STAFF`, `STUDENT`, `PARENT`), campus, and class arm with publication scheduling and expiration windows.
2. **Timetable Scheduling**: Recurring weekly slot schedules (`TimetableSlot`) connecting class arms, subjects, teachers, days of week, time periods, and rooms.
3. **Pure Clash Detection Engine**: Automated detection and transactional conflict refusal for teacher double-booking, class arm schedule overlap, and room conflicts.
4. **Interactive Visual Canvas**: Visual drag-and-drop workflow grid adopting the node architecture from `TwoNode_V2_Design_Canvas.html` with real-time clash highlighting and mobile-responsive schedule cards.
5. **PostgreSQL Row-Level Security**: Complete multi-tenant RLS isolation on `Announcement` and `TimetableSlot`.

---

## 2. Context & Related Docs
- Canonical Reference: `docs/development-history/roadmap-breakdown.md` §1.6 & `domain-implementation-plan.md` lines 1831–1866.
- Permission Guard: `CAN_PUBLISH_CONTENT` (held implicitly by `ADMIN` or granted to staff).
- Security Requirements: Tenant-level RLS (`forTenant()`), IDOR isolation for targeted announcements, server-side clash prevention.
- Preceding Work: Phase 1.2 (Staff/ClassArms), Phase 1.3 (Attendance), Phase 1.4 (Results), Phase 1.5 (Finance).

---

## 3. Work Breakdown

### Sub-phase A: Schema & Migration (`timetable.prisma` & `announcements.prisma`)
- [x] Create `prisma/schema/announcements.prisma` with `Announcement`, `AnnouncementStatus`, audience target roles, campus and class scoping.
- [x] Create `prisma/schema/timetable.prisma` with `TimetableSlot`, day of week, start/end time, room, relations to ClassArm, Subject, and StaffRecord.
- [x] Add back-relations to `tenancy.prisma`, `academics.prisma`, and `people.prisma`.
- [x] Generate and deploy migration with PostgreSQL RLS policies (`ENABLE/FORCE ROW LEVEL SECURITY`, `app_tenant_id()`).
- [x] Run `prisma generate` and verify catalog invariants.

### Sub-phase B: Pure Rules & Clash Detection Engine
- [x] `src/lib/timetable/rules.ts`:
  - Time interval overlap calculation (`startTime < other.endTime && endTime > other.startTime`).
  - Teacher clash detection (`staffRecordId` conflict across class arms).
  - Class arm clash detection (`classArmId` conflict across subjects).
  - Room clash detection (`room` conflict across arms and teachers).
  - Time boundary and format validation (`HH:MM`, `startTime < endTime`).
- [x] `src/lib/announcements/rules.ts`:
  - Audience visibility rules (role targeting, campus matching, class arm links).
  - Publication window enforcement (`publishedAt <= now <= expiresAt`).

### Sub-phase C: Domain Services & HTTP Schemas
- [x] `src/lib/timetable/service.ts`:
  - Query timetable slots (by class arm, teacher, or day).
  - Create slot with atomic clash prevention.
  - Update slot with differential clash check.
  - Delete slot.
  - Bulk save timetable slots with transactional conflict rollback.
- [x] `src/lib/announcements/service.ts`:
  - List announcements filtered by user permissions and recipient role/campus.
  - Create announcement with audience targeting.
  - Update and archive announcements.
- [x] `src/lib/timetable/http.ts` & `src/lib/announcements/http.ts`: Zod validation schemas.

### Sub-phase D: API Endpoints
- [x] `GET/POST /api/v1/schools/[code]/timetable`: Query and create slots.
- [x] `PATCH/DELETE /api/v1/schools/[code]/timetable/[id]`: Modify or remove slots.
- [x] `POST /api/v1/schools/[code]/timetable/batch`: Batch update for visual canvas.
- [x] `GET/POST /api/v1/schools/[code]/announcements`: Audience-filtered feed and broadcast creation.
- [x] `GET/PATCH/DELETE /api/v1/schools/[code]/announcements/[id]`: Detail, edit, and archive.

### Sub-phase E: UI Components
- [x] `src/components/timetable/TimetableCanvas.tsx`: Interactive visual grid with color-coded subject nodes, teacher & room badges, and instant visual clash warning badges.
- [x] `src/components/timetable/SlotEditModal.tsx`: Slot assignment modal with real-time clash warning.
- [x] `src/components/announcements/AnnouncementsFeed.tsx`: Filterable broadcast list for staff, parents, and students.
- [x] `src/components/announcements/AnnouncementComposerModal.tsx`: Announcement creation dialog with role and campus targeting.

### Sub-phase F: Testing & Quality Gates
- [x] Unit tests for clash detection engine, interval overlaps, and audience visibility rules (22 tests).
- [x] API integration tests: timetable clash rejection (409 Conflict), audience isolation (parents only see their announcements), unauthenticated and IDOR protections (20 tests).
- [x] RLS catalog and tenant boundary verification (66 tests).
- [x] Quality gates: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm tasks:check`.
- [x] Git commit and push to fork branch `claude/phase-1-6-timetable`.
