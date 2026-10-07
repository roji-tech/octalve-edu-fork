import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { cleanName } from "@/lib/academics/rules";
import { checkBands, gradeFor, type BandInput, type ScaleProblem } from "@/lib/academics/scoring";
import { auditAcademic, refuse, refuseAndRollBack, rollingBack, type AcademicResult } from "@/lib/academics/sessions";

// Grade scales as data (plan "Build design — Phase 1.0 and 1.1", decision 15): bands of score → letter → remark, contiguous from 0 to 100 with no gap
// and no overlap for ANY decimal score, versioned like assessment schemes (edited in place while unlocked; locked by `lockScale` when a result first
// uses it; then a change is a NEW VERSION). Exactly one live scale is the school's DEFAULT.

type TenantCtx = TenantAuthContext["tenant"];

export const SCALE_NAME_MAX = 60;

export type BandView = { id: string; min: number; max: number; letter: string; remark: string; sortOrder: number };
export type ScaleView = {
  id: string;
  name: string;
  isDefault: boolean;
  version: number;
  locked: boolean;
  supersedesId: string | null;
  archived: boolean;
  bands: BandView[];
};

const num = (value: { toString(): string }) => Number(value.toString());
const SCALE_INCLUDE = { bands: { orderBy: [{ minScore: "asc" }, { id: "asc" }] } } satisfies Prisma.GradeScaleInclude;
type ScaleRow = Prisma.GradeScaleGetPayload<{ include: typeof SCALE_INCLUDE }>;
const toScale = (row: ScaleRow): ScaleView => ({
  id: row.id,
  name: row.name,
  isDefault: row.isDefault,
  version: row.version,
  locked: row.lockedAt !== null,
  supersedesId: row.supersedesId,
  archived: row.archivedAt !== null,
  bands: row.bands.map((band) => ({
    id: band.id,
    min: num(band.minScore),
    max: num(band.maxScore),
    letter: band.letter,
    remark: band.remark,
    sortOrder: band.sortOrder,
  })),
});
const asRecord = (view: Pick<ScaleView, "name" | "bands">) => ({
  name: view.name,
  bands: view.bands.map((band) => ({ min: band.min, max: band.max, letter: band.letter, remark: band.remark })),
});

