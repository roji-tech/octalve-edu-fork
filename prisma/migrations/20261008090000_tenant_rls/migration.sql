-- Row-level security for tenant-scoped tables (domain-implementation-plan.md §0.5.2). Run by the MIGRATOR role (the
-- table owner); the app connects as `app_user`, which RLS applies to.
--
-- THE RULE for every table added from here on: if it has a "tenantId" column it gets, IN THE SAME MIGRATION that
-- creates it, ENABLE + FORCE ROW LEVEL SECURITY and a policy with BOTH `USING` (what can be read/touched) and
-- `WITH CHECK` (what can be written) on "tenantId" = app_tenant_id(). A catalog test fails the build otherwise.

-- --- the context the policies read ---------------------------------------------------------------------------------
-- The application sets these per transaction (set_config(..., true), a bind parameter — see lib/tenant/for-tenant.ts).
-- NULLIF matters: after a transaction that set a transaction-local value, a pooled connection reads the setting back as
-- the EMPTY STRING, not NULL. Empty → NULL → no row ever matches → an unset context means ZERO rows and no writes.
CREATE FUNCTION app_tenant_id() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '') $$;

CREATE FUNCTION app_user_id() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

-- --- Campus: plainly tenant-scoped -----------------------------------------------------------------------------------
ALTER TABLE "Campus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Campus" FORCE ROW LEVEL SECURITY;
CREATE POLICY campus_tenant_isolation ON "Campus"
  USING ("tenantId" = app_tenant_id())
  WITH CHECK ("tenantId" = app_tenant_id());

-- --- AuditLog: tenant-scoped AND append-only -----------------------------------------------------------------------------
-- Readable and insertable inside the tenant context; there is NO update or delete policy, and the runtime role is not
-- granted those privileges at all (see app_grant_runtime_privileges) — two independent locks.
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON "AuditLog" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY audit_insert ON "AuditLog" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());

-- --- TenantMembership: tenant data that is ALSO read before any tenant is known -----------------------------------------
-- A tenant sees (and manages) its own roster; a person may READ their own memberships through the user context (that is
-- how the school is found at all). Writes are tenant-context only, so nobody can grant themselves a role through the
-- user path, and an unscoped `findMany()` returns nothing instead of every school's staff list.
ALTER TABLE "TenantMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantMembership" FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON "TenantMembership" FOR SELECT
  USING ("tenantId" = app_tenant_id() OR "userId" = app_user_id());
CREATE POLICY membership_insert ON "TenantMembership" FOR INSERT
  WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY membership_update ON "TenantMembership" FOR UPDATE
  USING ("tenantId" = app_tenant_id())
  WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY membership_delete ON "TenantMembership" FOR DELETE
  USING ("tenantId" = app_tenant_id());

-- --- the runtime role's privileges -------------------------------------------------------------------------------------
-- Data access only: SELECT/INSERT/UPDATE/DELETE on the tables — no DDL, no `_prisma_migrations`, and the audit log can only
-- be appended to. A function (not inline SQL) so `pnpm db:roles` can re-apply it to a database whose role was created AFTER
-- the migrations ran, and so a later migration that adds an append-only table can call it again. The role is created by
-- infrastructure (docker/postgres/init, `pnpm db:roles`, the installer) — a cluster-level object, not a migration's business.
-- If it does not exist yet this only says so; the application REFUSES to serve tenant data in production on a role that
-- bypasses RLS (lib/tenant/assert-rls.ts), so a missing role cannot quietly mean "no RLS".
CREATE FUNCTION app_grant_runtime_privileges() RETURNS void LANGUAGE plpgsql AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    RAISE NOTICE 'role app_user does not exist: runtime privileges NOT granted (create it, then run: SELECT app_grant_runtime_privileges())';
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO app_user;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."_prisma_migrations" FROM app_user;
  END IF;
  REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public."AuditLog" FROM app_user;
  -- Tables created by later migrations are granted without anyone having to remember.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
END
$$;

SELECT app_grant_runtime_privileges();
