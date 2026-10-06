import type { AcademicPeriod, AcademicSession, Prisma, PeriodKind, SessionStatus } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import {
  addYears,
  checkPeriodDates,
  checkSessionDates,
  cleanName,
  findOverlap,
  findPeriodOverlap,
  fromIsoDate,
  isIsoDate,
  nextSessionLabel,
  periodKindFor,
  toIsoDate,
  wholeYearsBetween,
  type PeriodProblem,
  type SessionDatesProblem,
} from "@/lib/academics/rules";

// Academic sessions and their periods (plan "Build design — Phase 1.0 and 1.1", decisions 7–12 and 16).
//
// EVERY function runs in ONE transaction through `tenant.run` (the only door to tenant-scoped data), names the tenant in its queries
// even though row-level security is the net underneath, and writes its audit row IN THE SAME TRANSACTION as the change. Nothing is
// deleted: rows are archived. Rules that must hold under concurrency (no two overlapping sessions in a scope, one ACTIVE per scope,
// one current period, ordinals and labels) are enforced twice — here under a per-scope advisory lock, and by a partial unique index.

type TenantCtx = TenantAuthContext["tenant"];

export const SESSION_LABEL_MAX = 40;
export const PERIOD_LABEL_MAX = 60;
export const MAX_PERIODS_PER_SESSION = 12;

export type SessionView = {
  id: string;
  campusId: string | null;
  campusName: string | null;
  label: string;
  startDate: string;
  endDate: string;
  status: SessionStatus;
  archived: boolean;
  copiedFromId: string | null;
  periodCount: number;
};

export type PeriodView = {
  id: string;
  sessionId: string;
  kind: PeriodKind;
  ordinal: number;
  label: string;
  startDate: string;
  endDate: string | null;
  isCurrent: boolean;
  archived: boolean;
};

const SESSION_INCLUDE = {
  campus: { select: { name: true } },
  _count: { select: { periods: { where: { archivedAt: null } } } },
} satisfies Prisma.AcademicSessionInclude;
type SessionRow = Prisma.AcademicSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

const toSessionView = (row: SessionRow): SessionView => ({
  id: row.id,
  campusId: row.campusId,
  campusName: row.campus?.name ?? null,
  label: row.label,
  startDate: toIsoDate(row.startDate),
  endDate: toIsoDate(row.endDate),
  status: row.status,
  archived: row.archivedAt !== null,
  copiedFromId: row.copiedFromId,
  periodCount: row._count.periods,
});

const toPeriodView = (row: AcademicPeriod): PeriodView => ({
  id: row.id,
  sessionId: row.sessionId,
  kind: row.kind,
  ordinal: row.ordinal,
  label: row.label,
  startDate: toIsoDate(row.startDate),
  endDate: row.endDate ? toIsoDate(row.endDate) : null,
  isCurrent: row.isCurrent,
  archived: row.archivedAt !== null,
});

/// Which sessions this member may see (decision 7): an ADMIN sees every campus; anyone else sees the school-wide ones and their own campus's.
export function visibleTo(tenant: TenantCtx): Prisma.AcademicSessionWhereInput {
  if (tenant.role === "ADMIN") return {};
  return { OR: [{ campusId: null }, ...(tenant.campusId ? [{ campusId: tenant.campusId }] : [])] };
}

