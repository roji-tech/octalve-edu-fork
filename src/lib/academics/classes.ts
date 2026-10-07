import type { ClassArm, ClassGroup, Prisma, Subject } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { cleanName } from "@/lib/academics/rules";
import { auditAcademic, refuse, type AcademicResult } from "@/lib/academics/sessions";

// Class groups, their arms, subjects, and which class group studies which subject (plan "Build design — Phase 1.0 and 1.1", decision 13).
//
// Same discipline as sessions.ts: ONE transaction through `tenant.run`, the tenant named in every query, an audit row in the same transaction,
// nothing deleted (groups, arms and subjects are ARCHIVED; only an offering is really removed, because nothing references one yet), and every
// uniqueness rule enforced twice — here under a lock, and by a partial unique index.

type TenantCtx = TenantAuthContext["tenant"];

export const GROUP_NAME_MAX = 60;
export const ARM_NAME_MAX = 30;
export const SUBJECT_NAME_MAX = 80;
export const MAX_ARMS_PER_GROUP = 26;
export const MAX_CAPACITY = 1000;

export type ArmView = { id: string; classGroupId: string; name: string; capacity: number | null; archived: boolean };
export type ClassGroupView = {
  id: string;
  campusId: string | null;
  campusName: string | null;
  name: string;
  sortOrder: number;
  archived: boolean;
  arms: ArmView[];
  subjectCount: number;
};
export type SubjectView = { id: string; name: string; code: string | null; archived: boolean };

const toArm = (row: ClassArm): ArmView => ({
  id: row.id,
  classGroupId: row.classGroupId,
  name: row.name,
  capacity: row.capacity,
  archived: row.archivedAt !== null,
});
const toSubject = (row: Subject): SubjectView => ({ id: row.id, name: row.name, code: row.code, archived: row.archivedAt !== null });

const GROUP_INCLUDE = {
  campus: { select: { name: true } },
  arms: { where: { archivedAt: null }, orderBy: [{ name: "asc" }, { id: "asc" }] },
  _count: { select: { offerings: true } },
} satisfies Prisma.ClassGroupInclude;
type GroupRow = Prisma.ClassGroupGetPayload<{ include: typeof GROUP_INCLUDE }>;
const toGroup = (row: GroupRow): ClassGroupView => ({
  id: row.id,
  campusId: row.campusId,
  campusName: row.campus?.name ?? null,
  name: row.name,
  sortOrder: row.sortOrder,
  archived: row.archivedAt !== null,
  arms: row.arms.map(toArm),
  subjectCount: row._count.offerings,
});

/// Which class groups this member may see (decision 7): an ADMIN every campus's; anyone else the school-wide ones and their own campus's.
export function groupsVisibleTo(tenant: TenantCtx): Prisma.ClassGroupWhereInput {
  if (tenant.role === "ADMIN") return {};
  return { OR: [{ campusId: null }, ...(tenant.campusId ? [{ campusId: tenant.campusId }] : [])] };
}

const findGroup = (tx: Tx, tenant: TenantCtx, id: string) =>
  tx.classGroup.findFirst({ where: { id, tenantId: tenant.tenantId, ...groupsVisibleTo(tenant) }, include: GROUP_INCLUDE });

async function lockGroupScope(tx: Tx, tenantId: string, campusId: string | null) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`class-group:${tenantId}:${campusId ?? ""}`}::text))`;
}
async function lockGroup(tx: Tx, tenantId: string, groupId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`class-arm:${tenantId}:${groupId}`}::text))`;
}
async function lockSubjects(tx: Tx, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subject:${tenantId}`}::text))`;
}

const validSortOrder = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999;
const validCapacity = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CAPACITY;

/// A subject code: trimmed, upper-cased, 1–12 letters or digits; blank means "no code".
export function cleanCode(value: unknown): string | null | "INVALID" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "INVALID";
  const code = value.trim().toUpperCase();
  if (code === "") return null;
  return /^[A-Z0-9]{1,12}$/.test(code) ? code : "INVALID";
}

// --- class groups -------------------------------------------------------------------------------------------------------------

export type GroupStatusFilter = "live" | "archived" | "all";

