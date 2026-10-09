# 0001 — Tenant isolation is row-level security plus composite foreign keys
Status: accepted · Decided: Phase 0.5.2 (applied to every table since) · Recorded: 2026-10-07

## Context
Many schools share one database. An application-layer `WHERE tenantId = …` is one forgotten clause away from a cross-school leak, and a query that runs as the migration owner ignores RLS without any sign that it does.

## Decision
- Every tenant-scoped table has `ENABLE` **and** `FORCE ROW LEVEL SECURITY` with `USING` and `WITH CHECK` on `"tenantId" = app_tenant_id()`, in the same migration that creates the table.
- The app connects as `app_user` and reaches data only through `auth.tenant.run(tx => …)`; queries still name the tenant.
- A child row points at its parent with a **composite** foreign key `(tenantId, parentId) → parent(tenantId, id)`, so a row cannot reference another school's parent even through the owner role. The tenant FK cascades; the composite ones are `ON DELETE NO ACTION`.
- Tests arrange data as the admin and read as `app_user`; a test that runs as the owner can pass while protecting nothing.

## Consequences
Prisma cannot create nested children with a composite tenant key, so services create the parent and then `createMany` the children. Every new table must be added to the catalog guard.

## Enforced by
`tests/integration/rls.spec.ts` (the catalog guard enumerates tables and demands forced RLS; per-table cross-tenant tests) and `tests/api/tenant-boundary.spec.ts`.

## Related
PRD §7 · plan §0.5.2 · `phases/phase-0.5.2-tenant-boundary.md` · `phases/phase-1.1-academic-structure.md` finding 6.