export type AcademicFailure =
  /// No such session/period in THIS school or not visible to this member: unknown, another school's, another campus's — one answer.
  | "NOT_FOUND"
  | "INVALID_CAMPUS"
  | "INVALID_LABEL"
  | "INVALID_DATES"
  | "LABEL_TAKEN"
  | "OVERLAP"
  /// Activation refused because another session in the scope is active (and the caller did not ask to close it).
  | "SESSION_ALREADY_ACTIVE"
  /// The action needs a different state: activate needs PLANNED; close needs ACTIVE; a CLOSED/archived session is read-only.
  | "WRONG_STATE"
  | "ARCHIVED"
  | "CLOSED_READONLY"
  | "ACTIVE_CANNOT_ARCHIVE"
  | "PERIODS_OUTSIDE"
  | "TOO_MANY_PERIODS"
  | "ORDINAL_TAKEN"
  | "ALREADY_COPIED"
  | "SESSION_NOT_ACTIVE"
  // --- classes, arms and subjects (family B) ---
  | "INVALID_NAME"
  | "INVALID_CAPACITY"
  | "INVALID_SORT_ORDER"
  | "INVALID_CODE"
  | "NAME_TAKEN"
  | "CODE_TAKEN"
  /// A class group cannot be archived while it still has live arms: archive the arms first (nothing is archived silently).
  | "HAS_ACTIVE_ARMS"
  /// A subject cannot be archived while a live class group still studies it.
  | "SUBJECT_IN_USE"
  /// The offering list named a subject that does not exist in this school (or is archived).
  | "UNKNOWN_SUBJECT"
  | "TOO_MANY_ARMS"
  // --- assessment schemes and grade scales (families C and D) ---
  | "SCHEME_INVALID"
  | "BANDS_INVALID"
  /// A locked scheme/scale (a result references it) cannot be edited in place — make a new version.
  | "LOCKED"
  /// A new version is only for a LOCKED scheme/scale; an unlocked one is edited in place.
  | "NOT_LOCKED"
  | "UNKNOWN_CLASS_GROUP"
  /// A live scheme already exists for that scope (one class group, or the school default).
  | "SCOPE_TAKEN"
  | "DEFAULT_CANNOT_ARCHIVE";

export type AcademicResult<T> = ({ ok: true } & T) | { ok: false; reason: AcademicFailure; detail?: Record<string, unknown> };
export const refuse = (reason: AcademicFailure, detail?: Record<string, unknown>) => ({
  ok: false as const,
  reason,
  ...(detail ? { detail } : {}),
});

/// The scope key a session belongs to: "" for school-wide, else the campus id. One lock per (school, scope) serialises every
/// check-then-write on that scope's calendar.
const scopeKey = (campusId: string | null) => campusId ?? "";
async function lockScope(tx: Tx, tenantId: string, campusId: string | null) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`academic-session:${tenantId}:${scopeKey(campusId)}`}::text))`;
}
async function lockSession(tx: Tx, tenantId: string, sessionId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`academic-period:${tenantId}:${sessionId}`}::text))`;
}

/// One audit row for ANY academic entity, written in the caller's transaction (the other services use this too).
export const auditAcademic = (
  tx: Tx,
  tenantId: string,
  actorUserId: string,
  targetType: string,
  action: string,
  targetId: string,
  beforeValue?: Prisma.InputJsonValue,
  afterValue?: Prisma.InputJsonValue,
) =>
  tx.auditLog.create({
    data: {
      tenantId,
      actorUserId,
      action,
      targetType,
      targetId,
      ...(beforeValue ? { beforeValue } : {}),
      ...(afterValue ? { afterValue } : {}),
    },
  });
const audit = (
  tx: Tx,
  tenantId: string,
  actorUserId: string,
  action: string,
  targetId: string,
  beforeValue?: Prisma.InputJsonValue,
  afterValue?: Prisma.InputJsonValue,
) => auditAcademic(tx, tenantId, actorUserId, "AcademicSession", action, targetId, beforeValue, afterValue);
const auditPeriod = (
  tx: Tx,
  tenantId: string,
  actorUserId: string,
  action: string,
  targetId: string,
  beforeValue?: Prisma.InputJsonValue,
  afterValue?: Prisma.InputJsonValue,
) =>
  tx.auditLog.create({
    data: {
      tenantId,
      actorUserId,
      action,
      targetType: "AcademicPeriod",
      targetId,
      ...(beforeValue ? { beforeValue } : {}),
      ...(afterValue ? { afterValue } : {}),
    },
  });

export const findVisible = (tx: Tx, tenant: TenantCtx, id: string) =>
  tx.academicSession.findFirst({ where: { id, tenantId: tenant.tenantId, ...visibleTo(tenant) }, include: SESSION_INCLUDE });

const rangeOf = (row: Pick<AcademicSession, "startDate" | "endDate">) => ({ start: toIsoDate(row.startDate), end: toIsoDate(row.endDate) });

/// The live (non-archived) sessions of one scope, as ranges — what a new or moved session must not overlap.
async function liveRangesInScope(tx: Tx, tenantId: string, campusId: string | null, exceptId?: string) {
  const rows = await tx.academicSession.findMany({
    where: { tenantId, campusId, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, label: true, startDate: true, endDate: true },
  });
  return rows.map((row) => ({ id: row.id, label: row.label, ...rangeOf(row) }));
}