export async function listClassGroups(
  tenant: TenantCtx,
  filters: { status: GroupStatusFilter; campusId?: string },
  page: { skip: number; take: number },
): Promise<{ groups: ClassGroupView[]; total: number }> {
  const where: Prisma.ClassGroupWhereInput = {
    tenantId: tenant.tenantId,
    AND: [groupsVisibleTo(tenant)],
    ...(filters.campusId ? { campusId: filters.campusId } : {}),
    ...(filters.status === "live" ? { archivedAt: null } : {}),
    ...(filters.status === "archived" ? { archivedAt: { not: null } } : {}),
  };
  return tenant.run(async (tx) => {
    const [total, rows] = await Promise.all([
      tx.classGroup.count({ where }),
      tx.classGroup.findMany({
        where,
        include: GROUP_INCLUDE,
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }], // the progression order, then a stable tiebreak
        skip: page.skip,
        take: page.take,
      }),
    ]);
    return { groups: rows.map(toGroup), total };
  });
}

export async function getClassGroup(tenant: TenantCtx, id: string): Promise<AcademicResult<{ group: ClassGroupView }>> {
  return tenant.run(async (tx) => {
    const row = await findGroup(tx, tenant, id);
    return row ? { ok: true, group: toGroup(row) } : refuse("NOT_FOUND");
  });
}

export async function createClassGroup(
  tenant: TenantCtx,
  actorUserId: string,
  input: { campusId?: string | null; name: unknown; sortOrder?: unknown },
): Promise<AcademicResult<{ group: ClassGroupView }>> {
  const name = cleanName(input.name, GROUP_NAME_MAX);
  if (!name) return refuse("INVALID_NAME");
  const sortOrder = input.sortOrder === undefined ? 0 : input.sortOrder;
  if (!validSortOrder(sortOrder)) return refuse("INVALID_SORT_ORDER");
  const campusId = input.campusId ?? null;
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    if (campusId) {
      const campus = await tx.campus.findFirst({ where: { id: campusId, tenantId }, select: { id: true } });
      if (!campus) return refuse("INVALID_CAMPUS");
    }
    await lockGroupScope(tx, tenantId, campusId);
    if (await tx.classGroup.findFirst({ where: { tenantId, campusId, name, archivedAt: null }, select: { id: true } }))
      return refuse("NAME_TAKEN");
    const created = await tx.classGroup.create({ data: { tenantId, campusId, name, sortOrder }, include: GROUP_INCLUDE });
    await auditAcademic(tx, tenantId, actorUserId, "ClassGroup", "CLASS_GROUP_CREATED", created.id, undefined, {
      name,
      campusId,
      sortOrder,
    });
    return { ok: true, group: toGroup(created) };
  });
}

export async function updateClassGroup(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  input: { name?: unknown; sortOrder?: unknown },
): Promise<AcademicResult<{ group: ClassGroupView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await findGroup(tx, tenant, id);
    if (!current) return refuse("NOT_FOUND");
    if (current.archivedAt) return refuse("ARCHIVED");
    const name = input.name === undefined ? current.name : cleanName(input.name, GROUP_NAME_MAX);
    if (!name) return refuse("INVALID_NAME");
    const sortOrder = input.sortOrder === undefined ? current.sortOrder : input.sortOrder;
    if (!validSortOrder(sortOrder)) return refuse("INVALID_SORT_ORDER");
    if (name === current.name && sortOrder === current.sortOrder) return { ok: true, group: toGroup(current), changed: false };
    await lockGroupScope(tx, tenantId, current.campusId);
    if (
      name !== current.name &&
      (await tx.classGroup.findFirst({
        where: { tenantId, campusId: current.campusId, name, archivedAt: null, id: { not: id } },
        select: { id: true },
      }))
    ) {
      return refuse("NAME_TAKEN");
    }
    await tx.classGroup.update({ where: { id }, data: { name, sortOrder } });
    await auditAcademic(
      tx,
      tenantId,
      actorUserId,
      "ClassGroup",
      "CLASS_GROUP_UPDATED",
      id,
      { name: current.name, sortOrder: current.sortOrder },
      { name, sortOrder },
    );
    return { ok: true, group: toGroup(await tx.classGroup.findUniqueOrThrow({ where: { id }, include: GROUP_INCLUDE })), changed: true };
  });
}

