import { forTenant } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import { findSlotClashes, findBatchClashes, groupSlotsByDay, type TimetableSlotInput, type TimetableClash } from "./rules";
import type {
  CreateTimetableSlotInput,
  UpdateTimetableSlotInput,
  BatchSaveTimetableInput,
  QueryTimetableInput,
  TimetableFailure,
} from "./http";

export type TimetableServiceResult<T> =
  { ok: true; data: T } | { ok: false; failure: TimetableFailure; detail?: string; clashes?: TimetableClash[] };

export interface TimetableSlotDto {
  id: string;
  tenantId: string;
  classArmId: string;
  classArmName: string;
  classGroupName: string;
  subjectId: string;
  subjectName: string;
  subjectCode: string;
  staffRecordId: string;
  teacherName: string;
  dayOfWeek: number;
  periodNumber: number | null;
  startTime: string;
  endTime: string;
  room: string | null;
  createdAt: string;
  updatedAt: string;
}

const slotInclude = {
  classArm: {
    select: {
      id: true,
      name: true,
      classGroup: { select: { id: true, name: true } },
    },
  },
  subject: {
    select: { id: true, name: true, code: true },
  },
  staffRecord: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  },
} as const;

type SlotWithIncludes = {
  id: string;
  tenantId: string;
  classArmId: string;
  subjectId: string;
  staffRecordId: string;
  dayOfWeek: number;
  periodNumber: number | null;
  startTime: string;
  endTime: string;
  room: string | null;
  createdAt: Date;
  updatedAt: Date;
  classArm: { id: string; name: string; classGroup: { id: string; name: string } };
  subject: { id: string; name: string; code: string };
  staffRecord: { id: string; firstName: string; lastName: string };
};

function formatSlotDto(slot: SlotWithIncludes): TimetableSlotDto {
  return {
    id: slot.id,
    tenantId: slot.tenantId,
    classArmId: slot.classArmId,
    classArmName: slot.classArm.name,
    classGroupName: slot.classArm.classGroup.name,
    subjectId: slot.subjectId,
    subjectName: slot.subject.name,
    subjectCode: slot.subject.code,
    staffRecordId: slot.staffRecordId,
    teacherName: `${slot.staffRecord.firstName} ${slot.staffRecord.lastName}`.trim(),
    dayOfWeek: slot.dayOfWeek,
    periodNumber: slot.periodNumber,
    startTime: slot.startTime,
    endTime: slot.endTime,
    room: slot.room,
    createdAt: slot.createdAt.toISOString(),
    updatedAt: slot.updatedAt.toISOString(),
  };
}

/**
 * Queries timetable slots filtered by class arm, teacher, day of week, or room.
 */
export async function queryTimetableSlots(
  tenantId: string,
  query: QueryTimetableInput,
): Promise<{ slots: TimetableSlotDto[]; groupedByDay: Record<number, TimetableSlotDto[]> }> {
  const tId = trustedTenantId(tenantId);

  return forTenant(tId).transaction(async (tx) => {
    const where: {
      tenantId: string;
      classArmId?: string;
      staffRecordId?: string;
      dayOfWeek?: number;
      room?: string;
    } = { tenantId };

    if (query.classArmId) where.classArmId = query.classArmId;
    if (query.staffRecordId) where.staffRecordId = query.staffRecordId;
    if (query.dayOfWeek) where.dayOfWeek = query.dayOfWeek;
    if (query.room) where.room = query.room;

    const rows = (await tx.timetableSlot.findMany({
      where,
      include: slotInclude,
      orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    })) as unknown as SlotWithIncludes[];

    const dtos = rows.map(formatSlotDto);
    const grouped = groupSlotsByDay(dtos);

    return {
      slots: dtos,
      groupedByDay: grouped,
    };
  });
}

/**
 * Creates a single timetable slot, ensuring zero teacher/class/room conflicts.
 */
