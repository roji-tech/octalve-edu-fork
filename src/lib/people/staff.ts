import type { Prisma, Role, StaffCategory } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { groupsVisibleTo } from "@/lib/academics/classes";
import { cleanEmail, cleanOptional, cleanPersonName, cleanPhone } from "@/lib/people/rules";
import { auditPeople, invalid, refuse, refuseAndRollBack, rollingBack, type PeopleResult } from "@/lib/people/results";

// Staff records and their teaching assignments (plan "Build design — Phase 1.2", reconciliation 2 and decision P5).
//
// A staff RECORD is how the school knows a person (a security guard has one and never an account). A sign-in ACCOUNT is the member of this school it may be
// linked to — once, by an administrator, and only to a member whose role fits the record's category. Same discipline as the other people services: one
// transaction through `tenant.run`, an audit row in it, nothing deleted (records are ARCHIVED; an assignment, which nothing references yet, is really removed).

type TenantCtx = TenantAuthContext["tenant"];

/// The role a record's category signs in as (the invitation role, and the role a linked member must hold).
export const roleForCategory = (category: StaffCategory): Role => (category === "TEACHING" ? "TEACHING_STAFF" : "NON_TEACHING_STAFF");
export const CATEGORIES: readonly StaffCategory[] = ["TEACHING", "NON_TEACHING"];
const isCategory = (value: unknown): value is StaffCategory =>
  typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);

export type StaffAccount =
  | { state: "none" }
  | { state: "invited"; invitationId: string; expiresAt: string }
  | {
      state: "linked";
      userId: string;
      name: string | null;
      email: string | null;
      role: Role;
      /// Deactivated on the Users page: the link remains, the person cannot sign in.
      deactivated: boolean;
      /// The member's role no longer matches the record's category (the Users page changed it) — shown, not forbidden.
      roleDiffers: boolean;
    };

export type StaffView = {
  id: string;
  campusId: string | null;
  campusName: string | null;
  category: StaffCategory;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  archived: boolean;
  account: StaffAccount;
  assignmentCount: number;
};

export type AssignmentView = {
  id: string;
  subjectId: string;
  subjectName: string;
  classArmId: string;
  armName: string;
  classGroupName: string;
};

const STAFF_INCLUDE = (now: Date) =>
  ({
    campus: { select: { name: true } },
    membership: { select: { role: true, deactivatedAt: true, user: { select: { name: true, email: true } } } },
    invitations: { where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, select: { id: true, expiresAt: true }, take: 1 },
    _count: { select: { assignments: true } },
  }) satisfies Prisma.StaffRecordInclude;
type StaffRow = Prisma.StaffRecordGetPayload<{ include: ReturnType<typeof STAFF_INCLUDE> }>;

function toAccount(row: StaffRow): StaffAccount {
  if (row.userId && row.membership) {
    return {
      state: "linked",
      userId: row.userId,
      name: row.membership.user.name,
      email: row.membership.user.email,
      role: row.membership.role,
      deactivated: row.membership.deactivatedAt !== null,
      roleDiffers: row.membership.role !== roleForCategory(row.category),
    };
  }
  const open = row.invitations[0];
  return open ? { state: "invited", invitationId: open.id, expiresAt: open.expiresAt.toISOString() } : { state: "none" };
}

export const toStaff = (row: StaffRow): StaffView => ({
  id: row.id,
  campusId: row.campusId,
  campusName: row.campus?.name ?? null,
  category: row.category,
  firstName: row.firstName,
  lastName: row.lastName,
  phone: row.phone,
  email: row.email,
  archived: row.archivedAt !== null,
  account: toAccount(row),
  assignmentCount: row._count.assignments,
});

/// Which staff records this member may see: an ADMIN every campus's; anyone else the school-wide ones and their own campus's.
export function staffVisibleTo(tenant: TenantCtx): Prisma.StaffRecordWhereInput {
  if (tenant.role === "ADMIN") return {};
  return { OR: [{ campusId: null }, ...(tenant.campusId ? [{ campusId: tenant.campusId }] : [])] };
}

const findStaff = (tx: Tx, tenant: TenantCtx, id: string, now: Date) =>
  tx.staffRecord.findFirst({ where: { id, tenantId: tenant.tenantId, ...staffVisibleTo(tenant) }, include: STAFF_INCLUDE(now) });

/// Serialises a school's staff list changes (the email rule) and each record's account link.
async function lockStaff(tx: Tx, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff:${tenantId}`}::text))`;
}

