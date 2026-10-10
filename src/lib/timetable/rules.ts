export const DAYS_OF_WEEK = [1, 2, 3, 4, 5, 6, 7] as const;
export type DayOfWeekNumber = (typeof DAYS_OF_WEEK)[number];

export const DAY_NAMES: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

export const SHORT_DAY_NAMES: Record<number, string> = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun",
};

export function getDayName(day: number): string {
  return DAY_NAMES[day] ?? `Day ${day}`;
}

export function getShortDayName(day: number): string {
  return SHORT_DAY_NAMES[day] ?? `D${day}`;
}

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates whether a string matches "HH:MM" 24-hour time format (00:00 - 23:59).
 */
export function isValidTimeString(time: string): boolean {
  return TIME_REGEX.test(time.trim());
}

/**
 * Converts "HH:MM" into total elapsed minutes from 00:00.
 */
export function parseTimeToMinutes(time: string): number {
  const trimmed = time.trim();
  if (!isValidTimeString(trimmed)) {
    throw new Error(`Invalid time string "${time}". Expected format "HH:MM" (e.g. "08:30").`);
  }
  const [hours, minutes] = trimmed.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Converts elapsed minutes from midnight into 24-hour "HH:MM" string.
 */
export function formatMinutesToTime(totalMinutes: number): string {
  if (totalMinutes < 0 || totalMinutes >= 1440 || !Number.isInteger(totalMinutes)) {
    throw new Error(`Minutes must be an integer between 0 and 1439, got ${totalMinutes}`);
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Checks if start and end strings are valid "HH:MM" and start < end.
 */
export function isValidTimeRange(startTime: string, endTime: string): boolean {
  if (!isValidTimeString(startTime) || !isValidTimeString(endTime)) {
    return false;
  }
  return parseTimeToMinutes(startTime) < parseTimeToMinutes(endTime);
}

/**
 * Pure check whether two half-open intervals [startA, endA) and [startB, endB) overlap.
 * Adjacent intervals (e.g. 08:00-09:00 and 09:00-10:00) do NOT overlap.
 */
export function isTimeOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  const aStart = parseTimeToMinutes(startA);
  const aEnd = parseTimeToMinutes(endA);
  const bStart = parseTimeToMinutes(startB);
  const bEnd = parseTimeToMinutes(endB);

  return aStart < bEnd && aEnd > bStart;
}

export type ClashType = "TEACHER_CLASH" | "CLASS_ARM_CLASH" | "ROOM_CLASH";

export interface TimetableSlotInput {
  id?: string;
  classArmId: string;
  subjectId: string;
  staffRecordId: string;
  dayOfWeek: number;
  periodNumber?: number | null;
  startTime: string;
  endTime: string;
  room?: string | null;
}

export interface TimetableClash {
  type: ClashType;
  message: string;
  candidate: TimetableSlotInput;
  conflictingSlot: TimetableSlotInput;
}

/**
 * Finds all clashes between a candidate slot and existing slots.
 * Compares across:
 * 1. Teacher double-booking (same staffRecordId, overlapping time on same day)
 * 2. Class arm overlap (same classArmId, overlapping time on same day)
 * 3. Room conflict (same room name case-insensitive, overlapping time on same day)
 */
export function findSlotClashes(candidate: TimetableSlotInput, existingSlots: TimetableSlotInput[]): TimetableClash[] {
  const clashes: TimetableClash[] = [];

  for (const existing of existingSlots) {
    // Skip self-comparison when updating an existing slot
    if (candidate.id && existing.id && candidate.id === existing.id) {
      continue;
    }

    // Must be on the exact same day of the week
    if (candidate.dayOfWeek !== existing.dayOfWeek) {
      continue;
    }

    // Must overlap in time
    if (!isTimeOverlap(candidate.startTime, candidate.endTime, existing.startTime, existing.endTime)) {
      continue;
    }

    const dayName = getDayName(candidate.dayOfWeek);

    // 1. Teacher Clash
    if (candidate.staffRecordId && candidate.staffRecordId === existing.staffRecordId) {
      clashes.push({
        type: "TEACHER_CLASH",
        message: `Teacher is already scheduled on ${dayName} from ${existing.startTime} to ${existing.endTime}.`,
        candidate,
        conflictingSlot: existing,
      });
    }

    // 2. Class Arm Clash
    if (candidate.classArmId && candidate.classArmId === existing.classArmId) {
      clashes.push({
        type: "CLASS_ARM_CLASH",
        message: `Class arm is already scheduled for another period on ${dayName} from ${existing.startTime} to ${existing.endTime}.`,
        candidate,
        conflictingSlot: existing,
      });
    }

    // 3. Room Clash
    const candidateRoom = candidate.room?.trim().toLowerCase();
    const existingRoom = existing.room?.trim().toLowerCase();
    if (candidateRoom && existingRoom && candidateRoom === existingRoom) {
      clashes.push({
        type: "ROOM_CLASH",
        message: `Room "${existing.room?.trim() ?? candidate.room?.trim()}" is already booked on ${dayName} from ${existing.startTime} to ${existing.endTime}.`,
        candidate,
        conflictingSlot: existing,
      });
    }
  }

  return clashes;
}

/**
 * Detects the first clash between a candidate slot and existing slots, or returns null.
 */
export function detectAnyClash(candidate: TimetableSlotInput, existingSlots: TimetableSlotInput[]): TimetableClash | null {
  const clashes = findSlotClashes(candidate, existingSlots);
  return clashes.length > 0 ? clashes[0] : null;
}

/**
 * Validates internal collisions inside a proposed batch of slots.
 */
export function findBatchClashes(slots: TimetableSlotInput[]): TimetableClash[] {
  const clashes: TimetableClash[] = [];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const slotA = slots[i];
      const slotB = slots[j];

      if (slotA.dayOfWeek !== slotB.dayOfWeek) continue;
      if (!isTimeOverlap(slotA.startTime, slotA.endTime, slotB.startTime, slotB.endTime)) continue;

      const dayName = getDayName(slotA.dayOfWeek);

      if (slotA.staffRecordId === slotB.staffRecordId) {
        clashes.push({
          type: "TEACHER_CLASH",
          message: `Teacher has multiple overlapping slots on ${dayName} (${slotA.startTime}-${slotA.endTime} and ${slotB.startTime}-${slotB.endTime}).`,
          candidate: slotB,
          conflictingSlot: slotA,
        });
      }

      if (slotA.classArmId === slotB.classArmId) {
        clashes.push({
          type: "CLASS_ARM_CLASH",
          message: `Class arm has multiple overlapping slots on ${dayName} (${slotA.startTime}-${slotA.endTime} and ${slotB.startTime}-${slotB.endTime}).`,
          candidate: slotB,
          conflictingSlot: slotA,
        });
      }

      const roomA = slotA.room?.trim().toLowerCase();
      const roomB = slotB.room?.trim().toLowerCase();
      if (roomA && roomB && roomA === roomB) {
        clashes.push({
          type: "ROOM_CLASH",
          message: `Room "${slotA.room?.trim()}" is double-booked on ${dayName} (${slotA.startTime}-${slotA.endTime} and ${slotB.startTime}-${slotB.endTime}).`,
          candidate: slotB,
          conflictingSlot: slotA,
        });
      }
    }
  }
  return clashes;
}