export async function createTimetableSlot(
  tenantId: string,
  input: CreateTimetableSlotInput,
): Promise<TimetableServiceResult<TimetableSlotDto>> {
  const tId = trustedTenantId(tenantId);

  return forTenant(tId).transaction(async (tx) => {
    // 1. Verify foreign keys in this tenant
    const [arm, subject, staff] = await Promise.all([
      tx.classArm.findFirst({ where: { id: input.classArmId, tenantId, archivedAt: null } }),
      tx.subject.findFirst({ where: { id: input.subjectId, tenantId } }),
      tx.staffRecord.findFirst({ where: { id: input.staffRecordId, tenantId } }),
    ]);

    if (!arm || !subject || !staff) {
      return { ok: false, failure: "INVALID_FOREIGN_KEY", detail: "Class arm, subject, or staff record does not exist in this school." };
    }

    // 2. Query all existing slots on this day to detect clashes
    const existingOnDay = await tx.timetableSlot.findMany({
      where: { tenantId, dayOfWeek: input.dayOfWeek },
      select: {
        id: true,
        classArmId: true,
        subjectId: true,
        staffRecordId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        room: true,
      },
    });

    const clashes = findSlotClashes(input, existingOnDay);
    if (clashes.length > 0) {
      return {
        ok: false,
        failure: "CLASH",
        detail: clashes.map((c) => c.message).join(" "),
        clashes,
      };
    }

    // 3. Create the slot
    const created = (await tx.timetableSlot.create({
      data: {
        tenantId,
        classArmId: input.classArmId,
        subjectId: input.subjectId,
        staffRecordId: input.staffRecordId,
        dayOfWeek: input.dayOfWeek,
        periodNumber: input.periodNumber ?? null,
        startTime: input.startTime,
        endTime: input.endTime,
        room: input.room?.trim() ?? null,
      },
      include: slotInclude,
    })) as unknown as SlotWithIncludes;

    return { ok: true, data: formatSlotDto(created) };
  });
}

/**
 * Updates an existing timetable slot, ensuring the edit does not introduce clashes.
 */
export async function updateTimetableSlot(
  tenantId: string,
  id: string,
  input: UpdateTimetableSlotInput,
): Promise<TimetableServiceResult<TimetableSlotDto>> {
  const tId = trustedTenantId(tenantId);

  return forTenant(tId).transaction(async (tx) => {
    const existing = await tx.timetableSlot.findFirst({
      where: { id, tenantId },
    });

    if (!existing) {
      return { ok: false, failure: "NOT_FOUND" };
    }

    // Check FKs if modified
    if (input.classArmId && input.classArmId !== existing.classArmId) {
      const arm = await tx.classArm.findFirst({ where: { id: input.classArmId, tenantId, archivedAt: null } });
      if (!arm) return { ok: false, failure: "INVALID_FOREIGN_KEY", detail: "Class arm not found." };
    }
    if (input.subjectId && input.subjectId !== existing.subjectId) {
      const subj = await tx.subject.findFirst({ where: { id: input.subjectId, tenantId } });
      if (!subj) return { ok: false, failure: "INVALID_FOREIGN_KEY", detail: "Subject not found." };
    }
    if (input.staffRecordId && input.staffRecordId !== existing.staffRecordId) {
      const staff = await tx.staffRecord.findFirst({ where: { id: input.staffRecordId, tenantId } });
      if (!staff) return { ok: false, failure: "INVALID_FOREIGN_KEY", detail: "Staff record not found." };
    }

    const mergedDayOfWeek = input.dayOfWeek ?? existing.dayOfWeek;
    const mergedStartTime = input.startTime ?? existing.startTime;
    const mergedEndTime = input.endTime ?? existing.endTime;

    const candidate: TimetableSlotInput = {
      id: existing.id,
      classArmId: input.classArmId ?? existing.classArmId,
      subjectId: input.subjectId ?? existing.subjectId,
      staffRecordId: input.staffRecordId ?? existing.staffRecordId,
      dayOfWeek: mergedDayOfWeek,
      periodNumber: input.periodNumber !== undefined ? input.periodNumber : existing.periodNumber,
      startTime: mergedStartTime,
      endTime: mergedEndTime,
      room: input.room !== undefined ? input.room : existing.room,
    };

    // Query existing slots for this day to test for clashes
    const existingOnDay = await tx.timetableSlot.findMany({
      where: { tenantId, dayOfWeek: mergedDayOfWeek },
      select: {
        id: true,
        classArmId: true,
        subjectId: true,
        staffRecordId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        room: true,
      },
    });

    const clashes = findSlotClashes(candidate, existingOnDay);
    if (clashes.length > 0) {
      return {
        ok: false,
        failure: "CLASH",
        detail: clashes.map((c) => c.message).join(" "),
        clashes,
      };
    }

    const updated = (await tx.timetableSlot.update({
      where: { tenantId_id: { tenantId, id } },
      data: {
        classArmId: candidate.classArmId,
        subjectId: candidate.subjectId,
        staffRecordId: candidate.staffRecordId,
        dayOfWeek: candidate.dayOfWeek,
        periodNumber: candidate.periodNumber,
        startTime: candidate.startTime,
        endTime: candidate.endTime,
        room: candidate.room?.trim() ?? null,
      },
      include: slotInclude,
    })) as unknown as SlotWithIncludes;

    return { ok: true, data: formatSlotDto(updated) };
  });
}

