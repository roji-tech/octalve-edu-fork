import { z } from "zod";
import { fail } from "@/lib/api/envelope";
import { ResultStatus } from "@prisma/client";

export const STAFF_READ_ROLES = ["ADMIN", "TEACHING_STAFF", "NON_TEACHING_STAFF"] as const;
export const WRITE_ROLES = ["ADMIN", "TEACHING_STAFF"] as const;

export const componentScoreItemSchema = z.strictObject({
  name: z.string().min(1, "Component name is required").max(40, "Component name cannot exceed 40 characters"),
  score: z.number().min(0, "Component score cannot be negative"),
  maxScore: z.number().positive("Component max score must be positive"),
});

export const studentResultEntrySchema = z.strictObject({
  studentId: z.string().min(1, "Student ID is required"),
  score: z.number().min(0, "Score cannot be negative").optional(),
  maxScore: z.number().positive("Max score must be positive").optional().default(100),
  components: z.array(componentScoreItemSchema).optional(),
});

export const recordResultsSchema = z.strictObject({
  periodId: z.string().min(1, "Academic period ID is required"),
  subjectId: z.string().min(1, "Subject ID is required"),
  results: z.array(studentResultEntrySchema).min(1, "Provide at least one student result"),
});

export type RecordResultsInput = z.infer<typeof recordResultsSchema>;

export const transitionStatusSchema = z.strictObject({
  resultIds: z.array(z.string().min(1, "Result ID is required")).min(1, "Provide at least one result ID"),
  toStatus: z.nativeEnum(ResultStatus, { error: "Invalid result status" }),
  reason: z.string().max(500, "Reason cannot exceed 500 characters").optional().nullable(),
});

export type TransitionStatusInput = z.infer<typeof transitionStatusSchema>;

export const resultsQuerySchema = z.object({
  periodId: z.string().optional(),
  subjectId: z.string().optional(),
  classArmId: z.string().optional(),
  status: z.nativeEnum(ResultStatus).optional(),
});

export type ResultFailure =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVALID_TRANSITION"
  | "MISSING_REASON"
  | "SCHEME_VALIDATION_FAILED"
  | "SCORE_OUT_OF_BOUNDS"
  | "FORBIDDEN_STUDENT_ACCESS"
  | "PERIOD_NOT_ACTIVE";

export function resultFailure(reason: ResultFailure, message?: string): Response {
  switch (reason) {
    case "NOT_FOUND":
      return fail(message ?? "Resource not found.", 404, "NOT_FOUND");
    case "UNAUTHORIZED":
      return fail(message ?? "You lack the permission to perform this result action.", 403, "FORBIDDEN");
    case "INVALID_TRANSITION":
      return fail(message ?? "The requested result status transition is invalid.", 400, "INVALID_TRANSITION");
    case "MISSING_REASON":
      return fail(message ?? "A non-empty reason is required for this status change.", 400, "MISSING_REASON");
    case "SCHEME_VALIDATION_FAILED":
      return fail(message ?? "Component scores do not conform to assessment scheme.", 400, "VALIDATION");
    case "SCORE_OUT_OF_BOUNDS":
      return fail(message ?? "Score exceeds allowed maximum or is negative.", 400, "VALIDATION");
    case "FORBIDDEN_STUDENT_ACCESS":
      return fail(message ?? "You are not authorized to view this student's report card.", 403, "FORBIDDEN");
    case "PERIOD_NOT_ACTIVE":
      return fail(message ?? "The academic period is closed or invalid.", 409, "CONFLICT");
    default:
      return fail(message ?? "Results operation failed.", 400, "BAD_REQUEST");
  }
}