// --- sessions -----------------------------------------------------------------------------------------------------------------

export type SessionStatusFilter = "planned" | "active" | "closed" | "archived" | "all" | "live";

export async function listSessions(
  tenant: TenantCtx,
  filters: { status: SessionStatusFilter; campusId?: string },
  page: { skip: number; take: number },
): Promise<{ sessions: SessionView[]; total: number }> {
  const where: Prisma.AcademicSessionWhereInput = {
    tenantId: tenant.tenantId,
    AND: [visibleTo(tenant)],
    ...(filters.campusId ? { campusId: filters.campusId } : {}),
    ...(filters.status === "live" ? { archivedAt: null } : {}),
    ...(filters.status === "archived" ? { archivedAt: { not: null } } : {}),
    ...(filters.status === "planned" || filters.status === "active" || filters.status === "closed"
      ? { archivedAt: null, status: filters.status.toUpperCase() as SessionStatus }
      : {}),
  };
  return tenant.run(async (tx) => {
    const [total, rows] = await Promise.all([
      tx.academicSession.count({ where }),
      tx.academicSession.findMany({
        where,
        include: SESSION_INCLUDE,
        // newest calendar first; the id keeps pages stable when two sessions start the same day
        orderBy: [{ startDate: "desc" }, { label: "asc" }, { id: "asc" }],
        skip: page.skip,
        take: page.take,
      }),
    ]);
    return { sessions: rows.map(toSessionView), total };
  });
}

export async function getSession(tenant: TenantCtx, id: string): Promise<AcademicResult<{ session: SessionView; periods: PeriodView[] }>> {
  return tenant.run(async (tx) => {
    const row = await findVisible(tx, tenant, id);
    if (!row) return refuse("NOT_FOUND");
    const periods = await tx.academicPeriod.findMany({
      where: { tenantId: tenant.tenantId, sessionId: id },
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
    });
    return { ok: true, session: toSessionView(row), periods: periods.map(toPeriodView) };
  });
}

const datesProblem = (problem: SessionDatesProblem) => refuse("INVALID_DATES", { problem });

export async function createSession(
  tenant: TenantCtx,
  actorUserId: string,
  input: { campusId?: string | null; label: unknown; startDate: unknown; endDate: unknown },
): Promise<AcademicResult<{ session: SessionView }>> {
  const label = cleanName(input.label, SESSION_LABEL_MAX);
  if (!label) return refuse("INVALID_LABEL");
  const problem = checkSessionDates(input.startDate, input.endDate);
  if (problem) return datesProblem(problem);
  const campusId = input.campusId ?? null;
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    if (campusId) {
      // A campus of ANOTHER school is, to this one, a campus that does not exist.
      const campus = await tx.campus.findFirst({ where: { id: campusId, tenantId }, select: { id: true } });
      if (!campus) return refuse("INVALID_CAMPUS");
    }
    await lockScope(tx, tenantId, campusId);
    const live = await liveRangesInScope(tx, tenantId, campusId);
    if (live.some((other) => other.label === label)) return refuse("LABEL_TAKEN");
    const range = { start: input.startDate as string, end: input.endDate as string };
    const clash = findOverlap(range, live);
    if (clash) return refuse("OVERLAP", { sessionId: clash.id, label: clash.label });
    const created = await tx.academicSession.create({
      data: { tenantId, campusId, label, startDate: fromIsoDate(range.start), endDate: fromIsoDate(range.end) },
      include: SESSION_INCLUDE,
    });
    await audit(tx, tenantId, actorUserId, "SESSION_CREATED", created.id, undefined, {
      label,
      campusId,
      startDate: range.start,
      endDate: range.end,
    });
    return { ok: true, session: toSessionView(created) };
  });
}