// --- reading ------------------------------------------------------------------------------------------------------------------

export type StaffFilters = { status: "live" | "archived" | "all"; q?: string; campusId?: string; category?: StaffCategory };

export async function listStaff(
  tenant: TenantCtx,
  filters: StaffFilters,
  page: { skip: number; take: number },
  now: Date = new Date(),
): Promise<{ staff: StaffView[]; total: number }> {
  const and: Prisma.StaffRecordWhereInput[] = [staffVisibleTo(tenant)];
  for (const token of (filters.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 5)) {
    and.push({
      OR: [
        { firstName: { contains: token, mode: "insensitive" } },
        { lastName: { contains: token, mode: "insensitive" } },
        { email: { contains: token, mode: "insensitive" } },
        { phone: { contains: token } },
      ],
    });
  }
  const where: Prisma.StaffRecordWhereInput = {
    tenantId: tenant.tenantId,
    AND: and,
    ...(filters.campusId ? { campusId: filters.campusId } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.status === "live" ? { archivedAt: null } : {}),
    ...(filters.status === "archived" ? { archivedAt: { not: null } } : {}),
  };
  return tenant.run(async (tx) => {
    const [total, rows] = await Promise.all([
      tx.staffRecord.count({ where }),
      tx.staffRecord.findMany({
        where,
        include: STAFF_INCLUDE(now),
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
        skip: page.skip,
        take: page.take,
      }),
    ]);
    return { staff: rows.map(toStaff), total };
  });
}

const ASSIGNMENT_INCLUDE = {
  subject: { select: { name: true } },
  classArm: { select: { name: true, classGroup: { select: { name: true } } } },
} satisfies Prisma.StaffSubjectAssignmentInclude;
type AssignmentRow = Prisma.StaffSubjectAssignmentGetPayload<{ include: typeof ASSIGNMENT_INCLUDE }>;
const toAssignment = (row: AssignmentRow): AssignmentView => ({
  id: row.id,
  subjectId: row.subjectId,
  subjectName: row.subject.name,
  classArmId: row.classArmId,
  armName: row.classArm.name,
  classGroupName: row.classArm.classGroup.name,
});

export async function getStaff(
  tenant: TenantCtx,
  id: string,
  now: Date = new Date(),
): Promise<PeopleResult<{ staff: StaffView; assignments: AssignmentView[] }>> {
  return tenant.run(async (tx) => {
    const row = await findStaff(tx, tenant, id, now);
    if (!row) return refuse("NOT_FOUND");
    const assignments = await tx.staffSubjectAssignment.findMany({
      where: { tenantId: tenant.tenantId, staffRecordId: id },
      include: ASSIGNMENT_INCLUDE,
      orderBy: [
        { classArm: { classGroup: { sortOrder: "asc" } } },
        { classArm: { classGroup: { name: "asc" } } },
        { classArm: { name: "asc" } },
        { subject: { name: "asc" } },
        { id: "asc" },
      ],
    });
    return { ok: true, staff: toStaff(row), assignments: assignments.map(toAssignment) };
  });
}

// --- writing: the record ------------------------------------------------------------------------------------------------------

export type StaffInput = {
  campusId?: string | null;
  category: unknown;
  firstName: unknown;
  lastName: unknown;
  phone?: unknown;
  email?: unknown;
};
type CleanStaff = { category: StaffCategory; firstName: string; lastName: string; phone: string | null; email: string | null };

function cleanStaffFields(input: Omit<StaffInput, "campusId">): { ok: true; value: CleanStaff } | ReturnType<typeof invalid> {
  if (!isCategory(input.category)) return invalid("category");
  const firstName = cleanPersonName(input.firstName);
  if (!firstName) return invalid("firstName");
  const lastName = cleanPersonName(input.lastName);
  if (!lastName) return invalid("lastName");
  const phone = cleanOptional(input.phone, cleanPhone);
  if (phone === undefined) return invalid("phone");
  const email = cleanOptional(input.email, cleanEmail);
  if (email === undefined) return invalid("email");
  return { ok: true, value: { category: input.category, firstName, lastName, phone, email } };
}

