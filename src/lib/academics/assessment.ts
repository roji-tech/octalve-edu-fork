import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { cleanName } from "@/lib/academics/rules";
import { checkScheme, snapshotScheme, toHundredths, type SchemeProblem } from "@/lib/academics/scoring";
import { auditAcademic, refuse, type AcademicResult } from "@/lib/academics/sessions";

// Assessment schemes: how a mark is built (continuous-assessment components + the exam = a total), versioned so history cannot be rewritten
// (plan "Build design — Phase 1.0 and 1.1", decision 14). Edited in place only while UNLOCKED; `lockScheme` (called by Phase 1.4 the first time a
// result references one) freezes it — a database trigger then refuses every change to it and its components — and any later change is a NEW VERSION.

type TenantCtx = TenantAuthContext["tenant"];

export const SCHEME_NAME_MAX = 60;

export type ComponentView = { id: string; name: string; maxScore: number; sortOrder: number };
export type SchemeView = {
  id: string;
  classGroupId: string | null;
  classGroupName: string | null;
  name: string;
  totalMax: number;
  examMax: number;
  version: number;
  locked: boolean;
  supersedesId: string | null;
  archived: boolean;
  components: ComponentView[];
};

const num = (value: { toString(): string }) => Number(value.toString());
const SCHEME_INCLUDE = {
  classGroup: { select: { name: true } },
  components: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] },
} satisfies Prisma.AssessmentSchemeInclude;
type SchemeRow = Prisma.AssessmentSchemeGetPayload<{ include: typeof SCHEME_INCLUDE }>;
const toScheme = (row: SchemeRow): SchemeView => ({
  id: row.id,
  classGroupId: row.classGroupId,
  classGroupName: row.classGroup?.name ?? null,
  name: row.name,
  totalMax: num(row.totalMax),
  examMax: num(row.examMax),
  version: row.version,
  locked: row.lockedAt !== null,
  supersedesId: row.supersedesId,
  archived: row.archivedAt !== null,
  components: row.components.map((component) => ({
    id: component.id,
    name: component.name,
    maxScore: num(component.maxScore),
    sortOrder: component.sortOrder,
  })),
});

/// Which schemes this member may see: the school default, and those of class groups they may see (an ADMIN: all; others: school-wide groups and their own campus's).
function visibleTo(tenant: TenantCtx): Prisma.AssessmentSchemeWhereInput {
  if (tenant.role === "ADMIN") return {};
  const groupVisible: Prisma.ClassGroupWhereInput = {
    OR: [{ campusId: null }, ...(tenant.campusId ? [{ campusId: tenant.campusId }] : [])],
  };
  return { OR: [{ classGroupId: null }, { classGroup: groupVisible }] };
}
const findVisible = (tx: Tx, tenant: TenantCtx, id: string) =>
  tx.assessmentScheme.findFirst({ where: { id, tenantId: tenant.tenantId, ...visibleTo(tenant) }, include: SCHEME_INCLUDE });

async function lockSchemes(tx: Tx, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assessment-scheme:${tenantId}`}::text))`;
}

export type SchemeInputComponents = readonly { name: unknown; maxScore: unknown }[];
type Parsed = { components: { name: string; maxScore: number; sortOrder: number }[]; totalMax: number; examMax: number };

/// Cleans and validates the numbers and components of a scheme with the pure rule; the components keep the order they were given in (that is their sortOrder).
function parseScheme(input: {
  totalMax: unknown;
  examMax: unknown;
  components: SchemeInputComponents;
}): { ok: true; value: Parsed } | { ok: false; detail: { problem: SchemeProblem; index?: number; sum?: number } } {
  const components = input.components.map((component, sortOrder) => ({
    name: typeof component.name === "string" ? component.name.replace(/\s+/g, " ").trim() : "",
    maxScore: component.maxScore as number,
    sortOrder,
  }));
  const bad = checkScheme({ totalMax: input.totalMax as number, examMax: input.examMax as number, components });
  if (bad) return { ok: false, detail: bad };
  return { ok: true, value: { components, totalMax: input.totalMax as number, examMax: input.examMax as number } };
}
const asRecord = (view: Pick<SchemeView, "name" | "totalMax" | "examMax" | "components">) => ({
  name: view.name,
  totalMax: view.totalMax,
  examMax: view.examMax,
  components: view.components.map((component) => ({ name: component.name, maxScore: component.maxScore })),
});