export async function updateSession(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  input: { label?: unknown; startDate?: unknown; endDate?: unknown },
): Promise<AcademicResult<{ session: SessionView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await findVisible(tx, tenant, id);
    if (!current) return refuse("NOT_FOUND");
    if (current.archivedAt) return refuse("ARCHIVED");
    if (current.status === "CLOSED") return refuse("CLOSED_READONLY");

    const label = input.label === undefined ? current.label : cleanName(input.label, SESSION_LABEL_MAX);
    if (!label) return refuse("INVALID_LABEL");
    const start = input.startDate === undefined ? toIsoDate(current.startDate) : input.startDate;
    const end = input.endDate === undefined ? toIsoDate(current.endDate) : input.endDate;
    const problem = checkSessionDates(start, end);
    if (problem) return datesProblem(problem);

    const before = { label: current.label, startDate: toIsoDate(current.startDate), endDate: toIsoDate(current.endDate) };
    const after = { label, startDate: start as string, endDate: end as string };
    if (before.label === after.label && before.startDate === after.startDate && before.endDate === after.endDate) {
      return { ok: true, session: toSessionView(current), changed: false }; // a no-op writes nothing
    }

    await lockScope(tx, tenantId, current.campusId);
    const live = await liveRangesInScope(tx, tenantId, current.campusId, id);
    if (live.some((other) => other.label === label)) return refuse("LABEL_TAKEN");
    const clash = findOverlap({ start: after.startDate, end: after.endDate }, live);
    if (clash) return refuse("OVERLAP", { sessionId: clash.id, label: clash.label });

    // The periods must still fit inside the (moved or shortened) session.
    const periods = await tx.academicPeriod.findMany({
      where: { tenantId, sessionId: id, archivedAt: null },
      select: { kind: true, startDate: true, endDate: true },
    });
    const stranded = periods.filter(
      (period) =>
        checkPeriodDates(period.kind, toIsoDate(period.startDate), period.endDate ? toIsoDate(period.endDate) : null, {
          start: after.startDate,
          end: after.endDate,
        }) !== null,
    );
    if (stranded.length > 0) return refuse("PERIODS_OUTSIDE", { count: stranded.length });

    const updated = await tx.academicSession.update({
      where: { id },
      data: { label, startDate: fromIsoDate(after.startDate), endDate: fromIsoDate(after.endDate) },
      include: SESSION_INCLUDE,
    });
    await audit(tx, tenantId, actorUserId, "SESSION_UPDATED", id, before, after);
    return { ok: true, session: toSessionView(updated), changed: true };
  });
}

/// Activates a PLANNED session. If another session in the same scope is ACTIVE this is REFUSED, naming it — unless the caller explicitly asks
/// to close it (`closeCurrent`), in which case closing it and opening this one is ONE transaction, audited as two entries. Nothing is ever
/// deactivated silently.
export async function activateSession(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
  options: { closeCurrent: boolean },
): Promise<AcademicResult<{ session: SessionView; closed: { id: string; label: string } | null }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const target = await findVisible(tx, tenant, id);
    if (!target) return refuse("NOT_FOUND");
    if (target.archivedAt) return refuse("ARCHIVED");
    await lockScope(tx, tenantId, target.campusId);
    const active = await tx.academicSession.findFirst({
      where: { tenantId, campusId: target.campusId, status: "ACTIVE", archivedAt: null, id: { not: id } },
      select: { id: true, label: true },
    });
    if (active && !options.closeCurrent) return refuse("SESSION_ALREADY_ACTIVE", { sessionId: active.id, label: active.label });

    let closed: { id: string; label: string } | null = null;
    if (active) {
      const done = await tx.academicSession.updateMany({
        where: { id: active.id, tenantId, status: "ACTIVE" },
        data: { status: "CLOSED" },
      });
      if (done.count !== 1) return refuse("WRONG_STATE");
      await tx.academicPeriod.updateMany({ where: { tenantId, sessionId: active.id, isCurrent: true }, data: { isCurrent: false } });
      await audit(tx, tenantId, actorUserId, "SESSION_CLOSED", active.id, { status: "ACTIVE" }, { status: "CLOSED", closedToOpen: id });
      closed = active;
    }
    // The conditional update decides: it changes exactly one row only if the session is still PLANNED and live.
    const claimed = await tx.academicSession.updateMany({
      where: { id, tenantId, status: "PLANNED", archivedAt: null },
      data: { status: "ACTIVE" },
    });
    if (claimed.count !== 1) return refuse("WRONG_STATE");
    await audit(
      tx,
      tenantId,
      actorUserId,
      "SESSION_ACTIVATED",
      id,
      { status: "PLANNED" },
      { status: "ACTIVE", ...(closed ? { closed: closed.id } : {}) },
    );
    const row = await tx.academicSession.findUniqueOrThrow({ where: { id }, include: SESSION_INCLUDE });
    return { ok: true, session: toSessionView(row), closed };
  });
}

