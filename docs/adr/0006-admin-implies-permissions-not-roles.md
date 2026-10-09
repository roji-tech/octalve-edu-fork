# 0006 — ADMIN implies permissions, not roles; only an ADMIN grants
Status: accepted · Decided: Phase 1.0 · Recorded: 2026-10-07

## Context
Routes are guarded by role or by a named permission. An ADMIN who satisfied every `roles` check would become a teacher by accident; an admin who could delegate granting would make privilege unauditable.

## Decision
`withAuth(handler, { tenant: true, roles | permissions })` decides in `lib/auth/authorize.ts`: ADMIN satisfies a `permissions` requirement but **not** a `roles` requirement. Only an ADMIN may grant or revoke permissions (never delegable), only on staff roles (a CHECK constraint), and a role change clears them in the same transaction.

## Consequences
Every permission-guarded route is also reachable by ADMIN; role-guarded routes are not. No consumer of any permission exists until Phase 1.4/1.5.

## Enforced by
`tests/unit/authorize.spec.ts`, `with-auth.spec.ts`, `tests/integration/permissions.spec.ts`, `tests/api/members.spec.ts`.

## Related
Plan "Build design — Phase 1.0 and 1.1" · `phases/phase-1.0-foundations.md`.