// --- reads ----------------------------------------------------------------------------------------------------------------------

export async function listSchemes(
  tenant: TenantCtx,
  filters: { status: "live" | "archived" | "all"; classGroupId?: string },
  page: { skip: number; take: number },
): Promise<{ schemes: SchemeView[]; total: number }> {
  const where: Prisma.AssessmentSchemeWhereInput = {
    tenantId: tenant.tenantId,
    AND: [visibleTo(tenant)],
    ...(filters.classGroupId ? { classGroupId: filters.classGroupId } : {}),
    ...(filters.status === "live" ? { archivedAt: null } : {}),
    ...(filters.status === "archived" ? { archivedAt: { not: null } } : {}),
  };
  return tenant.run(async (tx) => {
    const [total, rows] = await Promise.all([
      tx.assessmentScheme.count({ where }),
      tx.assessmentScheme.findMany({
        where,
        include: SCHEME_INCLUDE,
        orderBy: [{ name: "asc" }, { version: "desc" }, { id: "asc" }],
        skip: page.skip,
        take: page.take,
      }),
    ]);
    return { schemes: rows.map(toScheme), total };
  });
}

export async function getScheme(
  tenant: TenantCtx,
  id: string,
): Promise<AcademicResult<{ scheme: SchemeView; snapshot: { json: string; sha256: string } }>> {
  return tenant.run(async (tx) => {
    const row = await findVisible(tx, tenant, id);
    if (!row) return refuse("NOT_FOUND");
    const scheme = toScheme(row);
    return { ok: true, scheme, snapshot: snapshotScheme(scheme) };
  });
}

// --- writes ---------------------------------------------------------------------------------------------------------------------

export async function createScheme(
  tenant: TenantCtx,
  actorUserId: string,
  input: { classGroupId?: string | null; name: unknown; totalMax?: unknown; examMax: unknown; components: SchemeInputComponents },
): Promise<AcademicResult<{ scheme: SchemeView }>> {
  const name = cleanName(input.name, SCHEME_NAME_MAX);
  if (!name) return refuse("INVALID_NAME");
  const parsed = parseScheme({
    totalMax: input.totalMax === undefined ? 100 : input.totalMax,
    examMax: input.examMax,
    components: input.components,
  });
  if (!parsed.ok) return refuse("SCHEME_INVALID", parsed.detail);
  const classGroupId = input.classGroupId ?? null;
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    if (classGroupId) {
      // a live class group of THIS school that this member may see; anything else is "no such class"
      const group = await tx.classGroup.findFirst({
        where: {
          id: classGroupId,
          tenantId,
          archivedAt: null,
          ...(tenant.role === "ADMIN" ? {} : { OR: [{ campusId: null }, ...(tenant.campusId ? [{ campusId: tenant.campusId }] : [])] }),
        },
        select: { id: true },
      });
      if (!group) return refuse("UNKNOWN_CLASS_GROUP");
    }
    await lockSchemes(tx, tenantId);
    if (await tx.assessmentScheme.findFirst({ where: { tenantId, classGroupId, archivedAt: null }, select: { id: true } }))
      return refuse("SCOPE_TAKEN");
    if (await tx.assessmentScheme.findFirst({ where: { tenantId, name, archivedAt: null }, select: { id: true } }))
      return refuse("NAME_TAKEN");
    const created = await tx.assessmentScheme.create({
      data: { tenantId, classGroupId, name, totalMax: parsed.value.totalMax, examMax: parsed.value.examMax },
    });
    await tx.assessmentComponent.createMany({
      data: parsed.value.components.map((component) => ({ tenantId, schemeId: created.id, ...component })),
    });
    await auditAcademic(tx, tenantId, actorUserId, "AssessmentScheme", "ASSESSMENT_SCHEME_CREATED", created.id, undefined, {
      name,
      classGroupId,
      totalMax: parsed.value.totalMax,
      examMax: parsed.value.examMax,
      components: parsed.value.components.map((component) => ({ name: component.name, maxScore: component.maxScore })),
    });
    return {
      ok: true,
      scheme: toScheme(await tx.assessmentScheme.findUniqueOrThrow({ where: { id: created.id }, include: SCHEME_INCLUDE })),
    };
  });
}

