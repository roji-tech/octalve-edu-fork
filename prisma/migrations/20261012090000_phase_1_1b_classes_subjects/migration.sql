-- Phase 1.1, family B — class groups, arms, subjects and what each class group studies (plan "Build design — Phase 1.0 and 1.1", decision 13).
-- ADDITIVE ONLY. RLS ships here. Groups, arms and subjects are ARCHIVED, never deleted: no DELETE policy. SubjectOffering alone has a DELETE policy
-- (removing "this class studies this subject" is a real delete in this slice because nothing references it yet).

-- CreateTable
CREATE TABLE "ClassGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campusId" TEXT,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassArm" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "classGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassArm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubjectOffering" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "classGroupId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubjectOffering_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassGroup_tenantId_idx" ON "ClassGroup"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassGroup_tenantId_id_key" ON "ClassGroup"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ClassArm_tenantId_classGroupId_idx" ON "ClassArm"("tenantId", "classGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassArm_tenantId_id_key" ON "ClassArm"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Subject_tenantId_idx" ON "Subject"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_tenantId_id_key" ON "Subject"("tenantId", "id");

-- CreateIndex
CREATE INDEX "SubjectOffering_tenantId_idx" ON "SubjectOffering"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SubjectOffering_classGroupId_subjectId_key" ON "SubjectOffering"("classGroupId", "subjectId");

-- AddForeignKey
ALTER TABLE "ClassGroup" ADD CONSTRAINT "ClassGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassGroup" ADD CONSTRAINT "ClassGroup_tenantId_campusId_fkey" FOREIGN KEY ("tenantId", "campusId") REFERENCES "Campus"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassArm" ADD CONSTRAINT "ClassArm_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassArm" ADD CONSTRAINT "ClassArm_tenantId_classGroupId_fkey" FOREIGN KEY ("tenantId", "classGroupId") REFERENCES "ClassGroup"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectOffering" ADD CONSTRAINT "SubjectOffering_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectOffering" ADD CONSTRAINT "SubjectOffering_tenantId_classGroupId_fkey" FOREIGN KEY ("tenantId", "classGroupId") REFERENCES "ClassGroup"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectOffering" ADD CONSTRAINT "SubjectOffering_tenantId_subjectId_fkey" FOREIGN KEY ("tenantId", "subjectId") REFERENCES "Subject"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- --- rules Prisma's schema language cannot express ------------------------------------------------------------------------------
ALTER TABLE "ClassGroup" ADD CONSTRAINT "ClassGroup_name_not_blank" CHECK (length(btrim("name")) BETWEEN 1 AND 60);
ALTER TABLE "ClassGroup" ADD CONSTRAINT "ClassGroup_sort_order_range" CHECK ("sortOrder" BETWEEN 0 AND 999);
-- A name is unique per (school, campus-scope) among LIVE groups; "every campus" is a scope of its own.
CREATE UNIQUE INDEX "ClassGroup_name_live" ON "ClassGroup"("tenantId", COALESCE("campusId", ''), "name") WHERE "archivedAt" IS NULL;

ALTER TABLE "ClassArm" ADD CONSTRAINT "ClassArm_name_not_blank" CHECK (length(btrim("name")) BETWEEN 1 AND 30);
ALTER TABLE "ClassArm" ADD CONSTRAINT "ClassArm_capacity_positive" CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 1000);
CREATE UNIQUE INDEX "ClassArm_name_live" ON "ClassArm"("classGroupId", "name") WHERE "archivedAt" IS NULL;

ALTER TABLE "Subject" ADD CONSTRAINT "Subject_name_not_blank" CHECK (length(btrim("name")) BETWEEN 1 AND 80);
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_code_shape" CHECK ("code" IS NULL OR "code" ~ '^[A-Z0-9]{1,12}$');
CREATE UNIQUE INDEX "Subject_name_live" ON "Subject"("tenantId", "name") WHERE "archivedAt" IS NULL;
CREATE UNIQUE INDEX "Subject_code_live" ON "Subject"("tenantId", "code") WHERE "code" IS NOT NULL AND "archivedAt" IS NULL;

-- --- row-level security ---------------------------------------------------------------------------------------------------------
ALTER TABLE "ClassGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassGroup" FORCE ROW LEVEL SECURITY;
CREATE POLICY class_group_read ON "ClassGroup" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY class_group_insert ON "ClassGroup" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY class_group_update ON "ClassGroup" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "ClassArm" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassArm" FORCE ROW LEVEL SECURITY;
CREATE POLICY class_arm_read ON "ClassArm" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY class_arm_insert ON "ClassArm" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY class_arm_update ON "ClassArm" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "Subject" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subject" FORCE ROW LEVEL SECURITY;
CREATE POLICY subject_read ON "Subject" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY subject_insert ON "Subject" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY subject_update ON "Subject" FOR UPDATE USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "SubjectOffering" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubjectOffering" FORCE ROW LEVEL SECURITY;
CREATE POLICY subject_offering_read ON "SubjectOffering" FOR SELECT USING ("tenantId" = app_tenant_id());
CREATE POLICY subject_offering_insert ON "SubjectOffering" FOR INSERT WITH CHECK ("tenantId" = app_tenant_id());
CREATE POLICY subject_offering_delete ON "SubjectOffering" FOR DELETE USING ("tenantId" = app_tenant_id());

SELECT app_grant_runtime_privileges();