/**
 * Deletes a timetable slot.
 */
export async function deleteTimetableSlot(tenantId: string, id: string): Promise<TimetableServiceResult<{ id: string; deleted: true }>> {
  const tId = trustedTenantId(tenantId);

  return forTenant(tId).transaction(async (tx) => {
    const existing = await tx.timetableSlot.findFirst({
      where: { id, tenantId },
    });

    if (!existing) {
      return { ok: false, failure: "NOT_FOUND" };
    }

    await tx.timetableSlot.delete({
      where: { tenantId_id: { tenantId, id } },
    });

    return { ok: true, data: { id, deleted: true } };
  });
}

/**
 * Batch saves timetable slots atomically, optionally replacing existing slots for a class arm.
 */
export async function batchSaveTimetable(
  tenantId: string,
  input: BatchSaveTimetableInput,
): Promise<TimetableServiceResult<{ savedCount: number; slots: TimetableSlotDto[] }>> {
  const tId = trustedTenantId(tenantId);

  // 1. Check internal batch collisions
  const internalClashes = findBatchClashes(input.slots);
  if (internalClashes.length > 0) {
    return {
      ok: false,
      failure: "CLASH",
      detail: `Internal collisions in proposed batch: ${internalClashes.map((c) => c.message).join(" ")}`,
      clashes: internalClashes,
    };
  }

  return forTenant(tId).transaction(async (tx) => {
    // 2. If replacing existing for a class arm, delete them first
    if (input.replaceExisting && input.classArmId) {
      await tx.timetableSlot.deleteMany({
        where: { tenantId, classArmId: input.classArmId },
      });
    }

    // 3. Query all remaining slots to check external clashes
    const remainingSlots = await tx.timetableSlot.findMany({
      where: { tenantId },
      select: {
        id: true,
        classArmId: true,
        subjectId: true,
        staffRecordId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        room: true,
      },
    });

    // Check each proposed slot against existing database slots
    for (const slot of input.slots) {
      const clashes = findSlotClashes(slot, remainingSlots);
      if (clashes.length > 0) {
        return {
          ok: false,
          failure: "CLASH",
          detail: `Conflict with existing schedule: ${clashes.map((c) => c.message).join(" ")}`,
          clashes,
        };
      }
    }

    // 4. Create all slots
    await tx.timetableSlot.createMany({
      data: input.slots.map((s) => ({
        tenantId,
        classArmId: s.classArmId,
        subjectId: s.subjectId,
        staffRecordId: s.staffRecordId,
        dayOfWeek: s.dayOfWeek,
        periodNumber: s.periodNumber ?? null,
        startTime: s.startTime,
        endTime: s.endTime,
        room: s.room?.trim() ?? null,
      })),
    });

    // Fetch saved slots for return
    const saved = (await tx.timetableSlot.findMany({
      where: {
        tenantId,
        ...(input.classArmId ? { classArmId: input.classArmId } : {}),
      },
      include: slotInclude,
      orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    })) as unknown as SlotWithIncludes[];

    return {
      ok: true,
      data: {
        savedCount: input.slots.length,
        slots: saved.map(formatSlotDto),
      },
    };
  });
}