async function lockScales(tx: Tx, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`grade-scale:${tenantId}`}::text))`;
}
const findScale = (tx: Tx, tenantId: string, id: string) => tx.gradeScale.findFirst({ where: { id, tenantId }, include: SCALE_INCLUDE });

type RawBand = { min: unknown; max: unknown; letter: unknown; remark: unknown };
/// Cleans the bands (trimmed text), validates them with the pure rule, and returns them in score order with their sortOrder.
function parseBands(
  input: readonly RawBand[],
): { ok: true; bands: (BandInput & { sortOrder: number })[] } | { ok: false; detail: { problem: ScaleProblem; index?: number } } {
  const cleaned: BandInput[] = input.map((band) => ({
    min: band.min as number,
    max: band.max as number,
    letter: typeof band.letter === "string" ? band.letter.trim() : "",
    remark: typeof band.remark === "string" ? band.remark.replace(/\s+/g, " ").trim() : "",
  }));
  const bad = checkBands(cleaned);
  if (bad) return { ok: false, detail: bad };
  const ordered = [...cleaned].sort((x, y) => x.min - y.min).map((band, sortOrder) => ({ ...band, sortOrder }));
  return { ok: true, bands: ordered };
}

// --- reads ----------------------------------------------------------------------------------------------------------------------

export async function listScales(
  tenant: TenantCtx,
  filters: { status: "live" | "archived" | "all" },
  page: { skip: number; take: number },
): Promise<{ scales: ScaleView[]; total: number }> {
  const where: Prisma.GradeScaleWhereInput = {
    tenantId: tenant.tenantId,
    ...(filters.status === "live" ? { archivedAt: null } : {}),
    ...(filters.status === "archived" ? { archivedAt: { not: null } } : {}),
  };
  return tenant.run(async (tx) => {
    const [total, rows] = await Promise.all([
      tx.gradeScale.count({ where }),
      tx.gradeScale.findMany({
        where,
        include: SCALE_INCLUDE,
        orderBy: [{ isDefault: "desc" }, { name: "asc" }, { version: "desc" }, { id: "asc" }],
        skip: page.skip,
        take: page.take,
      }),
    ]);
    return { scales: rows.map(toScale), total };
  });
}

export async function getScale(tenant: TenantCtx, id: string): Promise<AcademicResult<{ scale: ScaleView }>> {
  return tenant.run(async (tx) => {
    const row = await findScale(tx, tenant.tenantId, id);
    return row ? { ok: true, scale: toScale(row) } : refuse("NOT_FOUND");
  });
}

/// The school's default scale, or null when none has been made — what Phase 1.4 reads to turn a score into a letter (with `gradeFor`).
export async function getDefaultScale(tenant: TenantCtx): Promise<ScaleView | null> {
  return tenant.run(async (tx) => {
    const row = await tx.gradeScale.findFirst({
      where: { tenantId: tenant.tenantId, isDefault: true, archivedAt: null },
      include: SCALE_INCLUDE,
    });
    return row ? toScale(row) : null;
  });
}

/// Which band a score falls in on this scale (null for a score outside 0–100) — the only way a score becomes a letter.
export const bandFor = (scale: Pick<ScaleView, "bands">, score: number): BandView | null => gradeFor(scale.bands, score);

// --- writes ---------------------------------------------------------------------------------------------------------------------

/// Creates a scale. The FIRST live scale a school makes becomes its default automatically; later ones are not (use `makeDefaultScale`).
export async function createScale(
  tenant: TenantCtx,
  actorUserId: string,
  input: { name: unknown; bands: readonly RawBand[] },
): Promise<AcademicResult<{ scale: ScaleView }>> {
  const name = cleanName(input.name, SCALE_NAME_MAX);
  if (!name) return refuse("INVALID_NAME");
  const parsed = parseBands(input.bands);
  if (!parsed.ok) return refuse("BANDS_INVALID", parsed.detail);
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    await lockScales(tx, tenantId);
    if (await tx.gradeScale.findFirst({ where: { tenantId, name, archivedAt: null }, select: { id: true } })) return refuse("NAME_TAKEN");
    const hasDefault = Boolean(
      await tx.gradeScale.findFirst({ where: { tenantId, isDefault: true, archivedAt: null }, select: { id: true } }),
    );
    const created = await tx.gradeScale.create({ data: { tenantId, name, isDefault: !hasDefault } });
    await tx.gradeBand.createMany({
      data: parsed.bands.map((band) => ({
        tenantId,
        scaleId: created.id,
        minScore: band.min,
        maxScore: band.max,
        letter: band.letter,
        remark: band.remark,
        sortOrder: band.sortOrder,
      })),
    });
    await auditAcademic(tx, tenantId, actorUserId, "GradeScale", "GRADE_SCALE_CREATED", created.id, undefined, {
      name,
      isDefault: !hasDefault,
      bands: parsed.bands.map(({ min, max, letter, remark }) => ({ min, max, letter, remark })),
    });
    return { ok: true, scale: toScale((await findScale(tx, tenantId, created.id))!) };
  });
}

/// Edits a scale IN PLACE — only while it is unlocked and live. The whole band list is replaced and re-validated.
export async function updateScale(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  input: { name?: unknown; bands?: readonly RawBand[] },
): Promise<AcademicResult<{ scale: ScaleView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await findScale(tx, tenantId, id);
    if (!current) return refuse("NOT_FOUND");
    if (current.archivedAt) return refuse("ARCHIVED");
    if (current.lockedAt) return refuse("LOCKED");
    const before = toScale(current);
    const name = input.name === undefined ? current.name : cleanName(input.name, SCALE_NAME_MAX);
    if (!name) return refuse("INVALID_NAME");
    const parsed = parseBands(input.bands ?? before.bands);
    if (!parsed.ok) return refuse("BANDS_INVALID", parsed.detail);
    const after = { name, bands: parsed.bands.map(({ min, max, letter, remark }) => ({ min, max, letter, remark })) };
    if (JSON.stringify(asRecord(before)) === JSON.stringify(after)) return { ok: true, scale: before, changed: false };
    await lockScales(tx, tenantId);
    if (
      name !== current.name &&
      (await tx.gradeScale.findFirst({ where: { tenantId, name, archivedAt: null, id: { not: id } }, select: { id: true } }))
    )
      return refuse("NAME_TAKEN");
    await tx.gradeScale.update({ where: { id }, data: { name } });
    await tx.gradeBand.deleteMany({ where: { tenantId, scaleId: id } });
    await tx.gradeBand.createMany({
      data: parsed.bands.map((band) => ({
        tenantId,
        scaleId: id,
        minScore: band.min,
        maxScore: band.max,
        letter: band.letter,
        remark: band.remark,
        sortOrder: band.sortOrder,
      })),
    });
    await auditAcademic(tx, tenantId, actorUserId, "GradeScale", "GRADE_SCALE_UPDATED", id, asRecord(before), after);
    return { ok: true, scale: toScale((await findScale(tx, tenantId, id))!), changed: true };
  });
}

/// A change to a LOCKED scale: copies it as version + 1 (with the given changes), archives the one it supersedes and hands over the default flag.
export async function newScaleVersion(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  changes: { name?: unknown; bands?: readonly RawBand[] },
): Promise<AcademicResult<{ scale: ScaleView }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const old = await findScale(tx, tenantId, id);
    if (!old) return refuse("NOT_FOUND");
    if (old.archivedAt) return refuse("ARCHIVED");
    if (!old.lockedAt) return refuse("NOT_LOCKED");
    const before = toScale(old);
    const name = changes.name === undefined ? old.name : cleanName(changes.name, SCALE_NAME_MAX);
    if (!name) return refuse("INVALID_NAME");
    const parsed = parseBands(changes.bands ?? before.bands);
    if (!parsed.ok) return refuse("BANDS_INVALID", parsed.detail);
    await lockScales(tx, tenantId);
    // checked BEFORE the first write: a refusal after it would commit the predecessor's archiving without a successor
    if (name !== old.name && (await tx.gradeScale.findFirst({ where: { tenantId, name, archivedAt: null }, select: { id: true } })))
      return refuse("NAME_TAKEN");
    // the predecessor leaves the live set first (and gives up the default flag), so the unique indexes admit its successor
    const archived = await tx.gradeScale.updateMany({
      where: { id, tenantId, archivedAt: null },
      data: { archivedAt: new Date(), isDefault: false },
    });
    if (archived.count !== 1) return refuse("WRONG_STATE"); // nothing was written yet
    const created = await tx.gradeScale.create({
      data: { tenantId, name, isDefault: old.isDefault, version: old.version + 1, supersedesId: id },
    });
    await tx.gradeBand.createMany({
      data: parsed.bands.map((band) => ({
        tenantId,
        scaleId: created.id,
        minScore: band.min,
        maxScore: band.max,
        letter: band.letter,
        remark: band.remark,
        sortOrder: band.sortOrder,
      })),
    });
    await auditAcademic(
      tx,
      tenantId,
      actorUserId,
      "GradeScale",
      "GRADE_SCALE_NEW_VERSION",
      created.id,
      { supersedes: id, version: old.version, ...asRecord(before) },
      {
        version: old.version + 1,
        isDefault: old.isDefault,
        name,
        bands: parsed.bands.map(({ min, max, letter, remark }) => ({ min, max, letter, remark })),
      },
    );
    return { ok: true, scale: toScale((await findScale(tx, tenantId, created.id))!) };
  });
}

/// Makes a live scale THE default, in one transaction (the previous default stops being one). A no-op if it already is.
export async function makeDefaultScale(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
): Promise<AcademicResult<{ scale: ScaleView; changed: boolean }>> {
  const { tenantId } = tenant;
  return rollingBack(() =>
    tenant.run(async (tx) => {
      const current = await findScale(tx, tenantId, id);
      if (!current) return refuse("NOT_FOUND");
      if (current.archivedAt) return refuse("ARCHIVED");
      if (current.isDefault) return { ok: true, scale: toScale(current), changed: false };
      await lockScales(tx, tenantId);
      const previous = await tx.gradeScale.findFirst({ where: { tenantId, isDefault: true, archivedAt: null }, select: { id: true } });
      await tx.gradeScale.updateMany({ where: { tenantId, isDefault: true }, data: { isDefault: false } });
      const done = await tx.gradeScale.updateMany({
        where: { id, tenantId, archivedAt: null, isDefault: false },
        data: { isDefault: true },
      });
      if (done.count !== 1) return refuseAndRollBack("WRONG_STATE");
      await auditAcademic(
        tx,
        tenantId,
        actorUserId,
        "GradeScale",
        "GRADE_SCALE_DEFAULT_CHANGED",
        id,
        { defaultId: previous?.id ?? null },
        { defaultId: id },
      );
      return { ok: true, scale: toScale((await findScale(tx, tenantId, id))!), changed: true };
    }),
  );
}

/// Archives a scale — refused for the DEFAULT one (make another the default first), so the school is never left without one by accident.
export async function archiveScale(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
): Promise<AcademicResult<{ scale: ScaleView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await findScale(tx, tenantId, id);
    if (!current) return refuse("NOT_FOUND");
    if (current.archivedAt) return { ok: true, scale: toScale(current), changed: false };
    if (current.isDefault) return refuse("DEFAULT_CANNOT_ARCHIVE");
    await lockScales(tx, tenantId);
    const done = await tx.gradeScale.updateMany({
      where: { id, tenantId, archivedAt: null, isDefault: false },
      data: { archivedAt: new Date() },
    });
    if (done.count !== 1) return refuse("WRONG_STATE");
    await auditAcademic(tx, tenantId, actorUserId, "GradeScale", "GRADE_SCALE_ARCHIVED", id, { archived: false }, { archived: true });
    return { ok: true, scale: toScale((await findScale(tx, tenantId, id))!), changed: true };
  });
}

/// Locks a scale — called (inside the caller's transaction) the first time a result uses it. Idempotent; returns whether THIS call locked it.
export async function lockScale(tx: Tx, tenantId: string, id: string): Promise<boolean> {
  const done = await tx.gradeScale.updateMany({ where: { id, tenantId, lockedAt: null }, data: { lockedAt: new Date() } });
  return done.count === 1;
}
