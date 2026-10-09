# 0014 — Audited in-place override for namesake student registrations
Status: Accepted
Decided by: maintainer · Date: 2026-10-09
Recorded: 2026-10-09

## Context
`StudentRecord` duplicate detection matches against `(tenantId, firstName, lastName, dateOfBirth)` (trimmed, case-insensitive). In school systems—particularly in regions with frequent patronymics, shared ancestral names, or common estimated birth dates (e.g., January 1st)—namesake students (such as cousins) can genuinely share the exact same first name, last name, and date of birth. Middle names are optional and middle names can also match or be legally absent.

A hard refusal with zero override (`POSSIBLE_DUPLICATE`) permanently blocked administrators from enrolling legitimate namesake students, tempting operators to falsify names or birth dates to bypass the system.

## Decision
Retain automatic duplicate refusal as the default barrier to catch accidental double entries. Provide an audited administrative override:

1. **Service & API**: `insertStudent`, `createStudent`, `updateStudent`, `restoreStudent`, and `importStudents` accept `allowDuplicate?: boolean`. When false (the default), `findDuplicate` yields `POSSIBLE_DUPLICATE` naming the conflicting admission number. When true, the write proceeds and records `{ duplicateOverridden: true, existingAdmissionNo }` in the audit event metadata (`STUDENT_CREATED`, `STUDENT_UPDATED`, `STUDENT_RESTORED`).
2. **Zero PII in Audit**: Audit entries log only IDs and admission numbers, never student names or birth dates.
3. **UI Confirmation**: In `StudentFormDialog`, a `POSSIBLE_DUPLICATE` response displays an inline warning banner and requires checking a dedicated `CheckboxField` ("Register/Update anyway as a distinct student") before the save button re-enables. Changing name or date of birth fields automatically clears the notice. In `StudentDetail`, restoring an archived student with an active namesake prompts a confirmation dialog.

## Alternatives Considered
- **Strict zero override**: Rejected. Legitimate namesake students cannot be enrolled without falsifying birth dates or names, corrupting state records.
- **Secondary approval workflow / separate queue**: Rejected as unnecessary ceremony for single-school administrators when an explicit checkbox plus immutable audit logging provides full accountability.

## Consequences & Revisit Triggers
- Namesake students can be registered cleanly without data corruption.
- Every override is auditable with direct reference to the preexisting conflicting record.
- **Revisit if:** High rates of accidental double-entry occur in production onboarding, warranting a two-person "four-eyes" authorization requirement.

## Enforced by
- `tests/integration/people-students.spec.ts` (create, update, restore override and audit non-leakage)
- `tests/api/people-students.spec.ts` (API 409 vs 200/201 override cycle)
- Review for UI components.

## Binds
- `src/lib/people/students.ts`
- `src/lib/people/import.ts`
- `src/app/api/v1/schools/[code]/people/students/`
- `src/components/people/StudentDialogs.tsx`
- `src/components/people/StudentDetail.tsx`
