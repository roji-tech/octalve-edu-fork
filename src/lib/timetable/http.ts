import { z } from "zod";
import { fail } from "@/lib/api/envelope";
import { isValidTimeString, isValidTimeRange, type TimetableClash } from "./rules";

const timeStringSchema = z.string().refine(isValidTimeString, "Time must be 'HH:MM' 24-hour format (e.g. '08:30').");

export const createTimetableSlotSchema = z
  .strictObject({
    classArmId: z.string().min(1, "Class arm is required"),
    subjectId: z.string().min(1, "Subject is required"),
    staffRecordId: z.string().min(1, "Teacher / staff record is required"),
    dayOfWeek: z.number().int().min(1, "Day of week must be between 1 (Monday) and 7 (Sunday)").max(7),
    periodNumber: z.number().int().min(1).max(20).nullable().optional(),
    startTime: timeStringSchema,
    endTime: timeStringSchema,
    room: z.string().max(50, "Room name cannot exceed 50 characters").nullable().optional(),
  })
  .refine((data) => isValidTimeRange(data.startTime, data.endTime), {
    message: "startTime must be strictly before endTime",
    path: ["startTime"],
  });

export type CreateTimetableSlotInput = z.infer<typeof createTimetableSlotSchema>;

export const updateTimetableSlotSchema = z
  .strictObject({
    classArmId: z.string().min(1).optional(),
    subjectId: z.string().min(1).optional(),
    staffRecordId: z.string().min(1).optional(),
    dayOfWeek: z.number().int().min(1).max(7).optional(),
    periodNumber: z.number().int().min(1).max(20).nullable().optional(),
    startTime: timeStringSchema.optional(),
    endTime: timeStringSchema.optional(),
    room: z.string().max(50).nullable().optional(),
  })
  .refine(
    (data) => {
      if (data.startTime && data.endTime) {
        return isValidTimeRange(data.startTime, data.endTime);
      }
      return true;
    },
    {
      message: "startTime must be strictly before endTime",
      path: ["startTime"],
    },
  );

export type UpdateTimetableSlotInput = z.infer<typeof updateTimetableSlotSchema>;

export const batchSaveTimetableSchema = z.strictObject({
  classArmId: z.string().min(1).optional(),
  slots: z.array(createTimetableSlotSchema).min(1, "Provide at least one timetable slot"),
  replaceExisting: z.boolean().optional().default(false),
});

export type BatchSaveTimetableInput = z.infer<typeof batchSaveTimetableSchema>;

export const queryTimetableSchema = z.strictObject({
  classArmId: z.string().optional(),
  staffRecordId: z.string().optional(),
  dayOfWeek: z.coerce.number().int().min(1).max(7).optional(),
  room: z.string().optional(),
});

export type QueryTimetableInput = z.infer<typeof queryTimetableSchema>;

export type TimetableFailure = "NOT_FOUND" | "CLASH" | "INVALID_FOREIGN_KEY" | "BAD_REQUEST";

export function timetableFailure(reason: TimetableFailure, detail?: string, clashes?: TimetableClash[]): Response {
  switch (reason) {
    case "NOT_FOUND":
      return fail(detail ?? "Timetable slot not found.", 404, "NOT_FOUND");
    case "CLASH":
      return fail(
        detail ?? "Scheduling conflict detected.",
        409,
        "TIMETABLE_CLASH",
        clashes?.map((c) => ({ path: c.type, message: c.message })),
      );
    case "INVALID_FOREIGN_KEY":
      return fail(detail ?? "Invalid class arm, subject, or staff record reference.", 400, "INVALID_FOREIGN_KEY");
    default:
      return fail(detail ?? "Timetable operation failed.", 400, "BAD_REQUEST");
  }
}
