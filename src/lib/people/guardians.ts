import type { GuardianLinkStatus, Prisma, Relationship } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { cleanEmail, cleanOptional, cleanPersonName, cleanPhone, RELATIONSHIPS } from "@/lib/people/rules";
import { auditPeople, invalid, refuse, refuseAndRollBack, rollingBack, type PeopleResult } from "@/lib/people/results";
import { studentsVisibleTo } from "@/lib/people/students";

// Guardians — the people the school can phone — and their links to students (plan "Build design — Phase 1.2", reconciliation 4 and decision P6).
//
// In 1.2 ONLY an administrator creates a link, and it is APPROVED at once; no path lets a guardian create or approve their own (Phase 1.4 adds a
// linking-code claim that creates PENDING ones). Every read a guardian will ever make about a child goes through `status = APPROVED` and the guardian's
// ACCOUNT — nothing here exposes a student by number. Removing a link REVOKES it (history stays); a guardian is archived, never deleted.

type TenantCtx = TenantAuthContext["tenant"];

export type GuardianView = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  archived: boolean;
  /// How many students are linked to them now (revoked links do not count).
  studentCount: number;
};
export type GuardianLinkView = {
  id: string;
  guardian: GuardianView;
  relationship: Relationship;
  isPrimary: boolean;
  status: GuardianLinkStatus;
  createdAt: string;
};
/// The other side of a link: a student a guardian is linked to (only the identifying basics).
export type LinkedStudentView = {
  linkId: string;
  studentId: string;
  firstName: string;
  lastName: string;
  admissionNo: string;
  relationship: Relationship;
  isPrimary: boolean;
};

const LIVE: Prisma.GuardianLinkWhereInput = { status: { not: "REVOKED" } };

const GUARDIAN_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  archivedAt: true,
  _count: { select: { links: { where: LIVE } } },
} satisfies Prisma.GuardianRecordSelect;
type GuardianRow = Prisma.GuardianRecordGetPayload<{ select: typeof GUARDIAN_SELECT }>;
const toGuardian = (row: GuardianRow): GuardianView => ({
  id: row.id,
  firstName: row.firstName,
  lastName: row.lastName,
  phone: row.phone,
  email: row.email,
  archived: row.archivedAt !== null,
  studentCount: row._count.links,
});

const LINK_INCLUDE = { guardian: { select: GUARDIAN_SELECT } } satisfies Prisma.GuardianLinkInclude;
type LinkRow = Prisma.GuardianLinkGetPayload<{ include: typeof LINK_INCLUDE }>;
const toLink = (row: LinkRow): GuardianLinkView => ({
  id: row.id,
  guardian: toGuardian(row.guardian),
  relationship: row.relationship,
  isPrimary: row.isPrimary,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});

/// Which guardians this member may see: an ADMIN all; anyone else those linked (live) to a student they may see (campus scope of the STUDENT decides).
const guardiansVisibleTo = (tenant: TenantCtx): Prisma.GuardianRecordWhereInput =>
  tenant.role === "ADMIN" ? {} : { links: { some: { ...LIVE, student: studentsVisibleTo(tenant) } } };

const findVisibleStudent = (tx: Tx, tenant: TenantCtx, id: string) =>
  tx.studentRecord.findFirst({
    where: { id, tenantId: tenant.tenantId, ...studentsVisibleTo(tenant) },
    select: { id: true, archivedAt: true },
  });

const findGuardian = (tx: Tx, tenant: TenantCtx, id: string) =>
  tx.guardianRecord.findFirst({ where: { id, tenantId: tenant.tenantId, ...guardiansVisibleTo(tenant) }, select: GUARDIAN_SELECT });