export async function closeSession(tenant: TenantCtx, actorUserId: string, id: string): Promise<AcademicResult<{ session: SessionView }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const target = await findVisible(tx, tenant, id);
    if (!target) return refuse("NOT_FOUND");
    if (target.archivedAt) return refuse("ARCHIVED");
    await lockScope(tx, tenantId, target.campusId);
    const done = await tx.academicSession.updateMany({
      where: { id, tenantId, status: "ACTIVE", archivedAt: null },
      data: { status: "CLOSED" },
    });
    if (done.count !== 1) return refuse("WRONG_STATE");
    await tx.academicPeriod.updateMany({ where: { tenantId, sessionId: id, isCurrent: true }, data: { isCurrent: false } });
    await audit(tx, tenantId, actorUserId, "SESSION_CLOSED", id, { status: "ACTIVE" }, { status: "CLOSED" });
    const row = await tx.academicSession.findUniqueOrThrow({ where: { id }, include: SESSION_INCLUDE });
    return { ok: true, session: toSessionView(row) };
  });
}

/// Archives a PLANNED or CLOSED session and its periods (an ACTIVE one must be closed first). Archived rows stay forever; they only leave the lists.
export async function archiveSession(
  tenant: TenantCtx,
  actorUserId: string,
  id: string,
): Promise<AcademicResult<{ session: SessionView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const target = await findVisible(tx, tenant, id);
    if (!target) return refuse("NOT_FOUND");
    if (target.archivedAt) return { ok: true, session: toSessionView(target), changed: false };
    if (target.status === "ACTIVE") return refuse("ACTIVE_CANNOT_ARCHIVE");
    await lockScope(tx, tenantId, target.campusId);
    const now = new Date();
    const done = await tx.academicSession.updateMany({
      where: { id, tenantId, archivedAt: null, status: { not: "ACTIVE" } },
      data: { archivedAt: now },
    });
    if (done.count !== 1) return refuse("WRONG_STATE");
    await tx.academicPeriod.updateMany({
      where: { tenantId, sessionId: id, archivedAt: null },
      data: { archivedAt: now, isCurrent: false },
    });
    await audit(tx, tenantId, actorUserId, "SESSION_ARCHIVED", id, { archived: false }, { archived: true });
    const row = await tx.academicSession.findUniqueOrThrow({ where: { id }, include: SESSION_INCLUDE });
    return { ok: true, session: toSessionView(row), changed: true };
  });
}

export type CopyForwardPlan = {
  session: { label: string; startDate: string; endDate: string; campusId: string | null };
  periods: { ordinal: number; label: string; kind: PeriodKind; startDate: string; endDate: string | null }[];
  conflicts: { kind: "OVERLAP" | "LABEL_TAKEN" | "ALREADY_COPIED"; with?: { id: string; label: string } }[];
};