/// Archives a class group — refused while it still has live arms (nothing is archived silently; the administrator archives the arms first).
export async function archiveClassGroup(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
): Promise<AcademicResult<{ group: ClassGroupView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await findGroup(tx, tenant, id);
    if (!current) return refuse("NOT_FOUND");
    if (current.archivedAt) return { ok: true, group: toGroup(current), changed: false };
    await lockGroup(tx, tenantId, id);
    if (await tx.classArm.findFirst({ where: { tenantId, classGroupId: id, archivedAt: null }, select: { id: true } }))
      return refuse("HAS_ACTIVE_ARMS");
    const done = await tx.classGroup.updateMany({ where: { id, tenantId, archivedAt: null }, data: { archivedAt: new Date() } });
    if (done.count !== 1) return refuse("WRONG_STATE");
    await auditAcademic(tx, tenantId, actorUserId, "ClassGroup", "CLASS_GROUP_ARCHIVED", id, { archived: false }, { archived: true });
    return { ok: true, group: toGroup(await tx.classGroup.findUniqueOrThrow({ where: { id }, include: GROUP_INCLUDE })), changed: true };
  });
}

// --- arms ---------------------------------------------------------------------------------------------------------------------

export async function createArm(
  tenant: TenantCtx,
  actorUserId: string,
  groupId: string,
  input: { name: unknown; capacity?: unknown },
): Promise<AcademicResult<{ arm: ArmView }>> {
  const name = cleanName(input.name, ARM_NAME_MAX);
  if (!name) return refuse("INVALID_NAME");
  const capacity = input.capacity === undefined || input.capacity === null ? null : input.capacity;
  if (capacity !== null && !validCapacity(capacity)) return refuse("INVALID_CAPACITY");
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const group = await findGroup(tx, tenant, groupId);
    if (!group) return refuse("NOT_FOUND");
    if (group.archivedAt) return refuse("ARCHIVED"); // no arms in an archived group
    await lockGroup(tx, tenantId, groupId);
    const live = await tx.classArm.findMany({ where: { tenantId, classGroupId: groupId, archivedAt: null }, select: { name: true } });
    if (live.length >= MAX_ARMS_PER_GROUP) return refuse("TOO_MANY_ARMS");
    if (live.some((arm) => arm.name === name)) return refuse("NAME_TAKEN");
    const created = await tx.classArm.create({ data: { tenantId, classGroupId: groupId, name, capacity } });
    await auditAcademic(tx, tenantId, actorUserId, "ClassArm", "CLASS_ARM_CREATED", created.id, undefined, {
      classGroupId: groupId,
      name,
      capacity,
    });
    return { ok: true, arm: toArm(created) };
  });
}

export async function updateArm(
  tenant: TenantCtx,
  actorUserId: string,
  armId: string,
  input: { name?: unknown; capacity?: unknown },
): Promise<AcademicResult<{ arm: ArmView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await tx.classArm.findFirst({ where: { id: armId, tenantId } });
    if (!current) return refuse("NOT_FOUND");
    const group = await findGroup(tx, tenant, current.classGroupId);
    if (!group) return refuse("NOT_FOUND");
    if (current.archivedAt || group.archivedAt) return refuse("ARCHIVED");
    const name = input.name === undefined ? current.name : cleanName(input.name, ARM_NAME_MAX);
    if (!name) return refuse("INVALID_NAME");
    const capacity = input.capacity === undefined ? current.capacity : input.capacity;
    if (capacity !== null && !validCapacity(capacity)) return refuse("INVALID_CAPACITY");
    if (name === current.name && capacity === current.capacity) return { ok: true, arm: toArm(current), changed: false };
    await lockGroup(tx, tenantId, current.classGroupId);
    if (
      name !== current.name &&
      (await tx.classArm.findFirst({
        where: { tenantId, classGroupId: current.classGroupId, name, archivedAt: null, id: { not: armId } },
        select: { id: true },
      }))
    ) {
      return refuse("NAME_TAKEN");
    }
    const updated = await tx.classArm.update({ where: { id: armId }, data: { name, capacity } });
    await auditAcademic(
      tx,
      tenantId,
      actorUserId,
      "ClassArm",
      "CLASS_ARM_UPDATED",
      armId,
      { name: current.name, capacity: current.capacity },
      { name, capacity },
    );
    return { ok: true, arm: toArm(updated), changed: true };
  });
}