export interface SlotValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates slot schema invariants.
 */
export function validateTimetableSlot(slot: Partial<TimetableSlotInput>): SlotValidationResult {
  const errors: string[] = [];

  if (!slot.classArmId || slot.classArmId.trim() === "") {
    errors.push("classArmId is required");
  }
  if (!slot.subjectId || slot.subjectId.trim() === "") {
    errors.push("subjectId is required");
  }
  if (!slot.staffRecordId || slot.staffRecordId.trim() === "") {
    errors.push("staffRecordId is required");
  }

  if (slot.dayOfWeek === undefined || slot.dayOfWeek < 1 || slot.dayOfWeek > 7) {
    errors.push("dayOfWeek must be an integer between 1 (Monday) and 7 (Sunday)");
  }

  if (!slot.startTime || !isValidTimeString(slot.startTime)) {
    errors.push("startTime must be a valid 'HH:MM' string (00:00 to 23:59)");
  }

  if (!slot.endTime || !isValidTimeString(slot.endTime)) {
    errors.push("endTime must be a valid 'HH:MM' string (00:00 to 23:59)");
  }

  if (slot.startTime && slot.endTime && isValidTimeString(slot.startTime) && isValidTimeString(slot.endTime)) {
    if (parseTimeToMinutes(slot.startTime) >= parseTimeToMinutes(slot.endTime)) {
      errors.push("startTime must be strictly before endTime");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Groups slots by day of the week (1 to 7) and sorts them chronologically by startTime.
 */
export function groupSlotsByDay<T extends TimetableSlotInput>(slots: T[]): Record<number, T[]> {
  const grouped: Record<number, T[]> = {
    1: [],
    2: [],
    3: [],
    4: [],
    5: [],
    6: [],
    7: [],
  };

  for (const slot of slots) {
    if (grouped[slot.dayOfWeek]) {
      grouped[slot.dayOfWeek].push(slot);
    }
  }

  for (const day of DAYS_OF_WEEK) {
    grouped[day].sort((a, b) => {
      const aStart = parseTimeToMinutes(a.startTime);
      const bStart = parseTimeToMinutes(b.startTime);
      if (aStart !== bStart) return aStart - bStart;
      return parseTimeToMinutes(a.endTime) - parseTimeToMinutes(b.endTime);
    });
  }

  return grouped;
}