/// Plans (and, unless `dryRun`, performs) the copy of a session to the next year (decision 16): every date shifts by the whole-year difference
/// between the old start and the new one; the periods come along with the same ordinals, labels and kinds, none of them current; the new session
/// is PLANNED. Idempotent — a partial unique index allows ONE live copy per source, so a second run is refused (`ALREADY_COPIED`) and a dry run
/// reports it. A dry run writes NOTHING.
export async function copyForward(
  tenant: TenantCtx,
  actorUserId: string,
  sourceId: string,
  input: { label?: unknown; startDate: unknown; dryRun: boolean },
): Promise<AcademicResult<{ plan: CopyForwardPlan; created: SessionView | null }>> {
  if (!isIsoDate(input.startDate)) return refuse("INVALID_DATES", { problem: "START_INVALID" });
  const newStart = input.startDate;
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const source = await findVisible(tx, tenant, sourceId);
    if (!source) return refuse("NOT_FOUND");
    if (source.archivedAt) return refuse("ARCHIVED");
    const years = wholeYearsBetween(toIsoDate(source.startDate), newStart);
    const newEnd = addYears(toIsoDate(source.endDate), years);
    const proposed = input.label === undefined ? nextSessionLabel(source.label) : cleanName(input.label, SESSION_LABEL_MAX);
    if (!proposed) return refuse("INVALID_LABEL");
    const problem = checkSessionDates(newStart, newEnd);
    if (problem) return datesProblem(problem);

    await lockScope(tx, tenantId, source.campusId);
    const live = await liveRangesInScope(tx, tenantId, source.campusId);
    const conflicts: CopyForwardPlan["conflicts"] = [];
    const existingCopy = await tx.academicSession.findFirst({
      where: { tenantId, copiedFromId: sourceId, archivedAt: null },
      select: { id: true, label: true },
    });
    if (existingCopy) conflicts.push({ kind: "ALREADY_COPIED", with: existingCopy });
    if (live.some((other) => other.label === proposed)) conflicts.push({ kind: "LABEL_TAKEN" });
    const clash = findOverlap({ start: newStart, end: newEnd }, live);
    if (clash) conflicts.push({ kind: "OVERLAP", with: { id: clash.id, label: clash.label } });

    const periods = await tx.academicPeriod.findMany({
      where: { tenantId, sessionId: sourceId, archivedAt: null },
      orderBy: { ordinal: "asc" },
    });
    const plan: CopyForwardPlan = {
      session: { label: proposed, startDate: newStart, endDate: newEnd, campusId: source.campusId },
      periods: periods.map((period) => ({
        ordinal: period.ordinal,
        label: period.label,
        kind: period.kind,
        startDate: addYears(toIsoDate(period.startDate), years),
        endDate: period.endDate ? addYears(toIsoDate(period.endDate), years) : null,
      })),
      conflicts,
    };
    if (input.dryRun) return { ok: true, plan, created: null };
    if (conflicts.length > 0) {
      const first = conflicts[0];
      return refuse(first.kind === "ALREADY_COPIED" ? "ALREADY_COPIED" : first.kind === "LABEL_TAKEN" ? "LABEL_TAKEN" : "OVERLAP", {
        conflicts,
      });
    }

    // The session first, then its periods in the same transaction (a nested create cannot carry the composite key's tenantId).
    const base = await tx.academicSession.create({
      data: {
        tenantId,
        campusId: source.campusId,
        label: proposed,
        startDate: fromIsoDate(newStart),
        endDate: fromIsoDate(newEnd),
        copiedFromId: sourceId,
      },
    });
    await tx.academicPeriod.createMany({
      data: plan.periods.map((period) => ({
        tenantId,
        sessionId: base.id,
        kind: period.kind,
        ordinal: period.ordinal,
        label: period.label,
        startDate: fromIsoDate(period.startDate),
        endDate: period.endDate ? fromIsoDate(period.endDate) : null,
      })),
    });
    const created = await tx.academicSession.findUniqueOrThrow({ where: { id: base.id }, include: SESSION_INCLUDE });
    await audit(
      tx,
      tenantId,
      actorUserId,
      "SESSION_COPIED_FORWARD",
      created.id,
      { copiedFrom: sourceId },
      { label: proposed, startDate: newStart, endDate: newEnd, periods: plan.periods.length },
    );
    return { ok: true, plan, created: toSessionView(created) };
  });
}

// --- periods ------------------------------------------------------------------------------------------------------------------

export async function listPeriods(
  tenant: TenantCtx,
  sessionId: string,
  options: { includeArchived: boolean },
): Promise<AcademicResult<{ periods: PeriodView[] }>> {
  return tenant.run(async (tx) => {
    const session = await findVisible(tx, tenant, sessionId);
    if (!session) return refuse("NOT_FOUND");
    const rows = await tx.academicPeriod.findMany({
      where: { tenantId: tenant.tenantId, sessionId, ...(options.includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
    });
    return { ok: true, periods: rows.map(toPeriodView) };
  });
}

const periodProblem = (problem: PeriodProblem) => refuse("INVALID_DATES", { problem });
const livePeriodRanges = async (tx: Tx, tenantId: string, sessionId: string, exceptId?: string) =>
  (
    await tx.academicPeriod.findMany({
      where: { tenantId, sessionId, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true, kind: true, ordinal: true, label: true, startDate: true, endDate: true },
    })
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    ordinal: row.ordinal,
    label: row.label,
    start: toIsoDate(row.startDate),
    end: row.endDate ? toIsoDate(row.endDate) : null,
  }));