const emailTaken = async (tx: Tx, tenantId: string, email: string, exceptId?: string) =>
  Boolean(
    await tx.staffRecord.findFirst({
      where: { tenantId, email, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    }),
  );

export async function createStaff(
  tenant: TenantCtx,
  actorUserId: string,
  input: StaffInput,
  now: Date = new Date(),
): Promise<PeopleResult<{ staff: StaffView }>> {
  const fields = cleanStaffFields(input);
  if (!fields.ok) return fields;
  const campusId = input.campusId ?? null;
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      if (campusId) {
        const campus = await tx.campus.findFirst({ where: { id: campusId, tenantId }, select: { id: true } });
        if (!campus) return refuse("INVALID_CAMPUS");
      }
      await lockStaff(tx, tenantId);
      if (fields.value.email && (await emailTaken(tx, tenantId, fields.value.email))) return refuse("EMAIL_TAKEN");
      const row = await tx.staffRecord.create({ data: { tenantId, campusId, ...fields.value }, include: STAFF_INCLUDE(now) });
      await auditPeople(tx, tenantId, actorUserId, "StaffRecord", "STAFF_CREATED", row.id, undefined, { category: row.category, campusId });
      return { ok: true as const, staff: toStaff(row) };
    }),
  );
}

export async function updateStaff(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  input: Partial<Omit<StaffInput, "campusId">>,
  now: Date = new Date(),
): Promise<PeopleResult<{ staff: StaffView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const current = await findStaff(tx, tenant, id, now);
      if (!current) return refuse("NOT_FOUND");
      if (current.archivedAt) return refuse("ARCHIVED");
      const merged = cleanStaffFields({
        category: input.category ?? current.category,
        firstName: input.firstName ?? current.firstName,
        lastName: input.lastName ?? current.lastName,
        phone: input.phone === undefined ? current.phone : input.phone,
        email: input.email === undefined ? current.email : input.email,
      });
      if (!merged.ok) return merged;
      const next = merged.value;
      const changedFields = (["category", "firstName", "lastName", "phone", "email"] as const).filter(
        (field) => next[field] !== current[field],
      );
      if (changedFields.length === 0) return { ok: true as const, staff: toStaff(current), changed: false };
      // A record with a sign-in account keeps its category: the account's role was matched to it, and the Users page is where roles change.
      if (changedFields.includes("category") && current.userId) return refuse("ACCOUNT_MISMATCH", { field: "category" });
      await lockStaff(tx, tenantId);
      if (next.email && next.email !== current.email && (await emailTaken(tx, tenantId, next.email, id))) return refuse("EMAIL_TAKEN");
      const row = await tx.staffRecord.update({ where: { id }, data: next, include: STAFF_INCLUDE(now) });
      await auditPeople(tx, tenantId, actorUserId, "StaffRecord", "STAFF_UPDATED", id, undefined, { changed: changedFields });
      return { ok: true as const, staff: toStaff(row), changed: true };
    }),
  );
}

/// Archives a staff record — refused while subjects are still assigned to them (remove the assignments first). Their account, if any, is untouched:
/// signing in is the Users page's business.
export async function archiveStaff(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  now: Date = new Date(),
): Promise<PeopleResult<{ staff: StaffView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const current = await findStaff(tx, tenant, id, now);
      if (!current) return refuse("NOT_FOUND");
      if (current.archivedAt) return { ok: true as const, staff: toStaff(current), changed: false };
      await lockStaff(tx, tenantId);
      if (await tx.staffSubjectAssignment.findFirst({ where: { tenantId, staffRecordId: id }, select: { id: true } }))
        return refuse("HAS_ASSIGNMENTS");
      const done = await tx.staffRecord.updateMany({ where: { id, tenantId, archivedAt: null }, data: { archivedAt: now } });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditPeople(tx, tenantId, actorUserId, "StaffRecord", "STAFF_ARCHIVED", id);
      return {
        ok: true as const,
        staff: toStaff(await tx.staffRecord.findUniqueOrThrow({ where: { id }, include: STAFF_INCLUDE(now) })),
        changed: true,
      };
    }),
  );
}

export async function restoreStaff(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  now: Date = new Date(),
): Promise<PeopleResult<{ staff: StaffView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const current = await findStaff(tx, tenant, id, now);
      if (!current) return refuse("NOT_FOUND");
      if (!current.archivedAt) return { ok: true as const, staff: toStaff(current), changed: false };
      await lockStaff(tx, tenantId);
      if (current.email && (await emailTaken(tx, tenantId, current.email, id))) return refuse("EMAIL_TAKEN");
      const done = await tx.staffRecord.updateMany({ where: { id, tenantId, archivedAt: { not: null } }, data: { archivedAt: null } });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditPeople(tx, tenantId, actorUserId, "StaffRecord", "STAFF_RESTORED", id);
      return {
        ok: true as const,
        staff: toStaff(await tx.staffRecord.findUniqueOrThrow({ where: { id }, include: STAFF_INCLUDE(now) })),
        changed: true,
      };
    }),
  );
}