/// Edits a scheme IN PLACE — only while it is unlocked and live. Anything not given stays as it was; the whole result is re-validated.
export async function updateScheme(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  input: { name?: unknown; totalMax?: unknown; examMax?: unknown; components?: SchemeInputComponents },
): Promise<AcademicResult<{ scheme: SchemeView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await findVisible(tx, tenant, id);
    if (!current) return refuse("NOT_FOUND");
    if (current.archivedAt) return refuse("ARCHIVED");
    if (current.lockedAt) return refuse("LOCKED");
    const before = toScheme(current);
    const name = input.name === undefined ? current.name : cleanName(input.name, SCHEME_NAME_MAX);
    if (!name) return refuse("INVALID_NAME");
    const parsed = parseScheme({
      totalMax: input.totalMax === undefined ? before.totalMax : input.totalMax,
      examMax: input.examMax === undefined ? before.examMax : input.examMax,
      components: input.components ?? before.components,
    });
    if (!parsed.ok) return refuse("SCHEME_INVALID", parsed.detail);
    const after = {
      name,
      totalMax: parsed.value.totalMax,
      examMax: parsed.value.examMax,
      components: parsed.value.components.map((c) => ({ name: c.name, maxScore: c.maxScore })),
    };
    if (JSON.stringify(asRecord(before)) === JSON.stringify(after)) return { ok: true, scheme: before, changed: false };
    await lockSchemes(tx, tenantId);
    if (
      name !== current.name &&
      (await tx.assessmentScheme.findFirst({ where: { tenantId, name, archivedAt: null, id: { not: id } }, select: { id: true } }))
    )
      return refuse("NAME_TAKEN");
    await tx.assessmentScheme.update({ where: { id }, data: { name, totalMax: parsed.value.totalMax, examMax: parsed.value.examMax } });
    await tx.assessmentComponent.deleteMany({ where: { tenantId, schemeId: id } });
    await tx.assessmentComponent.createMany({
      data: parsed.value.components.map((component) => ({ tenantId, schemeId: id, ...component })),
    });
    await auditAcademic(tx, tenantId, actorUserId, "AssessmentScheme", "ASSESSMENT_SCHEME_UPDATED", id, asRecord(before), after);
    return {
      ok: true,
      scheme: toScheme(await tx.assessmentScheme.findUniqueOrThrow({ where: { id }, include: SCHEME_INCLUDE })),
      changed: true,
    };
  });
}

