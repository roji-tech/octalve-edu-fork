# Phase 1.4 — Results, Assessment Recording & Report Card Publishing

**Status: BUILT & VERIFIED (2026-10-09); Unit (26/26), API (8/8), Integration & RLS (66/66) all green.**
Branch: `claude/phase-1-4-results` (merged into `fork/claude/phase-1-3-attendance`).
Design of record: `docs/tasks/0003-phase-1-4-results-and-publishing.md`.
Roadmap: `docs/development-history/roadmap-breakdown.md` §1.4.

---

## What this delivers

| Step | Scope | What |
|---|---|---|
| Schema & Migration | DB / RLS | `prisma/schema/results.prisma` (`Result`, `ResultAudit`); migration `20261017090000_phase_1_4_results_and_publishing` applied to `octalve_edu` and `octalve_edu_test` with full RLS `ENABLE` & `FORCE`, immutability triggers on published results, and runtime grants |
| Pure Rules | Domain | `src/lib/results/rules.ts` (grade band resolution, GPA calculation, weighted composite scoring, locked assessment scheme verification) |
| API & Service | HTTP / Envelopes | `src/lib/results/http.ts`, `src/lib/results/service.ts`, `GET/POST /api/v1/schools/[code]/academics/results`, `GET/POST /api/v1/schools/[code]/academics/results/publish`, `GET /api/v1/schools/[code]/academics/students/[id]/report-card` |
| UI & Screens | Client Components | `src/components/results/ResultEntryMatrix.tsx` and `ReportCardModal.tsx` mounted in Academics; touch-friendly score grid, automated grade band pill previews, one-click report card PDF/print generator |
| Tests | Playwright | `tests/unit/results-rules.spec.ts`, `tests/api/results.spec.ts`, verified against `tests/integration/rls.spec.ts` |

---

## Key Technical Decisions & Invariants
1. **Append-Only Audit Trail (`ResultAudit`):** Every raw score change records previous score, new score, actor ID, and timestamp. The audit table has strict `REVOKE UPDATE, DELETE, TRUNCATE` for `app_user`.
2. **Atomic Publication Lock:** Once a term's results are published by an `ADMIN` (`isPublished: true`), scores are locked from staff edits. Unpublishing requires administrator override.
3. **Continuous Grade Computation:** Grades and remarks are dynamically resolved from the school's active `GradeScale` and contiguous `GradeBand` definitions (half-open intervals from 0 to 100).
4. **Tenant Isolation:** Cross-tenant assessment access is strictly refused at both route and PostgreSQL RLS layers.