/// Serialises a student's guardian changes: the primary-contact swap is a demote-then-promote and must not interleave with another.
async function lockLinks(tx: Tx, tenantId: string, studentId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`guardian-links:${tenantId}:${studentId}`}::text))`;
}

// --- reading ------------------------------------------------------------------------------------------------------------------

export async function listLinks(tenant: TenantCtx, studentId: string): Promise<PeopleResult<{ links: GuardianLinkView[] }>> {
  return tenant.run(async (tx) => {
    if (!(await findVisibleStudent(tx, tenant, studentId))) return refuse("NOT_FOUND");
    const rows = await tx.guardianLink.findMany({
      where: { tenantId: tenant.tenantId, studentId, ...LIVE },
      include: LINK_INCLUDE,
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return { ok: true, links: rows.map(toLink) };
  });
}

export type GuardianFilters = { status: "live" | "archived" | "all"; q?: string };

export async function listGuardians(
  tenant: TenantCtx,
  filters: GuardianFilters,
  page: { skip: number; take: number },
): Promise<{ guardians: GuardianView[]; total: number }> {
  const and: Prisma.GuardianRecordWhereInput[] = [guardiansVisibleTo(tenant)];
  for (const token of (filters.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 5)) {
    and.push({
      OR: [
        { firstName: { contains: token, mode: "insensitive" } },
        { lastName: { contains: token, mode: "insensitive" } },
        { phone: { contains: token } },
        { email: { contains: token, mode: "insensitive" } },
      ],
    });
  }
  const where: Prisma.GuardianRecordWhereInput = {
    tenantId: tenant.tenantId,
    AND: and,
    ...(filters.status === "live" ? { archivedAt: null } : {}),
    ...(filters.status === "archived" ? { archivedAt: { not: null } } : {}),
  };
  return tenant.run(async (tx) => {
    const [total, rows] = await Promise.all([
      tx.guardianRecord.count({ where }),
      tx.guardianRecord.findMany({
        where,
        select: GUARDIAN_SELECT,
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
        skip: page.skip,
        take: page.take,
      }),
    ]);
    return { guardians: rows.map(toGuardian), total };
  });
}

export async function getGuardian(
  tenant: TenantCtx,
  id: string,
): Promise<PeopleResult<{ guardian: GuardianView; students: LinkedStudentView[] }>> {
  return tenant.run(async (tx) => {
    const row = await findGuardian(tx, tenant, id);
    if (!row) return refuse("NOT_FOUND");
    const links = await tx.guardianLink.findMany({
      where: { tenantId: tenant.tenantId, guardianId: id, ...LIVE, student: studentsVisibleTo(tenant) },
      include: { student: { select: { id: true, firstName: true, lastName: true, admissionNo: true } } },
      orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }, { id: "asc" }],
    });
    return {
      ok: true,
      guardian: toGuardian(row),
      students: links.map((link) => ({
        linkId: link.id,
        studentId: link.student.id,
        firstName: link.student.firstName,
        lastName: link.student.lastName,
        admissionNo: link.student.admissionNo,
        relationship: link.relationship,
        isPrimary: link.isPrimary,
      })),
    };
  });
}

// --- writing ------------------------------------------------------------------------------------------------------------------

type ContactInput = { firstName?: unknown; lastName?: unknown; phone?: unknown; email?: unknown };
type CleanContact = { firstName: string; lastName: string; phone: string | null; email: string | null };

function cleanContact(input: ContactInput): { ok: true; value: CleanContact } | ReturnType<typeof invalid> {
  const firstName = cleanPersonName(input.firstName);
  if (!firstName) return invalid("firstName");
  const lastName = cleanPersonName(input.lastName);
  if (!lastName) return invalid("lastName");
  const phone = cleanOptional(input.phone, cleanPhone);
  if (phone === undefined) return invalid("phone");
  const email = cleanOptional(input.email, cleanEmail);
  if (email === undefined) return invalid("email");
  return { ok: true, value: { firstName, lastName, phone, email } };
}

const isRelationship = (value: unknown): value is Relationship =>
  typeof value === "string" && (RELATIONSHIPS as readonly string[]).includes(value);

export type AddGuardianInput = ContactInput & { guardianId?: string; relationship: unknown; isPrimary?: boolean };

/// Links a guardian to a student: an EXISTING guardian of the school (`guardianId`, e.g. a sibling's parent) or a NEW one (name and contact). The first live
/// guardian of a student becomes the primary contact; asking for `isPrimary` demotes the current one in the same transaction.
export async function addGuardian(
  tenant: TenantCtx,
  actorUserId: string,
  studentId: string,
  input: AddGuardianInput,
): Promise<PeopleResult<{ link: GuardianLinkView; createdGuardian: boolean; reactivated: boolean }>> {
  if (!isRelationship(input.relationship)) return invalid("relationship");
  const relationship = input.relationship;
  const existingId = input.guardianId;
  const hasContact = [input.firstName, input.lastName, input.phone, input.email].some((value) => value !== undefined);
  if ((existingId === undefined) === !hasContact) return invalid("guardianId"); // exactly one of: an existing guardian, or the details of a new one
  let contact: CleanContact | null = null;
  if (existingId === undefined) {
    const cleaned = cleanContact(input);
    if (!cleaned.ok) return cleaned;
    contact = cleaned.value;
  }
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const student = await findVisibleStudent(tx, tenant, studentId);
      if (!student) return refuse("NOT_FOUND");
      if (student.archivedAt) return refuse("ARCHIVED");
      await lockLinks(tx, tenantId, studentId);

      let guardianId: string;
      let createdGuardian = false;
      if (existingId !== undefined) {
        const guardian = await tx.guardianRecord.findFirst({ where: { id: existingId, tenantId, archivedAt: null }, select: { id: true } });
        if (!guardian) return refuse("INVALID_GUARDIAN");
        guardianId = guardian.id;
      } else {
        const made = await tx.guardianRecord.create({ data: { tenantId, ...contact! }, select: { id: true } });
        guardianId = made.id;
        createdGuardian = true;
        await auditPeople(tx, tenantId, actorUserId, "GuardianRecord", "GUARDIAN_CREATED", made.id, undefined, { studentId });
      }

      const existingLink = await tx.guardianLink.findFirst({
        where: { tenantId, studentId, guardianId },
        select: { id: true, status: true },
      });
      if (existingLink && existingLink.status !== "REVOKED") return refuse("ALREADY_LINKED");

      const liveCount = await tx.guardianLink.count({ where: { tenantId, studentId, ...LIVE } });
      const primary = input.isPrimary === true || liveCount === 0;
      if (primary) {
        await tx.guardianLink.updateMany({ where: { tenantId, studentId, isPrimary: true, ...LIVE }, data: { isPrimary: false } });
      }
      let linkId: string;
      let reactivated = false;
      if (existingLink) {
        // A removed link coming back: the row (one per student and guardian) is reactivated, not duplicated.
        const done = await tx.guardianLink.updateMany({
          where: { id: existingLink.id, tenantId, status: "REVOKED" },
          data: { status: "APPROVED", revokedAt: null, relationship, isPrimary: primary, approvedById: actorUserId },
        });
        if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
        linkId = existingLink.id;
        reactivated = true;
      } else {
        const created = await tx.guardianLink.create({
          data: { tenantId, studentId, guardianId, relationship, isPrimary: primary, status: "APPROVED", approvedById: actorUserId },
          select: { id: true },
        });
        linkId = created.id;
      }
      await auditPeople(
        tx,
        tenantId,
        actorUserId,
        "GuardianLink",
        reactivated ? "GUARDIAN_LINK_RESTORED" : "GUARDIAN_LINKED",
        linkId,
        undefined,
        {
          studentId,
          guardianId,
          relationship,
          isPrimary: primary,
        },
      );
      const row = await tx.guardianLink.findUniqueOrThrow({ where: { id: linkId }, include: LINK_INCLUDE });
      return { ok: true as const, link: toLink(row), createdGuardian, reactivated };
    }),
  );
}

/// Changes a link's relationship and/or makes it the primary contact (demoting the current one in the same transaction). Making it NOT primary is allowed:
/// a student may have no primary contact, and the screen then says so.
export async function updateLink(
  tenant: TenantCtx,
  actorUserId: string,
  studentId: string,
  linkId: string,
  input: { relationship?: unknown; isPrimary?: unknown },
): Promise<PeopleResult<{ link: GuardianLinkView; changed: boolean }>> {
  if (input.relationship !== undefined && !isRelationship(input.relationship)) return invalid("relationship");
  if (input.isPrimary !== undefined && typeof input.isPrimary !== "boolean") return invalid("isPrimary");
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      if (!(await findVisibleStudent(tx, tenant, studentId))) return refuse("NOT_FOUND");
      await lockLinks(tx, tenantId, studentId);
      const current = await tx.guardianLink.findFirst({ where: { id: linkId, tenantId, studentId, ...LIVE }, include: LINK_INCLUDE });
      if (!current) return refuse("NOT_FOUND");
      const relationship = (input.relationship as Relationship | undefined) ?? current.relationship;
      const isPrimary = (input.isPrimary as boolean | undefined) ?? current.isPrimary;
      if (relationship === current.relationship && isPrimary === current.isPrimary)
        return { ok: true as const, link: toLink(current), changed: false };
      if (isPrimary && !current.isPrimary) {
        await tx.guardianLink.updateMany({
          where: { tenantId, studentId, isPrimary: true, ...LIVE, id: { not: linkId } },
          data: { isPrimary: false },
        });
      }
      const done = await tx.guardianLink.updateMany({ where: { id: linkId, tenantId, ...LIVE }, data: { relationship, isPrimary } });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditPeople(
        tx,
        tenantId,
        actorUserId,
        "GuardianLink",
        "GUARDIAN_LINK_UPDATED",
        linkId,
        { relationship: current.relationship, isPrimary: current.isPrimary },
        { relationship, isPrimary, studentId },
      );
      return {
        ok: true as const,
        link: toLink(await tx.guardianLink.findUniqueOrThrow({ where: { id: linkId }, include: LINK_INCLUDE })),
        changed: true,
      };
    }),
  );
}

/// Removes a guardian from a student: the link is REVOKED (kept for history) and is no longer primary. Idempotent: an already-removed link answers `changed: false`.
export async function removeLink(
  tenant: TenantCtx,
  actorUserId: string,
  studentId: string,
  linkId: string,
): Promise<PeopleResult<{ changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      if (!(await findVisibleStudent(tx, tenant, studentId))) return refuse("NOT_FOUND");
      await lockLinks(tx, tenantId, studentId);
      const current = await tx.guardianLink.findFirst({
        where: { id: linkId, tenantId, studentId },
        select: { id: true, status: true, guardianId: true, isPrimary: true },
      });
      if (!current) return refuse("NOT_FOUND");
      if (current.status === "REVOKED") return { ok: true as const, changed: false };
      const done = await tx.guardianLink.updateMany({
        where: { id: linkId, tenantId, ...LIVE },
        data: { status: "REVOKED", revokedAt: new Date(), isPrimary: false },
      });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditPeople(
        tx,
        tenantId,
        actorUserId,
        "GuardianLink",
        "GUARDIAN_LINK_REMOVED",
        linkId,
        { wasPrimary: current.isPrimary },
        { studentId, guardianId: current.guardianId },
      );
      return { ok: true as const, changed: true };
    }),
  );
}

/// Edits a guardian's name and contact details (partial). Audited by field NAME only — never the phone or email value.
export async function updateGuardian(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  input: ContactInput,
): Promise<PeopleResult<{ guardian: GuardianView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const current = await tx.guardianRecord.findFirst({ where: { id, tenantId, ...guardiansVisibleTo(tenant) } });
      if (!current) return refuse("NOT_FOUND");
      if (current.archivedAt) return refuse("ARCHIVED");
      const merged = cleanContact({
        firstName: input.firstName ?? current.firstName,
        lastName: input.lastName ?? current.lastName,
        phone: input.phone === undefined ? current.phone : input.phone,
        email: input.email === undefined ? current.email : input.email,
      });
      if (!merged.ok) return merged;
      const next = merged.value;
      const changedFields = (["firstName", "lastName", "phone", "email"] as const).filter((field) => next[field] !== current[field]);
      const view = async () => toGuardian(await tx.guardianRecord.findUniqueOrThrow({ where: { id }, select: GUARDIAN_SELECT }));
      if (changedFields.length === 0) return { ok: true as const, guardian: await view(), changed: false };
      await tx.guardianRecord.update({ where: { id }, data: next });
      await auditPeople(tx, tenantId, actorUserId, "GuardianRecord", "GUARDIAN_UPDATED", id, undefined, { changed: changedFields });
      return { ok: true as const, guardian: await view(), changed: true };
    }),
  );
}

/// Archives a guardian — refused while any student is still linked to them (remove the links first; nothing is archived silently).
export async function archiveGuardian(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
): Promise<PeopleResult<{ guardian: GuardianView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const current = await tx.guardianRecord.findFirst({
        where: { id, tenantId, ...guardiansVisibleTo(tenant) },
        select: { id: true, archivedAt: true },
      });
      if (!current) return refuse("NOT_FOUND");
      const view = async () => toGuardian(await tx.guardianRecord.findUniqueOrThrow({ where: { id }, select: GUARDIAN_SELECT }));
      if (current.archivedAt) return { ok: true as const, guardian: await view(), changed: false };
      if (await tx.guardianLink.findFirst({ where: { tenantId, guardianId: id, ...LIVE }, select: { id: true } }))
        return refuse("HAS_LIVE_LINKS");
      const done = await tx.guardianRecord.updateMany({ where: { id, tenantId, archivedAt: null }, data: { archivedAt: new Date() } });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditPeople(tx, tenantId, actorUserId, "GuardianRecord", "GUARDIAN_ARCHIVED", id);
      return { ok: true as const, guardian: await view(), changed: true };
    }),
  );
}

export async function restoreGuardian(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
): Promise<PeopleResult<{ guardian: GuardianView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const current = await tx.guardianRecord.findFirst({
        where: { id, tenantId, ...guardiansVisibleTo(tenant) },
        select: { id: true, archivedAt: true },
      });
      if (!current) return refuse("NOT_FOUND");
      const view = async () => toGuardian(await tx.guardianRecord.findUniqueOrThrow({ where: { id }, select: GUARDIAN_SELECT }));
      if (!current.archivedAt) return { ok: true as const, guardian: await view(), changed: false };
      const done = await tx.guardianRecord.updateMany({ where: { id, tenantId, archivedAt: { not: null } }, data: { archivedAt: null } });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditPeople(tx, tenantId, actorUserId, "GuardianRecord", "GUARDIAN_RESTORED", id);
      return { ok: true as const, guardian: await view(), changed: true };
    }),
  );
}