export async function createPeriod(
  tenant: TenantCtx,
  actorUserId: string,
  sessionId: string,
  input: { ordinal?: unknown; label: unknown; startDate: unknown; endDate?: unknown },
): Promise<AcademicResult<{ period: PeriodView }>> {
  const label = cleanName(input.label, PERIOD_LABEL_MAX);
  if (!label) return refuse("INVALID_LABEL");
  const { tenantId } = tenant;
  const kind = periodKindFor(tenant.schoolType); // never from the client
  return tenant.run(async (tx) => {
    const session = await findVisible(tx, tenant, sessionId);
    if (!session) return refuse("NOT_FOUND");
    if (session.archivedAt) return refuse("ARCHIVED");
    if (session.status === "CLOSED") return refuse("CLOSED_READONLY");
    await lockSession(tx, tenantId, sessionId);
    const live = await livePeriodRanges(tx, tenantId, sessionId);
    if (live.length >= MAX_PERIODS_PER_SESSION) return refuse("TOO_MANY_PERIODS");
    const ordinal = input.ordinal === undefined ? Math.max(0, ...live.map((p) => p.ordinal)) + 1 : input.ordinal;
    if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 99)
      return refuse("INVALID_DATES", { problem: "ORDINAL_INVALID" });
    if (live.some((p) => p.ordinal === ordinal)) return refuse("ORDINAL_TAKEN");
    if (live.some((p) => p.label === label)) return refuse("LABEL_TAKEN");
    const end = input.endDate === undefined ? null : input.endDate;
    const problem = checkPeriodDates(kind, input.startDate, end, rangeOf(session));
    if (problem) return periodProblem(problem);
    const clash = findPeriodOverlap({ kind, start: input.startDate as string, end: end as string | null }, live);
    if (clash) return refuse("OVERLAP", { periodId: clash.id, label: clash.label });
    const created = await tx.academicPeriod.create({
      data: {
        tenantId,
        sessionId,
        kind,
        ordinal,
        label,
        startDate: fromIsoDate(input.startDate as string),
        endDate: end ? fromIsoDate(end as string) : null,
      },
    });
    await auditPeriod(tx, tenantId, actorUserId, "PERIOD_CREATED", created.id, undefined, {
      sessionId,
      kind,
      ordinal,
      label,
      startDate: input.startDate as string,
      endDate: (end as string | null) ?? null,
    });
    return { ok: true, period: toPeriodView(created) };
  });
}

export async function updatePeriod(
  tenant: TenantCtx,
  actorUserId: string,
  periodId: string,
  input: { ordinal?: unknown; label?: unknown; startDate?: unknown; endDate?: unknown },
): Promise<AcademicResult<{ period: PeriodView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await tx.academicPeriod.findFirst({ where: { id: periodId, tenantId } });
    if (!current) return refuse("NOT_FOUND");
    const session = await findVisible(tx, tenant, current.sessionId);
    if (!session) return refuse("NOT_FOUND");
    if (current.archivedAt || session.archivedAt) return refuse("ARCHIVED");
    if (session.status === "CLOSED") return refuse("CLOSED_READONLY");

    const label = input.label === undefined ? current.label : cleanName(input.label, PERIOD_LABEL_MAX);
    if (!label) return refuse("INVALID_LABEL");
    const ordinal = input.ordinal === undefined ? current.ordinal : input.ordinal;
    if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 99)
      return refuse("INVALID_DATES", { problem: "ORDINAL_INVALID" });
    const start = input.startDate === undefined ? toIsoDate(current.startDate) : input.startDate;
    const end = input.endDate === undefined ? (current.endDate ? toIsoDate(current.endDate) : null) : input.endDate;
    const before = {
      ordinal: current.ordinal,
      label: current.label,
      startDate: toIsoDate(current.startDate),
      endDate: current.endDate ? toIsoDate(current.endDate) : null,
    };
    const after = { ordinal, label, startDate: start as string, endDate: (end as string | null) ?? null };
    if (JSON.stringify(before) === JSON.stringify(after)) return { ok: true, period: toPeriodView(current), changed: false };

    await lockSession(tx, tenantId, current.sessionId);
    const problem = checkPeriodDates(current.kind, start, end, rangeOf(session));
    if (problem) return periodProblem(problem);
    const others = await livePeriodRanges(tx, tenantId, current.sessionId, periodId);
    if (others.some((p) => p.ordinal === ordinal)) return refuse("ORDINAL_TAKEN");
    if (others.some((p) => p.label === label)) return refuse("LABEL_TAKEN");
    const clash = findPeriodOverlap({ kind: current.kind, start: start as string, end: end as string | null }, others);
    if (clash) return refuse("OVERLAP", { periodId: clash.id, label: clash.label });
    const updated = await tx.academicPeriod.update({
      where: { id: periodId },
      data: { ordinal, label, startDate: fromIsoDate(after.startDate), endDate: after.endDate ? fromIsoDate(after.endDate) : null },
    });
    await auditPeriod(tx, tenantId, actorUserId, "PERIOD_UPDATED", periodId, before, after);
    return { ok: true, period: toPeriodView(updated), changed: true };
  });
}