// --- writing: the sign-in account (decision P5) -------------------------------------------------------------------------------

export type LinkableAccount = { userId: string; name: string | null; email: string | null };

/// Members of this school an administrator may link to a record: ACTIVE, holding the role that fits the category, and not linked to another staff record.
export async function linkableAccounts(
  tenant: TenantCtx,
  staffId: string,
  now: Date = new Date(),
): Promise<PeopleResult<{ accounts: LinkableAccount[] }>> {
  return tenant.run(async (tx) => {
    const record = await findStaff(tx, tenant, staffId, now);
    if (!record) return refuse("NOT_FOUND");
    const members = await tx.tenantMembership.findMany({
      where: {
        tenantId: tenant.tenantId,
        deactivatedAt: null,
        role: roleForCategory(record.category),
        staffRecords: { none: {} },
      },
      select: { userId: true, user: { select: { name: true, email: true } } },
      orderBy: [{ user: { name: "asc" } }, { userId: "asc" }],
      take: 200,
    });
    return { ok: true, accounts: members.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email })) };
  });
}

/// Links a record to an existing member of this school. Conditional (`userId IS NULL`), so two administrators linking at once make one link.
export async function linkAccount(
  tenant: TenantCtx,
  actorUserId: string,
  staffId: string,
  input: { userId: string },
  now: Date = new Date(),
): Promise<PeopleResult<{ staff: StaffView }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const record = await findStaff(tx, tenant, staffId, now);
      if (!record) return refuse("NOT_FOUND");
      if (record.archivedAt) return refuse("ARCHIVED");
      if (record.userId) return refuse("ALREADY_LINKED_ACCOUNT");
      await lockStaff(tx, tenantId);
      const member = await tx.tenantMembership.findFirst({
        where: { tenantId, userId: input.userId, deactivatedAt: null },
        select: { role: true },
      });
      if (!member || member.role !== roleForCategory(record.category)) return refuse("ACCOUNT_MISMATCH");
      if (await tx.staffRecord.findFirst({ where: { tenantId, userId: input.userId }, select: { id: true } }))
        return refuse("ACCOUNT_TAKEN");
      const done = await tx.staffRecord.updateMany({
        where: { id: staffId, tenantId, userId: null, archivedAt: null },
        data: { userId: input.userId },
      });
      if (done.count !== 1) return refuseAndRollBack("ALREADY_LINKED_ACCOUNT");
      await auditPeople(tx, tenantId, actorUserId, "StaffRecord", "STAFF_ACCOUNT_LINKED", staffId, undefined, { userId: input.userId });
      return {
        ok: true as const,
        staff: toStaff(await tx.staffRecord.findUniqueOrThrow({ where: { id: staffId }, include: STAFF_INCLUDE(now) })),
      };
    }),
  );
}

/// Clears the link (the account and its membership are untouched). Idempotent in effect: a record with no account answers NOT_LINKED.
export async function unlinkAccount(
  tenant: TenantCtx,
  actorUserId: string,
  staffId: string,
  now: Date = new Date(),
): Promise<PeopleResult<{ staff: StaffView }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const record = await findStaff(tx, tenant, staffId, now);
      if (!record) return refuse("NOT_FOUND");
      if (!record.userId) return refuse("NOT_LINKED");
      await lockStaff(tx, tenantId);
      const was = record.userId;
      const done = await tx.staffRecord.updateMany({ where: { id: staffId, tenantId, userId: was }, data: { userId: null } });
      if (done.count !== 1) return refuseAndRollBack("NOT_LINKED");
      await auditPeople(tx, tenantId, actorUserId, "StaffRecord", "STAFF_ACCOUNT_UNLINKED", staffId, { userId: was });
      return {
        ok: true as const,
        staff: toStaff(await tx.staffRecord.findUniqueOrThrow({ where: { id: staffId }, include: STAFF_INCLUDE(now) })),
      };
    }),
  );
}

