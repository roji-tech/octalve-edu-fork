-- A school cannot have two campuses of the same name (plan §0.5.3, B: the campus routes rely on it).
-- Additive: one unique index. (Campus holds no production data yet; on a database that already had duplicate names this would
-- fail loudly — rename them first.) The old non-unique tenantId index stays; the new index starts with tenantId too.
CREATE UNIQUE INDEX "Campus_tenantId_name_key" ON "Campus"("tenantId", "name");