/// Moves the session's single "current period" pointer to this period. Only an ACTIVE session has one; the pointer is unique per session
/// (a partial unique index), so two simultaneous moves cannot leave two current periods.
export async function setCurrentPeriod(
  tenant: TenantCtx,
  actorUserId: string,
  periodId: string,
): Promise<AcademicResult<{ period: PeriodView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await tx.academicPeriod.findFirst({ where: { id: periodId, tenantId } });
    if (!current) return refuse("NOT_FOUND");
    const session = await findVisible(tx, tenant, current.sessionId);
    if (!session) return refuse("NOT_FOUND");
    if (current.archivedAt || session.archivedAt) return refuse("ARCHIVED");
    if (session.status !== "ACTIVE") return refuse("SESSION_NOT_ACTIVE");
    await lockSession(tx, tenantId, current.sessionId);
    if (current.isCurrent) return { ok: true, period: toPeriodView(current), changed: false };
    const previous = await tx.academicPeriod.findFirst({
      where: { tenantId, sessionId: current.sessionId, isCurrent: true, archivedAt: null },
      select: { id: true },
    });
    await tx.academicPeriod.updateMany({ where: { tenantId, sessionId: current.sessionId, isCurrent: true }, data: { isCurrent: false } });
    const moved = await tx.academicPeriod.updateMany({
      where: { id: periodId, tenantId, archivedAt: null, isCurrent: false },
      data: { isCurrent: true },
    });
    if (moved.count !== 1) return refuse("WRONG_STATE");
    await auditPeriod(tx, tenantId, actorUserId, "PERIOD_SET_CURRENT", periodId, { current: previous?.id ?? null }, { current: periodId });
    const row = await tx.academicPeriod.findUniqueOrThrow({ where: { id: periodId } });
    return { ok: true, period: toPeriodView(row), changed: true };
  });
}

export async function archivePeriod(
  tenant: TenantCtx,
  actorUserId: string,
  periodId: string,
): Promise<AcademicResult<{ period: PeriodView; changed: boolean }>> {
  const { tenantId } = tenant;
  return tenant.run(async (tx) => {
    const current = await tx.academicPeriod.findFirst({ where: { id: periodId, tenantId } });
    if (!current) return refuse("NOT_FOUND");
    const session = await findVisible(tx, tenant, current.sessionId);
    if (!session) return refuse("NOT_FOUND");
    if (current.archivedAt) return { ok: true, period: toPeriodView(current), changed: false };
    if (session.status === "CLOSED") return refuse("CLOSED_READONLY");
    await lockSession(tx, tenantId, current.sessionId);
    const done = await tx.academicPeriod.updateMany({
      where: { id: periodId, tenantId, archivedAt: null },
      data: { archivedAt: new Date(), isCurrent: false },
    });
    if (done.count !== 1) return refuse("WRONG_STATE");
    await auditPeriod(
      tx,
      tenantId,
      actorUserId,
      "PERIOD_ARCHIVED",
      periodId,
      { archived: false, wasCurrent: current.isCurrent },
      { archived: true },
    );
    const row = await tx.academicPeriod.findUniqueOrThrow({ where: { id: periodId } });
    return { ok: true, period: toPeriodView(row), changed: true };
  });
}