export async function archiveArm(
  tenant: TenantCtx,
  actorUserId: string,
  armId: string,
): Promise<AcademicResult<{ arm: ArmView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await tx.classArm.findFirst({ where: { id: armId, tenantId } });
    if (!current) return refuse("NOT_FOUND");
    if (!(await findGroup(tx, tenant, current.classGroupId))) return refuse("NOT_FOUND");
    if (current.archivedAt) return { ok: true, arm: toArm(current), changed: false };
    await lockGroup(tx, tenantId, current.classGroupId);
    const done = await tx.classArm.updateMany({ where: { id: armId, tenantId, archivedAt: null }, data: { archivedAt: new Date() } });
    if (done.count !== 1) return refuse("WRONG_STATE");
    await auditAcademic(tx, tenantId, actorUserId, "ClassArm", "CLASS_ARM_ARCHIVED", armId, { archived: false }, { archived: true });
    return { ok: true, arm: toArm(await tx.classArm.findUniqueOrThrow({ where: { id: armId } })), changed: true };
  });
}

// --- subjects -----------------------------------------------------------------------------------------------------------------

/// Escapes `%`, `_` and `\` so a search term is text, never a pattern (the same rule as the member search).
const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

export async function listSubjects(
  tenant: TenantCtx,
  filters: { status: GroupStatusFilter; q?: string },
  page: { skip: number; take: number },
): Promise<{ subjects: SubjectView[]; total: number }> {
  const where: Prisma.SubjectWhereInput = {
    tenantId: tenant.tenantId,
    ...(filters.status === "live" ? { archivedAt: null } : {}),
    ...(filters.status === "archived" ? { archivedAt: { not: null } } : {}),
    ...(filters.q
      ? {
          OR: [
            { name: { contains: escapeLike(filters.q), mode: "insensitive" as const } },
            { code: { contains: escapeLike(filters.q.toUpperCase()) } },
          ],
        }
      : {}),
  };
  return tenant.run(async (tx) => {
    const [total, rows] = await Promise.all([
      tx.subject.count({ where }),
      tx.subject.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], skip: page.skip, take: page.take }),
    ]);
    return { subjects: rows.map(toSubject), total };
  });
}

export async function createSubject(
  tenant: TenantCtx,
  actorUserId: string,
  input: { name: unknown; code?: unknown },
): Promise<AcademicResult<{ subject: SubjectView }>> {
  const name = cleanName(input.name, SUBJECT_NAME_MAX);
  if (!name) return refuse("INVALID_NAME");
  const code = cleanCode(input.code);
  if (code === "INVALID") return refuse("INVALID_CODE");
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    await lockSubjects(tx, tenantId);
    if (await tx.subject.findFirst({ where: { tenantId, name, archivedAt: null }, select: { id: true } })) return refuse("NAME_TAKEN");
    if (code && (await tx.subject.findFirst({ where: { tenantId, code, archivedAt: null }, select: { id: true } })))
      return refuse("CODE_TAKEN");
    const created = await tx.subject.create({ data: { tenantId, name, code } });
    await auditAcademic(tx, tenantId, actorUserId, "Subject", "SUBJECT_CREATED", created.id, undefined, { name, code });
    return { ok: true, subject: toSubject(created) };
  });
}

export async function updateSubject(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  input: { name?: unknown; code?: unknown },
): Promise<AcademicResult<{ subject: SubjectView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await tx.subject.findFirst({ where: { id, tenantId } });
    if (!current) return refuse("NOT_FOUND");
    if (current.archivedAt) return refuse("ARCHIVED");
    const name = input.name === undefined ? current.name : cleanName(input.name, SUBJECT_NAME_MAX);
    if (!name) return refuse("INVALID_NAME");
    const code = input.code === undefined ? current.code : cleanCode(input.code);
    if (code === "INVALID") return refuse("INVALID_CODE");
    if (name === current.name && code === current.code) return { ok: true, subject: toSubject(current), changed: false };
    await lockSubjects(tx, tenantId);
    if (
      name !== current.name &&
      (await tx.subject.findFirst({ where: { tenantId, name, archivedAt: null, id: { not: id } }, select: { id: true } }))
    )
      return refuse("NAME_TAKEN");
    if (
      code &&
      code !== current.code &&
      (await tx.subject.findFirst({ where: { tenantId, code, archivedAt: null, id: { not: id } }, select: { id: true } }))
    )
      return refuse("CODE_TAKEN");
    const updated = await tx.subject.update({ where: { id }, data: { name, code } });
    await auditAcademic(
      tx,
      tenantId,
      actorUserId,
      "Subject",
      "SUBJECT_UPDATED",
      id,
      { name: current.name, code: current.code },
      { name, code },
    );
    return { ok: true, subject: toSubject(updated), changed: true };
  });
}

