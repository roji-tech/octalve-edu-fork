# Phase 1.7 — Settings UI, Step-up MFA & Audit Logging

**Status: BUILT AND VERIFIED (2026-10-10); Schema, RLS, Pure Rules (294/294), Services, APIs (15/15), and UI Components verified. All quality gates passing.**
Branch: `claude/phase-1-7-settings`.
Design of record: `docs/tasks/0006-phase-1-7-settings-and-mfa.md`.
Roadmap: `docs/development-history/roadmap-breakdown.md` §1.7.

---

## What this delivers

| Step | Scope | What |
|---|---|---|
| Schema & Migration | DB / RLS | `prisma/schema/settings.prisma` (`SettingsChangeAudit` model with `stepUpVerifiedAt`, `fromValue`, `toValue`, `field`, `actorUserId`, `tenantId`, index on `[tenantId, createdAt]`); migration `20261020090000_phase_1_7_settings_audit` applied to `octalve_edu` and `octalve_edu_test` with full RLS `ENABLE` & `FORCE`, read/insert policies, and `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public."SettingsChangeAudit" FROM app_user` |
| Pure Rules | Domain | `src/lib/school-settings/rules.ts` (`ALLOWED_SETTING_FIELDS`, `UpdatableSettings`, `isControlWeakened()`, `stringifySettingValue()`, `computeSettingsDeltas()`, `validateSettingsPayload()`), 7 unit tests in `tests/unit/settings-rules.spec.ts` (294 total repo unit tests green) |
| API & Service | HTTP / Envelopes | `src/lib/school-settings/http.ts`, `src/lib/school-settings/service.ts`, `GET /api/v1/schools/[code]/settings` (fetches settings, audit trail, user MFA status), `PATCH /api/v1/schools/[code]/settings` (validates step-up auth, atomic settings mutation and audit row generation); 15/15 API tests green |
| UI & Screens | Client Components | `src/components/settings/StepUpModal.tsx` (accessible dialog prompting for TOTP/recovery or password re-auth with security relaxation warnings), `src/components/settings/SettingsAuditLog.tsx` (immutable audit history viewer with verified badges), `src/components/settings/SchoolSettingsPanel.tsx` (tabbed settings controls, dirty state tracking), `src/app/(app)/schools/[code]/settings/page.tsx`, activated link in `src/components/shell/nav.ts` |
| Tests | Playwright | `tests/unit/settings-rules.spec.ts` (7 passed), `tests/integration/rls.spec.ts` (68 passed), `tests/api/settings.spec.ts` (15 passed), unit nav suite updated (294 passed) |

---

## Key Technical Decisions & Invariants
1. **Centralized PRD §14 Workflow Toggles:** Centralizes management of all 9 institutional workflow controls (`resultApprovalRequired`, `rolloverMode`, `classAutoAssignment`, `billingCycle`, `feeReminderEnabled`, `discountWorkflowMode`, `feeCostBearer`, `multiCampusEnabled`, `mfaRequiredForTeaching`).
2. **Step-Up Authentication Proof Gate:** Every settings mutation requires fresh authentication proof in the request body. If the administrator has active TOTP MFA enrolled, a fresh 6-digit TOTP code or recovery code is required; if MFA is not enrolled, password re-authentication (`proveOwnPassword`) is required.
3. **Security Relaxation Classification:** `isControlWeakened()` identifies changes that weaken governance (e.g. disabling result approval or teaching staff MFA requirements), triggering explicit warning banners in the UI and distinct delta classification in API responses.
4. **Append-Only Audit Invariant:** `SettingsChangeAudit` tracks actor, tenant, field, previous value, new value, timestamp, and `stepUpVerifiedAt`. Database privileges `UPDATE`, `DELETE`, and `TRUNCATE` are explicitly revoked from `app_user` on PostgreSQL, guaranteeing immutability.
5. **Active Shell Navigation:** The Settings item in `src/components/shell/nav.ts` is activated with route `/schools/[code]/settings` for administrators, replacing previous disabled "Soon" tags.