/// What the invitation route needs to invite a record's person: the address, the role their category signs in as, and the record's campus. Refused when there is
/// no address, the record is archived, or it already has an account. (The invitation service re-checks the record inside its own transaction.)
export async function staffInviteDetails(
  tenant: TenantCtx,
  staffId: string,
  now: Date = new Date(),
): Promise<PeopleResult<{ email: string; role: Role; campusId: string | null }>> {
  return tenant.run(async (tx) => {
    const record = await findStaff(tx, tenant, staffId, now);
    if (!record) return refuse("NOT_FOUND");
    if (record.archivedAt) return refuse("ARCHIVED");
    if (record.userId) return refuse("ALREADY_LINKED_ACCOUNT");
    if (!record.email) return refuse("EMAIL_REQUIRED");
    return { ok: true, email: record.email, role: roleForCategory(record.category), campusId: record.campusId };
  });
}

// --- assignments ---------------------------------------------------------------------------------------------------------------

/// A subject may be assigned to an arm only when the arm's class group studies it (`SubjectOffering`). A record with a campus teaches school-wide or its own
/// campus's classes; a record with no campus (a visiting teacher) may teach any class the caller can see.
export async function addAssignment(
  tenant: TenantCtx,
  actorUserId: string,
  staffId: string,
  input: { subjectId: string; classArmId: string },
  now: Date = new Date(),
): Promise<PeopleResult<{ assignment: AssignmentView }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const record = await findStaff(tx, tenant, staffId, now);
      if (!record) return refuse("NOT_FOUND");
      if (record.archivedAt) return refuse("ARCHIVED");
      const subject = await tx.subject.findFirst({ where: { id: input.subjectId, tenantId, archivedAt: null }, select: { id: true } });
      if (!subject) return refuse("INVALID_SUBJECT");
      const arm = await tx.classArm.findFirst({
        where: { id: input.classArmId, tenantId, archivedAt: null, classGroup: { archivedAt: null, ...groupsVisibleTo(tenant) } },
        select: { id: true, classGroupId: true, classGroup: { select: { campusId: true } } },
      });
      if (!arm) return refuse("INVALID_ARM");
      if (record.campusId !== null && arm.classGroup.campusId !== null && arm.classGroup.campusId !== record.campusId)
        return refuse("INVALID_ARM");
      const offered = await tx.subjectOffering.findFirst({
        where: { tenantId, classGroupId: arm.classGroupId, subjectId: subject.id },
        select: { id: true },
      });
      if (!offered) return refuse("SUBJECT_NOT_OFFERED");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-assignment:${tenantId}:${staffId}`}::text))`;
      if (
        await tx.staffSubjectAssignment.findFirst({
          where: { tenantId, staffRecordId: staffId, subjectId: subject.id, classArmId: arm.id },
          select: { id: true },
        })
      ) {
        return refuse("ALREADY_ASSIGNED");
      }
      const created = await tx.staffSubjectAssignment.create({
        data: { tenantId, staffRecordId: staffId, subjectId: subject.id, classArmId: arm.id },
        include: ASSIGNMENT_INCLUDE,
      });
      await auditPeople(tx, tenantId, actorUserId, "StaffSubjectAssignment", "STAFF_ASSIGNED", created.id, undefined, {
        staffRecordId: staffId,
        subjectId: subject.id,
        classArmId: arm.id,
      });
      return { ok: true as const, assignment: toAssignment(created) };
    }),
  );
}

/// Removes an assignment (a real delete: nothing references one yet — the day a later phase does, the catalog test fails and this becomes archive-on-reference).
export async function removeAssignment(
  tenant: TenantCtx,
  actorUserId: string,
  staffId: string,
  assignmentId: string,
  now: Date = new Date(),
): Promise<PeopleResult<{ removed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const record = await findStaff(tx, tenant, staffId, now);
      if (!record) return refuse("NOT_FOUND");
      const current = await tx.staffSubjectAssignment.findFirst({ where: { id: assignmentId, tenantId, staffRecordId: staffId } });
      if (!current) return refuse("NOT_FOUND");
      const done = await tx.staffSubjectAssignment.deleteMany({ where: { id: assignmentId, tenantId, staffRecordId: staffId } });
      if (done.count !== 1) return refuseAndRollBack("NOT_FOUND");
      await auditPeople(tx, tenantId, actorUserId, "StaffSubjectAssignment", "STAFF_UNASSIGNED", assignmentId, {
        staffRecordId: staffId,
        subjectId: current.subjectId,
        classArmId: current.classArmId,
      });
      return { ok: true as const, removed: true };
    }),
  );
}