/// A change to a LOCKED scheme: copies it as version + 1 (with the given changes, if any), archives the one it supersedes, and links them.
/// An unlocked scheme is edited in place instead (`NOT_LOCKED`). One transaction; both audited.
export async function newSchemeVersion(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  changes: { name?: unknown; totalMax?: unknown; examMax?: unknown; components?: SchemeInputComponents },
): Promise<AcademicResult<{ scheme: SchemeView }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const old = await findVisible(tx, tenant, id);
    if (!old) return refuse("NOT_FOUND");
    if (old.archivedAt) return refuse("ARCHIVED");
    if (!old.lockedAt) return refuse("NOT_LOCKED");
    const before = toScheme(old);
    const name = changes.name === undefined ? old.name : cleanName(changes.name, SCHEME_NAME_MAX);
    if (!name) return refuse("INVALID_NAME");
    const parsed = parseScheme({
      totalMax: changes.totalMax === undefined ? before.totalMax : changes.totalMax,
      examMax: changes.examMax === undefined ? before.examMax : changes.examMax,
      components: changes.components ?? before.components,
    });
    if (!parsed.ok) return refuse("SCHEME_INVALID", parsed.detail);
    await lockSchemes(tx, tenantId);
    // checked BEFORE the first write: a refusal after it would commit the predecessor's archiving without a successor
    if (name !== old.name && (await tx.assessmentScheme.findFirst({ where: { tenantId, name, archivedAt: null }, select: { id: true } })))
      return refuse("NAME_TAKEN");
    // the predecessor leaves the "live" set FIRST, so the one-live-per-scope and unique-name indexes admit its successor
    const archived = await tx.assessmentScheme.updateMany({ where: { id, tenantId, archivedAt: null }, data: { archivedAt: new Date() } });
    if (archived.count !== 1) return refuse("WRONG_STATE"); // nothing was written yet
    const created = await tx.assessmentScheme.create({
      data: {
        tenantId,
        classGroupId: old.classGroupId,
        name,
        totalMax: parsed.value.totalMax,
        examMax: parsed.value.examMax,
        version: old.version + 1,
        supersedesId: id,
      },
    });
    await tx.assessmentComponent.createMany({
      data: parsed.value.components.map((component) => ({ tenantId, schemeId: created.id, ...component })),
    });
    await auditAcademic(
      tx,
      tenantId,
      actorUserId,
      "AssessmentScheme",
      "ASSESSMENT_SCHEME_NEW_VERSION",
      created.id,
      { supersedes: id, version: old.version, ...asRecord(before) },
      {
        version: old.version + 1,
        name,
        totalMax: parsed.value.totalMax,
        examMax: parsed.value.examMax,
        components: parsed.value.components.map((c) => ({ name: c.name, maxScore: c.maxScore })),
      },
    );
    return {
      ok: true,
      scheme: toScheme(await tx.assessmentScheme.findUniqueOrThrow({ where: { id: created.id }, include: SCHEME_INCLUDE })),
    };
  });
}

export async function archiveScheme(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
): Promise<AcademicResult<{ scheme: SchemeView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await findVisible(tx, tenant, id);
    if (!current) return refuse("NOT_FOUND");
    if (current.archivedAt) return { ok: true, scheme: toScheme(current), changed: false };
    await lockSchemes(tx, tenantId);
    const done = await tx.assessmentScheme.updateMany({ where: { id, tenantId, archivedAt: null }, data: { archivedAt: new Date() } });
    if (done.count !== 1) return refuse("WRONG_STATE");
    await auditAcademic(
      tx,
      tenantId,
      actorUserId,
      "AssessmentScheme",
      "ASSESSMENT_SCHEME_ARCHIVED",
      id,
      { archived: false },
      { archived: true },
    );
    return {
      ok: true,
      scheme: toScheme(await tx.assessmentScheme.findUniqueOrThrow({ where: { id }, include: SCHEME_INCLUDE })),
      changed: true,
    };
  });
}

/// Locks a scheme — called (inside the caller's transaction) the first time a result references it. Idempotent; returns whether THIS call locked it.
/// From then on the database refuses any change to it or its components; a change is a new version. Phase 1.4 is its first caller.
export async function lockScheme(tx: Tx, tenantId: string, id: string): Promise<boolean> {
  const done = await tx.assessmentScheme.updateMany({ where: { id, tenantId, lockedAt: null }, data: { lockedAt: new Date() } });
  return done.count === 1;
}

/// The canonical snapshot (JSON + SHA-256) of a scheme as it is now — what a result stores when it locks the scheme.
export async function snapshotOfScheme(tx: Tx, tenantId: string, id: string): Promise<{ json: string; sha256: string } | null> {
  const row = await tx.assessmentScheme.findFirst({ where: { id, tenantId }, include: SCHEME_INCLUDE });
  return row ? snapshotScheme(toScheme(row)) : null;
}

export { toHundredths };
