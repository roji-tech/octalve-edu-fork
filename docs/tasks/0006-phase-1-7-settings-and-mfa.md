# [TASK-0006]: Phase 1.7 — Settings UI, Step-up MFA & Audit Logging

- **Period / Focus:** 2026-10-10 (Settings UI, Multi-module School Workflow Configuration, Step-up MFA & Password Verification, Append-only Settings Change Audit)
- **Status:** Completed
- **Priority:** High
- **Assignee:** Claude Agent / Maintainer
- **Target Branch / PR:** `claude/phase-1-7-settings`
- **Started:** 2026-10-10 16:00:00 UTC
- **Ended:** 2026-10-10 17:10:00 UTC
- **Duration:** 1h 10m

> **How to tick:** change `[ ]` to `[x]`. The table shows the characters, not a clickable box.

---

## 1. Objective
Implement Phase 1.7 in Octalve Edu:
1. **Centralized School Settings UI**: Admin configurability surface at `/schools/[code]/settings` managing all 9 workflow toggles from PRD §14 (Result approval, Rollover mode, Class auto-assignment, Billing cycle, Fee reminders, Discount workflow mode, Fee cost bearer, Multi-campus, MFA requirement for teaching staff).
2. **Step-up Re-authentication Gate**: Require fresh second factor (`TOTP` / recovery code) or password re-authentication before applying any settings mutation, preventing session hijackers from silently disabling school controls.
3. **Immutable Settings Change Audit**: Append-only `SettingsChangeAudit` table capturing actor, field, previous value, new value, and timestamp of step-up verification with PostgreSQL RLS and revoked UPDATE/DELETE privileges.
4. **Active Navigation Shell Integration**: Activate the Settings tab in the sidebar nav (replacing the temporary "Soon" tag).
5. **Full Quality Gates**: Unit tests for settings validation & deltas, API tests for role protection, step-up failure rejection, and audit log generation; full RLS isolation tests.

---

## 2. Context & Related Docs
- Canonical Reference: `docs/PRD.md` §14, `docs/development-history/roadmap-breakdown.md` §1.7 & `domain-implementation-plan.md` lines 1880–1915, 2035.
- Security Requirements: Step-up authentication on every mutation (`hasActiveMfa` → TOTP/recovery or `proveOwnPassword`), immutable audit trail (`REVOKE UPDATE, DELETE ON "SettingsChangeAudit" FROM app_user`), tenant RLS.
- Preceding Work: Phase 1.0 (SchoolSettings table & defaults), Phase 0.5.D (MFA engine & password reauth), Phases 1.1–1.6 (Academic, attendance, grading, finance, timetable).

---

## 3. Work Breakdown

### Sub-phase A: Schema & Migration (`settings.prisma`)
- [x] Add `model SettingsChangeAudit` to `prisma/schema/settings.prisma` with `stepUpVerifiedAt`, `fromValue`, `toValue`, `field`, `actorUserId`, and `tenantId`.
- [x] Add back-relation `settingsChangeAudits SettingsChangeAudit[]` in `prisma/schema/tenancy.prisma`.
- [x] Create and apply PostgreSQL migration with `ENABLE/FORCE ROW LEVEL SECURITY`, tenant isolation policy, and `REVOKE UPDATE, DELETE ON "SettingsChangeAudit" FROM app_user`.
- [x] Verify test database and catalog invariants (`tests/integration/rls.spec.ts`).

### Sub-phase B: Pure Rules & Delta Computation
- [x] `src/lib/school-settings/rules.ts`:
  - Validate settings payload types and allowed enum values.
  - Diff current settings vs. desired updates to produce atomic change deltas.
  - Reject empty changes or unrecognized fields.
  - Security severity check (flagging high-risk control relaxations).

### Sub-phase C: Domain Services & Step-up Verification
- [x] `src/lib/school-settings/service.ts`:
  - `getSchoolSettings(tenantId)`: Query settings and recent change audit logs.
  - `verifyStepUp(userId, stepUp)`: Validate TOTP/recovery if MFA active, or fallback to password reauth.
  - `updateSchoolSettings(tenantId, actorUserId, updates, stepUp)`: Atomically log audit entries with `stepUpVerifiedAt` and apply settings update.
- [x] `src/lib/school-settings/http.ts`: Zod schema for settings update and step-up challenge payload.

### Sub-phase D: API Endpoints
- [x] `GET /api/v1/schools/[code]/settings`: Read settings and change history (ADMIN only).
- [x] `PATCH /api/v1/schools/[code]/settings`: Update settings with step-up verification and audit logging.

### Sub-phase E: UI Components & Shell Integration
- [x] `src/components/shell/SidebarNav.tsx`: Remove "Soon" badge from Settings item and wire active navigation.
- [x] `src/components/settings/SchoolSettingsPanel.tsx`: Tabbed or sectioned settings controls (Academic, Billing & Invoicing, Security & Access).
- [x] `src/components/settings/StepUpModal.tsx`: Step-up re-authentication modal handling TOTP / recovery / password input before saving.
- [x] `src/components/settings/SettingsAuditLog.tsx`: Collapsible or paginated audit history showing who changed what, when, and old vs new values.
- [x] Mount panel at `src/app/(app)/schools/[code]/settings/page.tsx`.

### Sub-phase F: Testing & Quality Gates
- [x] Unit tests for settings rules, delta calculations, and security classification (`tests/unit/settings-rules.spec.ts`).
- [x] API integration tests: ADMIN authorization, step-up failure (403), rate-limited reauth (429), successful step-up + audit entry creation, RLS cross-tenant isolation (`tests/api/settings.spec.ts`).
- [x] Update `tests/integration/rls.spec.ts` catalog table list and verify all RLS tests pass.
- [x] Run full quality gates: `pnpm test:unit`, `pnpm test:fast`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm tasks:check`.
- [x] Documentation update in `docs/development-history/phases/phase-1.7-settings-and-mfa.md`.