/// Archives a subject — refused while a live class group still studies it.
export async function archiveSubject(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
): Promise<AcademicResult<{ subject: SubjectView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await tx.subject.findFirst({ where: { id, tenantId } });
    if (!current) return refuse("NOT_FOUND");
    if (current.archivedAt) return { ok: true, subject: toSubject(current), changed: false };
    await lockSubjects(tx, tenantId);
    if (await tx.subjectOffering.findFirst({ where: { tenantId, subjectId: id, classGroup: { archivedAt: null } }, select: { id: true } }))
      return refuse("SUBJECT_IN_USE");
    const done = await tx.subject.updateMany({ where: { id, tenantId, archivedAt: null }, data: { archivedAt: new Date() } });
    if (done.count !== 1) return refuse("WRONG_STATE");
    await auditAcademic(tx, tenantId, actorUserId, "Subject", "SUBJECT_ARCHIVED", id, { archived: false }, { archived: true });
    return { ok: true, subject: toSubject(await tx.subject.findUniqueOrThrow({ where: { id } })), changed: true };
  });
}

// --- what each class group studies --------------------------------------------------------------------------------------------

export async function listOfferings(tenant: TenantCtx, groupId: string): Promise<AcademicResult<{ subjects: SubjectView[] }>> {
  return tenant.run(async (tx) => {
    if (!(await findGroup(tx, tenant, groupId))) return refuse("NOT_FOUND");
    const rows = await tx.subjectOffering.findMany({
      where: { tenantId: tenant.tenantId, classGroupId: groupId, subject: { archivedAt: null } },
      include: { subject: true },
      orderBy: [{ subject: { name: "asc" } }, { id: "asc" }],
    });
    return { ok: true, subjects: rows.map((row) => toSubject(row.subject)) };
  });
}

/// Sets the FULL list of subjects a class group studies (idempotent): adds the missing, removes the rest, audits the before/after — and writes
/// nothing when the list is already that. Every id must be a live subject of THIS school.
export async function setOfferings(
  tenant: TenantCtx,
  actorUserId: string,
  groupId: string,
  subjectIds: readonly string[],
): Promise<AcademicResult<{ subjects: SubjectView[]; changed: boolean }>> {
  const wanted = [...new Set(subjectIds)];
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const group = await findGroup(tx, tenant, groupId);
    if (!group) return refuse("NOT_FOUND");
    if (group.archivedAt) return refuse("ARCHIVED");
    await lockSubjects(tx, tenantId);
    const found = await tx.subject.findMany({ where: { tenantId, id: { in: wanted }, archivedAt: null }, select: { id: true } });
    if (found.length !== wanted.length) return refuse("UNKNOWN_SUBJECT");
    const current = await tx.subjectOffering.findMany({ where: { tenantId, classGroupId: groupId }, select: { subjectId: true } });
    const have = new Set(current.map((row) => row.subjectId));
    const add = wanted.filter((id) => !have.has(id));
    const remove = [...have].filter((id) => !wanted.includes(id));
    if (add.length === 0 && remove.length === 0) {
      const same = await listOfferings(tenant, groupId);
      return same.ok ? { ok: true, subjects: same.subjects, changed: false } : same;
    }
    if (remove.length > 0) await tx.subjectOffering.deleteMany({ where: { tenantId, classGroupId: groupId, subjectId: { in: remove } } });
    if (add.length > 0)
      await tx.subjectOffering.createMany({ data: add.map((subjectId) => ({ tenantId, classGroupId: groupId, subjectId })) });
    await auditAcademic(
      tx,
      tenantId,
      actorUserId,
      "ClassGroup",
      "SUBJECT_OFFERING_CHANGED",
      groupId,
      { subjectIds: [...have].sort() },
      { subjectIds: [...wanted].sort() },
    );
    const rows = await tx.subjectOffering.findMany({
      where: { tenantId, classGroupId: groupId },
      include: { subject: true },
      orderBy: [{ subject: { name: "asc" } }, { id: "asc" }],
    });
    return { ok: true, subjects: rows.map((row) => toSubject(row.subject)), changed: true };
  });
}

export type { ClassGroup };
