-- Phase 1.1, families C and D — assessment schemes and grade scales (plan "Build design — Phase 1.0 and 1.1", decisions 14 and 15).
-- ADDITIVE ONLY. RLS ships here. Schemes and scales are ARCHIVED, never deleted (no DELETE policy). Their children (components, bands) may be
-- replaced while the parent is UNLOCKED — and once a parent is locked (the first result that references it), TRIGGERS refuse every change to it
-- and to its children, whichever code writes: history cannot be rewritten even by a service with a bug.

-- CreateTable
CREATE TABLE "AssessmentScheme" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "classGroupId" TEXT,
    "name" TEXT NOT NULL,
    "totalMax" DECIMAL(6,2) NOT NULL DEFAULT 100,
    "examMax" DECIMAL(6,2) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lockedAt" TIMESTAMP(3),
    "supersedesId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentComponent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxScore" DECIMAL(6,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "AssessmentComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeScale" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lockedAt" TIMESTAMP(3),
    "supersedesId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradeScale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradeBand" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scaleId" TEXT NOT NULL,
    "minScore" DECIMAL(5,2) NOT NULL,
    "maxScore" DECIMAL(5,2) NOT NULL,
    "letter" TEXT NOT NULL,
    "remark" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "GradeBand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssessmentScheme_tenantId_idx" ON "AssessmentScheme"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentScheme_tenantId_id_key" ON "AssessmentScheme"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AssessmentComponent_tenantId_schemeId_idx" ON "AssessmentComponent"("tenantId", "schemeId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentComponent_tenantId_id_key" ON "AssessmentComponent"("tenantId", "id");

-- CreateIndex
CREATE INDEX "GradeScale_tenantId_idx" ON "GradeScale"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "GradeScale_tenantId_id_key" ON "GradeScale"("tenantId", "id");

-- CreateIndex
CREATE INDEX "GradeBand_tenantId_scaleId_idx" ON "GradeBand"("tenantId", "scaleId");

-- CreateIndex
CREATE UNIQUE INDEX "GradeBand_tenantId_id_key" ON "GradeBand"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "AssessmentScheme" ADD CONSTRAINT "AssessmentScheme_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentScheme" ADD CONSTRAINT "AssessmentScheme_tenantId_classGroupId_fkey" FOREIGN KEY ("tenantId", "classGroupId") REFERENCES "ClassGroup"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentScheme" ADD CONSTRAINT "AssessmentScheme_tenantId_supersedesId_fkey" FOREIGN KEY ("tenantId", "supersedesId") REFERENCES "AssessmentScheme"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentComponent" ADD CONSTRAINT "AssessmentComponent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentComponent" ADD CONSTRAINT "AssessmentComponent_tenantId_schemeId_fkey" FOREIGN KEY ("tenantId", "schemeId") REFERENCES "AssessmentScheme"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeScale" ADD CONSTRAINT "GradeScale_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeScale" ADD CONSTRAINT "GradeScale_tenantId_supersedesId_fkey" FOREIGN KEY ("tenantId", "supersedesId") REFERENCES "GradeScale"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeBand" ADD CONSTRAINT "GradeBand_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradeBand" ADD CONSTRAINT "GradeBand_tenantId_scaleId_fkey" FOREIGN KEY ("tenantId", "scaleId") REFERENCES "GradeScale"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- --- rules Prisma's schema language cannot express ------------------------------------------------------------------------------
ALTER TABLE "AssessmentScheme" ADD CONSTRAINT "AssessmentScheme_name_not_blank" CHECK (length(btrim("name")) BETWEEN 1 AND 60);
ALTER TABLE "AssessmentScheme" ADD CONSTRAINT "AssessmentScheme_totals" CHECK ("totalMax" > 0 AND "examMax" >= 0 AND "examMax" <= "totalMax");
ALTER TABLE "AssessmentScheme" ADD CONSTRAINT "AssessmentScheme_version_positive" CHECK ("version" >= 1);
-- One LIVE scheme per class-group scope (NULL = the school default), and a unique live name per school. A new version archives its predecessor first.
CREATE UNIQUE INDEX "AssessmentScheme_one_live_per_scope" ON "AssessmentScheme"("tenantId", COALESCE("classGroupId", '')) WHERE "archivedAt" IS NULL;
CREATE UNIQUE INDEX "AssessmentScheme_name_live" ON "AssessmentScheme"("tenantId", "name") WHERE "archivedAt" IS NULL;

ALTER TABLE "AssessmentComponent" ADD CONSTRAINT "AssessmentComponent_name_not_blank" CHECK (length(btrim("name")) BETWEEN 1 AND 40);
ALTER TABLE "AssessmentComponent" ADD CONSTRAINT "AssessmentComponent_max_positive" CHECK ("maxScore" > 0);
ALTER TABLE "AssessmentComponent" ADD CONSTRAINT "AssessmentComponent_sort_range" CHECK ("sortOrder" BETWEEN 0 AND 99);
CREATE UNIQUE INDEX "AssessmentComponent_name_per_scheme" ON "AssessmentComponent"("schemeId", lower("name"));

ALTER TABLE "GradeScale" ADD CONSTRAINT "GradeScale_name_not_blank" CHECK (length(btrim("name")) BETWEEN 1 AND 60);
ALTER TABLE "GradeScale" ADD CONSTRAINT "GradeScale_version_positive" CHECK ("version" >= 1);
-- Exactly one live DEFAULT scale per school, and a unique live name.
CREATE UNIQUE INDEX "GradeScale_one_live_default" ON "GradeScale"("tenantId") WHERE "isDefault" AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX "GradeScale_name_live" ON "GradeScale"("tenantId", "name") WHERE "archivedAt" IS NULL;

ALTER TABLE "GradeBand" ADD CONSTRAINT "GradeBand_range" CHECK ("minScore" >= 0 AND "maxScore" <= 100 AND "minScore" < "maxScore");
ALTER TABLE "GradeBand" ADD CONSTRAINT "GradeBand_letter_not_blank" CHECK (length(btrim("letter")) BETWEEN 1 AND 4);
ALTER TABLE "GradeBand" ADD CONSTRAINT "GradeBand_remark_not_blank" CHECK (length(btrim("remark")) BETWEEN 1 AND 40);
ALTER TABLE "GradeBand" ADD CONSTRAINT "GradeBand_sort_range" CHECK ("sortOrder" BETWEEN 0 AND 99);
CREATE UNIQUE INDEX "GradeBand_letter_per_scale" ON "GradeBand"("scaleId", lower("letter"));

-- --- immutability once locked ---------------------------------------------------------------------------------------------------
-- A locked scheme (a result references it) keeps its name, totals, version, scope and lock forever; only archiving (archivedAt) and updatedAt may change.
CREATE FUNCTION assessment_scheme_locked_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF OLD."lockedAt" IS NOT NULL AND (NEW."name", NEW."totalMax", NEW."examMax", NEW."version", NEW."classGroupId", NEW."supersedesId", NEW."lockedAt")
     IS DISTINCT FROM (OLD."name", OLD."totalMax", OLD."examMax", OLD."version", OLD."classGroupId", OLD."supersedesId", OLD."lockedAt") THEN
    RAISE EXCEPTION 'assessment scheme % is locked: a change is a new version', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assessment_scheme_locked BEFORE UPDATE ON "AssessmentScheme" FOR EACH ROW EXECUTE FUNCTION assessment_scheme_locked_guard();

-- Components of a locked scheme cannot be added, changed or removed. pg_trigger_depth() > 1 means the DELETE came from a foreign-key cascade
-- (deleting a whole school, run by the owner): that is allowed, a direct statement is not.
CREATE FUNCTION assessment_component_locked_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  locked timestamp(3);
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT "lockedAt" INTO locked FROM "AssessmentScheme" WHERE "id" = COALESCE(NEW."schemeId", OLD."schemeId");
  IF locked IS NOT NULL THEN
    RAISE EXCEPTION 'assessment scheme % is locked: its components cannot change', COALESCE(NEW."schemeId", OLD."schemeId") USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER assessment_component_locked BEFORE INSERT OR UPDATE OR DELETE ON "AssessmentComponent" FOR EACH ROW EXECUTE FUNCTION assessment_component_locked_guard();

CREATE FUNCTION grade_scale_locked_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF OLD."lockedAt" IS NOT NULL AND (NEW."name", NEW."version", NEW."supersedesId", NEW."lockedAt")
     IS DISTINCT FROM (OLD."name", OLD."version", OLD."supersedesId", OLD."lockedAt") THEN
    RAISE EXCEPTION 'grade scale % is locked: a change is a new version', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER grade_scale_locked BEFORE UPDATE ON "GradeScale" FOR EACH ROW EXECUTE FUNCTION grade_scale_locked_guard();

CREATE FUNCTION grade_band_locked_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  locked timestamp(3);
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT "lockedAt" INTO locked FROM "GradeScale" WHERE "id" = COALESCE(NEW."scaleId", OLD."scaleId");
  IF locked IS NOT NULL THEN
    RAISE EXCEPTION 'grade scale % is locked: its bands cannot change', COALESCE(NEW."scaleId", OLD."scaleId") USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER grade_band_locked BEFORE INSERT OR UPDATE OR DELETE ON "GradeBand" FOR EACH ROW EXECUTE FUNCTION grade_band_locked_guard();

-- --- row-level security ---------------------------------------------------------------------------------------------------------
ALTER TABLE "AssessmentScheme" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentScheme" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_scheme_read ON "AssessmentScheme" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY assessment_scheme_insert ON "AssessmentScheme" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY assessment_scheme_update ON "AssessmentScheme" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "AssessmentComponent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentComponent" FORCE ROW LEVEL SECURITY;
CREATE POLICY assessment_component_read ON "AssessmentComponent" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY assessment_component_insert ON "AssessmentComponent" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY assessment_component_update ON "AssessmentComponent" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY assessment_component_delete ON "AssessmentComponent" FOR DELETE USING ("tenantId" = app_tenant_id());

ALTER TABLE "GradeScale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GradeScale" FORCE ROW LEVEL SECURITY;
CREATE POLICY grade_scale_read ON "GradeScale" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY grade_scale_insert ON "GradeScale" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY grade_scale_update ON "GradeScale" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "GradeBand" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GradeBand" FORCE ROW LEVEL SECURITY;
CREATE POLICY grade_band_read ON "GradeBand" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY grade_band_insert ON "GradeBand" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY grade_band_update ON "GradeBand" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY grade_band_delete ON "GradeBand" FOR DELETE USING ("tenantId" = app_tenant_id());

SELECT app_grant_runtime_privileges();
